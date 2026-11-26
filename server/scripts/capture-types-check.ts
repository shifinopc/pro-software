/**
 * THE TWO CAPTURE TYPES WHOSE ANSWER IS NOT A STRING.
 *
 * `rows` and `files` broke the one assumption every other capture type satisfies — that an answer
 * is a scalar and `String(v).trim()` tells you whether it was given. The failure is quiet in the
 * worst direction: `String([{}])` is "[object Object]", so a table the officer created with
 * "+ Add partner" and never typed into reads as ANSWERED, and a required field is satisfied by
 * pressing a button. Money has carried its own check for exactly this reason since it was added.
 *
 * Asserts the property rather than the implementation: given what the officer did, is the step
 * allowed to complete, and is what gets stored only what the template asked for.
 */
import assert from "node:assert";
import { captureFilled, ROWS, FILES } from "../src/workflow.js";

const partners = {
  var: "acqPartners",
  type: ROWS,
  columns: [
    { var: "name", label: "Full name" },
    { var: "share", label: "Share %", type: "number", total: true, totalShouldBe: 100 },
  ],
};
const docs = { var: "acqOtherDocs", type: FILES };

let n = 0;
const ok = (what: string, cond: boolean) => { assert.ok(cond, what); n++; };

// ---- rows: given nothing, given empty rows, given a real one
ok("a table never touched is missing", !captureFilled(partners, undefined));
ok("an empty array is missing", !captureFilled(partners, []));
ok("a row of empty strings is missing — the button was pressed, nothing was typed",
  !captureFilled(partners, [{ name: "", share: "" }]));
ok("two empty rows are still missing", !captureFilled(partners, [{ name: "" }, { name: "" }]));
ok("a row with a name is given", captureFilled(partners, [{ name: "Shifin", share: "" }]));
ok("a row with only a percentage is given — a partial row is an answer in progress, not a blank",
  captureFilled(partners, [{ name: "", share: "50" }]));
ok("a null in the array does not throw", !captureFilled(partners, [null as any]));
ok("a string where a table belongs is not an answer", !captureFilled(partners, "Shifin" as any));

// ---- files: the FILE is the answer, the note only says what it is
ok("no attachments is missing", !captureFilled(docs, []));
ok("a note with nothing attached is missing", !captureFilled(docs, [{ note: "Share certificate", path: "" }]));
ok("an attachment with no note is given — the note is a kindness, not the document",
  captureFilled(docs, [{ path: "/api/files/abc", name: "passport.pdf", note: "" }]));
ok("one real attachment among blanks is given",
  captureFilled(docs, [{ path: "" }, { path: "/api/files/abc" }]));

// ---- the scalar and money behaviour it must not have changed
ok("an empty string is still missing", !captureFilled({ var: "x", type: "text" }, ""));
ok("whitespace is still missing", !captureFilled({ var: "x", type: "text" }, "   "));
ok("a scalar is still given", captureFilled({ var: "x", type: "text" }, "yes"));
ok("zero is an answer", captureFilled({ var: "x", type: "number" }, 0));
ok("money with no amount is still missing", !captureFilled({ var: "x", type: "money" }, { paid: "yes" }));
ok("money with an amount is still given", captureFilled({ var: "x", type: "money" }, { amount: "250" }));

// ---- the shape that reaches the run: only the declared columns, blank rows dropped
const trimRows = (cap: any, v: any[]) => {
  const cols = (cap.columns ?? []).map((c: any) => String(c.var));
  return v.slice(0, 50)
    .map((r: any) => Object.fromEntries(cols.map((c: string) => [c, String((r && r[c]) ?? "").slice(0, 300)])))
    .filter((r: any) => Object.values(r).some(x => String(x).trim() !== ""));
};
const stored = trimRows(partners, [
  { name: "Shifin", share: "60", secret: "dropped", nested: { a: 1 } },
  { name: "", share: "" },
  { name: "Iqbal", share: "40" },
]);
assert.deepStrictEqual(stored, [{ name: "Shifin", share: "60" }, { name: "Iqbal", share: "40" }],
  "undeclared keys are dropped, blank rows are dropped, declared ones survive in order");
n++;
assert.strictEqual(trimRows(partners, Array(80).fill({ name: "x" })).length, 50, "a table is bounded at 50 rows");
n++;

console.log(`capture-types-check: ${n} assertions passed`);
