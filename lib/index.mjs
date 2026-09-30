/**
 * dsh-plugin-scihub — native DeepSeek Harness plugin for academic literature.
 *
 * Tools
 *   sevastopol36_scihub_search      search papers across Crossref / OpenAlex / Europe PMC /
 *                      PubMed / Semantic Scholar / arXiv / DOAJ, merged + ranked
 *   sevastopol36_scihub_resolve     turn any identifier (DOI|PMID|PMCID|arXiv|title|URL)
 *                      into the complete identifier set + links
 *   sevastopol36_scihub_fetch       download the full text, legal open access first, then
 *                      Sci-Hub mirrors, then arXiv HTML
 *   sevastopol36_scihub_probe       live diagnostics: mirror health + channel reachability
 *   sevastopol36_scihub_sources     list every configured source, mirror and route
 *
 * No runtime dependencies: Node global fetch + node:fs.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { CONTACT_EMAIL, DEFAULT_UA } from "./util.mjs";
import {
  DEFAULT_SEARCH_PROVIDERS,
  SEARCH_PROVIDERS,
  openalexByDoi,
  pmcFullTextUrls,
  semanticScholarPaper,
  unpaywallPdfUrls,
} from "./sources.mjs";
import { multiSourceSearch } from "./search.mjs";
import {
  DEFAULT_MIRRORS,
  KNOWN_DEAD_MIRRORS,
  fetchFullText,
  probeChannels,
  probeMirrors,
  resolveIdentifiers,
} from "./resolve.mjs";

const name = "sevastopol36-scihub";
const inject = ["tools", "systemPrompt"];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ALL_PROVIDERS = Object.keys(SEARCH_PROVIDERS);

const Config = z.object({
  mirrors: z
    .array(z.string())
    .default(DEFAULT_MIRRORS)
    .description("Sci-Hub mirror base URLs, tried in order after the legal open-access routes"),
  downloadDir: z
    .string()
    .default("papers")
    .description("Directory (relative to the dsh server cwd) where downloaded PDFs are saved"),
  timeoutMs: z
    .number()
    .default(30000)
    .description("Per-request timeout in milliseconds"),
  searchRows: z
    .number()
    .default(8)
    .description("Default number of merged results returned by sevastopol36_scihub_search"),
  userAgent: z
    .string()
    .default(DEFAULT_UA)
    .description("User-Agent header sent to publishers and APIs"),
  email: z
    .string()
    .default(CONTACT_EMAIL)
    .description(
      "Contact address sent to Crossref/Unpaywall/NCBI. Unpaywall rejects example.com addresses — put your own address here.",
    ),
  ncbiApiKey: z
    .string()
    .default("")
    .description(
      "Optional NCBI API key (free from https://account.ncbi.nlm.nih.gov/settings/). Raises the E-utilities limit from 3 to 10 requests/second, which avoids HTTP 429 on bursty PubMed searches.",
    ),
  searchProviders: z
    .array(z.string())
    .default(DEFAULT_SEARCH_PROVIDERS)
    .description(`Providers fanned out by sevastopol36_scihub_search. One or more of: ${ALL_PROVIDERS.join(", ")}`),
  preferSciHub: z
    .boolean()
    .default(true)
    .description(
      "Try the Sci-Hub mirrors FIRST (default), then the open-access routes. Set false to prefer open access and use Sci-Hub only as a fallback.",
    ),
  openAccessFallback: z
    .boolean()
    .default(true)
    .description(
      "Whether the open-access routes (bioRxiv/medRxiv, PMC, Europe PMC, Unpaywall, OpenAlex, Semantic Scholar, publisher) run at all. With preferSciHub they act as the fallback; without it they run first.",
    ),
  allowHtmlFallback: z
    .boolean()
    .default(true)
    .description("When an arXiv PDF is unreachable, save the ar5iv full-text HTML instead"),
  titleConfidence: z
    .number()
    .default(0.6)
    .description("Minimum title-match confidence (0-1) before a title query may resolve to a DOI"),
  lookupTimeoutMs: z
    .number()
    .default(10000)
    .description("Per-source budget when resolving cross-identifiers (DOI <-> PMID <-> PMCID <-> arXiv)"),
  resolveDeadlineMs: z
    .number()
    .default(60000)
    .description("Total budget for identifier resolution before the remaining lookups are skipped"),
  verifyPdf: z
    .boolean()
    .default(true)
    .description(
      "After downloading, check the PDF really is the requested paper (its DOI in the metadata/first page, else title similarity) and try the next candidate on an obvious mismatch. A large, structurally sound PDF is accepted on trust.",
    ),
  probeTimeoutMs: z
    .number()
    .default(20000)
    .description("Per-mirror timeout used by sevastopol36_scihub_probe"),
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatIds(p) {
  const ids = [
    p.doi && `DOI ${p.doi}`,
    p.pmid && `PMID ${p.pmid}`,
    p.pmcid && p.pmcid,
    p.arxivId && `arXiv ${p.arxivId}`,
  ].filter(Boolean);
  return ids.length ? ids.join(" | ") : "(no identifier)";
}

function formatPaper(p, i) {
  const lines = [`[${i + 1}] ${p.title}`];
  lines.push(`    ${formatIds(p)}`);
  lines.push(
    `    ${p.authors?.slice(0, 4).join(", ") || "N/A"}${p.authors?.length > 4 ? ", et al." : ""}`,
  );
  const meta = [
    p.year ?? "n.d.",
    p.journal || "N/A",
    `${p.citations ?? 0} cited`,
    p.isOpenAccess === true ? "OPEN ACCESS" : p.isOpenAccess === false ? "paywalled" : "",
    p.type || "",
  ].filter(Boolean);
  lines.push(`    ${meta.join(" | ")}`);
  if (p.sources?.length) lines.push(`    found via: ${p.sources.join(", ")}`);
  return lines.join("\n");
}

function formatSearchResult(r) {
  if (!r.count) {
    const failed = r.failures.length ? `\nProvider failures:\n${r.failures.map((f) => `  - ${f}`).join("\n")}` : "";
    return `No papers found for "${r.query}" across: ${r.providers.join(", ")}.${failed}`;
  }
  const head =
    `${r.count} unique paper(s) for "${r.query}" ` +
    `(from ${r.providers.length} sources, ${r.totalBeforeMerge} raw hits merged).`;
  const perSource = r.perSource
    .map((s) => `${s.provider}=${s.ok ? s.count : "ERR"}${s.ok ? "" : `(${s.error.slice(0, 60)})`}`)
    .join(" ");
  const body = r.records.map(formatPaper).join("\n\n");
  const tail = [
    "",
    "Next: sevastopol36_scihub_resolve to expand identifiers, or sevastopol36_scihub_fetch with a DOI/PMID/PMCID/arXiv id to download the PDF.",
    r.failures.length ? `Provider failures: ${r.failures.join("; ")}` : "",
    r.unknownProviders.length ? `Ignored unknown providers: ${r.unknownProviders.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${head}\nPer-source: ${perSource}\n\n${body}\n${tail}`;
}

function formatResolve(r, live) {
  const lines = [
    `Resolved: ${r.ids.title || "(unknown title)"}`,
    `  DOI:    ${r.ids.doi || "-"}`,
    `  PMID:   ${r.ids.pmid || "-"}`,
    `  PMCID:  ${r.ids.pmcid || "-"}`,
    `  arXiv:  ${r.ids.arxivId || "-"}`,
    `  Year:   ${r.ids.year ?? "-"} | Journal: ${r.ids.journal || "-"} | Open access: ${r.ids.isOpenAccess ?? "unknown"}`,
    `  Authors: ${(r.ids.authors ?? []).slice(0, 6).join(", ") || "-"}`,
  ];
  if (r.ids.doi) lines.push(`  doi.org: https://doi.org/${r.ids.doi}`);
  if (r.ids.pmid) lines.push(`  PubMed:  https://pubmed.ncbi.nlm.nih.gov/${r.ids.pmid}/`);
  if (r.ids.pmcid) lines.push(`  PMC:     https://pmc.ncbi.nlm.nih.gov/articles/${r.ids.pmcid}/`);
  if (r.ids.arxivId) lines.push(`  arXiv:   https://arxiv.org/abs/${r.ids.arxivId}`);
  if (live) {
    lines.push("", `Live full-text availability (${live.length} location(s) found):`);
    for (const l of live.slice(0, 12)) lines.push(`  - [${l.source}] ${l.url}`);
    if (!live.length) lines.push("  (none of the open-access locators reported a PDF)");
  }
  if (r.candidates?.length && !r.ids.doi) {
    lines.push("", "Title candidates (confidence too low to auto-resolve):");
    for (const c of r.candidates.slice(0, 5)) lines.push(`  - ${c.title} (DOI: ${c.doi || "n/a"})`);
  }
  return lines.join("\n");
}

function formatFetch(r) {
  const sourceLabel = {
    cache: "local cache (already downloaded)",
    arxiv: "arXiv",
    "ar5iv-html": "ar5iv full-text HTML (arXiv)",
    biorxiv: "bioRxiv preprint",
    medrxiv: "medRxiv preprint",
    publisher: "publisher PDF (citation_pdf_url)",
  }[r.source];
  const label = sourceLabel
    ? sourceLabel
    : r.source?.startsWith("PMC")
      ? `open access — ${r.source}`
      : r.source?.startsWith("Europe PMC")
        ? `open access — ${r.source}`
        : r.source?.startsWith("Unpaywall")
          ? `open access — ${r.source}`
          : r.source === "OpenAlex OA location"
            ? "open access — OpenAlex"
            : r.source === "Semantic Scholar OA"
              ? "open access — Semantic Scholar"
              : r.source?.startsWith("http")
                ? `Sci-Hub mirror ${r.source}`
                : r.source;
  return [
    `Paper full text saved${r.reused ? " (reused local copy)" : ""}:`,
    `  Title:  ${r.title || "(unknown)"}`,
    `  ${formatIds(r)}`,
    `  Source: ${label}`,
    r.pdfUrl ? `  URL:    ${r.pdfUrl}` : "",
    `  File:   ${r.filePath}`,
    r.sizeBytes ? `  Size:   ${(r.sizeBytes / 1024).toFixed(1)} KB` : "",
    r.tries?.length > 1 ? `  Routes tried before success: ${r.tries.join(" -> ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatProbeMirrors(rows, doi) {
  const ok = rows.filter((r) => r.ok);
  const verified = rows.filter((r) => r.verified);
  const lines = [
    `Sci-Hub mirror probe (DOI ${doi}) — ${ok.length}/${rows.length} usable, ${verified.length} content-verified`,
    "",
  ];
  for (const r of rows) {
    const mark = r.verified ? "OK  " : r.ok ? "PDF?" : "FAIL";
    lines.push(`  ${mark}  ${r.mirror.padEnd(30)} ${String(r.ms).padStart(6)}ms  ${r.status}`);
  }

  // Several mirrors handing out the same file from one backend is worth saying
  // out loud: it means the list is route redundancy, not extra coverage.
  const backends = new Map();
  for (const r of ok) {
    const host = r.backend ?? "?";
    backends.set(host, (backends.get(host) ?? 0) + 1);
  }
  if (backends.size) {
    lines.push("", "PDF backends behind the usable mirrors:");
    for (const [host, n] of [...backends].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${host.padEnd(26)} ${n} mirror(s)`);
    }
    if (backends.size === 1) {
      lines.push("  note: every usable mirror shares ONE backend — DNS/route redundancy, not extra coverage.");
    }
  }

  if (ok.length) {
    const best = ok.slice(0, 5).map((r) => `      - '${r.mirror}'`);
    lines.push("", "Suggested mirrors config (fastest first):", "    mirrors:", ...best);
    if (verified.length !== ok.length) {
      lines.push(
        "",
        `  ${ok.length - verified.length} mirror(s) offered a PDF that could not be content-verified;`,
        "  they are still listed because a correct file may simply lack a readable DOI.",
      );
    }
  } else {
    lines.push("", "No mirror returned a usable PDF. Check network/DNS, then update `mirrors` in the profile patch.");
  }
  return lines.join("\n");
}

function formatProbeChannels(rows) {
  const ok = rows.filter((r) => r.ok);
  const lines = [`Open-access / metadata channel probe — ${ok.length}/${rows.length} reachable`, ""];
  for (const r of rows) {
    lines.push(`  ${r.ok ? "OK  " : "FAIL"}  ${r.channel.padEnd(20)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
  }
  const dead = rows.filter((r) => !r.ok).map((r) => r.channel);
  if (dead.length) lines.push("", `Unreachable here: ${dead.join(", ")} (the fetch cascade simply skips them).`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared tool plumbing
// ---------------------------------------------------------------------------

const stringOut = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value) }],
};

function budget(exec, ms) {
  const parts = [AbortSignal.timeout(ms)];
  if (exec?.signal) parts.unshift(exec.signal);
  return AbortSignal.any(parts);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const providers = (config.searchProviders ?? DEFAULT_SEARCH_PROVIDERS).filter((p) => SEARCH_PROVIDERS[p]);
  const providerList = (providers.length ? providers : DEFAULT_SEARCH_PROVIDERS).join(", ");

  ctx.systemPrompt.section({
    name: "sevastopol36-scihub",
    order: 143,
    text: () =>
      [
        "## Academic Literature Access (SciHub Papers)",
        "",
        "Tools for finding and downloading academic papers:",
        `- \`sevastopol36_scihub_search\` — search metadata across ${providerList} (title, authors, year, journal, DOI, PMID, PMCID, arXiv id, citations), merged and de-duplicated. Best first step for a topic, title or author.`,
        "- `sevastopol36_scihub_resolve` — turn ANY identifier (DOI, PMID, PMCID, arXiv id, doi.org/pubmed/arxiv URL, or a title) into the complete identifier set plus checkable links and live open-access locations.",
        "- `sevastopol36_scihub_fetch` — download the full text and report the saved path. Route order: arXiv PDF, then Sci-Hub mirrors, then the open-access routes (bioRxiv/medRxiv, PMC, Europe PMC, Unpaywall, OpenAlex, Semantic Scholar, publisher), then ar5iv HTML.",
        "- `sevastopol36_scihub_probe` — live diagnostics for Sci-Hub mirror health and open-access channel reachability. Run it when fetches start failing.",
        "- `sevastopol36_scihub_sources` — list every configured provider, mirror and route, in the order they are tried.",
        "",
        "Typical flow: `sevastopol36_scihub_search` → `sevastopol36_scihub_fetch` with the DOI (or `sevastopol36_scihub_resolve` first when you only have a PMID/PMCID/arXiv id). Always report the saved file path.",
        "Sci-Hub is the primary full-text route here and is intended for academic/educational access; respect copyright where applicable. Set `preferSciHub: false` to make open access the primary route instead.",
      ].join("\n"),
  });

  // -------------------------------------------------------------------------
  // sevastopol36_scihub_search
  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_scihub_search",
      description:
        `Search academic papers by title, keywords or author across multiple sources (${providerList}). Returns merged, de-duplicated, ranked metadata: title, authors, year, journal, DOI, PMID, PMCID, arXiv id and citation count. Use this first, then sevastopol36_scihub_fetch with the DOI.`,
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "Search query: paper title, keywords, or author name",
        },
        rows: {
          type: "number",
          description: `Maximum number of merged results to return (default ${config.searchRows}, max 50)`,
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: `Restrict the search to these providers (default: ${providerList}). Valid: ${ALL_PROVIDERS.join(", ")}`,
        },
        year_from: { type: "number", description: "Only papers published in or after this year" },
        year_to: { type: "number", description: "Only papers published in or before this year" },
      },
      output: stringOut,
      presentCall(args) {
        return {
          card: "generic",
          title: `Search papers: ${args.query}`,
          kind: "search",
          rawInput: args.query,
        };
      },
      async execute(args, exec) {
        const rows = Math.min(Math.max(args.rows ?? config.searchRows, 1), 50);
        const requested = args.sources?.length ? args.sources : config.searchProviders;
        const signal = budget(exec, config.timeoutMs * 3);
        const result = await multiSourceSearch(args.query, config, signal, {
          rows,
          providers: requested,
          yearFrom: args.year_from,
          yearTo: args.year_to,
        });
        return formatSearchResult(result);
      },
    }),
  );

  // -------------------------------------------------------------------------
  // sevastopol36_scihub_resolve
  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_scihub_resolve",
      description:
        "Resolve any paper identifier into the complete identifier set. Accepts a DOI, PMID, PMCID, arXiv id, a doi.org / pubmed.ncbi.nlm.nih.gov / pmc.ncbi.nlm.nih.gov / arxiv.org URL, or a title. Returns DOI + PMID + PMCID + arXiv id, citation links, and (with check_locations) the live open-access PDF locations. Use when you have one identifier and need another, or before sevastopol36_scihub_fetch to confirm the record.",
      parameters: {
        id: {
          type: "string",
          required: true,
          description:
            "DOI (10.1038/nature12373), PMID (23883930), PMCID (PMC4221854), arXiv id (1712.08900), any of those URLs, or an exact paper title",
        },
        check_locations: {
          type: "boolean",
          description: "Also query the open-access locators for live PDF URLs (slower, adds a few seconds)",
        },
      },
      output: stringOut,
      presentCall(args) {
        return {
          card: "generic",
          title: `Resolve identifier: ${args.id}`,
          kind: "search",
          rawInput: args.id,
        };
      },
      async execute(args, exec) {
        const signal = budget(exec, config.timeoutMs * 6);
        const ids = await resolveIdentifiers(String(args.id), config, signal);
        let live = null;
        if (args.check_locations) {
          live = [];
          const push = (source, url) => url && live.push({ source, url });
          if (ids.pmcid) {
            try {
              for (const u of await pmcFullTextUrls(ids.pmcid, { userAgent: config.userAgent, signal, email: config.email })) {
                push("PMC", u);
              }
            } catch {
              /* best-effort */
            }
          }
          if (ids.doi) {
            try {
              const up = await unpaywallPdfUrls(ids.doi, { userAgent: config.userAgent, signal, email: config.email });
              for (const u of up.pdfUrls) push(`Unpaywall(${up.oaStatus || "oa"})`, u);
            } catch {
              /* best-effort */
            }
            try {
              const w = await openalexByDoi(ids.doi, { userAgent: config.userAgent, signal, email: config.email });
              for (const u of w?.oaPdfUrls ?? []) push("OpenAlex", u);
            } catch {
              /* best-effort */
            }
            try {
              const p = await semanticScholarPaper(`DOI:${ids.doi}`, { userAgent: config.userAgent, signal, email: config.email });
              for (const u of p?.oaPdfUrls ?? []) push("Semantic Scholar", u);
            } catch {
              /* best-effort */
            }
          }
          live = [...new Map(live.map((l) => [l.url, l])).values()];
          if (live.length) ids.isOpenAccess = true;
        }
        return formatResolve({ ids, candidates: ids.candidates }, live);
      },
    }),
  );

  // -------------------------------------------------------------------------
  // sevastopol36_scihub_fetch
  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_scihub_fetch",
      description:
        "Download a paper's full text and save it locally. Accepts a DOI, PMID, PMCID, arXiv id, doi.org / pubmed / pmc / arxiv URL, or an exact title (resolved via Crossref with a confidence check). Tries the Sci-Hub mirrors first, then the open-access routes (bioRxiv/medRxiv, PMC, Europe PMC, Unpaywall, OpenAlex, Semantic Scholar, publisher), then ar5iv HTML. Returns the saved file path, the source used, and the routes that failed.",
      parameters: {
        doi: { type: "string", description: "The paper's DOI, e.g. 10.1038/nature12373" },
        pmid: { type: "string", description: "PubMed id, e.g. 23883930" },
        pmcid: { type: "string", description: "PMC id, e.g. PMC4221854" },
        arxiv: { type: "string", description: "arXiv id, e.g. 1712.08900" },
        title: {
          type: "string",
          description: "Exact paper title; resolved via Crossref with a confidence check before downloading",
        },
        url: {
          type: "string",
          description: "A doi.org / dx.doi.org / publisher / pubmed / pmc / arxiv.org URL",
        },
        only_sources: {
          type: "array",
          items: { type: "string" },
          description:
            "Restrict the route list, e.g. ['scihub'] to force Sci-Hub only, or ['unpaywall','pmc','europepmc','arxiv','openalex','semanticscholar','publisher','preprint','ar5iv'] for open access only",
        },
        force: {
          type: "boolean",
          description: "Re-download even when the destination file already exists (default false: reuse the local copy)",
        },
      },
      output: stringOut,
      presentCall(args) {
        const shown = args.doi || args.pmid || args.pmcid || args.arxiv || args.title || args.url || "(no id)";
        return { card: "generic", title: `Fetch paper: ${shown}`, kind: "fetch", rawInput: shown };
      },
      async execute(args, exec) {
        const signal = budget(exec, config.timeoutMs * 12);
        const result = await fetchFullText(args, config, signal, {
          onlySources: args.only_sources,
          force: args.force === true,
        });
        return formatFetch(result);
      },
    }),
  );

  // -------------------------------------------------------------------------
  // sevastopol36_scihub_probe
  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_scihub_probe",
      description:
        "Live diagnostics for this plugin. For every configured Sci-Hub mirror it fetches the article page, DOWNLOADS the advertised PDF and verifies the file really is the requested paper, reporting latency and the exact failure reason. It also checks reachability of the metadata/open-access channels (Crossref, OpenAlex, Europe PMC, Unpaywall, PubMed, Semantic Scholar, PMC, arXiv, bioRxiv, DOAJ) and runs a concurrent-PubMed burst to surface rate limiting. Run this when downloads start failing, then apply the suggested `mirrors` list.",
      parameters: {
        doi: {
          type: "string",
          description: "DOI used for the mirror probe (default 10.1038/nature12373, a paper present in Sci-Hub)",
        },
        include_known_dead: {
          type: "boolean",
          description:
            "Also probe the mirrors documented as dead (domain gone) or on-site-dead (answers but serves no PDF), to re-verify whether one came back",
        },
        channels_only: { type: "boolean", description: "Skip the mirror probe and check only the API channels" },
        link_check_only: {
          type: "boolean",
          description:
            "Only check that mirrors offer a PDF link; skip downloading and content-verifying the file (much faster, but cannot tell a wrong paper from a right one)",
        },
      },
      output: stringOut,
      presentCall(args) {
        return {
          card: "generic",
          title: `Probe literature sources${args.doi ? `: ${args.doi}` : ""}`,
          kind: "execute",
        };
      },
      async execute(args, exec) {
        const signal = budget(exec, config.timeoutMs * 8);
        const parts = [];
        if (!args.channels_only) {
          const rows = await probeMirrors(args.doi || "10.1038/nature12373", config, signal, {
            includeKnownDead: args.include_known_dead === true,
            verify: args.link_check_only !== true,
          });
          parts.push(formatProbeMirrors(rows, args.doi || "10.1038/nature12373"));
        }
        const channels = await probeChannels(config, signal);
        parts.push(formatProbeChannels(channels));
        return parts.join("\n\n");
      },
    }),
  );

  // -------------------------------------------------------------------------
  // sevastopol36_scihub_sources
  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_scihub_sources",
      description:
        "List every source this plugin can use: metadata/search providers, open-access full-text routes, Sci-Hub mirrors in configured order, and the mirrors documented as dead. Use to explain coverage or to see what a `sevastopol36_scihub_fetch` failure actually tried.",
      parameters: {},
      output: stringOut,
      presentCall() {
        return { card: "generic", title: "List literature sources", kind: "read" };
      },
      async execute() {
        const sciHubFirst = config.preferSciHub !== false;
        const oaEnabled = config.openAccessFallback !== false;
        const oaRoutes = [
          "bioRxiv / medRxiv preprint PDF",
          "PubMed Central (PMC) PDF",
          "Europe PMC OA PDF",
          "Unpaywall — every OA location",
          "OpenAlex OA locations",
          "Semantic Scholar openAccessPdf",
          "Publisher landing page (citation_pdf_url)",
        ];
        const routeLines = sciHubFirst
          ? [
              "  1. arXiv PDF (when an arXiv id is known)",
              "  2. Sci-Hub mirrors (primary route; see the list below)",
              ...oaRoutes.map((r, i) => `  ${i + 3}. ${r}${oaEnabled ? "" : "   [disabled: openAccessFallback=false]"}`),
              `  ${oaRoutes.length + 3}. ar5iv full-text HTML (arXiv PDF unreachable)`,
            ]
          : [
              "  1. arXiv PDF (when an arXiv id is known)",
              ...oaRoutes.map((r, i) => `  ${i + 2}. ${r}${oaEnabled ? "" : "   [disabled: openAccessFallback=false]"}`),
              `  ${oaRoutes.length + 2}. Sci-Hub mirrors (preferSciHub=false, so tried last)`,
              `  ${oaRoutes.length + 3}. ar5iv full-text HTML`,
            ];
        const lines = [
          "## Metadata / search providers",
          ...Object.entries(SEARCH_PROVIDERS).map(
            ([key, v]) =>
              `  ${providers.includes(key) ? "[x]" : "[ ]"} ${key.padEnd(16)} ${v.label}${providers.includes(key) ? "" : "  (available, not in default fan-out)"}`,
          ),
          "",
          "## Full-text routes (tried in this order)",
          ...routeLines,
          "",
          "## Sci-Hub mirrors (in configured order)",
          ...(config.mirrors ?? DEFAULT_MIRRORS).map((m, i) => `  ${String(i + 1).padStart(2)}. ${m}`),
          "",
          "## Mirrors documented as dead / parked (re-check with sevastopol36_scihub_probe include_known_dead=true)",
          `  ${KNOWN_DEAD_MIRRORS.join(", ")}`,
          "",
          "## Configuration",
          `  preferSciHub:       ${sciHubFirst}   ${sciHubFirst ? "(Sci-Hub is tried first)" : "(open access is tried first)"}`,
          `  openAccessFallback: ${oaEnabled}`,
          `  downloadDir:        ${config.downloadDir}`,
          `  timeoutMs:          ${config.timeoutMs}`,
          `  searchRows:         ${config.searchRows}`,
          `  email:              ${config.email}`,
          `  contact (Crossref): ${CONTACT_EMAIL}`,
          `  allowHtmlFallback:  ${config.allowHtmlFallback}`,
          `  titleConfidence:    ${config.titleConfidence}`,
        ];
        return lines.join("\n");
      },
    }),
  );
}

export { Config, apply, inject, name };

// Internals re-exported for tests and advanced callers; the Cordis loader reads
// only name/inject/Config/apply.
export {
  DEFAULT_MIRRORS,
  KNOWN_DEAD_MIRRORS,
  fetchFullText,
  multiSourceSearch,
  probeChannels,
  probeMirrors,
  resolveIdentifiers,
};
export { extractDoi, extractArxivId, extractPmid, extractPmcid, extractPdfUrl, downloadPdfBuffer, classifyIdentifier } from "./util.mjs";
export { crossrefSearch, crossrefWork, pubmedSearch, europePmcSearch, openalexSearch, semanticScholarSearch, arxivApi } from "./sources.mjs";
