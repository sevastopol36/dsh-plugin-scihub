/**
 * Literature metadata providers + open-access full-text locators.
 *
 * Every provider is a plain async function so it can be probed, unit-tested and
 * composed without any plugin context. Nothing here throws for "no result" —
 * "not found" is a value, not an error; only real transport failures throw.
 */
import {
  CONTACT_EMAIL,
  DEFAULT_UA,
  decodeXml,
  extractArxivId,
  fetchHtmlSmart,
  fetchJson,
  fetchText,
  stripTags,
} from "./util.mjs";

const JSON_HEADERS = { "User-Agent": DEFAULT_UA, Accept: "application/json" };
const XML_HEADERS = { "User-Agent": DEFAULT_UA, Accept: "application/xml,text/xml,*/*" };

/** NCBI asks for `tool` + `email` on E-utilities calls to stay in the polite pool. */
const NCBI_TOOL = "dsh-literature-plugin";

/**
 * Rate limiting.
 *
 * NCBI allows 3 E-utilities requests/second without a key and 10 with one; a
 * burst of searches otherwise earns HTTP 429 and the plugin silently loses its
 * PubMed results. Requests are serialised through a minimum gap and an optional
 * API key is forwarded.
 */
const ncbiState = { lastCall: 0, queue: Promise.resolve() };

/** Minimum spacing between NCBI calls, based on whether a key is configured. */
function ncbiGapMs(apiKey) {
  // 3/s without a key, 10/s with one, with headroom.
  return apiKey ? 120 : 360;
}

/** Serialise an NCBI call so a burst cannot exceed the allowed rate. */
async function ncbiThrottle(apiKey, fn) {
  const run = ncbiState.queue.then(async () => {
    const gap = ncbiGapMs(apiKey);
    const wait = ncbiState.lastCall + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    ncbiState.lastCall = Date.now();
    return fn();
  });
  // Keep the chain alive even if this call rejects.
  ncbiState.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function ncbiUrl(path, params, email, apiKey) {
  const url = new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  url.searchParams.set("tool", NCBI_TOOL);
  url.searchParams.set("email", email || CONTACT_EMAIL);
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url;
}

// ---------------------------------------------------------------------------
// Normalised record
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PaperRecord
 * @property {string} title
 * @property {string[]} authors
 * @property {number|null} year
 * @property {string} journal
 * @property {string} doi
 * @property {string} pmid
 * @property {string} pmcid
 * @property {string} arxivId
 * @property {number} citations
 * @property {boolean|null} isOpenAccess
 * @property {string} type
 * @property {string[]} sources        which providers returned this record
 */

/**
 * De-duplicating accumulator for multi-source search results. Records that
 * share any identifier (DOI / PMID / PMCID / arXiv id / normalised title) are
 * merged into one, so a paper found by four providers appears once.
 */
export class PaperStore {
  constructor() {
    this.#records = [];
    this.#index = new Map();
  }

  #records;
  #index;

  static #keys(rec) {
    return [
      rec.doi && `doi:${String(rec.doi).toLowerCase()}`,
      rec.pmid && `pmid:${rec.pmid}`,
      rec.pmcid && `pmcid:${String(rec.pmcid).toUpperCase()}`,
      rec.arxivId && `arxiv:${String(rec.arxivId).replace(/v\d+$/, "")}`,
      rec.title && `t:${String(rec.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`,
    ].filter(Boolean);
  }

  /** Merge one record; returns the (possibly pre-existing) merged record. */
  add(rec) {
    if (!rec) return null;
    const keys = PaperStore.#keys(rec);
    let target = null;
    for (const k of keys) {
      const hit = this.#index.get(k);
      if (hit) {
        target = hit;
        break;
      }
    }
    if (!target) {
      target = {
        title: "",
        authors: [],
        year: null,
        journal: "",
        doi: "",
        pmid: "",
        pmcid: "",
        arxivId: "",
        citations: 0,
        isOpenAccess: null,
        type: "",
        abstract: "",
        sources: [],
        oaPdfUrls: [],
        ftUrls: [],
      };
      this.#records.push(target);
    }

    for (const field of ["title", "journal", "doi", "pmid", "pmcid", "arxivId", "type"]) {
      if (!target[field] && rec[field]) target[field] = rec[field];
    }
    // Prefer the longest title: publishers truncate, Crossref rarely does.
    if (rec.title && rec.title.length > (target.title?.length ?? 0)) target.title = rec.title;
    if (!target.abstract && rec.abstract) target.abstract = rec.abstract;
    if (!target.year && rec.year) target.year = rec.year;
    if (!target.authors?.length && rec.authors?.length) target.authors = rec.authors;
    if ((rec.citations ?? 0) > (target.citations ?? 0)) target.citations = rec.citations;
    if (rec.isOpenAccess !== null && rec.isOpenAccess !== undefined) {
      target.isOpenAccess = target.isOpenAccess === true ? true : rec.isOpenAccess;
    }
    if (rec.oaPdfUrls?.length) target.oaPdfUrls = [...new Set([...target.oaPdfUrls, ...rec.oaPdfUrls])];
    if (rec.ftUrls?.length) target.ftUrls = [...target.ftUrls, ...rec.ftUrls];
    if (rec.source && !target.sources.includes(rec.source)) target.sources.push(rec.source);
    for (const k of PaperStore.#keys(target)) if (!this.#index.has(k)) this.#index.set(k, target);
    return target;
  }

  addAll(records) {
    for (const r of records ?? []) this.add(r);
    return this;
  }

  get size() {
    return this.#records.length;
  }

  toArray() {
    return [...this.#records];
  }
}

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------

function mapCrossref(w) {
  const year =
    w.issued?.["date-parts"]?.[0]?.[0] ??
    w.published?.["date-parts"]?.[0]?.[0] ??
    w["published-print"]?.["date-parts"]?.[0]?.[0] ??
    null;
  return {
    title: (Array.isArray(w.title) ? w.title[0] : w.title) ?? "(no title)",
    authors: (w.author ?? [])
      .map((a) => (a.name ? a.name : [a.given, a.family].filter(Boolean).join(" ")))
      .filter(Boolean),
    year,
    journal: w["container-title"]?.[0] ?? "",
    doi: w.DOI ?? "",
    pmid: "",
    pmcid: "",
    arxivId: /^10\.48550\/arxiv\./i.test(w.DOI ?? "") ? (w.DOI.match(/arxiv\.(.+)$/i)?.[1] ?? "") : "",
    citations: w["is-referenced-by-count"] ?? 0,
    isOpenAccess: null,
    type: w.type ?? "",
    abstract: stripTags(w.abstract ?? "").slice(0, 2000),
    source: "crossref",
  };
}

/** Exact DOI -> metadata (canonical, not fuzzy). Returns null on 404. */
export async function crossrefWork(doi, { signal, userAgent = DEFAULT_UA, timeoutMs = 20000, retries = 1 } = {}) {
  const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  url.searchParams.set("mailto", CONTACT_EMAIL);
  try {
    const data = await fetchJson(url, {
      headers: { "User-Agent": userAgent },
      signal,
      timeoutMs,
      retries,
    });
    return data?.message ? mapCrossref(data.message) : null;
  } catch (err) {
    if (err.status === 404 || /HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

export async function crossrefSearch(query, { rows = 10, field = "bibliographic", signal, userAgent = DEFAULT_UA, timeoutMs = 20000, retries = 1, yearFrom, yearTo } = {}) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set(field === "title" ? "query.title" : "query.bibliographic", query);
  url.searchParams.set("rows", String(Math.min(Math.max(rows, 1), 50)));
  url.searchParams.set(
    "select",
    "DOI,title,author,container-title,issued,published,is-referenced-by-count,type,abstract",
  );
  url.searchParams.set("mailto", CONTACT_EMAIL);
  const filters = [];
  if (yearFrom) filters.push(`from-pub-date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`until-pub-date:${yearTo}-12-31`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  const data = await fetchJson(url, {
    headers: { "User-Agent": userAgent },
    signal,
    timeoutMs,
    retries: 1,
  });
  return (data?.message?.items ?? []).map(mapCrossref);
}

// ---------------------------------------------------------------------------
// OpenAlex  (metadata + OA locations + arXiv/PMID/PMCID cross-ids)
// ---------------------------------------------------------------------------

/**
 * Recover an arXiv id from an OpenAlex work.
 *
 * `ids.arxiv` is frequently absent even when the work clearly has an arXiv
 * version (verified: "Attention Is All You Need" has arXiv PDF locations but no
 * `ids.arxiv`). The OA locations carry the evidence, so mine them as a fallback.
 */
function arxivIdFromOpenAlex(w) {
  const direct = extractArxivId(w.doi ?? "");
  if (direct) return direct;
  for (const loc of w.locations ?? []) {
    for (const candidate of [loc.landing_page_url, loc.pdf_url]) {
      const id = extractArxivId(candidate ?? "");
      if (id) return id;
    }
  }
  const ids = w.ids ?? {};
  return extractArxivId(ids.arxiv ?? "") ?? "";
}

/**
 * Prefer the canonical arXiv DOI when OpenAlex attached a junk DOI to an arXiv
 * work. OpenAlex sometimes points a well-known preprint at a mirrored copy on
 * an unrelated "publisher" instead of 10.48550/arXiv.<id>.
 */
function canonicalDoi(doi, arxivId) {
  const clean = String(doi ?? "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (!clean) return arxivId ? `10.48550/arXiv.${arxivId}` : "";
  if (arxivId && !/^10\.48550\//i.test(clean) && isSuspectArxivDoi(clean)) {
    return `10.48550/arXiv.${arxivId}`;
  }
  return clean;
}

/**
 * A DOI whose only arXiv evidence is a mirror, not the canonical arXiv DOI, and
 * which uses a prefix known to host mirrored copies. Kept deliberately narrow:
 * a legitimately published arXiv paper must keep its publisher DOI.
 */
function isSuspectArxivDoi(doi) {
  return /^10\.65215\//i.test(doi);
}

function mapOpenAlex(w) {
  const authors = (w.authorships ?? [])
    .map((a) => a.author?.display_name)
    .filter(Boolean);
  const ids = w.ids ?? {};
  // OpenAlex returns bare identifiers for `ids` on the list endpoint but full
  // URLs on the single-work endpoint (e.g. "https://pubmed.ncbi.nlm.nih.gov/23903748"),
  // so match on the trailing identifier rather than on an exact shape.
  const pmid = String(ids.pmid ?? "").match(/(\d+)\s*$/)?.[1] ?? "";
  const pmcidRaw = String(ids.pmcid ?? "").match(/(PMC\d+)\s*$/i)?.[1] ?? "";
  const arxivId = arxivIdFromOpenAlex(w);
  const oa = w.best_oa_location ?? w.primary_location ?? null;
  return {
    title: w.title ?? w.display_name ?? "(no title)",
    authors,
    year: w.publication_year ?? null,
    journal: w.primary_location?.source?.display_name ?? "",
    doi: canonicalDoi(w.doi, arxivId),
    pmid,
    pmcid: pmcidRaw ? pmcidRaw.toUpperCase() : "",
    arxivId,
    citations: w.cited_by_count ?? 0,
    isOpenAccess: w.open_access?.is_oa ?? null,
    type: w.type ?? "",
    abstract: w.abstract_inverted_index ? rebuildAbstract(w.abstract_inverted_index) : "",
    source: "openalex",
    oaPdfUrls: collectOpenAlexPdfs(w),
    oaUrl: oa?.landing_page_url ?? "",
  };
}

/** OpenAlex stores abstracts as an inverted index; rebuild the text. */
function rebuildAbstract(inverted) {
  const slots = [];
  for (const [word, positions] of Object.entries(inverted ?? {})) {
    for (const p of positions ?? []) slots[p] = word;
  }
  return slots.filter(Boolean).join(" ").slice(0, 2000);
}

function collectOpenAlexPdfs(w) {
  const out = [];
  const push = (loc) => {
    if (!loc) return;
    if (loc.pdf_url) out.push(loc.pdf_url);
    else if (loc.is_oa && /\.pdf($|\?)/i.test(loc.landing_page_url ?? "")) out.push(loc.landing_page_url);
  };
  push(w.best_oa_location);
  for (const l of w.locations ?? []) if (l.is_oa) push(l);
  return [...new Set(out)];
}

export async function openalexByDoi(doi, opts = {}) {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
  try {
    const w = await fetchJson(url, {
      headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 20000,
      retries: opts.retries ?? 1,
    });
    return w?.id ? mapOpenAlex(w) : null;
  } catch (err) {
    if (err.status === 404 || /HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

export async function openalexByPmid(pmid, opts = {}) {
  const url = `https://api.openalex.org/works/pmid:${encodeURIComponent(pmid)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
  try {
    const w = await fetchJson(url, {
      headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 20000,
      retries: opts.retries ?? 1,
    });
    return w?.id ? mapOpenAlex(w) : null;
  } catch (err) {
    if (err.status === 404 || /HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

export async function openalexSearch(query, { rows = 10, signal, userAgent = DEFAULT_UA, timeoutMs = 20000, yearFrom, yearTo } = {}) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(Math.min(Math.max(rows, 1), 50)));
  url.searchParams.set("mailto", CONTACT_EMAIL);
  const filters = [];
  if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  const data = await fetchJson(url, {
    headers: { "User-Agent": userAgent },
    signal,
    timeoutMs,
    retries: 1,
  });
  return (data?.results ?? []).map(mapOpenAlex);
}

// ---------------------------------------------------------------------------
// PubMed / PMC  (NCBI E-utilities)
// ---------------------------------------------------------------------------

function parsePubmedArticle(xml) {
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    return m ? stripTags(decodeXml(m[1])) : "";
  };
  const authors = [];
  for (const m of xml.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/gi)) {
    const block = m[1];
    const last = block.match(/<LastName>([\s\S]*?)<\/LastName>/i)?.[1] ?? "";
    const fore = block.match(/<ForeName>([\s\S]*?)<\/ForeName>/i)?.[1] ?? "";
    const collective = block.match(/<CollectiveName>([\s\S]*?)<\/CollectiveName>/i)?.[1] ?? "";
    const who = collective ? stripTags(decodeXml(collective)) : `${stripTags(decodeXml(fore))} ${stripTags(decodeXml(last))}`.trim();
    if (who) authors.push(who);
  }
  const doi =
    xml.match(/<ArticleId\s+IdType=["']doi["'][^>]*>([\s\S]*?)<\/ArticleId>/i)?.[1] ??
    xml.match(/<ELocationID\s+EIdType=["']doi["'][^>]*>([\s\S]*?)<\/ELocationID>/i)?.[1] ??
    "";
  const pmid = pick("PMID");
  const pmcid = (xml.match(/<ArticleId\s+IdType=["']pmc["'][^>]*>([\s\S]*?)<\/ArticleId>/i)?.[1] ?? "").toUpperCase();
  const year =
    Number(xml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/i)?.[1] ?? xml.match(/<Year>(\d{4})<\/Year>/i)?.[1] ?? 0) || null;
  const abstract = [...xml.matchAll(/<AbstractText\b[^>]*>([\s\S]*?)<\/AbstractText>/gi)]
    .map((m) => stripTags(decodeXml(m[1])))
    .join(" ")
    .slice(0, 2000);
  return {
    title: pick("ArticleTitle") || "(no title)",
    authors,
    year,
    journal: pick("Title") || pick("ISOAbbreviation"),
    doi,
    pmid,
    pmcid,
    arxivId: "",
    citations: 0,
    isOpenAccess: null,
    type: "journal-article",
    abstract,
    source: "pubmed",
  };
}

export async function pubmedFetch(ids, { signal, userAgent = DEFAULT_UA, timeoutMs = 25000, email, apiKey } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return [];
  const url = ncbiUrl("efetch.fcgi", { db: "pubmed", id: list.join(","), retmode: "xml" }, email, apiKey);
  const text = await ncbiThrottle(apiKey, () =>
    fetchText(url, { headers: XML_HEADERS, signal, timeoutMs, retries: 1 }),
  );
  const out = [];
  for (const m of text.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/gi)) out.push(parsePubmedArticle(m[1]));
  return out;
}

/**
 * PubMed search via E-utilities. Accepts a free-text query or a raw
 * `term` string (callers can pass e.g. `10.1038/nature12373[DOI]`).
 */
export async function pubmedSearch(term, { rows = 10, signal, userAgent = DEFAULT_UA, timeoutMs = 25000, email, sort, apiKey } = {}) {
  const esearch = ncbiUrl(
    "esearch.fcgi",
    { db: "pubmed", term, retmode: "json", retmax: Math.min(Math.max(rows, 1), 50), sort },
    email,
    apiKey,
  );
  const found = await ncbiThrottle(apiKey, () =>
    fetchJson(esearch, { headers: { "User-Agent": userAgent }, signal, timeoutMs, retries: 1 }),
  );
  const ids = found?.esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  return pubmedFetch(ids, { signal, userAgent, timeoutMs, email, apiKey });
}

/** DOI -> PMID via a precise `[DOI]` field query. */
export async function pmidsForDoi(doi, opts = {}) {
  const url = ncbiUrl("esearch.fcgi", { db: "pubmed", term: `${doi}[DOI]`, retmode: "json", retmax: 5 }, opts.email, opts.apiKey);
  const d = await ncbiThrottle(opts.apiKey, () =>
    fetchJson(url, {
      headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 20000,
      retries: opts.retries ?? 1,
    }),
  );
  return d?.esearchresult?.idlist ?? [];
}

/** OpenAlex `ids` values are sometimes bare ids and sometimes full URLs. */
export function barePmid(value) {
  return String(value ?? "").match(/(\d{5,9})\s*$/)?.[1] ?? "";
}

/** OpenAlex `ids.pmcid` may be `PMC4221854` or a URL ending in `/PMC4221854/`. */
export function barePmcid(value) {
  const m = String(value ?? "").match(/(PMC\d{5,9})(?!\d)/i);
  return m ? m[1].toUpperCase() : "";
}

/**
 * NCBI's PMC ID Converter: the authoritative, key-free way to translate
 * between DOI / PMID / PMCID.
 *
 * Verified live: accepts a single id per call (a comma-separated list returns
 * HTTP 400) and reports unknown ids as `{err: "Identifier not found in PMC"}`
 * with HTTP 200, so the caller must inspect the records, not just the status.
 *
 * @param {string} id  a DOI, PMID or PMCID
 * @returns {Promise<{pmid: string, pmcid: string, doi: string}|null>}
 */
export async function convertId(id, opts = {}) {
  const value = String(id ?? "").trim();
  if (!value) return null;
  const url = new URL("https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/");
  url.searchParams.set("ids", value);
  url.searchParams.set("format", "json");
  url.searchParams.set("tool", NCBI_TOOL);
  url.searchParams.set("email", opts.email || CONTACT_EMAIL);
  try {
    const d = await fetchJson(url, {
      headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 20000,
      retries: opts.retries ?? 1,
    });
    const rec = d?.records?.[0];
    if (!rec || rec.err) return null;
    return {
      pmid: String(rec.pmid ?? ""),
      pmcid: String(rec.pmcid ?? "").toUpperCase(),
      doi: String(rec.doi ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * PMCID -> a full bibliographic record.
 *
 * Order is deliberate and was chosen from measurements: the NCBI ID converter
 * answers in ~0.7-2.5 s and Crossref in ~0.5 s, while Europe PMC intermittently
 * takes >20 s or returns 503 (verified live). Europe PMC therefore runs LAST, as
 * best-effort enrichment, so a slow Europe PMC can never delay or fail the
 * identifiers the caller actually needs.
 *
 * @param {object} [opts]
 * @param {number} [opts.enrichTimeoutMs] budget for the optional Europe PMC step
 * @param {{pmid?:string,pmcid?:string,doi?:string}|null} [opts.converted]
 *        An identifier set the caller ALREADY resolved. Supplying it (including
 *        `null` for "tried and found nothing") skips a duplicate `convertId`
 *        round-trip — measured at 2.4 s per call.
 * @param {object|null} [opts.europePmcRecord]
 *        A Europe PMC record the caller already fetched, reused instead of
 *        re-querying. Measured at 1.5-3 s per call.
 */
export async function lookupByPmcid(pmcid, opts = {}) {
  const id = String(pmcid).toUpperCase();
  const converted = opts.converted !== undefined ? opts.converted : await convertId(id, opts);

  const base = {
    title: "",
    authors: [],
    year: null,
    journal: "",
    doi: converted?.doi ?? "",
    pmid: converted?.pmid ?? "",
    pmcid: converted?.pmcid || id,
    arxivId: "",
    citations: 0,
    isOpenAccess: null,
    type: "journal-article",
    abstract: "",
    source: "idconv",
  };

  // Crossref is fast and authoritative for a known DOI, so the title comes first.
  let record = base;
  if (base.doi) {
    try {
      const w = await crossrefWork(base.doi, { ...opts, retries: 0 });
      if (w) record = { ...w, pmid: base.pmid, pmcid: base.pmcid, source: "crossref+idconv" };
    } catch {
      /* metadata is optional */
    }
  }

  // Europe PMC is the richest source for PMC records but only worth a short
  // wait; on timeout the already-good record above is returned unchanged.
  // A record the caller already fetched is reused rather than re-queried.
  const enrichMs = opts.enrichTimeoutMs ?? 6000;
  try {
    const rec =
      opts.europePmcRecord !== undefined
        ? opts.europePmcRecord
        : await europePmcByPmcid(id, { ...opts, retries: 0, timeoutMs: enrichMs });
    if (rec) {
      return {
        ...record,
        ...rec,
        // Keep identifiers we already resolved if Europe PMC omits them.
        doi: rec.doi || record.doi,
        pmid: rec.pmid || record.pmid,
        pmcid: rec.pmcid || record.pmcid,
        title: rec.title || record.title,
        source: record.source?.includes("crossref") ? "europepmc+crossref" : "europepmc",
      };
    }
  } catch {
    /* Europe PMC is optional and intermittently slow or 503 */
  }

  return converted || record.title ? record : null;
}

/**
 * PMID -> PMCID via elink (pubmed_pmc link set), falling back to OpenAlex.
 */
export async function pmcidForPmid(pmid, opts = {}) {
  const url = ncbiUrl("elink.fcgi", { dbfrom: "pubmed", db: "pmc", id: pmid, retmode: "json" }, opts.email, opts.apiKey);
  try {
    const d = await ncbiThrottle(opts.apiKey, () =>
      fetchJson(url, {
        headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA },
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 20000,
        retries: opts.retries ?? 1,
      }),
    );
    for (const set of d?.linksets ?? []) {
      for (const db of set.linksetdbs ?? []) {
        if (db.linkname === "pubmed_pmc" && db.links?.length) return `PMC${db.links[0]}`;
      }
    }
  } catch {
    /* elink has no PMC counterpart for many records — try OpenAlex next */
  }
  try {
    const w = await openalexByPmid(pmid, opts);
    if (w?.pmcid) return w.pmcid;
  } catch {
    /* OpenAlex is best-effort */
  }
  return "";
}

/**
 * PMC full-text PDF candidates for a PMCID. The article page carries the
 * canonical `citation_pdf_url`; the OA service covers author manuscripts.
 */
export async function pmcFullTextUrls(pmcid, opts = {}) {
  const out = [];
  const id = String(pmcid).toUpperCase();
  try {
    const { text } = await fetchHtmlSmart(
      `https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(id)}/`,
      opts.userAgent ?? DEFAULT_UA,
      opts.signal,
      { timeoutMs: opts.timeoutMs ?? 25000 },
    );
    const m =
      text.match(/<meta[^>]*citation_pdf_url["'][^>]*content=["']([^"']+)["']/i) ||
      text.match(/<meta[^>]*content=["']([^"']+\.pdf[^"']*)["'][^>]*citation_pdf_url/i);
    if (m) out.push(m[1].replace(/&amp;/g, "&"));
  } catch {
    /* page route is best-effort */
  }
  // Deterministic fallback shape used by PMC for OA articles.
  out.push(`https://pmc.ncbi.nlm.nih.gov/articles/${id}/pdf/`);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Europe PMC  (metadata + PMCID/PMID cross-ids + OA full-text URLs)
// ---------------------------------------------------------------------------

const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";

function mapEuropePmc(r) {
  const year = Number(r.pubYear ?? 0) || null;
  const doi = r.doi ?? "";
  return {
    title: r.title ? stripTags(r.title) : "(no title)",
    authors: r.authorString ? r.authorString.split(/,\s*/).filter(Boolean) : [],
    year,
    journal: r.journalInfo?.journal?.title ?? r.bookOrReportDetails?.publisher ?? "",
    doi,
    pmid: r.pmid ?? "",
    pmcid: (r.pmcid ?? "").toUpperCase(),
    arxivId: extractArxivId(doi) ?? "",
    citations: Number(r.citedByCount ?? 0) || 0,
    isOpenAccess: r.isOpenAccess === "Y" ? true : r.isOpenAccess === "N" ? false : null,
    type: r.pubType ?? "",
    abstract: stripTags(r.abstractText ?? "").slice(0, 2000),
    source: "europepmc",
    ftUrls: (r.fullTextUrlList?.fullTextUrl ?? [])
      .filter((u) => u?.url)
      .map((u) => ({ url: u.url, style: u.documentStyle ?? "", availability: u.availability ?? "", code: u.availabilityCode ?? "" })),
  };
}

export async function europePmcSearch(query, { rows = 10, signal, userAgent = DEFAULT_UA, timeoutMs = 25000, retries = 1 } = {}) {
  const url = new URL(`${EPMC}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", String(Math.min(Math.max(rows, 1), 50)));
  const d = await fetchJson(url, {
    headers: { "User-Agent": userAgent },
    signal,
    timeoutMs,
    retries,
  });
  return (d?.resultList?.result ?? []).map(mapEuropePmc);
}

export async function europePmcByDoi(doi, opts = {}) {
  const hits = await europePmcSearch(`DOI:"${doi}"`, { rows: 1, ...opts });
  return hits[0] ?? null;
}

export async function europePmcByPmid(pmid, opts = {}) {
  const hits = await europePmcSearch(`EXT_ID:${pmid}`, { rows: 1, ...opts });
  return hits[0] ?? null;
}

/**
 * Europe PMC lookup by PMCID.
 *
 * NOTE: `PMCID:"PMC1234567"` (quoted) matches NOTHING — verified against the
 * live API. The unquoted form and the bare id both work.
 */
export async function europePmcByPmcid(pmcid, opts = {}) {
  const id = String(pmcid).toUpperCase();
  const hits = await europePmcSearch(`PMCID:${id}`, { rows: 1, ...opts });
  if (hits[0]) return hits[0];
  const fallback = await europePmcSearch(id, { rows: 1, ...opts });
  return fallback[0] ?? null;
}

/** Europe PMC full-text XML for an OA article (PMCID required). */
export async function europePmcFullTextXml(pmcid, opts = {}) {
  const url = `${EPMC}/${encodeURIComponent(String(pmcid).toUpperCase())}/fullTextXML`;
  try {
    return await fetchText(url, {
      headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA, Accept: "application/xml,text/xml,*/*" },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 25000,
      retries: 1,
    });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

export async function europePmcPdfUrls(pmcid, opts = {}) {
  const out = [];
  const id = String(pmcid).toUpperCase();
  try {
    const hits = await europePmcSearch(`PMCID:"${id}"`, { rows: 1, ...opts });
    for (const u of hits[0]?.ftUrls ?? []) if (u.style === "pdf" && u.url) out.push(u.url);
  } catch {
    /* best-effort */
  }
  out.push(...(await pmcFullTextUrls(id, opts)));
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Semantic Scholar  (good external-id graph + OA PDF links)
// ---------------------------------------------------------------------------

function mapS2(p) {
  return {
    title: p.title ?? "(no title)",
    authors: (p.authors ?? []).map((a) => a.name).filter(Boolean),
    year: p.year ?? null,
    journal: p.venue ?? p.journal?.name ?? "",
    doi: p.externalIds?.DOI ?? "",
    pmid: p.externalIds?.PubMed ?? "",
    pmcid: p.externalIds?.PubMedCentral ? `PMC${p.externalIds.PubMedCentral}` : "",
    arxivId: p.externalIds?.ArXiv ?? "",
    citations: p.citationCount ?? 0,
    isOpenAccess: typeof p.isOpenAccess === "boolean" ? p.isOpenAccess : null,
    type: p.publicationTypes?.[0] ?? "",
    abstract: (p.abstract ?? "").slice(0, 2000),
    source: "semanticscholar",
    oaPdfUrls: p.openAccessPdf?.url ? [p.openAccessPdf.url] : [],
  };
}

const S2_FIELDS = "title,authors,year,venue,journal,externalIds,citationCount,isOpenAccess,openAccessPdf,abstract,publicationTypes";

export async function semanticScholarSearch(query, { rows = 10, signal, userAgent = DEFAULT_UA, timeoutMs = 25000 } = {}) {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(Math.min(Math.max(rows, 1), 50)));
  url.searchParams.set("fields", S2_FIELDS);
  const d = await fetchJson(url, {
    headers: { "User-Agent": userAgent },
    signal,
    timeoutMs,
    retries: 1,
  });
  return (d?.data ?? []).map(mapS2);
}

export async function semanticScholarPaper(id, opts = {}) {
  const url = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}`);
  url.searchParams.set("fields", S2_FIELDS);
  try {
    const p = await fetchJson(url, {
      headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 25000,
      retries: opts.retries ?? 1,
    });
    return p?.paperId ? mapS2(p) : null;
  } catch (err) {
    if (err.status === 404 || /HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Unpaywall  (the canonical OA-location index)
// ---------------------------------------------------------------------------

export async function unpaywallPdfUrls(doi, opts = {}) {
  const email = opts.email || CONTACT_EMAIL;
  const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
  url.searchParams.set("email", email);
  let d;
  try {
    d = await fetchJson(url, {
      headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 20000,
      retries: 1,
    });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return { pdfUrls: [], isOa: false, best: null };
    throw err;
  }
  const pdfUrls = [];
  const push = (loc) => {
    if (loc?.url_for_pdf) pdfUrls.push(loc.url_for_pdf);
    else if (loc?.url && /\.pdf($|\?)/i.test(loc.url)) pdfUrls.push(loc.url);
  };
  push(d?.best_oa_location);
  for (const loc of d?.oa_locations ?? []) push(loc);
  return {
    pdfUrls: [...new Set(pdfUrls)],
    isOa: Boolean(d?.is_oa),
    best: d?.best_oa_location?.url_for_pdf ?? null,
    oaStatus: d?.oa_status ?? "",
    journal: d?.journal_name ?? "",
    publisher: d?.publisher ?? "",
  };
}

// ---------------------------------------------------------------------------
// arXiv  (API + proxy routes, because export.arxiv.org is unreachable here)
// ---------------------------------------------------------------------------

function parseArxivFeed(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const e = m[1];
    const pick = (tag) => {
      const mm = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return mm ? decodeXml(mm[1]).replace(/\s+/g, " ").trim() : "";
    };
    const idUrl = pick("id");
    const arxivId = idUrl.match(/abs\/([^/]+)$/)?.[1] ?? extractArxivId(idUrl) ?? "";
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)].map((a) => decodeXml(a[1]).trim());
    const doi = pick("arxiv:doi") || (e.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i)?.[1] ?? "");
    out.push({
      title: pick("title") || "(no title)",
      authors,
      year: Number(pick("published").slice(0, 4)) || null,
      journal: pick("arxiv:journal_ref"),
      doi: doi.trim(),
      pmid: "",
      pmcid: "",
      arxivId,
      citations: 0,
      isOpenAccess: true,
      type: "preprint",
      abstract: pick("summary").slice(0, 2000),
      source: "arxiv",
      categories: [...e.matchAll(/<category[^>]*term=["']([^"']+)["']/gi)].map((c) => c[1]),
    });
  }
  return out;
}

/** arXiv Atom API. Fails fast (export.arxiv.org is often blocked). */
export async function arxivApi(query, { rows = 10, signal, userAgent = DEFAULT_UA, timeoutMs = 20000, idList } = {}) {
  const url = new URL("https://export.arxiv.org/api/query");
  if (idList) url.searchParams.set("id_list", idList);
  else url.searchParams.set("search_query", query);
  url.searchParams.set("max_results", String(Math.min(Math.max(rows, 1), 50)));
  const xml = await fetchText(url, {
    headers: { "User-Agent": userAgent, Accept: "application/atom+xml,application/xml,text/xml,*/*" },
    signal,
    timeoutMs,
    retries: 0, // export.arxiv.org hangs rather than refuses; do not multiply the wait
  });
  return parseArxivFeed(xml);
}

export function arxivPdfUrl(arxivId) {
  return `https://arxiv.org/pdf/${String(arxivId).replace(/^arxiv[:\s]*/i, "")}`;
}

export function ar5ivUrl(arxivId) {
  return `https://ar5iv.labs.arxiv.org/html/${String(arxivId).replace(/^arxiv[:\s]*/i, "")}`;
}

/**
 * Resolve an arXiv id to a real record WITHOUT reaching arxiv.org.
 *
 * OpenAlex indexes the arXiv landing page exactly as
 * `http://arxiv.org/abs/<id>`, so an exact `locations.landing_page_url` filter
 * finds the record. (The `.search:` variant returns HTTP 400 — verified live.)
 * This matters because arxiv.org and export.arxiv.org are unreachable from
 * some networks, which would otherwise make an arXiv id useless.
 */
export async function openalexByArxivId(arxivId, opts = {}) {
  const id = String(arxivId).replace(/v\d+$/i, "");
  for (const scheme of ["http", "https"]) {
    const landing = `${scheme}://arxiv.org/abs/${id}`;
    const url =
      `https://api.openalex.org/works?filter=locations.landing_page_url:${encodeURIComponent(landing)}` +
      `&per-page=3&mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
    try {
      const d = await fetchJson(url, {
        headers: { "User-Agent": opts.userAgent ?? DEFAULT_UA },
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 20000,
        retries: opts.retries ?? 1,
      });
      const w = d?.results?.[0];
      if (w) {
        const rec = mapOpenAlex(w);
        rec.arxivId = rec.arxivId || id;
        rec.source = "openalex-arxiv";
        return rec;
      }
    } catch {
      /* try the other scheme, then give up */
    }
  }
  return null;
}

/**
 * Resolve an arXiv id using every route that does not need arxiv.org.
 * Returns a normalised record or null.
 *
 * Crossref is deliberately NOT used as a fallback: arXiv does not deposit
 * per-paper DOIs with Crossref, and `query.bibliographic` on an arXiv id
 * returns unrelated junk (verified: it matched ISBN records). A wrong paper is
 * worse than no answer.
 */
export async function resolveArxivOffline(arxivId, opts = {}) {
  const id = String(arxivId).replace(/v\d+$/i, "");
  const viaOpenAlex = await openalexByArxivId(id, opts);
  if (viaOpenAlex?.title) return viaOpenAlex;
  // Semantic Scholar knows arXiv ids directly and carries the published DOI.
  const viaS2 = await semanticScholarPaper(`ARXIV:${id}`, opts).catch(() => null);
  if (viaS2?.title) return { ...viaS2, arxivId: id };
  return null;
}

// ---------------------------------------------------------------------------
// bioRxiv / medRxiv
// ---------------------------------------------------------------------------

/** bioRxiv/medRxiv details API (returns preprint + published-version rows). */
export async function biorxivDetails(doi, { server = "biorxiv", signal, userAgent = DEFAULT_UA, timeoutMs = 20000 } = {}) {
  const url = `https://api.biorxiv.org/details/${server}/${encodeURIComponent(doi)}`;
  let d;
  try {
    d = await fetchJson(url, {
      headers: { "User-Agent": userAgent },
      signal,
      timeoutMs,
      retries: 1,
    });
  } catch {
    return null;
  }
  const row = (d?.collection ?? []).find((r) => r?.doi) ?? null;
  if (!row) return null;
  return {
    title: row.title ?? "(no title)",
    authors: (row.authors ?? "").split(/;\s*/).filter(Boolean),
    year: Number(String(row.date ?? "").slice(0, 4)) || null,
    journal: server === "medrxiv" ? "medRxiv (preprint)" : "bioRxiv (preprint)",
    doi: row.doi,
    pmid: "",
    pmcid: "",
    arxivId: "",
    citations: 0,
    isOpenAccess: true,
    type: "preprint",
    abstract: row.abstract ?? "",
    source: server,
    version: row.version ?? "",
    publishedDoi: row.published && row.published !== "NA" ? row.published : "",
    server,
  };
}

/** Which preprint server (if either) owns this DOI. */
export async function preprintServerFor(doi, opts = {}) {
  if (!/^10\.1101\//i.test(doi)) return null;
  for (const server of ["biorxiv", "medrxiv"]) {
    const rec = await biorxivDetails(doi, { ...opts, server });
    if (rec) return rec;
  }
  return null;
}

export function biorxivPdfUrl(doi, version = "") {
  const v = String(version || "1").replace(/^v/i, "") || "1";
  return `https://www.biorxiv.org/content/${doi}v${v}.full.pdf`;
}

export function medrxivPdfUrl(doi, version = "") {
  const v = String(version || "1").replace(/^v/i, "") || "1";
  return `https://www.medrxiv.org/content/${doi}v${v}.full.pdf`;
}

// ---------------------------------------------------------------------------
// DOAJ  (fully open-access journal index)
// ---------------------------------------------------------------------------

export async function doajSearch(query, { rows = 10, signal, userAgent = DEFAULT_UA, timeoutMs = 20000 } = {}) {
  const url = new URL(`https://doaj.org/api/search/articles/${encodeURIComponent(query)}`);
  url.searchParams.set("pageSize", String(Math.min(Math.max(rows, 1), 50)));
  const d = await fetchJson(url, {
    headers: { "User-Agent": userAgent },
    signal,
    timeoutMs,
    retries: 1,
  });
  return (d?.results ?? []).map((r) => {
    const b = r.bibjson ?? {};
    const doiObj = (b.identifier ?? []).find((i) => i.type === "doi");
    return {
      title: b.title ?? "(no title)",
      authors: (b.author ?? []).map((a) => a.name).filter(Boolean),
      year: Number(b.year ?? 0) || null,
      journal: b.journal?.title ?? "",
      doi: doiObj?.id ?? "",
      pmid: "",
      pmcid: "",
      arxivId: "",
      citations: 0,
      isOpenAccess: true,
      type: "journal-article",
      abstract: stripTags(b.abstract ?? "").slice(0, 2000),
      source: "doaj",
      oaPdfUrls: (b.link ?? []).filter((l) => l.type === "fulltext" && /\.pdf($|\?)/i.test(l.url ?? "")).map((l) => l.url),
    };
  });
}

// ---------------------------------------------------------------------------
// Provider registry used by the multi-source search
// ---------------------------------------------------------------------------

/**
 * Named search providers. Each `run(query, opts)` returns normalised records.
 * `kind` tells the caller whether free text or an exact identifier is expected.
 */
export const SEARCH_PROVIDERS = {
  crossref: { label: "Crossref", kind: "text", run: (q, o) => crossrefSearch(q, o) },
  openalex: { label: "OpenAlex", kind: "text", run: (q, o) => openalexSearch(q, o) },
  europepmc: { label: "Europe PMC", kind: "text", run: (q, o) => europePmcSearch(q, o) },
  semanticscholar: { label: "Semantic Scholar", kind: "text", run: (q, o) => semanticScholarSearch(q, o) },
  pubmed: { label: "PubMed", kind: "text", run: (q, o) => pubmedSearch(q, o) },
  arxiv: { label: "arXiv", kind: "text", run: (q, o) => arxivApi(`all:"${q}"`, o) },
  doaj: { label: "DOAJ", kind: "text", run: (q, o) => doajSearch(q, o) },
};

/**
 * PubMed syntax used to turn a DOI into a PMID. Named separately because it is
 * an exact-identifier lookup, not a free-text search.
 */
export function pubmedDoiTerm(doi) {
  return `${doi}[DOI]`;
}

/** Default fan-out: broad and fast. `arxiv` and `doaj` are opt-in. */
export const DEFAULT_SEARCH_PROVIDERS = ["crossref", "openalex", "europepmc", "pubmed", "semanticscholar"];
