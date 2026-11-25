/**
 * A GATE THAT READS THE RECORD, RATHER THAN ASKING SOMEBODY TO SAY IT IS FINE.
 *
 *   npx tsx scripts/checklist-field-check.ts     (needs the API running)
 *
 * A stage checklist could be satisfied two ways: a filed document, or a person ticking a box. The
 * tick is a declaration and nothing more — somebody ticks "Budget confirmed" on a deal that has no
 * budget anywhere on it, the deal moves, and the pipeline total is fiction built on a click. That
 * is the version of a qualification gate that gets waived into uselessness in a month.
 *
 * So there is a third kind: the item is satisfied when a FIELD on the deal actually holds a value,
 * and by nothing else.
 *
 * What is asserted, and why each one is here:
 *
 *   · an empty field is not done, and the move out of the stage is REFUSED naming the item
 *   · filling the field ticks it with nobody touching the checklist, and the move then goes
 *   · it CANNOT be ticked by hand — otherwise it is a manual item with extra steps, and the hand
 *     tick would win over the record, which is the disagreement reading the field was meant to end
 *   · a zero budget is not a budget. `valueMinor` unset arrives as 0 and must not satisfy "a figure"
 *   · "no" is not a value. A field item on `hasCr` means "we hold their CR"; the fact reads "no"
 *     when we do not, and a naive truthiness test would tick it the moment the fact existed
 *   · an ARCHIVED contact is not a contact — a deal must not qualify on somebody who was removed
 *   · the value is carried as the item's evidence, so the row says WHAT it found and a figure that
 *     is present but wrong is visible instead of hidden behind a tick
 *   · an item naming no field degrades to manual rather than becoming permanently unsatisfiable
 *   · waiving still works on one, because the escape hatch is what makes a blocking gate survivable
 *
 * Everything it makes is tagged "ZZ Field" and removed at the end, which is also why it refuses to
 * run anywhere but a scratch database.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";
import { normalizeItems, statusFor } from "../src/dealchecklist.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This writes throwaway deals, stages and contacts."));
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:4100";
let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const expect = (got: unknown, want: unknown, what: string) =>
  got === want ? ok(`${what} → ${JSON.stringify(got)}`) : fail(`${what} → got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

const TAG = "ZZ Field";
const EMAIL = "zz-field@example.invalid";

async function sweep() {
  const opps = await prisma.opportunity.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
  if (opps.length) await prisma.opportunity.deleteMany({ where: { id: { in: opps.map(o => o.id) } } });
  await prisma.contact.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.pipelineStage.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

const ITEMS = [
  { key: "contact", label: "A named decision maker", required: true, source: "field", field: "contact" },
  { key: "reach", label: "A way to reach them", required: true, source: "field", field: "contactReach" },
  { key: "budget", label: "A budget figure", required: true, source: "field", field: "value" },
  { key: "when", label: "An expected close date", required: true, source: "field", field: "closeDate" },
];

async function main() {
  await sweep();
  await prisma.user.create({ data: { name: TAG, email: EMAIL, roleId: "super_admin", status: "active", type: "staff" } });
  const token = await tokenForEmail(EMAIL);
  const co = await prisma.company.create({ data: { name: `${TAG} Client`, country: "ZZ" } });

  // Two columns of our own, so the real pipeline is never touched and the move has somewhere to go.
  const from = await prisma.pipelineStage.create({
    data: { name: `${TAG} Enquiry`, country: "ZZ", sort: 0, checklistSource: "static", checklistItems: ITEMS as any },
  });
  const to = await prisma.pipelineStage.create({ data: { name: `${TAG} Qualified`, country: "ZZ", sort: 1 } });

  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(API + path, {
      method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  const deal = await prisma.opportunity.create({
    data: { title: `${TAG} deal`, companyId: co.id, stageId: from.id, country: "ZZ" },
  });

  console.log("\nan empty deal is refused, and told what is missing");
  const blocked = await call("POST", `/api/opportunities/${deal.id}/move`, { stageId: to.id });
  expect(blocked.status, 409, "the move");
  const named = (blocked.body?.blockers ?? []).map((b: any) => b.key).sort().join(",");
  expect(named, "budget,contact,reach,when", "every missing item named");
  expect((await prisma.opportunity.findUnique({ where: { id: deal.id } }))?.stageId, from.id, "it did not move");

  console.log("\nit cannot be ticked by hand");
  const tick = await call("POST", `/api/opportunities/${deal.id}/checklist`, { key: "budget", done: true });
  expect(tick.status, 400, "ticking a field item");
  /read from the deal/i.test(String(tick.body?.error ?? ""))
    ? ok("and says where to fill it in instead") : fail(`unhelpful refusal → ${tick.body?.error}`);

  console.log("\nzero is not a budget, and an archived contact is not a contact");
  const archived = await prisma.contact.create({
    data: { companyId: co.id, name: `${TAG} Gone`, phone: "0500000000", archived: true },
  });
  await prisma.opportunity.update({ where: { id: deal.id }, data: { valueMinor: 0, contactId: archived.id } });
  const d0 = await prisma.opportunity.findUnique({ where: { id: deal.id }, include: { stage: true } });
  const s0 = await statusFor(d0, co, d0!.stage);
  expect(s0.find(i => i.key === "budget")?.done, false, "valueMinor = 0");
  expect(s0.find(i => i.key === "contact")?.done, false, "an archived contact");

  console.log("\nfilling the fields ticks them, with nobody touching the checklist");
  const person = await prisma.contact.create({
    data: { companyId: co.id, name: `${TAG} Buyer`, jobTitle: "Owner", whatsapp: "0551234567" },
  });
  await prisma.opportunity.update({
    where: { id: deal.id },
    data: { contactId: person.id, valueMinor: 4000000, expectedCloseDate: "2026-12-31" },
  });
  const d1 = await prisma.opportunity.findUnique({ where: { id: deal.id }, include: { stage: true } });
  const s1 = await statusFor(d1, co, d1!.stage);
  expect(s1.filter(i => i.done).length, 4, "items satisfied");
  expect(s1.every(i => i.how === "field"), true, "every one of them read from the deal");
  // WhatsApp alone is a way to reach somebody; requiring a specific channel would fail most of
  // this market.
  expect(s1.find(i => i.key === "reach")?.evidence, "0551234567", "the reach it found");
  expect(s1.find(i => i.key === "budget")?.evidence, "40000", "the budget it found, in major units");

  console.log("\nand then it moves");
  const moved = await call("POST", `/api/opportunities/${deal.id}/move`, { stageId: to.id });
  expect(moved.status, 200, "the move");
  expect((await prisma.opportunity.findUnique({ where: { id: deal.id } }))?.stageId, to.id, "it landed");

  // THE CASE THAT DECIDES WHETHER THIS IS A GATE OR A DEAD END.
  //
  // The console never sets `Opportunity.contactId` — the deal form has no contact picker — so a
  // deal's contact comes from the client record in practice. If this failed, "a named decision
  // maker" would be a required item nobody could satisfy without a developer.
  console.log("\na deal with no contact of its own falls back to the client's");
  const loose = await prisma.opportunity.create({
    data: { title: `${TAG} no contact`, companyId: co.id, stageId: from.id, country: "ZZ", valueMinor: 100000, expectedCloseDate: "2026-11-30" },
  });
  const dl = await prisma.opportunity.findUnique({ where: { id: loose.id }, include: { stage: true } });
  const sl = await statusFor(dl, co, dl!.stage);
  expect(dl?.contactId, null, "the deal names nobody");
  expect(sl.find(i => i.key === "contact")?.done, true, "and still has a named decision maker");
  expect(sl.find(i => i.key === "contact")?.evidence, `${TAG} Buyer`, "the client's contact");
  expect((await call("POST", `/api/opportunities/${loose.id}/move`, { stageId: to.id })).status, 200, "so it moves");

  console.log("\n\"no\" is not a value");
  const crItem = [{ key: "cr", label: "CR on file", required: true, source: "field", field: "hasCr" }];
  await prisma.pipelineStage.update({ where: { id: from.id }, data: { checklistItems: crItem as any } });
  const noCr = await prisma.opportunity.create({
    data: { title: `${TAG} no cr`, companyId: co.id, stageId: from.id, country: "ZZ" },
  });
  const dn = await prisma.opportunity.findUnique({ where: { id: noCr.id }, include: { stage: true } });
  expect((await statusFor(dn, co, dn!.stage))[0]?.done, false, "hasCr reading \"no\"");
  const withCr = { ...co, cr: "1010101010" };
  expect((await statusFor(dn, withCr, dn!.stage))[0]?.done, true, "and once the CR is on file");

  console.log("\nwaiving still works on one");
  const waived = await call("POST", `/api/opportunities/${noCr.id}/checklist/waive`, { key: "cr", reason: "formation case — no CR exists yet" });
  expect(waived.status, 200, "the waiver");
  const dw = await prisma.opportunity.findUnique({ where: { id: noCr.id }, include: { stage: true } });
  const sw = await statusFor(dw, co, dw!.stage);
  expect(sw[0]?.done, true, "the item");
  expect(sw[0]?.how, "waived", "and it reports WHY, not as satisfied");

  console.log("\nan item naming no field is not left unsatisfiable");
  const degraded = normalizeItems([{ key: "x", label: "Nameless", source: "field" }]);
  expect(degraded[0]?.source, "manual", "it degrades to manual");
  expect(degraded[0]?.field, null, "carrying no stale pointer");
  // The same rule the document kind has always had, asserted beside it so the two cannot drift.
  expect(normalizeItems([{ key: "y", label: "No type", source: "document" }])[0]?.source, "manual", "as a document item does");
}

main()
  .catch((e) => { console.error(e); bad++; })
  .finally(async () => {
    await sweep();
    await prisma.$disconnect();
    console.log(bad ? `\n${bad} FAILED` : "\nall good");
    process.exit(bad ? 1 : 0);
  });
