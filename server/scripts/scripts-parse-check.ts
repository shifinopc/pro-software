/**
 * EVERY CHECK SCRIPT AT LEAST PARSES.
 *
 *   npx tsx scripts/scripts-parse-check.ts
 *
 * `tsconfig.json` includes `src` and `prisma` — not `scripts`. So the 220-odd files that make up
 * this project's entire test suite are never looked at by `tsc`, and CI's "Type check" step passes
 * with a broken one sitting right there.
 *
 * That is not theoretical. Writing this suite's own manifest, a reason string was given as
 *
 *     why: "two SEEDED workflows are broken: "Visa Processing" points at a rule that..."
 *
 * — the inner quotes ended the string. `tsc --noEmit` reported clean. The break only appeared when
 * the suite ran and esbuild refused the file, as a transform error in the middle of a 50-minute
 * run, nowhere near the thing that caused it.
 *
 * This is the cheap half of the gap: does each file PARSE. It deliberately does not type-check
 * them — scripts/ currently has 163 type errors under strict mode, and a gate that reports 163
 * things is a gate nobody reads. Parsing is binary, instant, and catches the whole class above.
 *
 * Reads files. Runs nothing, connects to nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f => f.endsWith(".ts")).sort();

let bad = 0;
for (const f of files) {
  try {
    // The same transform tsx itself uses, so "parses here" means "tsx can run it".
    transformSync(readFileSync(join(here, f), "utf8"), { loader: "ts", format: "esm" });
  } catch (e: any) {
    bad++;
    const first = (e?.errors?.[0]) ?? {};
    const where = first.location ? `:${first.location.line}:${first.location.column}` : "";
    console.log(`  FAIL ${f}${where} — ${first.text ?? e?.message ?? e}`);
  }
}

console.log(bad ? `\n${bad} of ${files.length} script(s) do not parse` : `  ok   all ${files.length} scripts parse`);
process.exitCode = bad ? 1 : 0;
