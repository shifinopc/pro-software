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

console.log(bad ? `\n${bad} problem${bad === 1 ? "" : "s"}.` : "\nin order.");
process.exit(bad ? 1 : 0);
