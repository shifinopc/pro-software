/**
 * WHAT A PASTED SIGNATURE TURNS INTO.
 *
 *   npx tsx scripts/signature-check.ts      (writes nothing, touches no database)
 *
 * The parser is heuristics, which is the honest word for guesses that are usually right. Guesses
 * rot quietly: a tweak that improves one shape of signature breaks another, and nobody notices
 * because the form still fills in something.
 *
 * So these are real signature shapes — the Saudi mobile written five different ways, the block with
 * no company line, the one that is nothing but a name and a number, the Arabic company — each with
 * what it must produce. A field that comes out WRONG is worse than one left empty: empty is a box
 * somebody fills, wrong is a box somebody accepts.
 */
import { parseSignature, normalisePhone } from "../src/signature.js";

const fails: string[] = [];
const ok = (cond: boolean, what: string, got?: unknown) => {
  if (cond) console.log(`    ok    ${what}`);
  else { fails.push(`${what} — got ${JSON.stringify(got)}`); console.log(`    FAIL  ${what} — got ${JSON.stringify(got)}`); }
};

console.log("phone shapes, all five that arrived in a real import:");
for (const [raw, want] of [
  ["0537940238", "+966 537940238"],
  ["966533675383", "+966 533675383"],
  ["+966 55 123 4567", "+966 551234567"],
  ["555253678", "+966 555253678"],
  ["Mobile: 0501234567", "+966 501234567"],
  ["+91 98765 43210", "+919876543210"],
] as const) ok(normalisePhone(raw) === want, `${raw} → ${want}`, normalisePhone(raw));

const cases: Array<{ name: string; text: string; want: Record<string, string>; absent?: string[] }> = [
  {
    name: "the ordinary one",
    text: `Faisal Al Otaibi
Operations Manager
Al Noor Contracting Est
Mobile: 0551234567
faisal@alnoor.com.sa
www.alnoor.com.sa
Riyadh, Saudi Arabia`,
    want: { contactName: "Faisal Al Otaibi", jobTitle: "Operations Manager", companyName: "Al Noor Contracting Est",
            phone: "+966 551234567", email: "faisal@alnoor.com.sa", website: "alnoor.com.sa", city: "Riyadh" },
  },
  {
    name: "decorated with pipes and bullets",
    text: `• Ahmed Hassan •
   | Sales Director |
MOONPACK PLASTIC COMPANY
T: +966 13 845 9000
ahmed@moonpack.sa`,
    want: { contactName: "Ahmed Hassan", jobTitle: "Sales Director", companyName: "MOONPACK PLASTIC COMPANY",
            email: "ahmed@moonpack.sa" },
  },
  {
    name: "no company line — the domain has to stand in",
    text: `Maria Santos
maria@brightlogistics.sa
0569998888`,
    want: { contactName: "Maria Santos", email: "maria@brightlogistics.sa", phone: "+966 569998888" },
  },
  {
    name: "a name and a number, nothing else",
    text: `Shihab
0503377137`,
    want: { contactName: "Shihab", phone: "+966 503377137" },
    absent: ["email", "website", "companyName"],
  },
  {
    name: "an Arabic company name",
    text: `Khalid Al Harbi
مؤسسة الخليج للتجارة
khalid@gulf-est.sa
+966 55 777 1234`,
    want: { contactName: "Khalid Al Harbi", companyName: "مؤسسة الخليج للتجارة", email: "khalid@gulf-est.sa", phone: "+966 557771234" },
  },
  {
    name: "a CR number in the block must NOT be read as a phone",
    text: `Sami Noor
Gulf Trading LLC
CR 4030111111
sami@gulftrading.sa`,
    want: { contactName: "Sami Noor", companyName: "Gulf Trading LLC", email: "sami@gulftrading.sa" },
  },
];

for (const c of cases) {
  console.log(`\n${c.name}:`);
  const got = parseSignature(c.text) as any;
  for (const [k, v] of Object.entries(c.want)) ok(got[k]?.value === v, `${k} = ${v}`, got[k]?.value);
  for (const k of c.absent ?? []) ok(!got[k], `${k} is left empty rather than guessed`, got[k]?.value);
}

console.log("\nempty input:");
const none = parseSignature("   \n\n ");
ok(Object.keys(none).length === 1 && none.lines === 0, "nothing in, nothing out", none);

if (fails.length) {
  console.log(`\n${fails.length} failure(s):`);
  for (const f of fails) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log("\nin order — every shape read the way it should.");
}
