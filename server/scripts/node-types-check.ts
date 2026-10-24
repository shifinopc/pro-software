/**
 * THE VALIDATOR'S LIST OF NODE TYPES MUST MATCH THE ENGINE'S SWITCH.
 *
 *   npx tsx scripts/node-types-check.ts
 *
 * workflow-validate.ts holds ENGINE_NODE_TYPES and asks, in a comment, that anyone adding a `case`
 * to runFrontier() adds it there too. Somebody added `prereq_gate` and did not, so for as long as
 * that lasted every template with an Insurance & Prerequisite Check was told in red that its gate
 * would be skipped and the run would report success anyway — about a working gate. A builder that
 * cries wolf gets ignored, which costs more than the drift did.
 *
 * A comment cannot enforce itself. This reads both files and fails when they disagree.
 *
 * It parses rather than imports on purpose: importing the engine would pull in Prisma and a
 * database connection to answer a question that is answerable from the source text.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not the URL's own pathname: a project under "Stimes Pro" arrives percent-encoded.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(here, "..", "src", p), "utf8");

const engineSrc = read("workflow.ts");
const validateSrc = read("workflow-validate.ts");

// The node switch only — the file holds another switch for comparison operators (eq, gt, contains),
// and those are not node types. Bounded by the switch header and its own default branch.
const from = engineSrc.indexOf("switch (node.type)");
if (from < 0) { console.error("Could not find `switch (node.type)` in workflow.ts — this check needs updating."); process.exit(2); }
const to = engineSrc.indexOf("the engine does not recognise", from);
if (to < 0) { console.error("Could not find the node switch's default branch — this check needs updating."); process.exit(2); }
const engine = new Set([...engineSrc.slice(from, to).matchAll(/^\s*case "([a-z_]+)":/gm)].map(m => m[1]));

const setFrom = validateSrc.indexOf("ENGINE_NODE_TYPES = new Set([");
const setTo = validateSrc.indexOf("]);", setFrom);
if (setFrom < 0 || setTo < 0) { console.error("Could not find ENGINE_NODE_TYPES — this check needs updating."); process.exit(2); }
const declared = new Set([...validateSrc.slice(setFrom, setTo).matchAll(/"([a-z_]+)"/g)].map(m => m[1]));

const missing = [...engine].filter(t => !declared.has(t)).sort();
const extra = [...declared].filter(t => !engine.has(t)).sort();

console.log(`engine executes ${engine.size} node types; the validator declares ${declared.size}.`);
if (!missing.length && !extra.length) { console.log("in step."); process.exit(0); }

// Both directions are wrong, and differently. A type the engine runs but the validator does not
// know is called broken on screen while working. One the validator knows and the engine does not
// run is passed as fine and silently skipped — the failure the default branch exists to report.
for (const t of missing) console.log(`  MISSING  "${t}" — the engine runs it; add it to ENGINE_NODE_TYPES or the Builder calls it broken.`);
for (const t of extra) console.log(`  EXTRA    "${t}" — the validator passes it; the engine has no case, so it is skipped at runtime.`);
process.exit(1);
