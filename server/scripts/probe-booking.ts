/**
 * Throwaway check: a booking link offers only real times, and can only ever do two things.
 *
 * The slug lives in a URL, so it is public whatever anybody intends. This probes it the way the web
 * intake endpoint was probed — assuming the slug is known to somebody who should not have it — and
 * separately checks the slot arithmetic, which is where the quiet errors live: a slot offered on a
 * non-working day, one that ignores an existing meeting, or one bookable with no notice.
 *
 * The overlap case is the one worth reading. A 30-minute slot at 10:00 is NOT free if something
 * runs 09:45–10:15, and a check that compares start times alone would offer it — which is how a
 * booking page double-books somebody while looking correct.
 *
 * Own link, own leads, own appointments. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { freeSlots } from "../src/booking.js";

const API = "http://localhost:4100";
const SLUG = "zz-probe-book";

async function sweep() {
  await prisma.bookingLink.deleteMany({ where: { slug: { startsWith: "zz-" } } });
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ BOOK" } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.appointment.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.appointment.deleteMany({ where: { title: { startsWith: "ZZ BOOK" } } });
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
}

const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };

  try {
    await sweep();
    const rep = await prisma.user.create({ data: { name: "ZZ Rep", email: "zz-rep@example.invalid", roleId: "sales", status: "active", type: "staff" } });
    const link = await prisma.bookingLink.create({
      data: {
        userId: rep.id, slug: SLUG, title: "ZZ BOOK consultation", minutes: 30, bufferMins: 0,
        dayStart: 9, dayEnd: 12, workDays: "1,2,3,4,5,6,7", daysAhead: 7, noticeHours: 0, active: true,
      },
    });

    // ── the slot maths ────────────────────────────────────────────────────────────────────────
    const { slots, zone } = await freeSlots(link);
    console.log(`slots are generated in the org zone:     ${zone}`);
    const perDay = new Map<string, string[]>();
    for (const s of slots) (perDay.get(s.day) ?? perDay.set(s.day, []).get(s.day)!).push(s.time);
    const sample = [...perDay.entries()].find(([d]) => d > isoDay(0));
    console.log(`  a full day offers 09:00–11:30:        ${sample && sample[1].join(",") === "09:00,09:30,10:00,10:30,11:00,11:30" ? "YES" : "NO (" + (sample ? sample[1].join(",") : "no day") + ")"}`);
    if (!sample || sample[1].join(",") !== "09:00,09:30,10:00,10:30,11:00,11:30") fail("working hours 9–12 did not produce six 30-minute slots ending at 11:30");

    // ── a non-working day is not offered ──────────────────────────────────────────────────────
    const oneDay = await prisma.bookingLink.update({ where: { id: link.id }, data: { workDays: "3" } });
    const only = await freeSlots(oneDay);
    const dows = new Set(only.slots.map(s => new Date(s.day + "T00:00:00Z").getUTCDay()));
    console.log(`\nonly the configured weekday is offered:  ${dows.size <= 1 ? "YES" : "NO (" + [...dows].join(",") + ")"}`);
    if (dows.size > 1) fail("slots appeared on days the link does not work");
    await prisma.bookingLink.update({ where: { id: link.id }, data: { workDays: "1,2,3,4,5,6,7" } });

    // ── AN EXISTING MEETING BLOCKS ITS SLOT, AND THE ONE IT OVERLAPS ──────────────────────────
    const day = isoDay(2);
    await prisma.appointment.create({ data: { title: "ZZ BOOK existing", employee: "ZZ Rep", date: day, time: "09:45", status: "Confirmed" } });
    const after = await freeSlots(await prisma.bookingLink.findUniqueOrThrow({ where: { id: link.id } }));
    const thatDay = after.slots.filter(s => s.day === day).map(s => s.time);
    console.log(`\na 09:45 meeting blocks 09:30 AND 10:00: ${!thatDay.includes("09:30") && !thatDay.includes("10:00") ? "YES" : "NO (" + thatDay.join(",") + ")"}`);
    if (thatDay.includes("09:30") || thatDay.includes("10:00")) fail("an overlapping meeting did not block both slots it runs across — this double-books people");
    console.log(`  …and 09:00 / 11:00 are still free:    ${thatDay.includes("09:00") && thatDay.includes("11:00") ? "YES" : "NO (" + thatDay.join(",") + ")"}`);
    if (!thatDay.includes("09:00") || !thatDay.includes("11:00")) fail("one meeting blocked out the whole day");
    // A cancelled meeting is not a meeting.
    await prisma.appointment.updateMany({ where: { title: "ZZ BOOK existing" }, data: { status: "Cancelled" } });
    const reopened = (await freeSlots(await prisma.bookingLink.findUniqueOrThrow({ where: { id: link.id } }))).slots.filter(s => s.day === day).map(s => s.time);
    console.log(`  cancelling it frees the slot again:   ${reopened.includes("09:30") ? "YES" : "NO"}`);
    if (!reopened.includes("09:30")) fail("a cancelled meeting still blocked its slot");
    await prisma.appointment.deleteMany({ where: { title: { startsWith: "ZZ BOOK" } } });

    // ── the public endpoints ──────────────────────────────────────────────────────────────────
    const pub: any = await (await fetch(`${API}/api/public/book/${SLUG}`)).json();
    console.log(`\nthe public read works unauthenticated:   ${Array.isArray(pub.slots) ? "YES (" + pub.slots.length + " slots)" : "NO"}`);
    if (!Array.isArray(pub.slots)) fail("the public booking endpoint did not return slots");
    console.log(`  it does NOT leak the rep's email/id:  ${!JSON.stringify(pub).includes("example.invalid") && !JSON.stringify(pub).includes(rep.id) ? "YES" : "NO"}`);
    if (JSON.stringify(pub).includes("example.invalid") || JSON.stringify(pub).includes(rep.id)) fail("the public payload carried the staff member's email or id");

    const missing = await fetch(`${API}/api/public/book/zz-does-not-exist`);
    const inactiveLink = await prisma.bookingLink.create({ data: { userId: rep.id, slug: "zz-off", title: "ZZ BOOK off", active: false } });
    const off = await fetch(`${API}/api/public/book/zz-off`);
    console.log(`  unknown and disabled look identical:  ${missing.status === off.status ? "YES (both " + missing.status + ")" : "NO (" + missing.status + " vs " + off.status + ")"}`);
    if (missing.status !== off.status) fail("a disabled link is distinguishable from a non-existent one — that is a way to enumerate slugs");
    await prisma.bookingLink.delete({ where: { id: inactiveLink.id } });

    // ── booking, and what it refuses ──────────────────────────────────────────────────────────
    const post = (b: any) => fetch(`${API}/api/public/book/${SLUG}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const free = (await freeSlots(await prisma.bookingLink.findUniqueOrThrow({ where: { id: link.id } }))).slots.find(s => s.day > isoDay(0))!;

    // The write limiter allows 10 bookings an hour per IP and this probe spends 6, so a second run
    // inside the hour runs out of budget. That is the guard doing its job, not a defect — but every
    // assertion after this point would then fail for the wrong reason, so it is detected FIRST and
    // reported in words. An earlier version dereferenced a null further down and died with a
    // TypeError, which reads as "booking is broken" when the truth is "the flood guard held".
    const probeWrite = await post({});
    if (probeWrite.status === 429) {
      console.log(`
the write limiter is holding:            YES — 10 bookings/hour/IP is spent`);
      console.log(`  this probe spends 6 per run, so the booking flow itself is NOT re-checked here.`);
      console.log(`  restart the API (or wait an hour) to run the full pass again.`);
      console.log(`
failures so far: ${bad}`);
      return;
    }

    for (const [label, body] of [
      ["no name", { email: "z@example.invalid", day: free.day, time: free.time }],
      ["no way to contact them", { name: "ZZ Visitor", day: free.day, time: free.time }],
      ["a nonsense email", { name: "ZZ Visitor", email: "nope", day: free.day, time: free.time }],
      ["a time that is not offered", { name: "ZZ Visitor", email: "z@example.invalid", day: free.day, time: "03:00" }],
    ] as const) {
      const r = await post(body);
      console.log(`  refuses ${String(label).padEnd(28)} ${r.status === 400 ? "YES" : "NO (" + r.status + ")"}`);
      if (r.status !== 400) fail(`a booking with ${label} was accepted`);
    }

    const good = await post({ name: "ZZ Visitor", company: "ZZ BOOK Co", email: "visitor@example.invalid", phone: "+966 55 123 4567", note: "ZZ probe", day: free.day, time: free.time });
    const gj: any = await good.json();
    console.log(`\na real booking is accepted:              ${good.status === 201 ? "YES — " + gj.when : "NO (" + good.status + ") " + gj.error}`);
    if (good.status !== 201) fail("a valid booking was refused");

    // ── what it created, and what it did NOT ──────────────────────────────────────────────────
    const appt = await prisma.appointment.findFirst({ where: { date: free.day, time: free.time, employee: "ZZ Rep" } });
    console.log(`  the appointment exists:               ${appt ? "YES (" + appt.status + ")" : "NO"}`);
    if (!appt) fail("no appointment was created");
    const lead = await prisma.company.findFirst({ where: { name: "ZZ BOOK Co" } });
    console.log(`  a LEAD was created, not a client:     ${lead?.lifecycle === "lead" ? "YES" : "NO (" + lead?.lifecycle + ")"}`);
    if (lead?.lifecycle !== "lead") fail("a public booking produced something other than a lead");
    console.log(`  …owned by the rep it books:           ${lead?.ownerId === rep.id ? "YES" : "NO"}`);
    if (lead?.ownerId !== rep.id) fail("the lead was not assigned to the person whose diary was booked");
    const inter = lead ? await prisma.interaction.findFirst({ where: { companyId: lead.id } }) : null;
    console.log(`  it is on the client's timeline too:   ${inter ? "YES (" + inter.kind + ")" : "NO"}`);
    if (!inter) fail("the meeting exists in a diary but not on the record's timeline");

    // ── the same slot cannot be taken twice ───────────────────────────────────────────────────
    const dup = await post({ name: "ZZ Second", email: "second@example.invalid", day: free.day, time: free.time });
    const dj: any = await dup.json();
    console.log(`\nthe same slot cannot be booked twice:    ${dup.status === 400 ? "YES" : "NO (" + dup.status + ")"}`);
    if (dup.status !== 400) fail("two people booked the same slot");
    else console.log(`  and says so plainly:                  "${String(dj.error).slice(0, 60)}"`);

    // ── the page itself ───────────────────────────────────────────────────────────────────────
    const page = await fetch(`${API}/book/${SLUG}`);
    const html = await page.text();
    console.log(`\nthe page is served and self-contained:   ${page.status === 200 && html.includes("<!doctype html>") && !html.includes("<script src=") ? "YES" : "NO"}`);
    if (page.status !== 200) fail("the booking page did not load");
    if (html.includes("<script src=")) fail("the page pulls in an external bundle — it must work when the console does not");
    console.log(`  and asks not to be indexed:           ${/noindex/.test(html) ? "YES" : "NO"}`);
    if (!/noindex/.test(html)) fail("a private booking link is indexable");

  } finally {
    await sweep();
  }

  const left = await prisma.bookingLink.count({ where: { slug: { startsWith: "zz-" } } })
    + await prisma.company.count({ where: { name: { startsWith: "ZZ BOOK" } } })
    + await prisma.user.count({ where: { email: { contains: "example.invalid" } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
