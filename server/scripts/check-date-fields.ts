/**
 * Keep DATE_FIELDS honest against the schema.
 *
 * The first version of that list was written from memory. It named four columns that do not exist
 * and missed two that do — and both mistakes are silent: a field that is not there is simply never
 * normalised, and a field that is missing from the list is simply never checked. Nothing fails, the
 * bad values just keep arriving.
 *
 *   npx tsx scripts/check-date-fields.ts
 *
 * Exits non-zero when the two disagree, so it can go in front of a deploy.
 */
import { Prisma } from "@prisma/client";
import { DATE_FIELDS } from "../src/dates.js";

/**
 * Timestamps the server writes itself, in full ISO with a time. They are not user-entered dates and
 * must keep their time of day, so they are deliberately outside this mechanism.
 */
const SERVER_TIMESTAMPS = /^(createdAt|updatedAt|lastClientMsgAt|lastUsedAt|lastActive|at|suspendedAt|supersededAt|deletedAt|lockedUntil|sessionsInvalidBefore|readAt|sentAt|archivedAt)$/i;

/**
 * Columns whose name says "date" but whose value is a full server-written timestamp. `Activity.date`
 * is the feed's ordering key, set to `new Date().toISOString()` — normalising it would throw away
 * the time of day and collapse a day's activity into one indistinguishable block.
 */
const SERVER_TIMESTAMP_FIELDS = new Set([
  "activity.date",
  // Derived from the step's slaHours — 24 to 240 — so it carries a real time of day. Rounding it to
  // a date would move every SLA deadline to midnight and change which tasks count as breached.
  "workflowTask.dueDate",
]);

const looksLikeADate = (name: string) => /(^|[a-z])(date|expiry|until|dob)\b/i.test(name);

const problems: string[] = [];
const expected = new Map<string, string[]>();

for (const model of Prisma.dmmf.datamodel.models) {
  const key = model.name.charAt(0).toLowerCase() + model.name.slice(1);
  const fields = model.fields
    .filter(f => f.type === "String" && looksLikeADate(f.name) && !SERVER_TIMESTAMPS.test(f.name)
                 && !SERVER_TIMESTAMP_FIELDS.has(`${key}.${f.name}`))
    .map(f => f.name);
  if (fields.length) expected.set(key, fields);

  const listed = DATE_FIELDS[key] ?? [];
  const real = new Set(model.fields.map(f => f.name));
  for (const f of listed) {
    if (!real.has(f)) problems.push(`${key}.${f} is in DATE_FIELDS but not in the schema`);
  }
  for (const f of fields) {
    if (!listed.includes(f)) problems.push(`${key}.${f} looks like a date column but is not in DATE_FIELDS`);
  }
}

for (const key of Object.keys(DATE_FIELDS)) {
  if (!Prisma.dmmf.datamodel.models.some(m => m.name.charAt(0).toLowerCase() + m.name.slice(1) === key)) {
    problems.push(`${key} is in DATE_FIELDS but is not a model`);
  }
}

if (problems.length) {
  console.error(`DATE_FIELDS and the schema disagree in ${problems.length} place(s):\n`);
  problems.forEach(p => console.error("  " + p));
  console.error("\nExpected, from the schema:\n");
  console.error(JSON.stringify(Object.fromEntries([...expected].sort()), null, 2));
  process.exit(1);
}

const total = Object.values(DATE_FIELDS).reduce((n, f) => n + f.length, 0);
console.log(`DATE_FIELDS matches the schema — ${total} column(s) across ${Object.keys(DATE_FIELDS).length} model(s).`);
