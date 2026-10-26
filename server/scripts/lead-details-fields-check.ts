/**
 * WHAT THE EDIT FORM SENDS, THE ROUTE MUST WRITE.
 *
 *   npx tsx scripts/lead-details-fields-check.ts
 *
 * PUT /api/companies/:id/details writes a named list of columns. The lead edit form posts a body to
 * it. Nothing connects the two, so a field added to the form reaches a route that does not mention
 * it — and the failure is the quiet kind: a 200, a closed dialog, and the old value still in the
 * database. Nobody reports it for weeks, because the form said it had worked.
 *
 * It has now happened twice. First `industry` and `campaign`, which the route's own comment
 * describes being "quietly dropped on the floor" while "the edit form sent them faithfully on every
 * save". Then `service` — the product a lead came for — which was worse, because Leads can be
 * filtered by product: the lead kept its old answer and then did not appear under the filter meant
 * to find it.
 *
 * So this reads both sides and compares them. Two files, one list, checked rather than remembered.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");
const server = fs.readFileSync(path.join(here, "..", "src", "index.ts"), "utf8");

/** Keys the edit form puts in the body it sends to /details. */
const sentFields = (() => {
  const at = html.indexOf("'/api/companies/' + f.id + '/details'");
  if (at < 0) return null;
  const from = html.indexOf("JSON.stringify({", at);
  const to = html.indexOf("}),", from);
  if (from < 0 || to < 0) return null;
  // Top-level keys only: `contact` is an object and is written by its own branch in the route.
  const body = html.slice(from, to);
  let depth = 0;
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (depth === 1) for (const m of trimmed.matchAll(/(?:^|[,{]\s*)([a-zA-Z][a-zA-Z0-9]*)\s*:/g)) keys.push(m[1]);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return [...new Set(keys)];
})();

/** Columns the route actually writes, whether named outright or spread in on presence. */
const writtenFields = (() => {
  const at = server.indexOf('app.put("/api/companies/:id/details"');
  if (at < 0) return null;
  const from = server.indexOf("data: {", at);
  const to = server.indexOf("});", from);
  if (from < 0 || to < 0) return null;
  const data = server.slice(from, to);
  const plain = [...data.matchAll(/^\s{8}([a-zA-Z][a-zA-Z0-9]*)[,:]/gm)].map(m => m[1]);
  const onPresence = [...data.matchAll(/\.\.\.\("([a-zA-Z0-9]+)" in b \?/g)].map(m => m[1]);
  return [...new Set([...plain, ...onPresence])];
})();

if (!sentFields || !writtenFields) {
  console.error("Could not find both sides of this — the edit form's body or the route's update. This check needs updating.");
  process.exit(2);
}

// Handled by their own branches in the route rather than by the column list.
const ELSEWHERE = new Set(["contact"]);

const dropped = sentFields.filter(f => !ELSEWHERE.has(f) && !writtenFields.includes(f));

console.log(`  the edit form sends: ${sentFields.join(", ")}`);
console.log(`  the route writes:    ${writtenFields.join(", ")}`);

if (!dropped.length) { console.log("\nin order — nothing is sent and dropped."); process.exit(0); }
for (const f of dropped) {
  console.log(`\n  FAIL  "${f}" is sent by the edit form and written nowhere in the route.`);
  console.log(`        Saving will answer 200, close the dialog, and leave the old value on the row.`);
  console.log(`        Add it to the update in src/index.ts, keyed on presence:`);
  console.log(`            ...("${f}" in b ? { ${f}: b.${f} || null } : {}),`);
}
process.exit(1);
