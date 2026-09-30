/**
 * Full-text resolution: identify -> cascade of open-access and Sci-Hub routes.
 *
 * Route order is deliberate: legal open-access sources come first (they are
 * faster, more reliable and higher quality than the Sci-Hub mirrors), and
 * Sci-Hub is the fallback rather than the default path.
 */
import { inflateSync } from "node:zlib";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONTACT_EMAIL,
  DEFAULT_UA,
  arxivDoi,
  citationDoi,
  citationPdfUrls,
  classifyIdentifier,
  doisInPdfBuffer,
  downloadPdfBuffer,
  extractArxivId,
  extractDoi,
  extractPdfUrl,
  fetchHtmlSmart,
  isAbort,
  isPdfBuffer,
  isRateLimitError,
  isSelfReferentialPdfLink,
  isTitleMatch,
  retryAfterMs,
  slugify,
  stripFragment,
  titleConfidence,
  titleSimilarity,
  withTimeout,
} from "./util.mjs";
import { resolveByTitle } from "./search.mjs";
import {
  ar5ivUrl,
  arxivApi,
  arxivPdfUrl,
  barePmid,
  barePmcid,
  biorxivPdfUrl,
  convertId,
  crossrefWork,
  crossrefSearch,
  doajSearch,
  europePmcByDoi,
  europePmcByPmid,
  europePmcFullTextXml,
  europePmcPdfUrls,
  lookupByPmcid,
  medrxivPdfUrl,
  openalexByDoi,
  openalexByPmid,
  pmcFullTextUrls,
  pmcidForPmid,
  pmidsForDoi,
  preprintServerFor,
  resolveArxivOffline,
  semanticScholarPaper,
  unpaywallPdfUrls,
} from "./sources.mjs";

/** A DOI must look like a DOI: two sources returning URLs must not poison it. */
const DOI_SHAPE = /^10\.\d{4,9}\/\S+$/;

/**
 * Hosts that recently refused or timed out on EVERY attempt, with the time of
 * the failure. Some hosts (arxiv.org in mainland China, various publishers) are
 * consistently unreachable, and retrying them on every call wastes the whole
 * route budget. A host is retried once the cooldown expires.
 */
const hostFailures = new Map();
const HOST_COOLDOWN_MS = 10 * 60 * 1000;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when this host is in cooldown and should be skipped. */
export function hostInCooldown(url) {
  const host = hostOf(url);
  if (!host) return false;
  const at = hostFailures.get(host);
  if (!at) return false;
  if (Date.now() - at > HOST_COOLDOWN_MS) {
    hostFailures.delete(host);
    return false;
  }
  return true;
}

function markHostFailure(url) {
  const host = hostOf(url);
  if (host) hostFailures.set(host, Date.now());
}

function markHostSuccess(url) {
  const host = hostOf(url);
  if (host) hostFailures.delete(host);
}

/** For tests: clear the circuit breaker. */
export function resetHostCooldowns() {
  hostFailures.clear();
}

/**
 * Per-route time budgets, as a fraction of `timeoutMs`.
 *
 * A single global budget is not enough: measured live, five "unavailable" routes
 * each burned their full allowance and the fetch took over two minutes before
 * reaching the route that works. Routes that are known to be fast-or-nothing
 * (arXiv, Semantic Scholar, the bibliographic lookups) get a short leash, and
 * only the routes that actually deliver PDFs get a generous one.
 *
 * `scihub` is the largest because it is the primary route and its mirrors split
 * into two storage backends: sci.bban.top (shared by nine mirrors) and
 * sci-hub.red (sci-hub.ru). A mirror that times out once is worth one retry —
 * measured live, sci-hub.red answered a 921 KB PDF in 2 s on the second attempt
 * after a 47 s stall on the first.
 */
const ROUTE_BUDGET = {
  arxiv: 0.5,
  preprint: 0.8,
  pmc: 0.7,
  europepmc: 0.7,
  unpaywall: 0.8,
  openalex: 0.8,
  semanticscholar: 0.5,
  publisher: 1.0,
  scihub: 2.0,
  ar5iv: 0.8,
};

// ---------------------------------------------------------------------------
// Sci-Hub mirrors
// ---------------------------------------------------------------------------

/**
 * Mirror health verified live.
 *
 * The nine mirrors above all serve from ONE backend (`sci.bban.top`), so the list
 * is DNS/route redundancy rather than extra coverage — and that backend answers
 * HTTP 429 if several PDFs are pulled through it at once, which is why the
 * download path retries on 429.
 *
 * `sci-hub.ru` is the only mirror with an INDEPENDENT backend: it serves PDFs
 * from its own `sci-hub.red` storage via an `<object data=…>` tag. It is kept
 * LAST because it is unreliable in a way no client setting fixes — probing it
 * with identical headers returns the article once and its "are you are robot?"
 * wall the next three times (verified: the same request alternates between a
 * 26 KB article page and a 7 KB wall). Its retries therefore must not delay the
 * nine fast mirrors, but its unique coverage is still worth one cheap attempt.
 */
export const DEFAULT_MIRRORS = [
  "https://sci-hub.ren",
  "https://sci-hub.in",
  "https://sci-hub.ee",
  "https://sci-hub.mk",
  "https://sci-hub.al",
  "https://sci-hub.hkvisa.net",
  "https://sci-hub.vg",
  "https://sci-hub.usualwant.com",
  "https://sci-hub.mksa.top",
  "https://sci-hub.ru",
];

/**
 * Hosts that answer the article request but never yield a PDF. Kept here so
 * `sevastopol36_scihub_probe include_known_dead=true` can re-check them.
 * Verified 2026-02: `.st` returns HTTP 403, `.red` returns HTTP 502, `.yt`
 * serves a page with no PDF link.
 */
export const ON_SITE_DEAD_MIRRORS = ["https://sci-hub.st", "https://sci-hub.red", "https://sci-hub.yt"];

/** Mirrors whose domain no longer exists at all (DNS / connection failure). */
export const KNOWN_DEAD_MIRRORS = [
  "https://sci-hub.se",
  "https://sci-hub.es",
  "https://sci-hub.tw",
  "https://sci-hub.sci-hub.se",
  "https://sci-hub.one",
  "https://sci-hub.41610.org",
  "https://sci-hub.glass",
  "https://sci-hub.box",
  "https://sci-hub.cam",
  "https://sci-hub.art",
  "https://sci-hub.download",
  "https://sci-hub.help",
  "https://sci-hub.live",
  "https://sci-hub.me",
  "https://sci-hub.top",
  "https://sci-hub.work",
  "https://sci-hub.pl",
  "https://sci-hub.pub",
  "https://sci-hub.tech",
];

const NOT_FOUND_MARKERS = [
  "article is not found",
  "article not found",
  "\u0441\u0442\u0430\u0442\u044c\u044f \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430",
  "could not find",
];

/** Proxy aggregator mirrors serve a JS "search proxy" page instead of an article. */
const AGGREGATOR_MARKERS = ["search proxy", "no matching proxies", "proxy found, please wait"];

/** Challenge / parked / placeholder pages: the mirror answered, but not with an article. */
const BLOCKED_MARKERS = [
  "are you are robot",
  "just a moment",
  "checking your browser",
  "cf-browser-verification",
  "enable javascript and cookies",
  "click here to enter",
];

function mirrorPageUrl(base, doi) {
  const b = String(base).replace(/\/+$/, "");
  const path = String(doi)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${b}/${path}`;
}

function classifyMirrorHtml(html) {
  const lower = String(html).toLowerCase();
  return {
    notFound: NOT_FOUND_MARKERS.some((m) => lower.includes(m)),
    aggregator: AGGREGATOR_MARKERS.some((m) => lower.includes(m)),
    blocked: BLOCKED_MARKERS.some((m) => lower.includes(m)),
  };
}

/** Ask one mirror for the article page and return the PDF link it advertises. */
export async function mirrorArticle(mirror, doi, { userAgent = DEFAULT_UA, signal, timeoutMs = 25000 } = {}) {
  const pageUrl = mirrorPageUrl(mirror, doi);
  const { text, url } = await fetchHtmlSmart(pageUrl, userAgent, signal, { timeoutMs, maxHops: 1 });
  const pdfUrl = extractPdfUrl(url || pageUrl, text);
  const marks = classifyMirrorHtml(text);
  return { mirror, pageUrl, finalUrl: url, html: text, pdfUrl, ...marks };
}

/**
 * Run a non-critical route step under its own timeout budget.
 *
 * A route that stalls (a publisher hanging the connection, a mirror that never
 * answers) degrades to a recorded failure instead of aborting the whole
 * cascade. Only the CALLER's cancellation propagates.
 *
 * @returns {Promise<{ok: true, value: any}|{ok: false, error: Error}>}
 */
export async function runRoute(label, signal, ms, fn, errors, emit) {  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  try {
    const value = await fn(AbortSignal.any([signal, AbortSignal.timeout(Math.max(500, ms))]));
    return { ok: true, value };
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const message = err?.name === "TimeoutError" ? `route timed out after ${ms}ms` : err.message;
    errors.push(`${label}: ${message}`);
    emit?.({ stage: "route-error", route: label, reason: message });
    return { ok: false, error: err };
  }
}

// ---------------------------------------------------------------------------
// Identifier resolution
// ---------------------------------------------------------------------------

/**
 * Build the full identifier set for one paper, using every cross-id source that
 * is reachable. Each lookup is independent, budgeted and best-effort: a source
 * that is slow or down degrades the result instead of failing the call.
 *
 * @param {string|{kind:string,value:string}} input
 * @param {object} config
 * @param {AbortSignal} signal budget for the WHOLE resolution
 * @returns {Promise<object>} `{doi, pmid, pmcid, arxivId, title, ...}`
 */
export async function resolveIdentifiers(input, config, signal) {
  const cls = typeof input === "string" ? classifyIdentifier(input) : input;
  const out = {
    doi: "",
    pmid: "",
    pmcid: "",
    arxivId: "",
    title: "",
    year: null,
    journal: "",
    authors: [],
    source: "",
    candidates: [],
    oaPdfUrls: [],
    notes: [],
  };
  const lookupMs = config.lookupTimeoutMs ?? 10000;
  const deadline = Date.now() + (config.resolveDeadlineMs ?? 45000);
  const opts = { userAgent: config.userAgent, email: config.email, apiKey: config.ncbiApiKey, retries: 0 };
  /**
   * Run an optional lookup. Failures and deadline exhaustion are recorded as
   * notes and never thrown, so a slow or down source only costs its own budget.
   */
  const optional = async (label, fn) => {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (Date.now() > deadline) {
      out.notes.push(`${label}: skipped (resolution deadline reached)`);
      return null;
    }
    try {
      return await fn(withTimeout(signal, Math.min(lookupMs, Math.max(1000, deadline - Date.now()))));
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      out.notes.push(`${label}: ${err.message}`);
      return null;
    }
  };
  const budget = (ms) => withTimeout(signal, ms);

  if (cls.kind === "doi") out.doi = cls.value;
  else if (cls.kind === "arxiv") out.arxivId = cls.value;
  else if (cls.kind === "pmid") out.pmid = cls.value;
  else if (cls.kind === "pmcid") out.pmcid = cls.value;

  // --- URL: pull a DOI / arXiv id / publisher meta out of the page ---------
  if (cls.kind === "url") {
    const url = cls.value;
    out.doi = extractDoi(url) ?? "";
    out.arxivId = extractArxivId(url) ?? "";
    if (!out.doi) {
      await optional("page", async (s) => {
        const { text } = await fetchHtmlSmart(url, config.userAgent, s, { timeoutMs: config.timeoutMs });
        out.doi = citationDoi(text) ?? "";
        out.title =
          (text.match(/<meta[^>]*citation_title["'][^>]*content=["']([^"']+)/i) || [, ""])[1] || "";
        return true;
      });
    }
  }

  // --- Title: resolve to a DOI through Crossref + OpenAlex, with a gate ---
  // Crossref alone is not enough: for a paper whose venue issues no DOI it
  // returns only mirrored copies, so OpenAlex is queried in parallel and the
  // records are merged and quality-ranked.
  if (cls.kind === "title") {
    const { best, candidates, failures } = await resolveByTitle(cls.value, config, budget(config.timeoutMs * 2), {
      providers: config.titleProviders ?? ["crossref", "openalex"],
    });
    out.candidates = candidates;
    if (failures.length) out.notes.push(...failures);
    if (best) {
      out.doi = best.doi ?? "";
      out.pmid = best.pmid ?? "";
      out.pmcid = best.pmcid ?? "";
      out.arxivId = best.arxivId ?? "";
      out.title = best.title;
      out.year = best.year;
      out.journal = best.journal;
      out.authors = best.authors ?? [];
      out.isOpenAccess = best.isOpenAccess ?? null;
      out.oaPdfUrls = best.oaPdfUrls ?? [];
      out.source = `title(${best.sources?.join("+") ?? "?"})`;
    } else if (candidates.length) {
      throw Object.assign(
        new Error(
          `Title match confidence too low for "${cls.value}".\nCandidates:\n${candidates
            .slice(0, 5)
            .map(
              (h) =>
                `  - ${h.title} (DOI: ${h.doi || "n/a"}, overlap ${h.overlap.toFixed(2)}, similarity ${h.similarity.toFixed(2)}, quality ${h.quality})`,
            )
            .join("\n")}\nPass an explicit doi / pmid / pmcid / arxiv id to fetch the right one.`,
        ),
        { candidates },
      );
    } else {
      throw new Error(`No title match for "${cls.value}" in Crossref or OpenAlex. Try sevastopol36_scihub_search first, or pass a DOI.`);
    }
  }

  // --- arXiv DOI route ----------------------------------------------------
  if (!out.arxivId && /^10\.48550\/arxiv\./i.test(out.doi)) {
    out.arxivId = extractArxivId(out.doi) ?? "";
  }

  // --- identifier cross-links (only ask for what is still missing) --------

  // NCBI's PMC ID Converter answers every direction (DOI <-> PMID <-> PMCID) in
  // one authoritative call and needs no key, so it goes first. The result is
  // kept so later steps do not repeat the same round-trip.
  let converted = null;
  if ((!out.pmid || !out.pmcid) && (out.doi || out.pmid || out.pmcid)) {
    converted = await optional("idconv", (s) =>
      convertId(out.doi || out.pmid || out.pmcid, { ...opts, signal: s }),
    );
    if (converted) {
      out.pmid ||= converted.pmid;
      out.pmcid ||= converted.pmcid;
      out.doi ||= converted.doi && DOI_SHAPE.test(converted.doi) ? converted.doi : out.doi;
    }
  }

  // PMCID -> title / authors / OA flags. The converter gives ids only, and its
  // result is handed over so it is not fetched twice.
  if (out.pmcid && (!out.title || !out.doi || !out.pmid)) {
    const rec = await optional("pmcid-lookup", (s) =>
      lookupByPmcid(out.pmcid, { ...opts, signal: s, converted }),
    );
    if (rec) {
      out.doi ||= rec.doi && DOI_SHAPE.test(rec.doi) ? rec.doi : out.doi;
      out.pmid ||= barePmid(rec.pmid);
      out.title ||= rec.title;
      out.year ||= rec.year;
      out.journal ||= rec.journal;
      if (!out.authors.length && rec.authors?.length) out.authors = rec.authors;
      out.isOpenAccess ??= rec.isOpenAccess;
      out.source ||= rec.source ?? "pmcid-lookup";
      if (rec.ftUrls?.length) out.ftUrls = rec.ftUrls;
    }
  }

  if (out.doi && !out.pmid) {
    const got = await optional("pubmed-id", (s) => pmidsForDoi(out.doi, { ...opts, signal: s }));
    if (got?.length) out.pmid = got[0];
  }
  if (out.pmid && !out.pmcid) {
    const got = await optional("pmc-id", (s) => pmcidForPmid(out.pmid, { ...opts, signal: s }));
    if (got) out.pmcid = got;
  }
  if (out.pmid && !out.doi) {
    const got = await optional("openalex-by-pmid", (s) => openalexByPmid(out.pmid, { ...opts, signal: s }));
    if (got) {
      out.doi ||= got.doi && DOI_SHAPE.test(got.doi) ? got.doi : out.doi;
      out.pmcid ||= got.pmcid;
      out.title ||= got.title;
      out.year ||= got.year;
      out.journal ||= got.journal;
      if (!out.authors.length) out.authors = got.authors;
      out.oaPdfUrls = [...new Set([...(out.oaPdfUrls ?? []), ...(got.oaPdfUrls ?? [])])];
      out.source ||= "openalex";
    }
  }

  // --- arXiv id: resolve without arxiv.org (often unreachable) ------------
  // OpenAlex indexes arXiv landing pages and Crossref carries the
  // 10.48550/arXiv.<id> DOI, so both routes work with arxiv.org blocked.
  if (cls.kind === "arxiv" && !out.doi) {
    const rec = await optional("arxiv-resolve", (s) => resolveArxivOffline(out.arxivId, { ...opts, signal: s }));
    if (rec) {
      const recDoi = extractDoi(rec.doi ?? "");
      if (recDoi && DOI_SHAPE.test(recDoi)) out.doi = recDoi;
      out.title ||= rec.title;
      out.year ||= rec.year;
      out.journal ||= rec.journal;
      if (!out.authors.length) out.authors = rec.authors ?? [];
      out.pmid ||= barePmid(rec.pmid) || rec.pmid;
      out.pmcid ||= barePmcid(rec.pmcid) || rec.pmcid;
      out.citations = rec.citations ?? out.citations;
      out.isOpenAccess ??= rec.isOpenAccess ?? true;
      if (rec.oaPdfUrls?.length) out.oaPdfUrls = [...new Set([...out.oaPdfUrls, ...rec.oaPdfUrls])];
      out.source ||= rec.source ?? "arxiv-resolve";
    }
  }

  // --- normalise anything a source returned in URL form ------------------
  // Sources disagree on shape: OpenAlex hands back "https://doi.org/10.x/y",
  // Europe PMC a bare DOI, and a misbehaving source can return something that
  // is not a DOI at all. Keep only a well-formed DOI so the cascade never
  // queries a nonsense identifier.
  if (out.doi) {
    const cleaned = extractDoi(out.doi);
    if (cleaned && DOI_SHAPE.test(cleaned)) {
      out.doi = cleaned;
    } else {
      out.notes.push(`ignored a malformed DOI from a source: ${String(out.doi).slice(0, 80)}`);
      out.doi = "";
    }
  }
  if (out.pmid) out.pmid = barePmid(out.pmid) || out.pmid;
  if (out.pmcid) out.pmcid = barePmcid(out.pmcid) || out.pmcid;

  /**
   * Stop asking once nothing important is missing.
   *
   * Each remaining source is an independent network round-trip, so continuing
   * after the record is complete only adds latency — measured, the redundant
   * OpenAlex and (rate-limited) Semantic Scholar steps cost ~8 s of a ~11 s
   * resolution that already had everything it needed.
   */
  const completeEnough = () => Boolean(out.title && out.doi && out.pmid && out.pmcid);
  const skipIfDone = (label) => {
    if (!completeEnough()) return false;
    out.notes.push(`${label}: skipped (all identifiers already resolved)`);
    return true;
  };

  // Europe PMC: cheapest single source for the remaining cross-ids + OA flags.
  // The record is cached so `pmcid-lookup` and this step never repeat the query.
  let europePmcRecord = null;
  if (!skipIfDone("europepmc") && (!out.pmcid || !out.title)) {
    const rec = await optional("europepmc", (s) => {
      if (out.doi) return europePmcByDoi(out.doi, { ...opts, signal: s });
      if (out.pmid) return europePmcByPmid(out.pmid, { ...opts, signal: s });
      return null;
    });
    if (rec) {
      europePmcRecord = rec;
      out.pmid ||= rec.pmid;
      out.pmcid ||= rec.pmcid;
      out.doi ||= rec.doi;
      out.title ||= rec.title;
      out.year ||= rec.year;
      out.journal ||= rec.journal;
      if (!out.authors.length) out.authors = rec.authors;
      out.isOpenAccess ??= rec.isOpenAccess;
      out.source ||= "europepmc";
      out.ftUrls = rec.ftUrls ?? [];
    }
  }

  // Crossref: canonical metadata for a known DOI.
  if (!skipIfDone("crossref") && out.doi && !out.title) {
    const w = await optional("crossref", (s) =>
      crossrefWork(out.doi, { signal: s, userAgent: config.userAgent }),
    );
    if (w) {
      out.title = w.title;
      out.year = w.year;
      out.journal = w.journal;
      out.authors = w.authors;
      out.source ||= "crossref";
    }
  }

  // OpenAlex: fills in arXiv id / PMC id and contributes OA PDF locations.
  if (!skipIfDone("openalex") && (!out.arxivId || !out.pmcid || !out.title || !out.oaPdfUrls.length)) {
    const w = await optional("openalex", (s) =>
      out.doi
        ? openalexByDoi(out.doi, { ...opts, signal: s })
        : out.pmid
          ? openalexByPmid(out.pmid, { ...opts, signal: s })
          : null,
    );
    if (w) {
      out.arxivId ||= w.arxivId;
      out.pmcid ||= w.pmcid;
      out.pmid ||= w.pmid;
      out.doi ||= w.doi;
      out.title ||= w.title;
      out.year ||= w.year;
      out.journal ||= w.journal;
      if (!out.authors.length && w.authors.length) out.authors = w.authors;
      out.isOpenAccess ??= w.isOpenAccess;
      out.oaPdfUrls = [...new Set([...(out.oaPdfUrls ?? []), ...(w.oaPdfUrls ?? [])])];
      out.source ||= "openalex";
    }
  }

  // Semantic Scholar: excellent cross-id graph, but rate-limits hard without a
  // key (HTTP 429). A 429 is recorded as a note; the other sources cover it.
  // It only adds value when the arXiv id is still unknown.
  if (!skipIfDone("semanticscholar") && !out.arxivId) {
    const key = out.doi ? `DOI:${out.doi}` : out.pmid ? `PMID:${out.pmid}` : out.arxivId ? `ARXIV:${out.arxivId}` : null;
    if (key) {
      const p = await optional("semanticscholar", (s) => semanticScholarPaper(key, { ...opts, signal: s }));
      if (p) {
        out.arxivId ||= p.arxivId;
        out.pmid ||= p.pmid;
        out.pmcid ||= p.pmcid;
        out.doi ||= p.doi;
        out.title ||= p.title;
        out.citations = p.citations;
        out.isOpenAccess ??= p.isOpenAccess;
        if (p.oaPdfUrls?.length) out.oaPdfUrls = [...new Set([...out.oaPdfUrls, ...p.oaPdfUrls])];
      }
    }
  }

  out.oaPdfUrls = [...new Set(out.oaPdfUrls.filter(Boolean))];
  return out;
}

// ---------------------------------------------------------------------------
// Route implementations
// ---------------------------------------------------------------------------

async function savePdf(buffer, dest) {
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buffer);
  return buffer.length;
}

/**
 * Does this PDF actually look like the paper we asked for?
 *
 * A `%PDF-` magic check proves we downloaded *a* PDF, not *the right* PDF. Some
 * mirrors serve unrelated articles, so when an expectation is supplied the PDF
 * metadata and first-page text are read for the requested DOI, falling back to
 * title similarity.
 *
 * Deliberately lenient: a large, structurally sound PDF is accepted on trust,
 * because a false rejection would lose a paper the user legitimately wanted.
 * Only a small PDF that carries neither the DOI nor a matching title — the
 * signature of an error/placeholder document — is rejected.
 *
 * @returns {{verdict: 'match'|'mismatch'|'unknown', detail: string}}
 */
export function verifyPdfContent(buffer, expect) {
  if (!expect || (!expect.doi && !expect.title)) return { verdict: "unknown", detail: "no expectation supplied" };
  if (!isPdfBuffer(buffer)) return { verdict: "mismatch", detail: "not a PDF" };

  const dois = doisInPdfBuffer(buffer);
  if (expect.doi) {
    const want = expect.doi.toLowerCase();
    if (dois.some((d) => d.toLowerCase() === want)) {
      return { verdict: "match", detail: `contains DOI ${expect.doi}` };
    }
  }
  if (expect.title) {
    const text = pdfHeadText(buffer);
    const score = titleConfidence(expect.title, `${text} ${dois.join(" ")}`);
    if (score >= 0.6) {
      return { verdict: "match", detail: `title similarity ${score.toFixed(2)}` };
    }
    if (buffer.length >= 100_000) {
      // Too big to be a placeholder, and text extraction is unreliable for many
      // publishers' PDFs. Trust it rather than lose a legitimate paper.
      return { verdict: "unknown", detail: `large PDF (${(buffer.length / 1024).toFixed(0)} KB), no DOI in head` };
    }
    return {
      verdict: "mismatch",
      detail: `no DOI ${expect.doi ?? "(none)"} in head and only ${score.toFixed(2)} title similarity`,
    };
  }
  return { verdict: "unknown", detail: `no DOI in head; ${dois.length} other DOI(s) present` };
}

/** Readable text from a PDF's leading bytes and its first inflated streams. */
function pdfHeadText(buffer, maxBytes = 200_000) {
  const head = buffer.subarray(0, maxBytes);
  const chunks = [head.toString("latin1")];
  let inflated = 0;
  for (const m of head.toString("latin1").matchAll(/stream\r?\n/g)) {
    if (inflated >= 4) break;
    const start = m.index + m[0].length;
    const end = head.indexOf(Buffer.from("endstream"), start, "latin1");
    if (end === -1) continue;
    try {
      chunks.push(inflateSync(head.subarray(start, end)).toString("latin1"));
      inflated++;
    } catch {
      /* not a deflate stream */
    }
  }
  return chunks.join(" ").replace(/[^\x20-\x7e]+/g, " ");
}

/**
 * Try a list of PDF URLs in order against one destination.
 * @param {object} [opts.expect]  `{doi, title, source}` used to verify content
 * @returns {Promise<{url, sizeBytes, cookies}|null>}
 */
async function tryPdfUrls(
  urls,
  dest,
  { userAgent, signal, timeoutMs, referer, cookies, errors, label, retries = 1, expect = null, emit = null },
) {
  // A route may hand us several candidates; give each a slice of the route
  // budget so one stalling host cannot consume the whole allowance.
  const pending = urls.filter(Boolean);
  candidate: for (let i = 0; i < pending.length; i++) {
    const raw = pending[i];
    const url = stripFragment(raw);
    // Skip a host that already failed every attempt inside the cooldown window.
    if (hostInCooldown(url)) {
      errors.push(`${label} ${url}: skipped (host unreachable earlier in this session)`);
      continue;
    }
    const remaining = pending.length - i;
    const perUrlMs = Math.max(4000, Math.floor(timeoutMs / Math.max(1, Math.min(remaining, 2))));

    // The shared sci.bban.top backend behind nine mirrors answers HTTP 429 once
    // a handful of PDFs have been pulled through it in quick succession, so every
    // MIRROR then looks broken even though the mirror list is fine. Wait briefly
    // and retry the same URL before moving on.
    const maxRateLimitRetries = 2;

    for (let attempt = 0; attempt <= maxRateLimitRetries; attempt++) {
      try {
        const { buffer, url: finalUrl, cookies: jar } = await downloadPdfBuffer(url, {
          referer: referer ?? url,
          userAgent,
          signal,
          timeoutMs: perUrlMs,
          cookies,
          retries,
        });
        markHostSuccess(url);

        // Content check: a valid PDF is not necessarily the right paper.
        if (expect) {
          const check = verifyPdfContent(buffer, expect);
          if (check.verdict === "mismatch") {
            errors.push(`${label} ${finalUrl}: rejected — ${check.detail}`);
            emit?.({ stage: "content-mismatch", route: label, url: finalUrl, reason: check.detail });
            continue candidate; // next candidate, rather than saving the wrong paper
          }
          emit?.({ stage: "content-verified", route: label, url: finalUrl, reason: check.detail });
        }

        const sizeBytes = await savePdf(buffer, dest);
        return { url: finalUrl, sizeBytes, cookies: jar };
      } catch (err) {
        if (isAbort(err)) throw err;

        if (isRateLimitError(err) && attempt < maxRateLimitRetries) {
          const waitMs = retryAfterMs(err) ?? 1500 * (attempt + 1);
          emit?.({ stage: "rate-limited", route: label, url, reason: `HTTP 429; retrying in ${waitMs}ms` });
          await delay(waitMs, signal);
          continue;
        }

        // A host that times out or refuses is worth remembering; a 403 or 429 is
        // throttling / content policy, not a dead host.
        if (/timed out|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(err.message)) {
          markHostFailure(url);
        }
        errors.push(
          `${label} ${url}: ${err.message}${isRateLimitError(err) ? " (host is rate-limiting; try again later)" : ""}`,
        );
        continue candidate;
      }
    }
  }
  return null;
}

/** Publisher landing page -> citation_pdf_url (handles bot-check interstitials). */
async function publisherRoute(url, dest, { userAgent, signal, timeoutMs, errors }) {
  try {
    const { text, url: finalUrl, cookies } = await fetchHtmlSmart(url, userAgent, signal, { timeoutMs });
    const got = await tryPdfUrls(citationPdfUrls(text), dest, {
      userAgent,
      signal,
      timeoutMs,
      referer: finalUrl,
      cookies,
      errors,
      label: "publisher",
    });
    return got ? { ...got, referer: finalUrl } : null;
  } catch (err) {
    if (isAbort(err)) throw err;
    errors.push(`publisher ${url}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

/**
 * Obtain the full text of one paper.
 *
 * ROUTE ORDER (configurable via `preferSciHub`, which defaults to ON):
 *   1. arXiv direct     - the canonical, fastest home of an arXiv paper
 *   2. Sci-Hub mirrors  - the primary full-text source, tried first
 *   3. open access      - PMC, Europe PMC, Unpaywall, OpenAlex, Semantic
 *                         Scholar, bioRxiv/medRxiv, publisher citation_pdf_url
 *   4. ar5iv HTML       - last resort, HTML rather than a PDF
 *
 * With `preferSciHub: false` the open-access routes run before Sci-Hub, which
 * avoids Sci-Hub entirely for the many papers that are legitimately open.
 *
 * `openAccessFallback: false` disables group 3 altogether.
 *
 * @param {object} args          `{doi|title|url|pmid|pmcid|arxiv|id}`
 * @param {object} config        resolved plugin config
 * @param {AbortSignal} signal   caller budget for the WHOLE operation
 * @param {object} [opts]
 * @param {string} [opts.destOverride]  exact output path
 * @param {string[]} [opts.onlySources] restrict the route list
 * @param {(e:object)=>void} [opts.onEvent] progress callback
 * @returns {Promise<object>} result record
 */
export async function fetchFullText(args, config, signal, opts = {}) {
  const events = [];
  const emit = (e) => {
    events.push(e);
    opts.onEvent?.(e);
  };
  const errors = [];
  const budget = (ms) => withTimeout(signal, ms);
  const timeoutMs = config.timeoutMs ?? 30000;
  const ua = config.userAgent ?? DEFAULT_UA;
  /** Sci-Hub first (the default), or open access first. */
  const sciHubFirst = config.preferSciHub !== false;
  /** Whether the open-access group runs at all. */
  const oaEnabled = config.openAccessFallback !== false;

  // A route that stalls must not be able to consume the whole cascade. Every
  // route runs inside `runRoute`, which caps each one; this adds an overall cap
  // so the total is bounded even when many routes each burn their allowance.
  const fetchStart = Date.now();
  const maxTotalMs = opts.maxTotalMs ?? timeoutMs * 12;
  /** Clamp a route allowance to whatever is left of the global budget. */
  const routeBudget = (want) => Math.max(1500, Math.min(want, maxTotalMs - (Date.now() - fetchStart)));
  const outOfBudget = () => Date.now() - fetchStart >= maxTotalMs;

  // --- 1. identify ---
  const rawId = args.doi || args.title || args.url || args.pmid || args.pmcid || args.arxiv || args.id;
  if (!rawId) {
    throw new Error("Provide at least one of: doi, pmid, pmcid, arxiv, title, url (or id with a resolver prefix).");
  }
  let ids;
  if (args.pmid) ids = await resolveIdentifiers({ kind: "pmid", value: String(args.pmid) }, config, signal);
  else if (args.pmcid) ids = await resolveIdentifiers({ kind: "pmcid", value: String(args.pmcid) }, config, signal);
  else if (args.arxiv) ids = await resolveIdentifiers({ kind: "arxiv", value: String(args.arxiv) }, config, signal);
  else ids = await resolveIdentifiers(String(rawId), config, signal);

  // A bare PMCID needs its DOI/PMID filled in before the OA routes can help.
  if (ids.pmcid && !ids.doi) {
    try {
      const xml = await europePmcFullTextXml(ids.pmcid, { userAgent: ua, signal: budget(timeoutMs), email: config.email });
      if (xml) {
        ids.doi = extractDoi(xml.match(/<article-id[^>]*pub-id-type="doi"[^>]*>([\s\S]*?)<\/article-id>/i)?.[1] ?? "") ?? "";
        ids.title ||= xml.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
      }
    } catch {
      /* optional */
    }
  }

  emit({ stage: "identified", ids: { ...ids, authors: undefined, oaPdfUrls: undefined } });

  if (!ids.doi && !ids.arxivId && !ids.pmcid) {
    throw new Error(
      `Could not resolve "${rawId}" to a DOI, PMID, PMCID or arXiv id. Try sevastopol36_scihub_search to find the exact record first.`,
    );
  }

  // --- 2. destination ---
  const downloadDir = resolve(process.cwd(), config.downloadDir ?? "papers");
  const stem = slugify(ids.title || ids.doi || ids.arxivId || ids.pmcid || "paper");
  const suffix = ids.doi ? `-${slugify(ids.doi)}` : ids.arxivId ? `-arxiv-${slugify(ids.arxivId)}` : `-${slugify(ids.pmcid)}`;
  const dest = opts.destOverride || join(downloadDir, `${stem.slice(0, 90)}${suffix}.pdf`);

  // --- 3. idempotency ---
  // Only a previously saved PDF may short-circuit the cascade. An HTML fallback
  // is never treated as "already downloaded", otherwise one successful ar5iv
  // fetch would permanently stop the plugin from finding the real PDF.
  if (!opts.force) {
    try {
      const info = await stat(dest);
      return {
        ...publicIds(ids),
        filePath: dest,
        sizeBytes: info.size,
        source: "cache",
        mirror: null,
        pdfUrl: null,
        reused: true,
        tries: [],
        events,
      };
    } catch {
      /* no cached PDF */
    }
    const cachedHtml = await stat(dest.replace(/\.pdf$/i, "") + ".html").catch(() => null);
    if (cachedHtml) {
      emit({ stage: "note", reason: "an HTML fallback is cached; still looking for a real PDF" });
    }
  }

  const wanted = opts.onlySources ? new Set(opts.onlySources) : null;
  const wants = (name) => !wanted || wanted.has(name);
  const got = [];
  const record = (source, url, sizeBytes) => {
    got.push(source);
    return {
      ...publicIds(ids),
      filePath: dest,
      sizeBytes,
      source,
      mirror: source,
      pdfUrl: url,
      reused: false,
      tries: got,
      events,
    };
  };

  /**
   * Try every Sci-Hub mirror in configured order.
   *
   * Returns the saved record on success, or null after every mirror has been
   * tried. On exhaustion it records the reason and emits a note, so both the
   * "Sci-Hub first" and "Sci-Hub last" call sites behave identically.
   */
  let sciHubExhausted = false;
  const runSciHub = async () => {
    if (!ids.doi || !wants("scihub")) return null;
    for (const mirror of config.mirrors ?? DEFAULT_MIRRORS) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      if (outOfBudget()) {
        errors.push(`${mirror}: skipped (fetch budget of ${maxTotalMs}ms exhausted)`);
        continue;
      }
      const r = await runRoute(
        mirror,
        signal,
        routeBudget(timeoutMs * ROUTE_BUDGET.scihub),
        async (s) => {
          const art = await mirrorArticle(mirror, ids.doi, { userAgent: ua, signal: s, timeoutMs });
          if (!art.pdfUrl) {
            const why = art.notFound
              ? "article not in Sci-Hub"
              : art.aggregator
                ? "mirror returned its search-proxy page"
                : art.blocked
                  ? "mirror is behind a bot challenge (intermittent; retry later)"
                  : "no PDF link on the page";
            emit({ stage: "mirror-miss", mirror, reason: why });
            throw new Error(why);
          }
          // Some mirrors echo the article URL back as the "PDF" link when they
          // have nothing; downloading it only burns the route budget.
          if (isSelfReferentialPdfLink(art.pdfUrl, art.finalUrl || art.pageUrl)) {
            const why = "link points back at the article page (mirror has no PDF)";
            emit({ stage: "mirror-miss", mirror, reason: why });
            throw new Error(why);
          }
          // Verify content when the configuration asks for it: a mirror can hand
          // back a different article entirely, and saving the wrong paper
          // silently is the worst possible failure for this plugin.
          const hit = await tryPdfUrls([art.pdfUrl], dest, {
            userAgent: ua,
            signal: s,
            timeoutMs: timeoutMs * 2,
            referer: art.finalUrl || art.pageUrl,
            errors,
            label: `Sci-Hub(${mirror})`,
            emit,
            expect:
              config.verifyPdf === false
                ? null
                : { doi: ids.doi, title: ids.title, source: mirror },
          });
          return hit;
        },
        errors,
        emit,
      );
      if (r.ok && r.value) {
        emit({ stage: "done", source: "sci-hub", mirror });
        return record(mirror, r.value.url, r.value.sizeBytes);
      }
    }
    sciHubExhausted = true;
    emit({ stage: "note", reason: "Sci-Hub could not supply this paper; trying open-access routes" });

    return null;
  };

  // --- 4. arXiv direct (host is often unreachable; kept on a short leash) ---
  if (ids.arxivId && wants("arxiv")) {
    const r = await runRoute(
      "arxiv",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.arxiv),
      (s) =>
        // arxiv.org answers HEAD and serves its abs page but its PDF host hangs
        // on GET from some networks (verified live), so this route gets a short
        // leash via ROUTE_BUDGET.arxiv rather than a reachability probe.
        tryPdfUrls([arxivPdfUrl(ids.arxivId)], dest, {
          userAgent: ua,
          signal: s,
          timeoutMs,
          referer: `https://arxiv.org/abs/${ids.arxivId}`,
          errors,
          label: "arxiv",
          // arxiv.org either answers quickly or not at all here; a retry just
          // doubles the wait before the cooldown can kick in.
          retries: 0,
        }),
      errors,
      emit,
    );
    if (r.ok && r.value) {
      emit({ stage: "done", source: "arxiv" });
      return record("arxiv", r.value.url, r.value.sizeBytes);
    }
  }

  // --- 5. Sci-Hub mirrors (the primary route: tried FIRST by default) ---
  if (sciHubFirst) {
    const hit = await runSciHub();
    if (hit) return hit;
  }

  // --- 6. bioRxiv / medRxiv preprints ---
  if (ids.doi && oaEnabled && wants("preprint")) {
    const r = await runRoute(
      "preprint",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.preprint),
      async (s) => {
        const pre = await preprintServerFor(ids.doi, { userAgent: ua, signal: s, email: config.email });
        if (!pre) return null;
        ids.title ||= pre.title;
        if (pre.publishedDoi) ids.publishedDoi = pre.publishedDoi;
        const urls =
          pre.server === "medrxiv"
            ? [medrxivPdfUrl(ids.doi, pre.version)]
            : [biorxivPdfUrl(ids.doi, pre.version)];
        const hit = await tryPdfUrls(urls, dest, {
          userAgent: ua,
          signal: s,
          timeoutMs,
          referer: `https://www.${pre.server}.org/content/${ids.doi}`,
          errors,
          label: pre.server,
        });
        return hit ? { hit, server: pre.server } : null;
      },
      errors,
      emit,
    );
    if (r.ok && r.value) {
      emit({ stage: "done", source: r.value.server });
      return record(r.value.server, r.value.hit.url, r.value.hit.sizeBytes);
    }
  }

  // --- 7. PubMed Central ---
  if (ids.pmcid && oaEnabled && wants("pmc")) {
    const r = await runRoute(
      "PMC",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.pmc),
      async (s) => {
        const urls = await pmcFullTextUrls(ids.pmcid, { userAgent: ua, signal: s, email: config.email });
        return tryPdfUrls(urls, dest, {
          userAgent: ua,
          signal: s,
          timeoutMs,
          referer: `https://pmc.ncbi.nlm.nih.gov/articles/${ids.pmcid}/`,
          errors,
          label: "PMC",
        });
      },
      errors,
      emit,
    );
    if (r.ok && r.value) {
      emit({ stage: "done", source: "pmc" });
      return record(`PMC (${ids.pmcid})`, r.value.url, r.value.sizeBytes);
    }
  }

  // --- 8. Europe PMC ---
  if (ids.pmcid && oaEnabled && wants("europepmc")) {
    const r = await runRoute(
      "Europe PMC",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.europepmc),
      async (s) => {
        const urls = await europePmcPdfUrls(ids.pmcid, { userAgent: ua, signal: s, email: config.email });
        const direct = (ids.ftUrls ?? [])
          .filter((u) => u.style === "pdf" && u.availabilityCode === "OA")
          .map((u) => u.url);
        return tryPdfUrls([...direct, ...urls], dest, {
          userAgent: ua,
          signal: s,
          timeoutMs,
          errors,
          label: "Europe PMC",
        });
      },
      errors,
      emit,
    );
    if (r.ok && r.value) {
      emit({ stage: "done", source: "europepmc" });
      return record(`Europe PMC (${ids.pmcid})`, r.value.url, r.value.sizeBytes);
    }
  }

  // --- 9. Unpaywall ---
  if (ids.doi && oaEnabled && wants("unpaywall")) {
    const r = await runRoute(
      "Unpaywall",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.unpaywall),
      async (s) => {
        const up = await unpaywallPdfUrls(ids.doi, { userAgent: ua, signal: s, email: config.email });
        ids.isOpenAccess ??= up.isOa;
        if (!up.pdfUrls.length) throw new Error(`no open-access PDF for ${ids.doi}`);
        const hit = await tryPdfUrls(up.pdfUrls, dest, {
          userAgent: ua,
          signal: s,
          timeoutMs,
          errors,
          label: "Unpaywall",
        });
        return hit ? { hit, status: up.oaStatus || "oa" } : null;
      },
      errors,
      emit,
    );
    if (r.ok && r.value) {
      emit({ stage: "done", source: "unpaywall" });
      return record(`Unpaywall (${r.value.status})`, r.value.hit.url, r.value.hit.sizeBytes);
    }
  }

  // --- 10. OpenAlex OA locations ---
  if (oaEnabled && wants("openalex") && (ids.oaPdfUrls?.length || ids.doi)) {
    const r = await runRoute(
      "OpenAlex",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.openalex),
      async (s) => {
        let urls = ids.oaPdfUrls ?? [];
        if (!urls.length && ids.doi) {
          const w = await openalexByDoi(ids.doi, { userAgent: ua, signal: s, email: config.email });
          urls = w?.oaPdfUrls ?? [];
        }
        if (!urls.length) throw new Error("no open-access PDF location");
        return tryPdfUrls(urls, dest, { userAgent: ua, signal: s, timeoutMs, errors, label: "OpenAlex" });
      },
      errors,
      emit,
    );
    if (r.ok && r.value) {
      emit({ stage: "done", source: "openalex" });
      return record("OpenAlex OA location", r.value.url, r.value.sizeBytes);
    }
  }

  // --- 11. Semantic Scholar OA pdf ---
  if (ids.doi && oaEnabled && wants("semanticscholar")) {
    const r = await runRoute(
      "Semantic Scholar",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.semanticscholar),
      async (s) => {
        const p = await semanticScholarPaper(`DOI:${ids.doi}`, { userAgent: ua, signal: s, email: config.email });
        const urls = p?.oaPdfUrls ?? [];
        if (!urls.length) return null;
        return tryPdfUrls(urls, dest, { userAgent: ua, signal: s, timeoutMs, errors, label: "Semantic Scholar" });
      },
      errors,
      emit,
    );
    if (r.ok && r.value) {
      emit({ stage: "done", source: "semanticscholar" });
      return record("Semantic Scholar OA", r.value.url, r.value.sizeBytes);
    }
  }

  // --- 12. Publisher landing page (citation_pdf_url) ---
  const publisherUrl = args.url && /^https?:\/\//i.test(args.url) && !/arxiv\.org/i.test(args.url) ? args.url : null;
  if (publisherUrl && oaEnabled && wants("publisher")) {
    const r = await runRoute(
      "publisher",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.publisher),
      (s) => publisherRoute(publisherUrl, dest, { userAgent: ua, signal: s, timeoutMs, errors }),
      errors,
      emit,
    );
    if (r.ok && r.value) {
      emit({ stage: "done", source: "publisher" });
      return record("publisher (citation_pdf_url)", r.value.url, r.value.sizeBytes);
    }
  }

  // --- 12b. Sci-Hub mirrors (only when not already tried first) ---
  if (!sciHubFirst && !sciHubExhausted) {
    const hit = await runSciHub();
    if (hit) return hit;
  }

  // --- 13. arXiv HTML (ar5iv) \u2014 the last resort, and only HTML ------------
  // Deliberately LAST: it yields HTML, not a PDF, so every route that can
  // produce a real PDF is tried first.
  if (ids.arxivId && wants("ar5iv") && (config.allowHtmlFallback ?? true)) {
    const r = await runRoute(
      "ar5iv",
      signal,
      routeBudget(timeoutMs * ROUTE_BUDGET.ar5iv),
      async (s) => {
        // No separate reachability pre-check: the `fetch` below is the
        // reachability test, and a non-2xx answer is reported through `res.ok`.
        // The guard that used to stand here called an undefined helper, so it
        // threw a ReferenceError and this last-resort route never ran.
        const res = await fetch(ar5ivUrl(ids.arxivId), {
          headers: { "User-Agent": ua, Accept: "text/html" },
          signal: s,
          redirect: "follow",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        markHostSuccess(ar5ivUrl(ids.arxivId));
        return body;
      },
      errors,
      emit,
    );
    if (r.ok && r.value) {
      const htmlDest = dest.replace(/\.pdf$/i, "") + ".html";
      await mkdir(dirname(htmlDest), { recursive: true });
      await writeFile(htmlDest, r.value);
      emit({ stage: "done", source: "ar5iv-html" });
      const rec = record("ar5iv-html", ar5ivUrl(ids.arxivId), r.value.length);
      rec.filePath = htmlDest;
      return rec;
    }
  }

  const err = new Error(
    `Could not obtain the full text of ${ids.title || ids.doi || ids.pmcid || ids.arxivId}.\n` +
      `Routes tried in order (legal open access first, then Sci-Hub, then arXiv HTML):\n` +
      `${errors.map((e) => `  - ${e}`).join("\n")}` +
      (outOfBudget() ? `\n\nNote: the overall fetch budget (${maxTotalMs}ms) was exhausted, so some routes were skipped.` : ""),
  );
  err.errors = errors;
  err.ids = publicIds(ids);
  throw err;
}

function publicIds(ids) {
  return {
    doi: ids.doi || null,
    pmid: ids.pmid || null,
    pmcid: ids.pmcid || null,
    arxivId: ids.arxivId || null,
    title: ids.title || null,
    year: ids.year ?? null,
    journal: ids.journal || null,
    authors: ids.authors ?? [],
    isOpenAccess: ids.isOpenAccess ?? null,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Serialise PDF downloads for the diagnostics probe.
 *
 * The probe checks every mirror concurrently, but nine of them share the
 * sci.bban.top backend — ten simultaneous PDF requests make it answer HTTP 429
 * and the probe then reports a rate limit it caused itself. Article-page
 * requests stay parallel (different hosts, cheap); only the downloads queue.
 */
let pdfQueueTail = Promise.resolve();
function pdfDownloadQueue(fn) {
  const run = pdfQueueTail.then(fn, fn);
  pdfQueueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Probe every configured mirror (plus optionally the known-dead lists) for one
 * DOI, returning latency and the reason a mirror failed.
 *
 * With `verify: true` (the default) each mirror's advertised PDF is actually
 * downloaded and checked against the DOI, because "the mirror offered a PDF
 * link" and "the mirror can give me this paper" are different claims — the
 * former is true even for a nonexistent DOI on some mirrors.
 */
export async function probeMirrors(doi, config, signal, { includeKnownDead = false, limit, verify = true } = {}) {
  const list = [...(config.mirrors ?? DEFAULT_MIRRORS)];
  if (includeKnownDead) {
    for (const m of [...KNOWN_DEAD_MIRRORS, ...ON_SITE_DEAD_MIRRORS]) if (!list.includes(m)) list.push(m);
  }
  const targets = limit ? list.slice(0, limit) : list;
  const timeoutMs = config.probeTimeoutMs ?? 20000;

  const results = await Promise.all(
    targets.map(async (mirror) => {
      const started = Date.now();
      try {
        const art = await mirrorArticle(mirror, doi, {
          userAgent: config.userAgent ?? DEFAULT_UA,
          signal,
          timeoutMs,
        });
        if (!art.pdfUrl) {
          return {
            mirror,
            ms: Date.now() - started,
            ok: false,
            status: art.notFound
              ? "article not in Sci-Hub"
              : art.aggregator
                ? "search-proxy page"
                : art.blocked
                  ? "bot challenge / parked page (intermittent)"
                  : "no pdf link",
            pdfUrl: null,
            pageUrl: art.finalUrl || art.pageUrl,
            verified: false,
          };
        }

        const base = {
          mirror,
          ms: Date.now() - started,
          pdfUrl: art.pdfUrl,
          pageUrl: art.finalUrl || art.pageUrl,
          backend: (() => {
            try {
              return new URL(art.pdfUrl).hostname;
            } catch {
              return "?";
            }
          })(),
          selfReferential: isSelfReferentialPdfLink(art.pdfUrl, art.finalUrl || art.pageUrl),
        };

        if (base.selfReferential) {
          return { ...base, ok: false, status: "pdf link points back at the article page", verified: false };
        }
        if (!verify) return { ...base, ok: true, status: "article + pdf link", verified: false };

        // Download it: the link existing is not proof the file is right.
        //
        // Downloads are SERIALISED across mirrors. Nine of them share the
        // sci.bban.top backend, and firing ten PDF requests at it at once earns
        // HTTP 429 — the probe would then report a rate limit it caused itself.
        try {
          const { buffer } = await pdfDownloadQueue(async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                return await downloadPdfBuffer(art.pdfUrl, {
                  userAgent: config.userAgent ?? DEFAULT_UA,
                  referer: art.finalUrl || art.pageUrl,
                  signal,
                  timeoutMs: Math.max(timeoutMs, 30000),
                  retries: 0,
                });
              } catch (err) {
                if (!isRateLimitError(err) || attempt === 2) throw err;
                await delay(retryAfterMs(err) ?? 1500 * (attempt + 1), signal);
              }
            }
            throw new Error("unreachable");
          });
          const check = verifyPdfContent(buffer, { doi });
          const sizeKb = Math.round(buffer.length / 1024);
          if (check.verdict === "mismatch") {
            return { ...base, ok: false, verified: false, bytes: buffer.length, status: `PDF is a different paper (${sizeKb} KB, ${check.detail})` };
          }
          return {
            ...base,
            ok: true,
            verified: check.verdict === "match",
            bytes: buffer.length,
            status: `${check.verdict === "match" ? "verified PDF" : "PDF (unverified)"} ${sizeKb} KB — ${check.detail}`,
          };
        } catch (err) {
          return { ...base, ok: false, verified: false, status: `pdf download failed: ${err.message.slice(0, 60)}` };
        }
      } catch (err) {
        return {
          mirror,
          ms: Date.now() - started,
          ok: false,
          status: `unreachable: ${err.message}`,
          pdfUrl: null,
          verified: false,
        };
      }
    }),
  );
  return results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms);
}

/** Cheap reachability probe for the metadata / OA channel APIs. */
export async function probeChannels(config, signal) {
  const ua = config.userAgent ?? DEFAULT_UA;
  const opts = { userAgent: ua, email: config.email, signal, timeoutMs: config.probeTimeoutMs ?? 15000 };
  const doi = config.probeDoi ?? "10.1038/nature12373";
  const checks = [
    ["Crossref", () => crossrefWork(doi, opts).then((r) => r && `"${r.title.slice(0, 44)}"`)],
    ["OpenAlex", () => openalexByDoi(doi, opts).then((r) => r && `oa=${r.isOpenAccess} pdfs=${r.oaPdfUrls.length}`)],
    ["Europe PMC", () => europePmcByDoi(doi, opts).then((r) => r && `pmcid=${r.pmcid} pmid=${r.pmid}`)],
    ["Unpaywall", () => unpaywallPdfUrls(doi, opts).then((r) => `is_oa=${r.isOa} pdfs=${r.pdfUrls.length}`)],
    [
      "PubMed",
      () =>
        pmidsForDoi(doi, opts).then(async (pmids) =>
          pmids.length ? `pmid=${pmids[0]} pmcid=${(await pmcidForPmid(pmids[0], opts)) || "-"}` : "no PMID",
        ),
    ],
    ["Semantic Scholar", () => semanticScholarPaper(`DOI:${doi}`, opts).then((r) => r && `arxiv=${r.arxivId || "-"} oa=${r.isOpenAccess}`)],
    ["PMC full text", () => pmcFullTextUrls("PMC4221854", opts).then((u) => `${u.length} candidate URL(s)`)],
    ["arXiv API", () => arxivApi('all:"electron"', { ...opts, rows: 1 }).then((r) => `${r.length} entry`)],
    ["bioRxiv API", () => preprintServerFor("10.1101/2020.02.07.20021154", opts).then((r) => (r ? `server=${r.server}` : "no record"))],
    ["DOAJ", () => doajSearch('doi:"10.1371/journal.pone.0172611"', opts).then((r) => `${r.length} record(s)`)],
  ];
  const out = [];
  for (const [label, run] of checks) {
    const started = Date.now();
    try {
      // A channel that neither answers nor rejects must not hang the probe.
      const detail = await Promise.race([
        run(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("probe timed out")), (opts.timeoutMs ?? 15000) + 5000),
        ),
      ]);
      out.push({ channel: label, ok: true, ms: Date.now() - started, detail: String(detail ?? "ok") });
    } catch (err) {
      out.push({ channel: label, ok: false, ms: Date.now() - started, detail: err.message });
    }
  }
  return out;
}
