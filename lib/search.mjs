/**
 * Multi-source literature search: one query, fanned out over every configured
 * provider, merged into de-duplicated records and ranked.
 */
import { PaperStore, SEARCH_PROVIDERS } from "./sources.mjs";
import { isTitleMatch, titleConfidence, titleSimilarity } from "./util.mjs";

/**
 * Publishers whose "posted-content" DOIs are widely mirrored/pirated copies
 * rather than the version of record. They are not excluded — they are ranked
 * below a real journal article or a preprint on arXiv/bioRxiv.
 *
 * Motivation (live case): Crossref's top title hit for "Attention Is All You
 * Need" is a `posted-content` record on 10.65215, a predatory-looking DOI
 * prefix, while the paper's actual venue (NeurIPS) issues no DOI at all.
 */
const LOW_QUALITY_DOI_PREFIXES = ["10.65215/"];

const HIGH_QUALITY_TYPES = new Set(["journal-article", "book-chapter", "proceedings-article", "review-article", "editorial"]);

/**
 * Ranking quality of one record, higher is better. Used before the citation
 * tie-break so a legitimate venue outranks a mirrored copy with better
 * "title overlap".
 */
export function qualityScore(rec) {
  let score = 0;
  const doi = String(rec.doi ?? "");
  if (HIGH_QUALITY_TYPES.has(String(rec.type ?? "").toLowerCase())) score += 3;
  if (doi && /^10\.\d{4,9}\//.test(doi)) score += 1;
  if (doi && LOW_QUALITY_DOI_PREFIXES.some((p) => doi.startsWith(p))) score -= 4;
  if (rec.pmid || rec.pmcid) score += 2; // indexed in PubMed/PMC
  if (rec.arxivId || /^10\.48550\//i.test(doi)) score += 1;
  if (rec.isOpenAccess === true) score += 1;
  return score;
}

/** Ranking: title match dominates, source quality breaks near-ties. */
export function rankRecords(records, query) {
  const q = String(query ?? "").trim();
  return [...records].sort((a, b) => {
    if (q) {
      const oa = titleConfidence(q, a.title);
      const ob = titleConfidence(q, b.title);
      if (Math.abs(oa - ob) > 0.05) return ob - oa;
      const sa = titleSimilarity(q, a.title);
      const sb = titleSimilarity(q, b.title);
      if (Math.abs(sa - sb) > 0.05) return sb - sa;
    }
    const qual = qualityScore(b) - qualityScore(a);
    if (qual) return qual;
    const oa = Number(b.isOpenAccess === true) - Number(a.isOpenAccess === true);
    if (oa) return oa;
    if ((b.citations ?? 0) !== (a.citations ?? 0)) return (b.citations ?? 0) - (a.citations ?? 0);
    const recent = (b.year ?? 0) - (a.year ?? 0);
    if (recent) return recent;
    return Number(Boolean(b.doi)) - Number(Boolean(a.doi)) || Number(Boolean(b.pmid)) - Number(Boolean(a.pmid));
  });
}

/**
 * Pick the best record for a title query.
 *
 * Crossref alone is not enough: for a paper whose venue issues no DOI it
 * returns only mirrored copies. Querying Crossref plus OpenAlex in parallel
 * finds the real record (which carries the arXiv id and often the published
 * DOI), and `rankRecords` puts it first.
 *
 * @returns {Promise<{best: object|null, candidates: object[], failures: string[]}>}
 */
export async function resolveByTitle(title, config, signal, { providers = ["crossref", "openalex"], rows = 8 } = {}) {
  const usable = providers.filter((p) => SEARCH_PROVIDERS[p]);
  const store = new PaperStore();
  const failures = [];
  const settled = await Promise.all(
    usable.map(async (p) => {
      try {
        return { ok: true, recs: await SEARCH_PROVIDERS[p].run(title, { rows, signal, userAgent: config.userAgent, email: config.email, apiKey: config.ncbiApiKey, timeoutMs: config.timeoutMs }) };
      } catch (err) {
        return { ok: false, error: `${p}: ${err.message}`, recs: [] };
      }
    }),
  );
  for (const s of settled) {
    if (!s.ok) failures.push(s.error);
    store.addAll(s.recs);
  }
  const ranked = rankRecords(store.toArray(), title);
  const candidates = ranked
    .slice(0, 6)
    .map((r) => ({
      title: r.title,
      doi: r.doi,
      year: r.year,
      journal: r.journal,
      type: r.type,
      arxivId: r.arxivId,
      pmid: r.pmid,
      pmcid: r.pmcid,
      overlap: titleConfidence(title, r.title),
      similarity: titleSimilarity(title, r.title),
      quality: qualityScore(r),
      sources: r.sources,
    }));
  const best = ranked.find((r) => isTitleMatch(title, r.title, config.titleConfidence ?? 0.6)) ?? null;
  return { best, candidates, failures };
}

/**
 * Run one query against several providers concurrently.
 *
 * A provider that fails does not fail the search: its error is reported in
 * `failures` so the caller can surface degraded results honestly.
 *
 * @param {string} query
 * @param {object} config   plugin config (`searchProviders`, timeouts, email)
 * @param {AbortSignal} signal
 * @param {{providers?: string[], rows?: number, yearFrom?: number, yearTo?: number}} opts
 */
export async function multiSourceSearch(query, config, signal, opts = {}) {
  const wanted = (opts.providers?.length ? opts.providers : config.searchProviders) ?? [];
  const names = wanted.filter((n) => SEARCH_PROVIDERS[n]);
  const unknown = wanted.filter((n) => !SEARCH_PROVIDERS[n]);
  const rows = Math.min(Math.max(opts.rows ?? config.searchRows ?? 8, 1), 50);
  const store = new PaperStore();
  const failures = [];

  const settled = await Promise.all(
    names.map(async (name) => {
      const started = Date.now();
      try {
        const perProvider = Math.min(rows, 25);
        const recs = await SEARCH_PROVIDERS[name].run(query, {
          rows: perProvider,
          signal,
          userAgent: config.userAgent,
          email: config.email,
          apiKey: config.ncbiApiKey,
          ncbiApiKey: config.ncbiApiKey,
          timeoutMs: config.timeoutMs,
          yearFrom: opts.yearFrom,
          yearTo: opts.yearTo,
        });
        return { name, ok: true, ms: Date.now() - started, count: (recs ?? []).length, recs: recs ?? [] };
      } catch (err) {
        return { name, ok: false, ms: Date.now() - started, count: 0, recs: [], error: err.message };
      }
    }),
  );

  const perSource = [];
  for (const s of settled) {
    perSource.push({ provider: s.name, ok: s.ok, ms: s.ms, count: s.count, error: s.error });
    if (!s.ok) failures.push(`${s.name}: ${s.error}`);
    store.addAll(s.recs);
  }

  const records = rankRecords(store.toArray(), query);
  return {
    query,
    providers: names,
    unknownProviders: unknown,
    rows,
    totalBeforeMerge: perSource.reduce((n, s) => n + s.count, 0),
    count: records.length,
    records: records.slice(0, rows),
    allRecords: records,
    perSource,
    failures,
  };
}
