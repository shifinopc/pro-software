/**
 * SEND A REAL REMINDER TO A REAL PHONE.
 *
 *   npx tsx scripts/whatsapp-send-test.ts                      # what it would send, to nobody
 *   npx tsx scripts/whatsapp-send-test.ts --to 919847866202    # the same, aimed at a phone
 *   npx tsx scripts/whatsapp-send-test.ts --to 919847866202 --send
 *   npx tsx scripts/whatsapp-send-test.ts --to … --send --template hello_world
 *
 * The point is not to prove an API works — the Meta dashboard does that. It is to see the message
 * a CLIENT would get, built from this database: a document that really is expiring, the person it
 * belongs to, the real date, the real number of days left. Wording only survives contact with real
 * data, and this is that contact.
 *
 * Prints before it sends, always. Sends only with --send.
 *
 * WHICH OF THE TWO WAYS depends on Meta's 24-hour rule, and this tool does not pretend otherwise:
 * if that phone has messaged the test number in the last day, the full wording goes as free text.
 * If not, only an APPROVED TEMPLATE is allowed, and on a fresh app the only approved one is
 * `hello_world` — which carries none of the wording below. That is not a bug in here; it is the
 * reason template approval is on the critical path.
 */
import { prisma } from "../src/db.js";
import { getWaConfig, hasOpenWindow, identify, notifyClient, sendTemplate, sendText, waNumber } from "../src/whatsapp.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("whatsapp-send-test");

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i > 0 ? process.argv[i + 1] : null;
};
const SEND = process.argv.includes("--send");
/**
 * `--text` — "I can see the client's message on the phone; send the real words."
 *
 * The 24-hour window is a fact about META, and this app learns it from inbound messages landing in
 * WhatsAppMessage. Until the webhook exists nothing lands there, so `hasOpenWindow` says CLOSED
 * even when the client messaged the test number five minutes ago. This flag says otherwise on a
 * human's word. It is a TESTING flag and nothing else uses it — when the webhook is built the
 * table knows on its own and this stops being needed.
 *
 * Safe to be wrong about: if the window really is shut, Meta refuses with a 400 and nothing is
 * sent. The failure is loud and costs nothing.
 */
const FORCE_TEXT = process.argv.includes("--text");
const TO = arg("--to");
const TEMPLATE = arg("--template") || "hello_world";

const days = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 86400000);
const nice = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** The soonest real expiry in this database, with the client and person it belongs to. */
async function pickReminder() {
  const soon = await prisma.document.findMany({
    where: { expiryDate: { not: null }, status: { in: ["valid", "expiring"] } },
    select: { docType: true, person: true, expiryDate: true, docNumber: true, companyId: true,
              company: { select: { name: true } } },
    orderBy: { expiryDate: "asc" },
    take: 200,
  });
  const ahead = soon.filter(d => d.expiryDate && days(d.expiryDate) > 0);
  return ahead[0] ?? null;
}

const cfg = getWaConfig();
console.log(`sending is ${cfg.enabled ? "ON" : "OFF"}${cfg.phoneNumberId ? ` · from phone id ${cfg.phoneNumberId}` : " · no credentials in the environment"}\n`);

const doc = await pickReminder();
if (!doc) {
  console.log("no document in this database has an expiry date in the future — nothing to remind anybody about");
  process.exit(0);
}

const left = days(doc.expiryDate!);
const subject = doc.person && doc.person !== "—" ? doc.person : (doc.company?.name ?? "your company");

/**
 * THE WORDING HAS TO MOVE WITH THE DATE, and the first real record proved why.
 *
 * It picked an Iqama expiring TOMORROW and the draft read "in 1 days. We'll start the renewal in
 * good time. Nothing needed from you yet." Both halves wrong: the plural, and a reassurance that is
 * false — one day out, something IS needed from somebody, today. A client who reads that and relaxes
 * has been misled by us.
 *
 * So one sentence per band. Nothing clever; the bands are what the officer would say out loud.
 */
const dayCount = `${left} day${left === 1 ? "" : "s"}`;
const line2 =
  left <= 3 ? `This is urgent — we are on it, and we will call you today if anything is needed from you.`
  : left <= 14 ? `The renewal is under way. We will tell you here the moment we need anything from you.`
  : left <= 45 ? `We have started the renewal. Nothing needed from you yet.`
  : `We will start the renewal in good time. Nothing needed from you yet.`;
const head = left <= 3 ? "⚠️ *STIMES PRO*" : "🔔 *STIMES PRO*";
const text =
  `${head}\n\n` +
  `*${subject}'s ${doc.docType}* expires on *${nice(doc.expiryDate!)}* — in ${dayCount}.\n` +
  `${line2}\n\n` +
  `Reply here if anything has changed.`;

console.log("the client would read:\n");
console.log(text.replace(/\*/g, "").split("\n").map(l => "    " + l).join("\n"));
console.log(`\n(from ${doc.company?.name ?? "—"}${doc.docNumber ? ` · ${doc.docType} ${doc.docNumber}` : ""})\n`);

if (!TO) {
  console.log("no --to given, so nothing was sent. Add --to <number with country code> --send");
  process.exit(0);
}

const to = waNumber(TO);
if (!to) {
  console.error(`"${TO}" has no country code, so it cannot be dialled. Give it in full, e.g. 919847866202.`);
  process.exit(1);
}

// Who does this number belong to? Not needed to send, but it is the check the bot will live or die
// by, and seeing it answered on a real number is worth the two lines.
const who = await identify(to);
console.log(`that number is: ${
  who.kind === "client" ? `${who.contactName} at ${who.companyName}`
  : who.kind === "ambiguous" ? `AMBIGUOUS — on ${who.companies.map(c => c.name).join(" and ")}`
  : "not on any client's contact list"}`);

const open = FORCE_TEXT || await hasOpenWindow(to);
console.log(`24-hour window: ${FORCE_TEXT ? "taken as OPEN on your say-so (--text)" : open ? "OPEN — the full wording above can be sent as it is" : "CLOSED — only an approved template is allowed, so you will receive \"" + TEMPLATE + "\" instead"}`);

if (!SEND) {
  console.log("\ndry run. Add --send to actually send it.");
  process.exit(0);
}

// `--text` has to bypass notifyClient entirely, not just the branch above: notifyClient asks
// hasOpenWindow ITSELF, which is the whole point of it — the rule lives in one place so no caller
// can get it wrong. The first version of this flag changed only which branch ran, notifyClient
// re-checked, and the template went out anyway. The flag means "skip the check", so it must skip
// the thing that does the checking.
const r = FORCE_TEXT
  ? { ...(await sendText({ to, body: text, kind: "renewal_due", companyId: doc.companyId ?? null })), via: "text" as const }
  : open
  ? await notifyClient({
      to, text, kind: "renewal_due",
      template: { name: TEMPLATE, language: "en_US" },
      companyId: doc.companyId ?? null,
    })
  : { ...(await sendTemplate({ to, name: TEMPLATE, language: "en_US", preview: text, kind: "renewal_due", companyId: doc.companyId ?? null })), via: "template" as const };

console.log(`\n${r.sent ? "SENT" : "NOT SENT"} — as ${r.via}${r.messageId ? ` · ${r.messageId}` : ""}${r.reason ? ` · ${r.reason}` : ""}`);
console.log("every send, skip and failure is on the WhatsAppMessage table either way.");
process.exit(r.sent ? 0 : 1);
