#!/usr/bin/env node
/**
 * repo-metrics.mjs: regenerate every published number in the documentation.
 *
 * Zero dependencies, read-only, deterministic. Node >= 22.
 *
 * The point of this script is that nobody has to trust the README. Every count
 * it prints is derived here, the counting rules are published alongside the
 * numbers, and `--check` fails if the committed docs have drifted from the code.
 *
 *   node scripts/repo-metrics.mjs           # markdown report to stdout
 *   node scripts/repo-metrics.mjs --write   # rewrite portfolio/METRICS.md + the README table
 *   node scripts/repo-metrics.mjs --check   # exit 1 if the committed docs are stale
 *   node scripts/repo-metrics.mjs --json    # raw object
 *
 * The file set comes from `git ls-files`, not from a raw directory walk, so that
 * a fresh clone reproduces the numbers exactly: gitignored local files such as
 * .dev.vars must never move a published figure. Metrics are still derived from
 * file contents rather than from git history, because this repository is
 * published as a snapshot and has no history to read.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const METRICS_DOC = join(ROOT, "portfolio", "METRICS.md");
const README = join(ROOT, "README.md");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".wrangler", ".wrangler-demo", "dist", "coverage",
  "test-results", "playwright-report", ".vitest-cache", ".playwright-cli", ".playwright-mcp",
]);
const SKIP_FILES = new Set(["package-lock.json"]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2", ".pdf", ".zip"]);

// Directory holding the migrations that actually build the deployed database.
const LIVE_MIGRATION_DIR = "migrations";
// A staged subset of the above, re-stated for the phased rollout. It never adds
// objects to the live schema, so it must not add objects to the published counts.
const STAGED_MIGRATION_DIR = "migrations_phase1";

// ---------------------------------------------------------------------------
// Counting rules. These are published verbatim in portfolio/METRICS.md so that any
// number below can be re-derived by a reader who disagrees with them.
// ---------------------------------------------------------------------------
const RULES = {
  files:
    "The file set is whatever `git ls-files` reports, so gitignored and untracked files (`.dev.vars`, local " +
    "scratch output) can never move a published number and a fresh clone reproduces these counts exactly. " +
    "If git is unavailable the script falls back to walking the working tree. Either way node_modules, build " +
    "output, and package-lock.json are excluded. Binary assets (screenshots) are counted as files but " +
    "contribute no lines.",
  loc: "Physical lines: the count of newline-terminated lines in the file. Blank lines and comments are included.",
  split:
    "Files are classified by role, in this order. TEST: path under tests/ or basename matching " +
    "*.test.* / *.spec.*. CONFIG: basename matching *.config.* or one of package.json, tsconfig.json, " +
    ".eslintrc.cjs, wrangler.jsonc, wrangler.phase1.jsonc, .gitignore, .gitattributes. " +
    "SCHEMA: under migrations/ or migrations_phase1/. TOOLING: under scripts/, meaning ops, verifiers, and " +
    "the demo/screenshot harness. DOCS: under portfolio/ or docs/, plus the root markdown files and " +
    "LICENSE. " +
    "APPLICATION: everything else, which is src/ and admin/src/. " +
    "The headline test ratio compares APPLICATION to TEST, because comparing tests against ops " +
    "scripts and documentation would flatter the number without meaning anything.",
  tests:
    "Line-anchored regex over test files. Cases: /^\\s*(it|test)(\\.\\w+)?\\s*\\(/gm  " +
    "Suites: /^\\s*describe(\\.\\w+)?\\s*\\(/gm . Line-anchoring is why this number is lower " +
    "than a naive substring count: it ignores it(...) appearing mid-expression or inside strings. " +
    "Cases are bucketed by the command that runs them: UNIT is tests/unit/ (`npm test`), COMPONENT is " +
    "admin/src/ (`npm run test:admin`), END-TO-END is tests/e2e/ (`npm run test:e2e`), and SCREENSHOT is " +
    "tests/screenshots/, which none of those three commands runs because it belongs to the screenshot " +
    "capture harness. Screenshot specs are reported separately so they cannot pad the figure for the suites " +
    "that gate the build. " +
    "This counts test cases as DECLARED in source. Vitest expands parameterized `it.each` tables at " +
    "runtime, so the number of tests actually executed is higher than the number declared. Run the " +
    "suites yourself and expect a larger figure, not a smaller one.",
  endpoints:
    "Regex /^\\s*(\\w+)\\.(get|post|put|patch|delete|all)\\s*\\(/gm over src/worker.ts and src/routes/**. " +
    "A match is a 404 GUARD if its handler body contains 404; it is the SPA FALLBACK if it is " +
    'app.all("*"); otherwise it is a real endpoint. Guards and the fallback are reported separately ' +
    "so the endpoint count is not inflated by routing scaffolding.",
  schema:
    "Live object counts are produced by replaying migrations/ in filename order and applying each CREATE, " +
    "DROP, and ALTER TABLE ... RENAME TO in the order it appears, exactly as SQLite would. So an object that " +
    "a later statement drops is not counted, a table-rebuild temporary named <table>_new is counted under the " +
    "name it is renamed to rather than as an extra table, and dropping a table also drops the indexes and " +
    "triggers attached to it. migrations_phase1/ is a staged subset of the same work, re-stated for the phased " +
    "rollout, so its statements are included in the raw statement totals but contribute no objects to the live " +
    "schema. Raw statement counts and live object counts are published side by side and the difference between " +
    "them is itemised rather than asserted. CHECK, REFERENCES, and RAISE(ABORT) figures are raw declaration " +
    "counts across every migration statement in both directories, not live-schema counts.",
};

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

/**
 * Fallback only. Enumerates the working tree directly, which honours neither git
 * nor .gitignore, so it can see local files that are absent from a fresh clone.
 * Used when git is unavailable or this directory is not a repository yet.
 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (!SKIP_FILES.has(entry)) out.push(p);
  }
  return out;
}

/** Tracked files only, relative to ROOT, forward-slashed by git. */
function gitTrackedFiles() {
  const stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

/**
 * Preferred path: ask git for the tracked file set, so gitignored local files
 * cannot change a published number and `--check` still passes on a fresh clone.
 * SKIP_DIRS / SKIP_FILES are applied on top as a safety net in case build output
 * is ever committed by accident.
 */
function listFiles() {
  let rels;
  try {
    rels = gitTrackedFiles();
    if (rels.length === 0) throw new Error("git reported no tracked files");
  } catch {
    // FALLBACK: git is missing, or this is not a repository (or has no index yet).
    // The working-tree walk is not reproducible across clones, because it counts
    // gitignored files, so it exists purely so the script still runs at all.
    rels = walk(ROOT).map((p) => relative(ROOT, p).split(sep).join("/"));
  }

  const seen = new Set();
  const out = [];
  for (const rel of rels) {
    const parts = rel.split("/");
    if (parts.some((segment) => SKIP_DIRS.has(segment))) continue;
    if (SKIP_FILES.has(parts[parts.length - 1])) continue;
    if (seen.has(rel)) continue;
    // Tolerate index entries with no file on disk (submodule gitlinks, a
    // half-applied checkout) rather than crashing the whole report.
    if (!existsSync(join(ROOT, rel))) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out.sort();
}

const CONFIG_BASENAMES = new Set([
  "package.json", "tsconfig.json", ".eslintrc.cjs", "wrangler.jsonc",
  "wrangler.phase1.jsonc", ".gitignore", ".gitattributes",
]);

function classify(rel) {
  const base = basename(rel);
  const unix = rel.split(sep).join("/");
  if (unix.startsWith("tests/") || /\.(test|spec)\./.test(base)) return "test";
  if (/\.config\./.test(base) || CONFIG_BASENAMES.has(base)) return "config";
  if (unix.startsWith("migrations")) return "schema";
  if (unix.startsWith("scripts/")) return "tooling";
  if (unix.startsWith("docs/") || unix.startsWith("portfolio/")) return "docs";
  // Root-level prose: the markdown files, plus LICENSE/NOTICE, which have no
  // extension and would otherwise fall through and be counted as application code.
  if (!unix.includes("/") && (extname(base) === ".md" || base === "LICENSE" || base === "NOTICE")) return "docs";
  return "application";
}

function area(rel) {
  const unix = rel.split(sep).join("/");
  if (unix.startsWith("src/")) return "src/ (Cloudflare Worker)";
  if (unix.startsWith("admin/src/")) return "admin/src/ (React admin SPA)";
  if (unix.startsWith("tests/")) return "tests/ (unit, e2e, screenshots)";
  if (unix.startsWith("migrations")) return "migrations/ (D1 schema)";
  if (unix.startsWith("scripts/")) return "scripts/ (ops + verifiers)";
  if (unix.startsWith("docs/")) return "docs/ (screenshots + working notes)";
  if (unix.startsWith("portfolio/")) return "portfolio/ (the write-ups)";
  return "root + config";
}

function countLines(text) {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (!text.endsWith("\n")) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Schema: replay the migrations instead of counting CREATE statements.
//
// Counting CREATE statements over-reports the live schema in four different
// ways at once (rebuild temporaries, objects dropped by a later statement,
// objects dropped and recreated, and the staged migrations_phase1/ restatement),
// so the only defensible way to publish a live figure is to apply the DDL in
// order and see what is left standing.
// ---------------------------------------------------------------------------
const Q = String.raw`["'\`\[]?`; // optional opening quote/bracket on an identifier
const QC = String.raw`["'\`\]]?`; // optional closing quote/bracket on an identifier
const DDL_RE = new RegExp(
  [
    String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${Q}(?<createTable>\w+)`,
    String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${Q}(?<dropTable>\w+)`,
    String.raw`ALTER\s+TABLE\s+${Q}(?<renameFrom>\w+)${QC}\s+RENAME\s+TO\s+${Q}(?<renameTo>\w+)`,
    String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${Q}(?<createIndex>\w+)${QC}\s+ON\s+${Q}(?<createIndexOn>\w+)`,
    String.raw`DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?${Q}(?<dropIndex>\w+)`,
    String.raw`CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?${Q}(?<createTrigger>\w+)${QC}[^;]*?\bON\s+${Q}(?<createTriggerOn>\w+)`,
    String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${Q}(?<dropTrigger>\w+)`,
  ].join("|"),
  "gi",
);

/** Ordered DDL events for one .sql file. */
function parseDdl(text) {
  const events = [];
  for (const m of text.matchAll(DDL_RE)) {
    const g = m.groups;
    if (g.createTable) events.push({ op: "create", kind: "table", name: g.createTable });
    else if (g.dropTable) events.push({ op: "drop", kind: "table", name: g.dropTable });
    else if (g.renameFrom) events.push({ op: "rename", kind: "table", name: g.renameFrom, to: g.renameTo });
    else if (g.createIndex) events.push({ op: "create", kind: "index", name: g.createIndex, on: g.createIndexOn });
    else if (g.dropIndex) events.push({ op: "drop", kind: "index", name: g.dropIndex });
    else if (g.createTrigger) events.push({ op: "create", kind: "trigger", name: g.createTrigger, on: g.createTriggerOn });
    else if (g.dropTrigger) events.push({ op: "drop", kind: "trigger", name: g.dropTrigger });
  }
  return events;
}

/**
 * Apply the live migration directory in filename order and return the objects
 * that survive, mirroring SQLite semantics: DROP TABLE also removes the indexes
 * and triggers attached to that table, and RENAME carries them across.
 */
function replayLiveSchema(liveFiles) {
  const tables = new Set();
  const indexes = new Map(); // index name -> owning table
  const triggers = new Map(); // trigger name -> owning table

  const dropOwnedBy = (table) => {
    for (const [name, owner] of indexes) if (owner === table) indexes.delete(name);
    for (const [name, owner] of triggers) if (owner === table) triggers.delete(name);
  };

  for (const { events } of liveFiles) {
    for (const e of events) {
      if (e.kind === "table") {
        if (e.op === "create") tables.add(e.name);
        else if (e.op === "drop") { tables.delete(e.name); dropOwnedBy(e.name); }
        else if (e.op === "rename") {
          tables.delete(e.name);
          tables.add(e.to);
          for (const [name, owner] of indexes) if (owner === e.name) indexes.set(name, e.to);
          for (const [name, owner] of triggers) if (owner === e.name) triggers.set(name, e.to);
        }
      } else if (e.kind === "index") {
        if (e.op === "create") indexes.set(e.name, e.on);
        else indexes.delete(e.name);
      } else if (e.kind === "trigger") {
        if (e.op === "create") triggers.set(e.name, e.on);
        else triggers.delete(e.name);
      }
    }
  }
  return { table: tables, index: new Set(indexes.keys()), trigger: new Set(triggers.keys()) };
}

/**
 * Itemise the gap between "CREATE statements written" and "objects that exist".
 * The five buckets are exhaustive by construction, so raw minus their sum always
 * equals the live count. That is what makes the published sentence checkable
 * rather than a hand-waved excuse for a mismatch.
 */
function explainDelta(kind, liveFiles, stagedFiles, liveSet) {
  const b = { raw: 0, rebuildTemporaries: 0, recreated: 0, createdThenDropped: 0, stagedRestated: 0, stagedOnly: 0 };

  const liveCreatesByName = new Map();
  for (const { events } of liveFiles) {
    for (const e of events) {
      if (e.op !== "create" || e.kind !== kind) continue;
      b.raw++;
      liveCreatesByName.set(e.name, (liveCreatesByName.get(e.name) ?? 0) + 1);
    }
  }
  for (const [name, n] of liveCreatesByName) {
    if (liveSet.has(name)) b.recreated += n - 1; // one statement is the live object, the rest are rebuilds
    else if (kind === "table" && name.endsWith("_new")) b.rebuildTemporaries += n;
    else b.createdThenDropped += n;
  }

  for (const { events } of stagedFiles) {
    for (const e of events) {
      if (e.op !== "create" || e.kind !== kind) continue;
      b.raw++;
      if (liveSet.has(e.name)) b.stagedRestated++;
      else b.stagedOnly++;
    }
  }

  b.live = liveSet.size;
  return b;
}

const PLURAL = {
  table: ["table", "tables", "CREATE TABLE"],
  index: ["index", "indexes", "CREATE INDEX"],
  trigger: ["trigger", "triggers", "CREATE TRIGGER"],
};

/** Human-readable, generated from the numbers rather than asserted alongside them. */
function deltaSentence(kind, b) {
  const [one, many, stmt] = PLURAL[kind];
  const head = `- **${b.live}** ${b.live === 1 ? one : many} in the live schema, declared by ${b.raw} \`${stmt}\` statements.`;
  const gap = b.raw - b.live;
  if (gap === 0) return `${head} Every statement produces exactly one live object.`;

  const parts = [];
  const add = (n, singular, plural) => { if (n) parts.push({ n, text: n === 1 ? singular : plural }); };
  add(b.rebuildTemporaries,
    "SQLite table-rebuild temporary (`_new`), counted under the name it is renamed to",
    "SQLite table-rebuild temporaries (`_new`), counted under the names they are renamed to");
  add(b.recreated,
    `re-declaration by a later migration that drops and recreates the same ${one}`,
    `re-declarations by later migrations that drop and recreate the same ${one}`);
  add(b.createdThenDropped,
    `${one} created and then dropped again, so never present in the live schema`,
    `${many} created and then dropped again, so never present in the live schema`);
  add(b.stagedRestated,
    `re-statement in the staged \`${STAGED_MIGRATION_DIR}/\` subset`,
    `re-statements in the staged \`${STAGED_MIGRATION_DIR}/\` subset`);
  add(b.stagedOnly,
    `declaration found only in \`${STAGED_MIGRATION_DIR}/\`, which the live \`${LIVE_MIGRATION_DIR}/\` sequence supersedes`,
    `declarations found only in \`${STAGED_MIGRATION_DIR}/\`, which the live \`${LIVE_MIGRATION_DIR}/\` sequence supersedes`);

  if (parts.length === 1) return `${head} The difference is ${parts[0].n} ${parts[0].text}.`;
  return `${head} The ${gap}-statement difference: ${parts.map((p) => `${p.n} ${p.text}`).join("; ")}.`;
}

// ---------------------------------------------------------------------------
function collect() {
  const files = listFiles();
  const problems = [];

  const byArea = new Map();
  const bySplit = {
    application: { files: 0, loc: 0 }, test: { files: 0, loc: 0 }, schema: { files: 0, loc: 0 },
    tooling: { files: 0, loc: 0 }, docs: { files: 0, loc: 0 }, config: { files: 0, loc: 0 },
  };
  const byExt = new Map();
  let totalFiles = 0;
  let totalLoc = 0;
  let assetFiles = 0;

  const textOf = new Map();

  for (const rel of files) {
    const ext = extname(rel);
    if (BINARY_EXT.has(ext)) {
      // Screenshots are documentation assets, not source. Counted separately so
      // they cannot pad a "files" figure.
      assetFiles++;
      continue;
    }
    const text = readFileSync(join(ROOT, rel), "utf8");
    textOf.set(rel, text);
    const loc = countLines(text);
    totalFiles++;
    totalLoc += loc;

    const a = area(rel);
    if (!byArea.has(a)) byArea.set(a, { files: 0, loc: 0 });
    byArea.get(a).files++;
    byArea.get(a).loc += loc;

    const c = classify(rel);
    bySplit[c].files++;
    bySplit[c].loc += loc;

    const key = ext || "(none)";
    byExt.set(key, (byExt.get(key) ?? 0) + 1);
  }

  // --- tests -------------------------------------------------------------
  // Bucketed by the command that actually runs them. tests/screenshots/ is run by
  // neither `npm test` (vitest include: tests/unit) nor `npm run test:e2e`
  // (playwright testDir: tests/e2e), so folding it into "unit" would overstate
  // the suite that gates the build.
  let testCases = 0;
  let testSuites = 0;
  let testFiles = 0;
  const testBuckets = { unit: 0, component: 0, e2e: 0, screenshot: 0 };
  const testBucketFiles = { unit: 0, component: 0, e2e: 0, screenshot: 0 };
  for (const [rel, text] of textOf) {
    if (classify(rel) !== "test") continue;
    if (!/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
    testFiles++;
    const cases = (text.match(/^\s*(it|test)(\.\w+)?\s*\(/gm) ?? []).length;
    testCases += cases;
    testSuites += (text.match(/^\s*describe(\.\w+)?\s*\(/gm) ?? []).length;
    const unix = rel.split(sep).join("/");
    let bucket;
    if (unix.startsWith("tests/e2e/")) bucket = "e2e";
    else if (unix.startsWith("tests/screenshots/")) bucket = "screenshot";
    else if (unix.startsWith("tests/")) bucket = "unit";
    else bucket = "component";
    testBuckets[bucket] += cases;
    testBucketFiles[bucket]++;
  }
  const gatedCases = testBuckets.unit + testBuckets.component + testBuckets.e2e;
  const gatedFiles = testBucketFiles.unit + testBucketFiles.component + testBucketFiles.e2e;

  // --- endpoints ---------------------------------------------------------
  let real = 0;
  let guards = 0;
  let spaFallback = 0;
  const ROUTE_RE = /^\s*(\w+)\.(get|post|put|patch|delete|all)\s*\(/gm;
  for (const [rel, text] of textOf) {
    const unix = rel.split(sep).join("/");
    if (unix !== "src/worker.ts" && !unix.startsWith("src/routes/")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      ROUTE_RE.lastIndex = 0;
      if (!ROUTE_RE.test(lines[i])) continue;
      // Handler body: this line plus the next few, enough to see a status code.
      const body = lines.slice(i, i + 4).join("\n");
      if (/\.all\s*\(\s*"\*"/.test(lines[i])) spaFallback++;
      else if (/\b404\b/.test(body) && /\.all\s*\(/.test(lines[i])) guards++;
      else real++;
    }
  }

  // --- schema ------------------------------------------------------------
  // Filename order is the apply order, so sort before replaying.
  const liveFiles = [];
  const stagedFiles = [];
  let raiseAbort = 0;
  let checks = 0;
  let foreignKeys = 0;
  for (const rel of [...textOf.keys()].sort()) {
    const unix = rel.split(sep).join("/");
    if (!unix.startsWith("migrations") || extname(rel) !== ".sql") continue;
    const text = textOf.get(rel);
    const entry = { rel: unix, events: parseDdl(text) };
    if (unix.startsWith(`${LIVE_MIGRATION_DIR}/`)) liveFiles.push(entry);
    else if (unix.startsWith(`${STAGED_MIGRATION_DIR}/`)) stagedFiles.push(entry);
    raiseAbort += (text.match(/RAISE\s*\(\s*ABORT/gi) ?? []).length;
    checks += (text.match(/\bCHECK\s*\(/gi) ?? []).length;
    foreignKeys += (text.match(/\bREFERENCES\s+/gi) ?? []).length;
  }
  if (liveFiles.length === 0) {
    problems.push(`no .sql migrations found under ${LIVE_MIGRATION_DIR}/; the live schema counts would be zero`);
  }
  const live = replayLiveSchema(liveFiles);
  const schemaDelta = {
    table: explainDelta("table", liveFiles, stagedFiles, live.table),
    index: explainDelta("index", liveFiles, stagedFiles, live.index),
    trigger: explainDelta("trigger", liveFiles, stagedFiles, live.trigger),
  };

  // --- config-derived ----------------------------------------------------
  // Everything parsed below is published as a number. A silent fallback here
  // means shipping a confident-looking zero, so each one fails loudly instead.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const rollout = pkg.scripts?.["verify:rollout"] ?? "";
  const rolloutSteps = rollout ? rollout.split("&&").filter((s) => s.trim()).length : 0;
  if (rolloutSteps === 0) {
    problems.push('could not derive the verify:rollout step count from the "verify:rollout" script in package.json');
  }

  const vitestCfg = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  // Scope to the coverage block: the `test` block has its own `include` for spec
  // discovery, and matching that one instead would silently report an empty gate.
  const coverageBlock = vitestCfg.slice(vitestCfg.indexOf("coverage:"));
  const includeBlock = coverageBlock.match(/include:\s*\[([\s\S]*?)\]/);
  const coverageScope = includeBlock
    ? [...includeBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((s) => s.startsWith("src/"))
    : [];
  if (coverageScope.length === 0) {
    problems.push("could not parse the coverage include list from vitest.config.ts");
  }
  const threshold = Number(coverageBlock.match(/\blines:\s*(\d+)/)?.[1] ?? 0);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    problems.push("could not parse the coverage line threshold (thresholds.lines) from vitest.config.ts");
  }

  const widgetSrcPath = join(ROOT, "src", "routes", "widget", "index.ts");
  const widgetSrc = existsSync(widgetSrcPath) ? readFileSync(widgetSrcPath, "utf8") : "";
  const widgets = [...(widgetSrc.match(/VALID_WIDGETS\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (widgets.length === 0) {
    problems.push("could not parse the VALID_WIDGETS list from src/routes/widget/index.ts");
  }

  if (problems.length) {
    for (const p of problems) console.error(`repo-metrics: ${p}`);
    console.error("repo-metrics: refusing to publish placeholder numbers");
    process.exit(1);
  }

  const connectorDir = join(ROOT, "src", "connectors");
  const connectors = existsSync(connectorDir)
    ? readdirSync(connectorDir).filter((f) => f.endsWith(".ts") && f !== "base.ts" && f !== "index.ts")
    : [];

  const pagesDir = join(ROOT, "admin", "src", "pages");
  const pages = existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f)) : [];
  const compDir = join(ROOT, "admin", "src", "components");
  const components = existsSync(compDir) ? readdirSync(compDir).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f)) : [];

  const scriptsDir = join(ROOT, "scripts");
  const opsScripts = readdirSync(scriptsDir).filter((f) => /\.(ts|mjs)$/.test(f));
  const verifiers = opsScripts.filter((f) => f.startsWith("verify-"));

  return {
    totalFiles, totalLoc, assetFiles,
    byArea: [...byArea.entries()].sort((a, b) => b[1].loc - a[1].loc),
    bySplit, byExt: [...byExt.entries()].sort((a, b) => b[1] - a[1]),
    testFiles, testCases, testSuites, testBuckets, testBucketFiles, gatedCases, gatedFiles,
    endpoints: { real, guards, spaFallback },
    schema: {
      liveMigrationFiles: liveFiles.length,
      stagedMigrationFiles: stagedFiles.length,
      migrationFiles: liveFiles.length + stagedFiles.length,
      tables: schemaDelta.table.live, rawTables: schemaDelta.table.raw,
      indexes: schemaDelta.index.live, rawIndexes: schemaDelta.index.raw,
      triggers: schemaDelta.trigger.live, rawTriggers: schemaDelta.trigger.raw,
      delta: schemaDelta,
      raiseAbort, checks, foreignKeys,
    },
    deps: { prod: Object.keys(pkg.dependencies ?? {}).length, dev: Object.keys(pkg.devDependencies ?? {}).length },
    npmScripts: Object.keys(pkg.scripts ?? {}).length,
    rolloutSteps,
    coverage: { scope: coverageScope, threshold },
    widgets, connectors: connectors.length, pages: pages.length, components: components.length,
    opsScripts: opsScripts.length, verifiers: verifiers.length,
  };
}

// ---------------------------------------------------------------------------
function readmeTable(m) {
  const ratio = (m.bySplit.application.loc / m.bySplit.test.loc).toFixed(2);
  return [
    "| | |",
    "|---|---|",
    `| Lines of code | **${m.totalLoc.toLocaleString()}** across ${m.totalFiles} files |`,
    `| Application vs test code | ${m.bySplit.application.loc.toLocaleString()} / ${m.bySplit.test.loc.toLocaleString()} lines (**${ratio}:1**) |`,
    `| Tests | ${m.gatedCases} cases declared across ${m.gatedFiles} files, plus ${m.testBuckets.screenshot} screenshot specs |`,
    `| API surface | ${m.endpoints.real} endpoints, plus ${m.endpoints.guards} explicit 404 guards |`,
    `| Database | ${m.schema.tables} tables, ${m.schema.triggers} triggers, ${m.schema.indexes} indexes |`,
    `| Coverage gate | ${m.coverage.threshold}% on ${m.coverage.scope.length} security-critical modules |`,
    `| Deploy gate | ${m.rolloutSteps} automated checks in one command |`,
    `| Runtime | Cloudflare Workers · D1 · R2 · Hono 4 · React 19 |`,
  ].join("\n");
}

function metricsDoc(m) {
  const ratio = (m.bySplit.application.loc / m.bySplit.test.loc).toFixed(2);
  const L = [];
  L.push("<!-- Generated by scripts/repo-metrics.mjs. Do not edit by hand. -->");
  L.push("");
  L.push("# Metrics");
  L.push("");
  L.push("Every number here is produced by `node scripts/repo-metrics.mjs`. Run it yourself; you should");
  L.push("get the same output. `npm run metrics:check` fails the build if this file has drifted from the code.");
  L.push("");
  L.push("The file set comes from `git ls-files`, so gitignored local files cannot move a number and a fresh");
  L.push("clone reproduces these counts exactly. Contents are read from the working tree rather than from git");
  L.push("history, because this repository is published as a snapshot, so there is no history to read.");
  L.push("");
  L.push("## Size");
  L.push("");
  L.push("| Area | Files | Lines |");
  L.push("|---|---:|---:|");
  for (const [name, v] of m.byArea) L.push(`| ${name} | ${v.files} | ${v.loc.toLocaleString()} |`);
  L.push(`| **Total** | **${m.totalFiles}** | **${m.totalLoc.toLocaleString()}** |`);
  L.push("");
  L.push(`Plus ${m.assetFiles} binary documentation assets (screenshots), which contribute no lines.`);
  L.push("");
  L.push("## By role");
  L.push("");
  L.push("| Class | Files | Lines |");
  L.push("|---|---:|---:|");
  for (const k of ["application", "test", "schema", "tooling", "docs", "config"]) {
    L.push(`| ${k} | ${m.bySplit[k].files} | ${m.bySplit[k].loc.toLocaleString()} |`);
  }
  L.push("");
  L.push(`Application-to-test line ratio: **${ratio}:1** (src/ and admin/src/ against tests/).`);
  L.push("");
  L.push("Ops tooling, schema, and documentation are counted separately rather than folded into");
  L.push("\"production\", because comparing test volume against migration SQL and README prose would");
  L.push("inflate the ratio without telling you anything.");
  L.push("");
  L.push("## Tests");
  L.push("");
  L.push(`- **${m.gatedCases}** test cases declared across **${m.gatedFiles}** files in the three suites that gate the build.`);
  L.push(`- Unit (\`npm test\`): ${m.testBuckets.unit} · Admin component (\`npm run test:admin\`): ${m.testBuckets.component} · End-to-end (\`npm run test:e2e\`): ${m.testBuckets.e2e}`);
  L.push(`- Plus ${m.testBuckets.screenshot} cases in ${m.testBucketFiles.screenshot} \`tests/screenshots/\` specs, which belong to the screenshot capture harness. None of the three commands above runs them, so they are excluded from the figure on the first line. Counting all four buckets together gives ${m.testCases} declared cases across ${m.testFiles} files, in ${m.testSuites} suites.`);
  L.push("");
  L.push("These are cases as written in source. Parameterized `it.each` tables expand at runtime, so the");
  L.push("count vitest reports when you run the suites is higher than the count declared here.");
  L.push(`- Coverage gate: **${m.coverage.threshold}%** lines, functions, branches, and statements, enforced on ${m.coverage.scope.length} modules:`);
  for (const f of m.coverage.scope) L.push(`  - \`${f}\``);
  L.push("");
  L.push("The threshold is deliberately scoped rather than global. See `portfolio/TESTING.md` for the reasoning.");
  L.push("");
  L.push("## HTTP surface");
  L.push("");
  L.push(`- **${m.endpoints.real}** endpoints.`);
  L.push(`- **${m.endpoints.guards}** explicit \`app.all\` 404 guards on reserved prefixes.`);
  L.push(`- **${m.endpoints.spaFallback}** SPA fallback route.`);
  L.push("");
  L.push("## Database");
  L.push("");
  L.push(`- ${m.schema.liveMigrationFiles} migration files in \`${LIVE_MIGRATION_DIR}/\` build the live schema, plus ${m.schema.stagedMigrationFiles} in \`${STAGED_MIGRATION_DIR}/\`, a staged subset re-stated for the phased rollout.`);
  L.push("- The live counts below come from replaying `migrations/` in order and applying every `CREATE`, `DROP`,");
  L.push("  and `RENAME`, so they describe the objects that actually exist, not the statements that were written.");
  L.push(deltaSentence("table", m.schema.delta.table));
  L.push(deltaSentence("index", m.schema.delta.index));
  L.push(deltaSentence("trigger", m.schema.delta.trigger));
  L.push("- `scripts/verify-migration-state.ts` independently asserts these live counts against a real database.");
  L.push(`- ${m.schema.raiseAbort} \`RAISE(ABORT, ...)\` guards, ${m.schema.checks} \`CHECK\` constraints, and ${m.schema.foreignKeys} \`REFERENCES\` clauses.`);
  L.push("  Read those three as raw declaration counts across every migration statement in both directories, not as");
  L.push("  live-schema counts: a table rebuild re-declares the constraints of the table it replaces, so the live");
  L.push("  schema holds fewer of each than the totals above suggest.");
  L.push("");
  L.push("## Composition");
  L.push("");
  L.push(`- ${m.widgets.length} embeddable widgets: ${m.widgets.map((w) => `\`${w}\``).join(", ")}.`);
  L.push(`- ${m.connectors} review connector modules.`);
  L.push(`- ${m.pages} admin pages, ${m.components} shared components.`);
  L.push(`- ${m.opsScripts} operational scripts, of which ${m.verifiers} are verifiers that assert against a real database.`);
  L.push(`- ${m.deps.prod} production dependencies, ${m.deps.dev} dev dependencies.`);
  L.push(`- ${m.npmScripts} npm scripts, including a ${m.rolloutSteps}-step \`verify:rollout\` gate.`);
  L.push("");
  L.push("## How these are counted");
  L.push("");
  for (const [k, v] of Object.entries(RULES)) L.push(`- **${k}**: ${v}`);
  L.push("");
  return L.join("\n");
}

const START = "<!-- METRICS:START (generated by scripts/repo-metrics.mjs --write) -->";
const END = "<!-- METRICS:END -->";

function spliceReadme(text, table) {
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i === -1 || j === -1) return null;
  return text.slice(0, i) + START + "\n" + table + "\n" + text.slice(j);
}

// ---------------------------------------------------------------------------
const m = collect();
const args = process.argv.slice(2);

if (args.includes("--json")) {
  console.log(JSON.stringify(m, null, 2));
} else if (args.includes("--write")) {
  // Writing METRICS.md and the README table changes the line counts that produced
  // them, so a single pass never agrees with itself. Both documents have a fixed
  // number of lines once written (only the figures inside change), so this
  // converges in two passes; the loop is here to make that explicit rather than
  // depend on it.
  let current = m;
  let converged = false;
  for (let pass = 0; pass < 5; pass++) {
    const doc = metricsDoc(current);
    const table = readmeTable(current);
    const docStale = !existsSync(METRICS_DOC) || readFileSync(METRICS_DOC, "utf8") !== doc;
    if (docStale) writeFileSync(METRICS_DOC, doc);

    let readmeStale = false;
    if (existsSync(README)) {
      const text = readFileSync(README, "utf8");
      const spliced = spliceReadme(text, table);
      if (spliced === null) {
        console.log("note: README has no METRICS markers; table not injected");
      } else if (spliced !== text) {
        writeFileSync(README, spliced);
        readmeStale = true;
      }
    }

    if (!docStale && !readmeStale) { converged = true; break; }
    current = collect();
  }
  if (!converged) {
    console.error("metrics: numbers did not stabilise after 5 passes");
    process.exit(1);
  }
  console.log(`wrote ${relative(ROOT, METRICS_DOC)} and the README metrics table`);
} else if (args.includes("--check")) {
  const problems = [];
  if (!existsSync(METRICS_DOC)) problems.push("portfolio/METRICS.md is missing");
  else if (readFileSync(METRICS_DOC, "utf8") !== metricsDoc(m)) problems.push("portfolio/METRICS.md is stale");
  if (existsSync(README)) {
    const text = readFileSync(README, "utf8");
    const spliced = spliceReadme(text, readmeTable(m));
    if (spliced === null) problems.push("README is missing the METRICS markers");
    else if (spliced !== text) problems.push("the README metrics table is stale");
  }
  if (problems.length) {
    for (const p of problems) console.error(`metrics:check: ${p}`);
    console.error("run `npm run metrics` to regenerate");
    process.exit(1);
  }
  console.log("metrics:check: published numbers match the code");
} else {
  console.log(metricsDoc(m));
}
