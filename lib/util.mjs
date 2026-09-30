/**
 * Shared HTTP / identifier utilities for the literature plugin.
 *
 * Zero runtime dependencies: Node global fetch + node:fs only.
 */
import { inflateSync } from "node:zlib";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Polite contact address for the free APIs that ask for one. */
export const CONTACT_EMAIL = "dsh-literature-plugin@users.noreply.github.com";

// ---------------------------------------------------------------------------
// Timeouts / retries
// ---------------------------------------------------------------------------

/** Combine a caller signal with a per-request timeout budget. */
export function withTimeout(signal, ms) {
  const parts = [AbortSignal.timeout(Math.max(1, ms))];
  if (signal) parts.unshift(signal);
  return AbortSignal.any(parts);
}

export function delay(ms, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolveDelay, ms);
    if (timer.unref) timer.unref();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        rejectDelay(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function isAbort(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError";
}

/** HTTP statuses worth retrying: rate limits, gateways, and transient outages. */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function isTransient(err) {
  if (err?.name === "TimeoutError") return true;
  // A retryable HTTP status is tracked on the error so a 503 can be retried
  // rather than looking like a permanent failure.
  if (err?.status && isRetryableStatus(err.status)) return true;
  const m = String(err?.message ?? "");
  return (
    err?.name === "AbortError" ||
    /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|\b(?:408|425|429|5\d\d)\b/i.test(m)
  );
}

/** An HTTP response the caller must handle explicitly. */
export class HttpError extends Error {
  constructor(status, url, detail = "") {
    super(`HTTP ${status}${detail ? ` (${detail})` : ""} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = String(url);
    this.detail = detail;
  }
}

/**
 * True when a failure is the host deliberately throttling us.
 *
 * The shared sci.bban.top backend behind nine Sci-Hub mirrors returns HTTP 429
 * after a handful of PDFs, which otherwise makes the entire mirror list look
 * broken. A rate limit deserves a wait-and-retry, not a mark-dead.
 */
export function isRateLimitError(err) {
  if (!err) return false;
  if (err.status === 429 || err.status === 503) return true;
  return /\bHTTP (?:429|503)\b|\btoo many requests\b|\brate.?limit/i.test(String(err.message ?? ""));
}

/**
 * Seconds to wait before retrying, from a `Retry-After` header or a
 * "retry in N seconds" hint in the body. Returns null when the response did not
 * say.
 */
export function retryAfterMs(err) {
  const text = `${err?.detail ?? ""} ${err?.message ?? ""}`;
  const clamp = (ms) => Math.min(ms, 15000);

  // Milliseconds are checked FIRST: "retry after 250 ms" would otherwise be
  // read as 250 seconds by the seconds pattern below.
  const millis = text.match(/retry[- ]?(?:in|after)?\s*(\d+)\s*ms\b/i);
  if (millis) return clamp(Number(millis[1]));
  const seconds = text.match(/retry[- ]?(?:in|after)?\s*(\d+)\s*(?:s\b|sec\b|seconds?\b)/i);
  if (seconds) return clamp(Number(seconds[1]) * 1000);
  // A bare number, e.g. a `Retry-After: 2` header, means seconds.
  const bare = text.match(/retry[- ]after["':\s]*(\d+)\b/i);
  if (bare) return clamp(Number(bare[1]) * 1000);
  return null;
}

/**
 * fetch with a per-attempt timeout, bounded retries and exponential backoff.
 * Retryable HTTP statuses (429 / 5xx) are retried too, not just transport
 * errors — several of the free APIs answer 503 when busy.
 *
 * Returns the Response; a non-retryable non-2xx status is returned as-is so the
 * caller decides what it means.
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    headers = {},
    signal,
    timeoutMs = 20000,
    retries = 2,
    retryDelayMs = 500,
    redirect = "follow",
    method = "GET",
    retryStatuses = true,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        redirect,
        signal: withTimeout(signal, timeoutMs),
      });
      if (retryStatuses && !res.ok && isRetryableStatus(res.status) && attempt < retries) {
        lastErr = new HttpError(res.status, url, res.headers.get("retry-after") ? `retry-after ${res.headers.get("retry-after")}` : "");
        try {
          await res.arrayBuffer(); // drain so the socket can be reused
        } catch {
          /* ignore */
        }
        await delay(retryDelayMs * 2 ** attempt, signal);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err; // caller cancelled: never mask it
      if (!isTransient(err) || attempt >= retries) break;
      await delay(retryDelayMs * 2 ** attempt, signal);
    }
  }
  throw lastErr;
}

/** fetch + JSON parse, throwing an HttpError (with `.status`) on a non-2xx. */
export async function fetchJson(url, opts = {}) {
  const res = await fetchWithRetry(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 200);
    } catch {
      /* detail is best-effort */
    }
    throw new HttpError(res.status, url, detail);
  }
  // Guard against an HTML error page served with a JSON content type: a
  // mis-declared 503 body must not crash the caller with a JSON syntax error.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(res.status, url, `response was not JSON: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

/** fetch + text. */
export async function fetchText(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

// ---------------------------------------------------------------------------
// Cookie-aware HTML fetching + meta-refresh following
// ---------------------------------------------------------------------------

const META_REFRESH_RE =
  /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\s*\d+\s*;\s*url\s*=\s*["']?([^"'\s>]+)/i;

export function metaRefreshTarget(html) {
  const m = META_REFRESH_RE.exec(String(html));
  if (!m) return null;
  return stripFragment(m[1].replace(/^url=/i, ""));
}

/** Drop a URL fragment (`#view=FitH`): the server never sees it, but a naive
 *  `<a href>` / `<embed src>` copy keeps it and it corrupts extension checks. */
export function stripFragment(url) {
  const i = String(url).indexOf("#");
  return i === -1 ? String(url) : String(url).slice(0, i);
}

function mergeCookies(jar, setCookies) {
  for (const sc of setCookies ?? []) {
    const pair = String(sc).split(";")[0].trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const rest = jar
      .split("; ")
      .filter((c) => c && !c.startsWith(`${key}=`));
    rest.push(pair);
    jar = rest.join("; ");
  }
  return jar;
}

/**
 * Fetch an HTML page, following up to `maxHops` <meta http-equiv="refresh">
 * verification hops (MDPI and others gate content behind a bot-check
 * interstitial) while carrying the cookies set along the way.
 */
export async function fetchHtmlSmart(url, userAgent, signal, { maxHops = 3, timeoutMs = 20000, headers = {} } = {}) {
  let current = stripFragment(url);
  let cookies = "";
  for (let hop = 0; hop <= maxHops; hop++) {
    const reqHeaders = {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en,zh-CN;q=0.9,zh;q=0.8",
      ...headers,
    };
    if (cookies) reqHeaders.Cookie = cookies;
    const res = await fetchWithRetry(current, {
      headers: reqHeaders,
      signal,
      timeoutMs,
      retries: 1,
    });
    cookies = mergeCookies(cookies, res.headers.getSetCookie?.() ?? []);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${current}`);
    const finalUrl = stripFragment(res.url || current);
    const text = await res.text();
    const next = metaRefreshTarget(text);
    if (!next) return { text, url: finalUrl, cookies };
    current = new URL(next, finalUrl).href;
    if (hop < maxHops) await delay(1200, signal);
  }
  throw new Error(`too many meta-refresh hops starting at ${url}`);
}

// ---------------------------------------------------------------------------
// PDF extraction helpers
// ---------------------------------------------------------------------------

/** First `citation_pdf_url` meta tag value, decoded. */
export function citationPdfUrl(html) {
  const text = String(html);
  const m =
    text.match(/<meta[^>]*(?:citation_pdf_url|eprints\.document_url)["'][^>]*content=["']([^"']+)["']/i) ||
    text.match(/<meta[^>]*content=["']([^"']+)["'][^>]*(?:citation_pdf_url|eprints\.document_url)/i);
  return m ? m[1].replace(/&amp;/g, "&").trim() : null;
}

/** All `citation_pdf_url`-ish meta values in document order. */
export function citationPdfUrls(html) {
  const out = [];
  for (const m of String(html).matchAll(/<meta[^>]*content=["']([^"']*(?:\.pdf|pdf)[^"']*)["'][^>]*>/gi)) {
    const v = m[1].replace(/&amp;/g, "&").trim();
    if (/\.pdf($|\?|#)/i.test(v)) out.push(v);
  }
  return [...new Set(out)];
}

/** First DOI-bearing meta tag on a publisher page. */
export function citationDoi(html) {
  const text = String(html);
  const m =
    text.match(/<meta[^>]*(?:citation_doi|dc\.identifier|dc\.Identifier|DOI)["'][^>]*content=["']([^"']*10\.\d{4,9}\/[^"']+)["']/i) ||
    text.match(/<meta[^>]*content=["'](10\.\d{4,9}\/[^"']+)["'][^>]*(?:citation_doi|dc\.identifier|DOI)/i);
  return m ? extractDoi(m[1]) : null;
}

/**
 * Extract the PDF link from a Sci-Hub-style article page. Mirrors change their
 * markup, so several shapes are probed in order of reliability.
 */
export function extractPdfUrl(pageUrl, html) {
  const candidates = [];
  const push = (raw) => {
    if (typeof raw === "string" && raw.trim()) candidates.push(stripFragment(raw.trim()));
  };

  /** Attribute value: double-quoted, single-quoted, or an unquoted token. */
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  };

  // 1. Viewer tags. `<object>` is checked first because it carries an explicit
  //    PDF type; sci-hub.ru serves its PDF only this way.
  for (const m of String(html).matchAll(/<object\b[^>]*>/gi)) {
    const tag = m[0];
    const type = attr(tag, "type");
    const data = attr(tag, "data");
    if (data && (!type || /pdf/i.test(type))) push(data);
  }
  for (const m of String(html).matchAll(/<(?:embed|iframe)\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attr(tag, "src");
    const type = attr(tag, "type");
    if (!src) continue;
    // An <embed> with neither a PDF type/src nor a document-looking URL is
    // usually a preview image or a player; skip it rather than download junk.
    const looksDocument =
      /pdf/i.test(type) || /\.pdf(?:$|[?#])/i.test(src) || /\/(?:storage|pdf|download)\//i.test(src);
    if (looksDocument) push(src);
  }

  // 2. Explicit anchors and scripted navigations.
  for (const m of String(html).matchAll(/location\.href\s*=\s*['"]([^'"]+)['"]/gi)) push(m[1]);
  for (const m of String(html).matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], "href");
    if (href && (/\.pdf(?:$|[?#])/i.test(href) || /\/(?:storage|pdf)\//i.test(href))) push(href);
  }

  // 3. JavaScript variables a viewer may hand the file to.
  for (const m of String(html).matchAll(
    /(?:pdf_url|pdfUrl|file|url|href)\s*[:=]\s*['"]([^'"]+\.pdf[^'"]*)['"]/gi,
  )) {
    push(m[1]);
  }

  if (!candidates.length) return null;
  const raw = candidates[0];
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  try {
    return stripFragment(new URL(raw, pageUrl).href);
  } catch {
    return null;
  }
}

/**
 * True when the advertised "PDF" link is really the article page again.
 *
 * Mirrors with no copy of the paper echo the requested DOI path back as the PDF
 * link (verified: sci-hub.vg and sci-hub.ee both return the article URL for a
 * nonexistent DOI). Downloading that wastes a whole route budget only to fail
 * the magic-byte check, so it is rejected up front.
 *
 * @param {string} pdfUrl      the advertised link
 * @param {string} articleUrl  the article page it was parsed from
 */
export function isSelfReferentialPdfLink(pdfUrl, articleUrl) {
  if (!pdfUrl || !articleUrl) return false;
  const norm = (u) => {
    try {
      const p = new URL(u);
      return `${p.hostname.replace(/^www\./i, "")}${p.pathname.replace(/\/+$/, "")}`;
    } catch {
      return String(u);
    }
  };
  const a = norm(pdfUrl);
  const b = norm(articleUrl);
  if (a === b) return true;
  // Same path on a sibling host counts too: these mirrors swap domains freely.
  const pathOf = (s) => s.split("/").slice(1).join("/");
  return pathOf(a) === pathOf(b);
}

/**
 * Which DOI does a PDF claim to be? Reads the first bytes and un-compresses the
 * leading FlateDecode streams so `/Metadata` and the first page's text become
 * searchable. Used to catch a mirror serving the wrong article.
 */
export function doisInPdfBuffer(buffer, { maxBytes = 400_000, maxStreams = 6 } = {}) {
  if (!isPdfBuffer(buffer)) return [];
  const found = new Set();
  const collect = (text) => {
    for (const m of String(text).matchAll(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]{3,}/g)) {
      found.add(m[0].replace(/[.,;:)\]]+$/, ""));
    }
  };

  const head = buffer.subarray(0, maxBytes);
  collect(head.toString("latin1"));

  // Streams are usually Flate-compressed; inflate the first few.
  let inflated = 0;
  for (const m of head.toString("latin1").matchAll(/stream\r?\n/g)) {
    if (inflated >= maxStreams) break;
    inflated++;
    const start = m.index + m[0].length;
    const end = head.indexOf(Buffer.from("endstream"), start, "latin1");
    if (end === -1) continue;
    try {
      collect(inflateSync(head.subarray(start, end)).toString("latin1"));
    } catch {
      /* not a single deflate stream; ignore */
    }
  }
  return [...found];
}

const PDF_MAGIC = "%PDF-";

export function isPdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === PDF_MAGIC;
}

/**
 * Download a URL as a verified PDF. Follows meta-refresh interstitials (some
 * publishers gate the real PDF behind one), carries cookies, and returns the
 * bytes only when the `%PDF-` magic is present.
 *
 * @returns {Promise<{buffer: Buffer, url: string, cookies: string}>}
 */
export async function downloadPdfBuffer(pdfUrl, opts = {}) {
  const {
    referer,
    userAgent = DEFAULT_UA,
    signal,
    timeoutMs = 30000,
    maxHops = 3,
    cookies: initialCookies = "",
    maxBytes = 300 * 1024 * 1024,
    retries = 1,
  } = opts;

  let cookies = initialCookies;
  let current = stripFragment(pdfUrl);
  let refererUrl = referer;

  for (let hop = 0; hop <= maxHops; hop++) {
    const headers = {
      "User-Agent": userAgent,
      Accept: "application/pdf,application/octet-stream,*/*;q=0.9,text/html;q=0.8",
      "Accept-Language": "en,zh-CN;q=0.9,zh;q=0.8",
    };
    if (refererUrl) headers.Referer = refererUrl;
    if (cookies) headers.Cookie = cookies;

    const res = await fetchWithRetry(current, {
      headers,
      signal,
      timeoutMs,
      retries,
      redirect: "follow",
    });
    cookies = mergeCookies(cookies, res.headers.getSetCookie?.() ?? []);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${current}`);

    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len > maxBytes) {
      throw new Error(`PDF is ${(len / 1048576).toFixed(1)} MB, above the ${(maxBytes / 1048576).toFixed(0)} MB limit`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`PDF is ${(buf.length / 1048576).toFixed(1)} MB, above the ${(maxBytes / 1048576).toFixed(0)} MB limit`);
    }
    const finalUrl = stripFragment(res.url || current);

    if (isPdfBuffer(buf)) return { buffer: buf, url: finalUrl, cookies };

    // Not a PDF: it may be an interstitial that meta-refreshes to the real PDF.
    if (hop < maxHops && buf.length < 2_000_000) {
      const next = metaRefreshTarget(buf.toString("utf8"));
      if (next) {
        refererUrl = finalUrl;
        current = new URL(next, finalUrl).href;
        await delay(1200, signal);
        continue;
      }
    }
    const kind = /^\s*</.test(buf.toString("utf8", 0, 1)) ? "an HTML page" : "not a PDF";
    throw new Error(`downloaded content is ${kind} (${buf.length} bytes) at ${finalUrl}`);
  }
  throw new Error(`too many redirect hops for ${pdfUrl}`);
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/;

/** Extract a DOI from free text such as a doi.org URL or a citation string. */
export function extractDoi(text) {
  const m = String(text ?? "").match(DOI_RE);
  if (!m) return null;
  return m[0].replace(/[.,;:)\]]+$/, "");
}

/** Extract an arXiv id from an arxiv.org URL, arXiv DOI, or a bare id.
 *
 * The optional `vN` version suffix is KEPT when the identifier itself carries
 * it (so `arxiv.org/pdf/1712.08900v2` -> `1712.08900v2`) and never invented
 * from a surrounding word. */
export function extractArxivId(text) {
  const s = String(text ?? "").trim();
  const m =
    s.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i) ||
    s.match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5}(?:v\d+)?)/i) ||
    s.match(/^arxiv[:\s]*(\d{4}\.\d{4,5}(?:v\d+)?)$/i) ||
    s.match(/(?:^|[^\d.])(\d{4}\.\d{4,5}(?:v\d+)?)(?![.\d])/);
  return m ? m[1] : null;
}

/** The arXiv id with any version suffix removed — the key used for de-duplication. */
export function bareArxivId(arxivId) {
  return String(arxivId ?? "").replace(/v\d+$/i, "");
}

/** Extract a PubMed id from a pubmed URL, `PMID: 123` form, or a bare id. */
export function extractPmid(text) {
  const s = String(text ?? "").trim();
  const m =
    s.match(/pubmed(?:\.ncbi\.nlm\.nih\.gov)?\/(\d{6,9})/i) ||
    s.match(/[?&]term=(\d{6,9})/i) ||
    s.match(/\bpmid[:\s]*(\d{6,9})\b/i) ||
    s.match(/^(\d{6,9})$/);
  return m ? m[1] : null;
}

/** Extract a PMC id from a PMC URL or `PMC1234567` form. */
export function extractPmcid(text) {
  const s = String(text ?? "").trim();
  const m = s.match(/\bPMC(\d{5,9})\b/i) || s.match(/pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC(\d{5,9})/i);
  return m ? `PMC${m[1]}` : null;
}

export function arxivDoi(arxivId) {
  return `10.48550/arXiv.${arxivId}`;
}

/** Normalise a loose DOI (strip resolver prefixes, lowercase nothing). */
export function normalizeDoi(doi) {
  return String(doi ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;:)\]]+$/, "");
}

/**
 * Classify a free-form identifier string.
 * @returns {{kind: 'doi'|'arxiv'|'pmid'|'pmcid'|'url'|'title'|null, value: string}}
 */
export function classifyIdentifier(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { kind: null, value: "" };
  const doi = extractDoi(raw);
  if (doi) return { kind: "doi", value: doi };
  const arxiv = extractArxivId(raw);
  if (arxiv && /arxiv|^\d{4}\.\d{4,5}/i.test(raw)) return { kind: "arxiv", value: arxiv };
  const pmcid = extractPmcid(raw);
  if (pmcid) return { kind: "pmcid", value: pmcid };
  if (/^https?:\/\//i.test(raw)) return { kind: "url", value: raw };
  const pmid = extractPmid(raw);
  if (pmid) return { kind: "pmid", value: pmid };
  if (arxiv) return { kind: "arxiv", value: arxiv };
  return { kind: "title", value: raw };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function slugify(value, max = 80) {
  return (
    String(value ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "paper"
  );
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into",
  "is", "it", "of", "on", "or", "that", "the", "their", "this", "to", "using",
  "via", "with", "we", "our",
]);

/**
 * Word-overlap confidence between a requested title and a candidate title.
 *
 * Problems this solves: a short query like "quantum" trivially appears inside
 * any long title, so plain overlap would score 1.0 and silently resolve to the
 * wrong paper. Two guards are applied:
 *   - stopwords and 1-character tokens are ignored;
 *   - every unmatched candidate word costs, so a match must be proportional to
 *     BOTH strings, not just the query.
 *
 * A perfect containment match still scores 1.0; "quantum" against "Quantum
 * Theory, Quantum Materials, Quantum Computing" scores ~0.23.
 */
export function titleConfidence(asked, got) {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const queryWords = norm(asked)
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  if (!queryWords.length) return 1;
  const candWords = norm(got)
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  if (!candWords.length) return 0;

  const candSet = new Set(candWords);
  let hit = 0;
  for (const w of new Set(queryWords)) if (candSet.has(w)) hit++;
  const uniqueQuery = new Set(queryWords).size;

  // Query coverage (did we find the words the caller asked for?) balanced
  // against candidate coverage (is the candidate mostly those words?).
  const queryCoverage = hit / uniqueQuery;
  const candidateCoverage = hit / new Set(candWords).size;
  return Math.min(queryCoverage, queryCoverage * 0.75 + candidateCoverage * 0.25);
}

/**
 * Character-bigram Dice similarity — a second, independent signal used to
 * confirm a title match. Robust to word order and minor wording differences.
 */
export function titleSimilarity(a, b) {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const bigrams = (s) => {
    const t = norm(s).replace(/\s+/g, " ");
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/**
 * Word-BIGRAM overlap between two titles, order-sensitive.
 *
 * Character bigrams cannot tell "Attention Is All You Need" from "Is Attention
 * All You Need?" (similarity 0.98) because the same characters appear in both.
 * Word bigrams can: the second title's "is attention" / "all you" pairs do not
 * occur in the first, so the score drops sharply.
 *
 * Uses containment (shared / smaller set) so a long title containing a short
 * query still scores 1.0, while a reordering does not.
 */
export function titleWordBigrams(a) {
  const words = String(a ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  if (!out.size && words.length) out.add(words[0]);
  return out;
}

export function titleBigramOverlap(a, b) {
  const A = titleWordBigrams(a);
  const B = titleWordBigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * Decide whether a candidate record really is the paper the caller asked for.
 *
 * The rules are deliberately asymmetric because the two mistakes are not
 * equally bad: resolving a broad query like "deep learning" to one arbitrary
 * paper is much worse than refusing and asking for a DOI.
 *
 *   - exact match               -> accept (after punctuation/case folding)
 *   - 1-3 significant words     -> require a near-identical word sequence
 *   - longer query              -> require word overlap, character similarity
 *                                  and word-bigram agreement
 */
export function isTitleMatch(asked, got, threshold = 0.6) {
  const normalize = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const a = normalize(asked);
  const b = normalize(got);
  if (a && a === b) return true;
  const overlap = titleConfidence(asked, got);
  const similar = titleSimilarity(asked, got);
  const wordBigrams = titleBigramOverlap(asked, got);
  const queryWords = a.split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));

  if (queryWords.length <= 3) return similar >= 0.9 && wordBigrams >= 0.8;
  return overlap >= threshold && similar >= 0.62 && wordBigrams >= 0.6;
}

/** Strip JATS/XML tags and collapse whitespace. */
export function stripTags(xml) {
  return String(xml ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Decode the five XML entities plus numeric refs. */
export function decodeXml(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}
