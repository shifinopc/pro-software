/**
 * TWO WAYS THE ADD-CLIENT FORM BROKE, AND BOTH ARE INVISIBLE FROM THE CODE ALONE.
 *
 *   npx tsx scripts/client-form-check.ts
 *
 * 1. CREATING A CLIENT FAILED OUTRIGHT. The form sends `portalEmail` on every save — it is the
 *    address that becomes the portal login — and the create route reads it off `req.body` but never
 *    took it OUT of the spread into prisma.company.create. Prisma answered "Unknown argument
 *    `portalEmail`", so a correctly filled form came back with a 400 and a wall of Prisma text.
 *    Proven with two requests: the same body with and without that one key, 400 against 201.
 *
 * 2. TYPING COST 39ms A KEYSTROKE. Every field wrote to app state on every character, and each write
 *    recomputes the whole screen — one DOM mutation for 39ms of JavaScript. The fields now commit on
 *    BLUR, which measured 6.8ms, and are seeded through `sc-camel-default-value` so React stops
 *    restoring them mid-word.
 *
 *    `defaultValue` written plainly is the trap: this runtime lower-cases unknown attributes, so it
 *    reaches the DOM as a meaningless `defaultvalue=""` and the browser ignores it — a pre-filled
 *    field (a converted lead, or stepping Back from the documents page) renders EMPTY over state
 *    that holds the value. `sc-camel-` is the runtime's own escape hatch and emits the real prop.
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const ui = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");
const api = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8");

console.log("the create route does not hand Prisma a column that does not exist:");
ok(/const \{ contacts: incomingContacts, portalEmail: _portalEmail, \.\.\.body \} = req\.body/.test(api),
  "portalEmail is destructured out before the spread into company.create");
ok(api.includes('("portalEmail" in (req.body ?? {}) ? (req.body ?? {}).portalEmail : body?.email)'),
  "…and is still read from req.body, so the portal login it provisions is unchanged");
ok(ui.includes("portalEmail: st.acPortalNone ? '' : String(st.acPortalEmail || '').trim()"),
  "the form still sends it — the pairing is what this check is about");

console.log("\nthe form's fields commit on leaving, not on every character:");
const FIELDS = ["acCName", "acActivity", "acVat", "acGosi", "acMol", "acChamber", "acShortAddr", "acBuilding",
  "acStreet", "acSecondary", "acDistrict", "acPostal", "acCity", "acContact", "acDesignation", "acPhone", "acEmail"];
for (const f of FIELDS) {
  const setter = "setAc" + f.slice(2);
  ok(ui.includes(`sc-camel-default-value="{{ ${f} }}" onBlur="{{ ${setter} }}"`), `${f} is seeded and commits on blur`);
}

console.log("\nand the four that something else fills are deliberately still live:");
// Each of these is written while the form is open — by another field's blur, a mirror, or a toggle —
// and a seeded-once field would show a stale value over the state that had already changed.
for (const [f, why] of [
  ["acNameAr", "filled by the company name's blur (the Arabic suggestion)"],
  ["acPortalEmail", "mirrored from the e-mail field"],
  ["acCr", "cleared by the \"no CR yet\" toggle"],
  ["acMisa", "cleared when the company type stops being foreign"],
] as const) {
  const setter = "setAc" + f.slice(2);
  ok(ui.includes(`value="{{ ${f} }}" onChange="{{ ${setter} }}"`), `${f} stays controlled — ${why}`);
}

console.log("\nand nothing is left half-converted:");
ok(!/defaultValue="\{\{/.test(ui), "no plain defaultValue, which this runtime silently drops");
// The space matters: `sc-camel-default-value` ENDS in `value`, so an unanchored match flags every
// field this check just approved. Caught by this check failing on correct code.
ok(!/\svalue="\{\{ ac[A-Za-z]+ \}\}" onBlur=/.test(ui),
  "no field left with a bare value= and onBlur, which React restores mid-word");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
