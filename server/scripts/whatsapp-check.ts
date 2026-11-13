/**
 * THE TWO RULES THE WHATSAPP CHANNEL RESTS ON.
 *
 *   npx tsx scripts/whatsapp-check.ts
 *
 * 1. A NUMBER WITHOUT A COUNTRY CODE IS NOT SENT TO. Nine digits could be Saudi, Indian or
 *    Emirati, and guessing sends a client's renewal dates to whoever holds that number somewhere
 *    else. Refusing is the only safe answer, so `waNumber` returns null and every caller stops.
 *
 * 2. ONE NUMBER, ONE CLIENT. A number is the whole of a person's identity on WhatsApp — there is
 *    no password on a chat. If the same number sits on two clients' contact lists then "who is
 *    this?" has two answers, and anything that picks one is choosing at random between two
 *    companies' private files. It is refused where it is typed.
 *
 * Everything it creates, it deletes.
 */
import { prisma } from "../src/db.js";
import { waNumber, identify, getWaConfig } from "../src/whatsapp.js";
import { addContact, editContact, assertWhatsAppFree } from "../src/contacts.js";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const TAG = "ZZ whatsapp-check";
const NUM = "919999000111";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.whatsAppMessage.deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
}

console.log("a number is only dialled when it carries its country code:");
ok(waNumber("+91 98478 66202") === "919847866202", "written with a plus and spaces");
ok(waNumber("0091-9847866202") === "919847866202", "written with the international 00 prefix");
ok(waNumber("919847866202") === "919847866202", "written plainly");
ok(waNumber("+966 50 123 4567") === "966501234567", "a Saudi number");
ok(waNumber("50 123 4567") === null, "NINE digits and no country code — refused, not guessed at");
ok(waNumber("") === null && waNumber(null) === null, "empty and null are refused");
ok(waNumber("12345678901234567890") === null, "and so is something far too long to be a phone number");

await sweep();
try {
  console.log("\none WhatsApp number belongs to one client, and the refusal says whose it is:");
  const a = await prisma.company.create({ data: { name: `${TAG} Alpha` } as any });
  const b = await prisma.company.create({ data: { name: `${TAG} Beta` } as any });
  const c1 = await addContact(a.id, { name: "Asha", whatsapp: "+91 99990 00111" });
  ok(!!c1, "the first client's contact takes it");

  let refused = "";
  try { await addContact(b.id, { name: "Bilal", whatsapp: NUM }); }
  catch (e: any) { refused = String(e?.message ?? e); }
  ok(!!refused, "a second client cannot have the same number");
  ok(/Asha/.test(refused) && /Alpha/.test(refused),
    "…and the refusal names who already holds it, which is the only way to resolve it");

  // The same phone written a different way is the same phone. An exact string match would miss it,
  // which is the quiet version of this bug rather than the loud one.
  let refused2 = "";
  try { await addContact(b.id, { name: "Bilal", whatsapp: "0091 99990 00111" }); }
  catch (e: any) { refused2 = String(e?.message ?? e); }
  ok(!!refused2, "…however differently it is written");

  const bilal = await addContact(b.id, { name: "Bilal", whatsapp: "+91 99990 00222" });
  ok(!!bilal, "a different number is fine");
  let refused3 = "";
  try { await editContact(bilal!.id, { whatsapp: NUM }); }
  catch (e: any) { refused3 = String(e?.message ?? e); }
  ok(!!refused3, "and editing one onto a taken number is refused too — not just creating");
  await editContact(c1!.id, { whatsapp: "+91 99990 00111" });
  ok(true, "a contact may keep its own number when edited — it does not clash with itself");

  console.log("\nand who a number belongs to has three answers, not two:");
  const who = await identify("+91 99990 00111");
  ok(who.kind === "client" && who.companyName === `${TAG} Alpha`, "a number on one client resolves to that client");
  ok((await identify("+91 90000 00000")).kind === "unknown", "a number on nobody is unknown — nothing is revealed");
  ok((await identify("12345")).kind === "unknown", "and so is an unusable number");

  // Archiving is how access ends when somebody leaves, so it has to actually end it.
  await editContact(c1!.id, { archived: true });
  ok((await identify("+91 99990 00111")).kind === "unknown",
    "archiving the contact ends their access the same second — a coordinator who leaves keeps the handset");
  ok(await assertWhatsAppFree("+91 99990 00111").then(() => true).catch(() => false),
    "…and frees the number for somebody else");
} finally {
  await sweep();
}

console.log("\nand sending is off until somebody says otherwise:");
const cfg = getWaConfig();
ok(cfg.enabled === (process.env.WHATSAPP_ENABLED === "true" && !!cfg.phoneNumberId && !!cfg.token),
  `credentials alone do not switch it on (currently ${cfg.enabled ? "ON" : "OFF"})`);

await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
