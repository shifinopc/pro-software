/**
 * ONE LIST OF WORKFLOW NODE TYPES, CHECKED IN THREE PLACES.
 *
 * A node type is declared three times and cannot be declared once: the engine switches on it in
 * TypeScript, the validator holds a Set it compares against, and the builder's palette is a map
 * inside a 54,000-line HTML file the server cannot import.
 *
 * They drifted the day `stage_invoice` was added. The engine ran it and raised a real invoice; the
 * validator did not know it and told the firm, on screen and in red, that the step would be
 * skipped and the run would report success anyway. A validator that is wrong about the engine is
 * worse than none, because the next genuine error reads as another false alarm.
 *
 * So the three are compared here instead. The engine's switch is the source: whatever it handles
 * is what exists. Anything it handles that the validator does not know is an error. Anything the
 * builder cannot name is a warning, because a type can legitimately be engine-only — `start` and
 * `join` are not things a person drops on a canvas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_NODE_TYPES } from "../src/workflow-validate.js";

const root = join(import.meta.dirname, "..", "..");
const engineSrc = readFileSync(join(root, "server", "src", "workflow.ts"), "utf8");
const consoleSrc = readFileSync(join(root, "index.html"), "utf8");

/** Every `case "x":` inside the engine's own dispatch — the types it actually executes. */
const start = engineSrc.indexOf("switch (node.type)");
if (start < 0) { console.error("FAIL: the engine's node dispatch could not be found — this check is reading the wrong thing"); process.exit(1); }
const end = engineSrc.indexOf("\n  }", start);
const handled = [...engineSrc.slice(start, end).matchAll(/case\s+"([a-z_]+)"/g)].map(m => m[1]);
const uniq = [...new Set(handled)].sort();

/**
 * WHAT THE CANVAS CAN NAME. Read from WF_TYPE_MAP, which is the map the canvas actually
 * consults — not the palette beside it. A type missing from the MAP falls through to "task", so
 * the step is drawn and described as an ordinary job somebody has to do, however well the
 * palette knows it. That is exactly what happened to the invoice steps.
 */
const palette = (() => {
  const i = consoleSrc.indexOf("const WF_TYPE_MAP = {");
  if (i < 0) return null;
  const j = consoleSrc.indexOf("};", i);
  return new Set([...consoleSrc.slice(i, j).matchAll(/([a-z_]+):\s*'/g)].map(m => m[1]));
})();


let bad = 0;
console.log(`engine handles ${uniq.length} node types`);
for (const t of uniq) {
  if (!ENGINE_NODE_TYPES.has(t)) { console.error(`FAIL  ${t}: the engine runs it, the validator calls it unrecognised`); bad++; }
}
for (const t of [...ENGINE_NODE_TYPES].sort()) {
  if (!uniq.includes(t)) console.error(`FAIL  ${t}: the validator allows it, the engine does not handle it — a step of this type silently does nothing`), bad++;
}
if (palette) {
  const missing = uniq.filter(t => !palette.has(t));
  if (missing.length) { console.error(`FAIL  the canvas has no name for: ${missing.join(", ")} — they are drawn as "Task"`); bad += missing.length; }
} else console.warn("WARN  the builder's palette could not be read — the console may have been restructured");

console.log(bad ? `\n${bad} mismatch(es)` : "\nok — the engine, the validator and the builder agree");
process.exit(bad ? 1 : 0);
