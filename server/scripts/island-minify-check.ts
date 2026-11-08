/**
 * THE BUILD MUST ACTUALLY MINIFY THE DATA ISLAND — AND MUST NOT RENAME ANYTHING IN IT.
 *
 *   npx tsx scripts/island-minify-check.ts        (run `pnpm build` first)
 *
 * Both front ends keep their logic in a `<script type="text/x-dc" data-dc-script>` block. The
 * browser never runs it; support.js reads it with `.textContent` and evaluates it. Vite therefore
 * does not see it as code, and for the life of this project shipped it byte for byte — 2.1MB of the
 * console's 4.05MB document, comments included. `minifyDcIsland` in vite.config.ts now minifies it:
 * 656KB → 456KB over the wire for the console, 95KB → 75KB for the portal.
 *
 * This guards the three things that make that safe, each of which fails silently otherwise.
 *
 * 1. THE PLUGIN STILL RUNS. A rename, a plugin-order change or an `apply` tweak would quietly
 *    restore the old 4MB document, and nothing else would notice.
 *
 * 2. `Component` SURVIVES BY NAME. support.js appends
 *      return (typeof Component!=="undefined"&&Component)
 *    AFTER evaluating the island, so that one name is resolved from text. esbuild in transform mode
 *    leaves top-level declarations alone — but only while nobody adds `format` or `bundle` to the
 *    plugin's options, either of which would wrap the island in a scope and rename it. The symptom
 *    would be the whole console rendering as a placeholder.
 *
 * 3. LOCAL NAMES ARE KEPT. `minifyIdentifiers` is off on purpose. It is worth 15KB over the wire and
 *    it costs every local name in the console — and the app reports its own errors to
 *    /api/error-reports, where the useful ones read like "_ago9 is not defined". Line numbers are
 *    gone either way once whitespace goes, so names are the only signal left. Turning it on to save
 *    5% of one block would make every future production error report unreadable.
 *
 * It also re-checks the island for the constructs that would make ANY minification unsafe, so the
 * day somebody adds an `eval` to it this fails instead of production.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const kb = (n: number) => (n / 1024).toFixed(0) + "KB";

/** The island's text, or null when the file has none (console-app.html / portal-app.html). */
function island(html: string): string | null {
  const open = /<script\b[^>]*\bdata-dc-script\b[^>]*>/i.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = html.indexOf("</script>", start);
  return end < 0 ? null : html.slice(start, end);
}

// Local names that must survive, PER PAGE — the two front ends share no locals, so one list for
// both reported five false "refactored away" notices for the portal. Each name is checked against
// the SOURCE first: if one has genuinely gone, this says so and asks for the list to be updated,
// rather than crying wolf about renaming.
const KEEP_NAMES: Record<string, string[]> = {
  "index.html":  ["renderVals", "_bootFetch", "_paidFor", "_coByCode", "_empByCompany", "MODAL_FLAGS"],
  "portal.html": ["renderVals", "_rawFetch", "stateBannerApi", "_docTotal", "_payTotal", "_navCount"],
};

// Constructs that make minification unsafe at any setting. `with` and `eval` reach into the
// surrounding scope by name; `new Function` and `arguments.callee` reconstruct code at runtime.
const HAZARDS: [string, RegExp][] = [
  ["eval(",             /(^|[^.\w])eval\s*\(/],
  ["with (",            /(^|[^.\w])with\s*\(/],
  ["new Function(",     /new\s+Function\s*\(/],
  ["arguments.callee",  /arguments\s*\.\s*callee/],
  ["constructor.name",  /constructor\s*\.\s*name/],
];

/** Comments are where `with (` and the like legitimately appear in this file's prose. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

for (const page of ["index.html", "portal.html"]) {
  console.log(`\n── ${page}`);
  const srcPath = path.join(root, page);
  const outPath = path.join(root, "dist", page);
  if (!fs.existsSync(srcPath)) { fail(`${page} is missing from the repository root`); continue; }

  const src = island(fs.readFileSync(srcPath, "utf8"));
  if (!src) { fail(`${page} has no data-dc-script island — has the runtime changed?`); continue; }
  ok(`source island ${kb(src.length)}`);

  // ── hazards, against the source ──
  const code = stripComments(src);
  for (const [label, re] of HAZARDS) {
    if (re.test(code)) {
      const at = code.split(re)[0].split("\n").length;
      fail(`${page} island now contains \`${label}\` (around island line ${at}). Minifying it is no longer safe — see vite.config.ts.`);
    }
  }
  if (!HAZARDS.some(([, re]) => re.test(code))) ok("no eval / with / new Function / arguments.callee / constructor.name");

  // ── the built output ──
  if (!fs.existsSync(outPath)) {
    console.log(`  --    dist/${page} not built, so the build assertions are SKIPPED. Run \`pnpm build\` (CI always does).`);
    continue;
  }
  const out = island(fs.readFileSync(outPath, "utf8"));
  if (!out) { fail(`dist/${page} has no island — the build dropped it`); continue; }

  const saved = 1 - out.length / src.length;
  if (saved < 0.15) {
    fail(`dist/${page} island is ${kb(out.length)} against a source of ${kb(src.length)} — only ${(saved * 100).toFixed(0)}% smaller, so minifyDcIsland did not run. The document ships at full size.`);
  } else {
    ok(`built island ${kb(out.length)} (-${(saved * 100).toFixed(0)}%)`);
  }

  // Comments gone is the bulk of that saving, and the cheapest thing to confirm directly.
  if (/\n\s*\/\*\*/.test(out)) fail(`dist/${page} island still carries block comments — minifyWhitespace is not taking effect`);
  else ok("comments stripped");

  if (!/\bclass Component\b/.test(out)) {
    fail(`dist/${page} island no longer declares \`class Component\` by name. support.js resolves that name from text after evaluating the island, so the page will render as a placeholder. Check for \`format\`/\`bundle\` in the plugin's esbuild options.`);
  } else {
    ok("`class Component` survives by name");
  }

  const keep = KEEP_NAMES[page] ?? [];
  const renamed = keep.filter(n => new RegExp(`\\b${n}\\b`).test(src) && !new RegExp(`\\b${n}\\b`).test(out));
  const stale = keep.filter(n => !new RegExp(`\\b${n}\\b`).test(src));
  if (renamed.length) {
    fail(`identifiers were renamed in dist/${page} (${renamed.join(", ")} are in the source and gone from the build). minifyIdentifiers must stay OFF — it saves ~15KB and makes every production error report unreadable.`);
  } else if (keep.length - stale.length < 3) {
    fail(`only ${keep.length - stale.length} of the ${page} names in KEEP_NAMES still exist, so this is no longer testing anything. Replace them with locals the island actually declares.`);
  } else {
    ok(`local names kept (${keep.length - stale.length} checked)`);
  }
  for (const n of stale) console.log(`  --    \`${n}\` is no longer in ${page} at all — drop it from KEEP_NAMES in this check`);

  // Minified or not, it has to parse. `new Function` compiles the body without running it.
  try { new Function(out); ok("built island parses as JavaScript"); }
  catch (e: any) { fail(`dist/${page} island does not parse: ${String(e?.message).slice(0, 160)}`); }
}

console.log(bad ? `\n${bad} problem(s)` : "\nall good");
process.exit(bad ? 1 : 0);
