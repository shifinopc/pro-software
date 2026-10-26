/**
 * WHAT THE FIRST SCREEN WAITS FOR MUST NOT ALSO BE IN THE BATCH.
 *
 *   npx tsx scripts/first-paint-check.ts
 *
 * Starting the console asks for two sets of things. The HEAD fires a handful on their own —
 * `window.__firstPaint`, the lists the first screen is actually made of — and /api/boot answers the
 * other ninety together. The first paint is held until that handful arrives, so the dashboard
 * appears complete instead of filling in behind itself.
 *
 * A path in BOTH is fetched twice on every start: once on its own and once inside the batch. It
 * costs a request and a route run, and nothing looks wrong — which is why it survived two deploys.
 * /api/auth/me and /api/crm-dashboard were in both until a running container was asked which of
 * them it still had.
 *
 * The other direction needs no check: the app reads `window.__firstPaint` back out of the HEAD
 * rather than keeping its own copy, so those two cannot disagree.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOT_PATHS } from "../src/boot.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

const at = html.indexOf("window.__firstPaint = [");
if (at < 0) { console.error("Could not find window.__firstPaint in index.html — this check needs updating."); process.exit(2); }
const close = html.indexOf("]", at);
const firstPaint = [...html.slice(at, close).matchAll(/'([^']+)'/g)].map(m => m[1]);
if (!firstPaint.length) { console.error("Found window.__firstPaint but no paths in it — this check needs updating."); process.exit(2); }

console.log(`  the first screen waits for ${firstPaint.length}: ${firstPaint.join(", ")}`);
console.log(`  the batch carries ${BOOT_PATHS.length}`);

const both = firstPaint.filter(p => BOOT_PATHS.includes(p));
if (!both.length) { console.log("\nin order — nothing is fetched twice."); process.exit(0); }

for (const p of both) {
  console.log(`\n  FAIL  "${p}" is in BOTH the first-paint list and BOOT_PATHS.`);
  console.log(`        It is fetched twice on every start — once on its own, once inside the batch.`);
  console.log(`        Remove it from BOOT_PATHS in src/boot.ts; the first-paint list is the one that waits.`);
}
process.exit(1);
