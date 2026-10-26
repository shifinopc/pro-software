/**
 * VALUES THAT ARE ONLY BUILT ON THEIR OWN SCREEN MUST ONLY BE READ THERE.
 *
 *   npx tsx scripts/render-scope-check.ts
 *
 * The console is one component whose renderVals() runs on EVERY state change — opening a dropdown
 * is a state change. It was spending 83ms of each of those rebuilding the Documents screen's folder
 * cards, their contents and the status tiles out of ~500 documents, on every screen, for values
 * nothing was rendering. That is the dropdown lag people were reporting.
 *
 * So `_dxAll` is now null unless the Documents (or Compliance) screen is showing, and everything
 * below it falls into the "documents have not loaded yet" branch it has always had.
 *
 * THE REGRESSION THIS CATCHES. That gating is only safe while those values stay inside their own
 * block. The day somebody reads `_docsReal` from the dashboard or a client page, it is null there
 * and the symptom is not a crash — it is a panel quietly reading 0, which looks like a client with
 * no documents rather than like a bug. Nothing in the language stops that: it is one 24,700-line
 * function, so every local is in scope everywhere below it.
 *
 * Hence a check rather than a comment. It reads the file; it imports nothing and runs no browser.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8").split(/\r?\n/);

// Each gated group: the flag that gates it, the locals it makes conditional, and how far below the
// gate they are allowed to be used. The window is deliberately generous — it is there to catch a
// read from a different screen thousands of lines away, not to police the block's own length.
const GROUPS = [
  { gate: "_dxShowing", locals: ["_dxAll", "_docsReal"], within: 400, screen: "Documents / Compliance" },
];

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };

for (const g of GROUPS) {
  const gateAt = lines.findIndex(l => l.includes(`const ${g.gate} =`));
  if (gateAt < 0) { fail(`${g.gate} is gone — was the ${g.screen} gating removed? If on purpose, drop it from this check and expect the render to get ~83ms slower on every other screen.`); continue; }
  console.log(`  ok    ${g.gate} declared at line ${gateAt + 1} (${g.screen})`);

  for (const name of g.locals) {
    const decl = lines.findIndex(l => new RegExp(`const ${name}\\s*=`).test(l));
    if (decl < 0) { fail(`${name} is no longer declared`); continue; }
    // The declaration of the gated source must actually test the flag, or the gate is decorative.
    if (name === "_dxAll" && !lines[decl].includes(g.gate)) {
      fail(`${name} no longer tests ${g.gate} — it is being built on every screen again`);
      continue;
    }
    const uses = lines
      .map((l, i) => ({ i, l }))
      .filter(({ i, l }) => i !== decl && new RegExp(`\\b${name}\\b`).test(l) && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    const stray = uses.filter(u => u.i < gateAt || u.i > decl + g.within);
    if (stray.length) {
      for (const s of stray) fail(`${name} is read at line ${s.i + 1}, outside the ${g.screen} block — it is null there:\n          ${s.l.trim().slice(0, 110)}`);
    } else {
      console.log(`  ok    ${name}: ${uses.length} use${uses.length === 1 ? "" : "s"}, all inside its own block`);
    }
  }
}

/**
 * THE CALENDAR POPOVER builds its events inside `if (this.state.calOpen)`. Walking every document
 * and every task to fill a popover that is shut was 91ms of every click on every screen.
 *
 * A different regression from the one above, so a different check: `_calEv` is always declared and
 * is simply empty while the calendar is closed, so nothing can read it wrongly. What would undo the
 * fix is a third source added below the other two and outside the gate — easy to do, since the two
 * that are there look exactly like top-level statements. Every write to `_calEv` must be inside it.
 */
const calGate = lines.findIndex(l => l.includes("if (this.state.calOpen) {"));
if (calGate < 0) {
  fail("the calendar's `if (this.state.calOpen)` gate is gone — its events are being built on every click again");
} else {
  // The gate sits at one indent inside renderVals, so its block ends at the first line that closes
  // at exactly that indent.
  const indent = lines[calGate].match(/^\s*/)![0];
  const calEnd = lines.findIndex((l, i) => i > calGate && l === indent + "}");
  if (calEnd < 0) { fail("could not find the end of the calendar gate — this check needs updating."); }
  else {
    const writes = lines
      .map((l, i) => ({ i, l }))
      .filter(({ l }) => /_calEv\[[^\]]*\]\s*=/.test(l));
    const outside = writes.filter(w => w.i < calGate || w.i > calEnd);
    if (outside.length) {
      for (const o of outside) fail(`_calEv is written at line ${o.i + 1}, outside the calOpen gate — that work happens on every click on every screen:\n          ${o.l.trim().slice(0, 110)}`);
    } else {
      console.log(`  ok    calendar: all ${writes.length} writes to _calEv are inside the calOpen gate (lines ${calGate + 1}-${calEnd + 1})`);
    }
  }
}

console.log(bad ? `\n${bad} problem${bad === 1 ? "" : "s"}.` : "\nin order.");
process.exit(bad ? 1 : 0);
