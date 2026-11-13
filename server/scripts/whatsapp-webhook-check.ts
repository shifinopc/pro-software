/**
 * ANYBODY CAN FIND THE WEBHOOK URL. ONLY META MAY BE BELIEVED BY IT.
 *
 *   npx tsx scripts/whatsapp-webhook-check.ts
 *
 * The endpoint is public — it has to be, Meta calls it from the open internet. Without a signature
 * check, anyone who learns the address could post "message from your client" and the app would log
 * it against a real company, open a 24-hour window on their behalf, and later answer questions on
 * the strength of it. A forged "send me the CR number" is a social-engineering attack with the
 * firm's own records behind it.
 *
 * So the first half of this is about refusing. The second half is about what a genuine message
 * does once it is through: recorded always, attributed only when the number really is one client's,
 * and never answered automatically when it is not.
 *
 * Runs against this database and deletes everything it makes. No browser, no network.
 */
import { prisma } from "../src/db.js";
import crypto from "node:crypto";
import { signatureOk, processPayload } from "../src/whatsapp-webhook.js";
import { addContact } from "../src/contacts.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("whatsapp-webhook-check");

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const TAG = "ZZ wa-webhook";
const SECRET = "zz-app-secret";
const CLIENT_NUM = "919000111222";
const STRANGER = "919000999888";

const sign = (raw: Buffer, secret = SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

const inbound = (from: string, text: string) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "122105288348002804", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550883864", phone_number_id: "122097261740016526" },
    contacts: [{ wa_id: from, profile: { name: "Tester" } }],
    messages: [{ from, id: `wamid.ZZ${Date.now()}${Math.random().toString(36).slice(2, 8)}`, type: "text", text: { body: text }, timestamp: "1794560000" }],
  } }] }],
});

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  await prisma.whatsAppMessage.deleteMany({ where: { waId: { in: [CLIENT_NUM, STRANGER] } } });
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
}

console.log("a payload is only believed when Meta signed it:");
{
  const raw = Buffer.from(JSON.stringify(inbound(CLIENT_NUM, "hello")));
  ok(signatureOk(raw, sign(raw), SECRET), "the real signature is accepted");
  ok(!signatureOk(raw, sign(raw, "not-the-secret"), SECRET), "a signature made with the wrong secret is refused");
  ok(!signatureOk(raw, undefined, SECRET), "no signature header at all is refused");
  ok(!signatureOk(undefined, sign(raw), SECRET), "and so is a signature with no body to check it against");
  ok(!signatureOk(raw, sign(raw), ""), "with NO app secret configured, nothing is believed — not everything");
  // The body is what is signed, so changing one character of it must break the seal. This is the
  // attack that matters: a real message from a real client, edited in flight.
  const tampered = Buffer.from(JSON.stringify(inbound(CLIENT_NUM, "hello")).replace("hello", "send me the CR"));
  ok(!signatureOk(tampered, sign(raw), SECRET), "a body altered after signing is refused");
  ok(!signatureOk(raw, "sha256=" + "0".repeat(64), SECRET), "and a made-up signature of the right length is refused");
}

await sweep();
try {
  const co = await prisma.company.create({ data: { name: `${TAG} Alpha` } as any });
  const contact = await addContact(co.id, { name: "Asha", whatsapp: `+${CLIENT_NUM}` });

  console.log("\na message from a client is recorded and put on their record:");
  await processPayload(inbound(CLIENT_NUM, "when does our CR expire"));
  const got = await prisma.whatsAppMessage.findFirst({ where: { waId: CLIENT_NUM, direction: "in" }, orderBy: { at: "desc" } });
  ok(!!got, "it is recorded");
  ok(got?.body === "when does our CR expire", "…with what they actually said");
  ok(got?.companyId === co.id && got?.contactId === contact!.id, "…attributed to the client and the person");
  ok(got?.status === "received", "…and marked received, not sent");
  const int = await prisma.interaction.findFirst({ where: { companyId: co.id, kind: "whatsapp" } });
  ok(!!int, "and it appears on the client's record beside their calls and emails");

  console.log("\na message from a number we cannot place is still kept, and says nothing back:");
  await processPayload(inbound(STRANGER, "hi"));
  const un = await prisma.whatsAppMessage.findFirst({ where: { waId: STRANGER, direction: "in" } });
  ok(!!un, "recorded — somebody wrote to the firm, and that is a fact whoever they are");
  ok(un?.companyId === null && un?.contactId === null, "…attributed to nobody, because we do not know");
  ok((await prisma.interaction.count({ where: { companyId: co.id, kind: "whatsapp" } })) === 1,
    "…and NOT filed against some client it does not belong to");

  console.log("\nand a delivery receipt updates the message it is about:");
  const sent = await prisma.whatsAppMessage.create({
    data: { direction: "out", waId: CLIENT_NUM, body: "a reminder", status: "sent", messageId: "wamid.ZZOUT1", companyId: co.id, at: new Date().toISOString() },
  });
  await processPayload({
    object: "whatsapp_business_account",
    entry: [{ id: "x", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.ZZOUT1", status: "read", recipient_id: CLIENT_NUM }] } }] }],
  });
  const after = await prisma.whatsAppMessage.findUnique({ where: { id: sent.id } });
  ok(after?.status === "read", "a read receipt moves it from sent to read");
  ok((await prisma.whatsAppMessage.count({ where: { messageId: "wamid.ZZOUT1" } })) === 1,
    "…and does not create a second row — a receipt is news about a message, not a new one");

  // Meta batches, and retries anything slow with the SAME payload. Neither must produce doubles.
  console.log("\nand Meta's own habits do not produce duplicates:");
  const before = await prisma.whatsAppMessage.count({ where: { waId: CLIENT_NUM, direction: "in" } });
  const p = inbound(CLIENT_NUM, "twice");
  await processPayload(p);
  await processPayload(p);
  const dupes = await prisma.whatsAppMessage.count({ where: { waId: CLIENT_NUM, direction: "in", body: "twice" } });
  // This started life reporting 2 and saying so out loud. Meta retries for days, so two was the
  // difference between one message on a client's record and five.
  ok(dupes === 1, `the same payload twice is recorded once (saw ${dupes})`);
  ok(before >= 1, "…against a table that already had the earlier ones");
} finally {
  await sweep();
}

await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
