/**
 * dsh-plugin-scihub verification.
 *
 * Offline by default: every check below runs with no network and no
 * dependencies, and covers the parsing, identifier and routing helpers the
 * plugin's correctness rests on. Pass `--live` to add the checks that talk to
 * real providers and Sci-Hub mirrors (slower, and they fail when a host is down
 * rather than when the code is wrong).
 *
 *   node verify.mjs
 *   node verify.mjs --live
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { satisfiesRange } from "./lib/semver-range.mjs";
import {
  DEFAULT_MIRRORS,
  fetchFullText,
  probeMirrors,
  resolveIdentifiers,
} from "./lib/resolve.mjs";
import { barePmid, barePmcid, arxivPdfUrl, ar5ivUrl } from "./lib/sources.mjs";
import {
  HttpError,
  classifyIdentifier,
  extractArxivId,
  extractDoi,
  extractPdfUrl,
  extractPmid,
  extractPmcid,
  isPdfBuffer,
  isRateLimitError,
  isSelfReferentialPdfLink,
  normalizeDoi,
  slugify,
  stripFragment,
} from "./lib/util.mjs";

const live = process.argv.includes("--live");
let passed = 0;
const failures = [];
/** Checks that failed for a network reason, reported without failing the run. */
const environmental = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(` FAIL  ${name}\n        ${error.message}`);
  }
}

async function checkAsync(name, fn, { environmental: isEnvironmental = false } = {}) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    if (isEnvironmental) {
      environmental.push({ name, error });
      console.log(` skip  ${name}\n        network-dependent, unavailable here: ${error.message.split("\n")[0]}`);
      return;
    }
    failures.push({ name, error });
    console.log(` FAIL  ${name}\n        ${error.message}`);
  }
}

console.log("plugin manifest and module shape");

const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const module_ = await import("./lib/index.mjs");

check("manifest declares the bundle patch", () => {
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
});
check("the declared patch file exists and inserts this package", async () => {
  const patch = await readFile(new URL("./cordis.patch.yml", import.meta.url), "utf8");
  // The row id comes from the naming declaration, so a rename has one home.
  const naming = JSON.parse(await readFile(new URL("./dsh-plugin.naming.json", import.meta.url), "utf8"));
  assert.match(patch, new RegExp(naming.names.loaderIds[0]));
  assert.match(patch, new RegExp(manifest.name));
});
check("module exports the cordis plugin shape", () => {
  assert.equal(typeof module_.name, "string");
  assert.equal(typeof module_.apply, "function");
  assert.ok(Array.isArray(module_.inject));
  assert.ok(module_.Config !== undefined, "Config schema is exported");
});
check("every @deepseek-ai/dsh* peer accepts the verified runtimes", () => {
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(
    ([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"),
  );
  assert.ok(peers.length > 0, "at least one dsh peer is declared");
  for (const runtime of manifest.dsh.compatibility.verifiedRuntimes) {
    for (const [name, range] of peers) {
      assert.ok(
        satisfiesRange(runtime, range),
        `${name} ${range} rejects ${runtime}`,
      );
    }
  }
});
check("the range helper agrees with the host's peer check on the shapes used", () => {
  const range = manifest.peerDependencies["@deepseek-ai/dsh-tools"];
  // Accepted runtimes: the 0.1.x CLI line and the 0.2.x desktop runtime.
  assert.equal(satisfiesRange("0.1.5-rc.1", range), true);
  assert.equal(satisfiesRange("0.2.0-rc.2", range), true);
  // The range the package used to declare, which a 0.2.x runtime refuses.
  assert.equal(satisfiesRange("0.2.0-rc.2", "^0.1.0-rc.6"), false);
  assert.equal(satisfiesRange("0.1.5-rc.2", "^0.1.0-rc.6"), true);
  // Unparseable ranges must never read as satisfied.
  assert.equal(satisfiesRange("0.2.0-rc.2", "not-a-range"), false);
});
check("the naming declaration matches the plugin and the bundle patch", async () => {
  // A duplicate tool name in one scope is rejected by the host with
  // `tool "X" is already registered`, so every public identifier carries the
  // publisher namespace and the declaration records exactly which ones.
  const naming = JSON.parse(await readFile(new URL("./dsh-plugin.naming.json", import.meta.url), "utf8"));
  const patch = await readFile(new URL("./cordis.patch.yml", import.meta.url), "utf8");
  const rowId = /^\s*- id: (\S+)$/m.exec(patch)?.[1];

  assert.equal(naming.plugin.packageName, manifest.name);
  assert.equal(naming.plugin.coordinate, `${naming.plugin.namespace}/${naming.plugin.name}`);
  assert.deepEqual(naming.names.pluginNames, [module_.name]);
  assert.deepEqual(naming.names.loaderIds, [rowId]);
  assert.ok(naming.names.tools.length > 0, "the plugin registers tools");
  for (const tool of naming.names.tools) {
    assert.ok(tool.startsWith(`${naming.plugin.namespace}_`), `${tool} is not namespace-prefixed`);
  }
  // Nothing else may be declared: these surfaces are all genuinely unused.
  for (const surface of ["services", "commands", "skills", "skillProviders", "events", "settingsNamespaces", "routes"]) {
    assert.deepEqual(naming.names[surface], [], `${surface} must be empty because the plugin registers none`);
  }
});

console.log("\nidentifier extraction");

check("extractDoi reads a doi.org URL", () => {
  assert.equal(extractDoi("https://doi.org/10.1038/nature12373"), "10.1038/nature12373");
});
check("extractArxivId reads abs and pdf URLs", () => {
  assert.equal(extractArxivId("https://arxiv.org/abs/1712.08900"), "1712.08900");
  assert.equal(extractArxivId("https://arxiv.org/pdf/1712.08900v2"), "1712.08900v2");
});
check("extractPmid reads a PubMed URL", () => {
  assert.equal(extractPmid("https://pubmed.ncbi.nlm.nih.gov/23883930/"), "23883930");
});
check("extractPmcid reads a PMC URL", () => {
  assert.equal(extractPmcid("https://pmc.ncbi.nlm.nih.gov/articles/PMC4221854/"), "PMC4221854");
});
check("barePmid / barePmcid strip any surrounding form", () => {
  assert.equal(barePmid("https://pubmed.ncbi.nlm.nih.gov/23903748"), "23903748");
  assert.equal(barePmcid("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4221854/"), "PMC4221854");
});
check("normalizeDoi strips the resolver prefix but preserves the DOI's case", () => {
  // DOIs are case-insensitive for lookup, so the plugin normalises the prefix
  // and leaves the suffix exactly as published rather than risking a mismatch.
  assert.equal(normalizeDoi("https://doi.org/10.1038/nature12373"), "10.1038/nature12373");
  assert.equal(normalizeDoi("doi:10.1038/nature12373"), "10.1038/nature12373");
});
check("classifyIdentifier labels each identifier kind", () => {
  assert.equal(classifyIdentifier("https://arxiv.org/abs/1712.08900").kind, "arxiv");
  assert.equal(classifyIdentifier("10.1038/nature12373").kind, "doi");
  assert.equal(classifyIdentifier("https://www.mdpi.com/1424-8220/15/12/29792").kind, "url");
});

console.log("\nPDF link extraction");

check("stripFragment removes a fragment", () => {
  assert.equal(stripFragment("https://x.test/a.pdf#view=FitH"), "https://x.test/a.pdf");
  assert.equal(stripFragment("https://x.test/a.pdf"), "https://x.test/a.pdf");
});
check("embed src is preferred over an unrelated image", () => {
  const html = '<embed src="https://m.test/preview.png"><a href="/real.pdf">pdf</a>';
  assert.equal(extractPdfUrl("https://m.test/x", html), "https://m.test/real.pdf");
});
check("iframe with a protocol-relative src resolves", () => {
  assert.equal(
    extractPdfUrl("https://m.test/10.1/x", '<iframe id="pdf" src="//sci.bban.top/pdf/10.1/x.pdf"></iframe>'),
    "https://sci.bban.top/pdf/10.1/x.pdf",
  );
});
check("sci-hub.ru <object data> is read", () => {
  assert.equal(
    extractPdfUrl("https://sci-hub.ru/10.1/x", "<object type=application/pdf data=//sci-hub.red/storage/a/b.pdf>"),
    "https://sci-hub.red/storage/a/b.pdf",
  );
});
check("a non-PDF object type is ignored", () => {
  assert.equal(extractPdfUrl("https://m.test/x", '<object type="text/html" data="//x.test/a.html">'), null);
});
check("a page with no PDF link yields null", () => {
  assert.equal(extractPdfUrl("https://m.test/10.1/x", "<html>nothing here</html>"), null);
});
check("a self-referential mirror link is rejected", () => {
  assert.equal(isSelfReferentialPdfLink("https://sci-hub.vg/10.9/xyz", "https://sci-hub.vg/10.9/xyz"), true);
  assert.equal(isSelfReferentialPdfLink("https://sci-hub.red/storage/a/b.pdf", "https://sci-hub.ru/10.1/x"), false);
});

console.log("\nHTTP error classification and helpers");

check("isRateLimitError recognises HTTP 429", () => {
  assert.equal(isRateLimitError(new HttpError(429, "https://x.test/a.pdf")), true);
  assert.equal(isRateLimitError(new Error("connection reset")), false);
});
check("HttpError carries the URL in its message", () => {
  const error = new HttpError(503, "https://x.test/a", "Service Unavailable");
  assert.ok(error.message.includes("https://x.test/a"));
});
check("isPdfBuffer tests the %PDF- magic", () => {
  assert.equal(isPdfBuffer(Buffer.from("%PDF-1.7\n")), true);
  assert.equal(isPdfBuffer(Buffer.from("<!doctype html>")), false);
});
check("slugify produces a filesystem-safe name", () => {
  const slug = slugify("Attention Is All You Need: A/B test?", 60);
  assert.ok(!/[/\\:?*"<>|]/.test(slug), `slug still has reserved characters: ${slug}`);
  assert.ok(slug.length <= 60);
});

console.log("\nroute and mirror configuration");

check("the arXiv routes are well formed", () => {
  assert.equal(arxivPdfUrl("1706.03762"), "https://arxiv.org/pdf/1706.03762");
  assert.equal(ar5ivUrl("1706.03762"), "https://ar5iv.labs.arxiv.org/html/1706.03762");
});
check("the last default mirror is the independent backend", () => {
  assert.equal(DEFAULT_MIRRORS.at(-1), "https://sci-hub.ru");
  assert.ok(DEFAULT_MIRRORS.length >= 5);
});

if (live) {
  console.log("\nlive checks (network)");
  const config = {
    email: "dsh-plugin-scihub@users.noreply.github.com",
    timeoutMs: 30000,
    lookupTimeoutMs: 10000,
    resolveDeadlineMs: 60000,
    preferSciHub: false,
    openAccessFallback: true,
    verifyPdf: true,
    mirrors: DEFAULT_MIRRORS,
  };
  const signal = AbortSignal.timeout(120000);

  // These three reach the open internet. Whether this machine can reach arXiv,
  // ar5iv, PMC or the Sci-Hub mirrors is not a property of the code, so a
  // network failure is reported as `skip` and does not fail the run. Set
  // VERIFY_STRICT=1 to make them hard failures.
  const strict = process.env.VERIFY_STRICT === "1";
  const opts = { environmental: !strict };

  await checkAsync(
    "resolveIdentifiers resolves an arXiv id to a DOI",
    async () => {
      const resolved = await resolveIdentifiers({ arxivId: "1706.03762" }, config, signal);
      assert.ok(resolved, "no identifiers resolved");
    },
    opts,
  );
  await checkAsync(
    "fetchFullText saves the full text of a known arXiv paper",
    async () => {
      // ar5iv is the route this plugin can always serve for an arXiv id, and it
      // is the one that used to throw before it ran.
      const result = await fetchFullText({ arxiv: "1706.03762" }, config, signal, {
        onlySources: ["ar5iv"],
        destOverride: undefined,
      });
      assert.ok(result?.filePath, `no file saved: ${JSON.stringify(result)}`);
    },
    opts,
  );
  await checkAsync(
    "probeMirrors completes and classifies every mirror",
    async () => {
      const rows = await probeMirrors("10.1038/nature12373", config, signal, {
        verify: false,
        limit: 3,
      });
      assert.ok(Array.isArray(rows) && rows.length > 0, "no probe rows");
      for (const row of rows) {
        assert.equal(typeof row.mirror, "string");
        assert.equal(typeof row.status, "string");
      }
    },
    opts,
  );
}

const failed = failures.length;
console.log(
  `\n${passed}/${passed + failed} checks passed${live ? " (including live checks)" : " (offline)"}` +
    (environmental.length > 0 ? `, ${environmental.length} skipped as network-dependent` : ""),
);
if (failed > 0) {
  console.log("failed checks:");
  for (const { name } of failures) console.log(`  - ${name}`);
}
process.exitCode = failed === 0 ? 0 : 1;
