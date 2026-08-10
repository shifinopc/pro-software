/**
 * THE DAILY DIGEST — one email a morning instead of eleven through the day.
 *
 * WHY THIS EXISTS
 *
 * The owner-addressed reminders (follow-ups, quote chasing, quiet deals, renewals, web enquiries)
 * each send the moment the hourly tick notices them. That is right when there are two a week. With
 * five rule types live across a book of clients it becomes a steady drip, and a steady drip from one
 * sender is how a person builds a filter — taking the mail that mattered with it.
 *
 * So digest mode queues those reminders and sends each person ONE message at an hour they choose.
 *
 * WHAT IS DELIBERATELY NOT DIGESTED
 *
 * Anything addressed to a CLIENT. An invoice, a request update, a document rejection — those are
 * answers to something the client did, and holding one until tomorrow morning to save an email is
 * indefensible. Digest mode only ever intercepts `audience: "owner"`, which is internal by
 * definition. Staff-wide mail (approval requested, SLA breached) is left alone too: it is rare and
 * it is urgent, which is the opposite of what a digest is for.
 *
 * THE DAY BOUNDARY IS THE ORGANISATION'S, NOT THE SERVER'S
 *
 * "Send at 8am" has to mean 8am where the office is. The server may be anywhere, and on this
 * deployment it is not in Riyadh. So the hour and the day key are both computed in the timezone
 * configured in Settings → General, and the send-once guard is keyed on that local day.
 */
import { prisma } from "./db.js";
import { zoneFrom } from "./orgsettings.js";
import { sendMail } from "./mailer.js";
import { renderEmail, emailContext, esc } from "./emailshell.js";

export interface DigestSettings {
  /** "off" sends each reminder as it happens; "daily" collects them into one message. */
  mode: "off" | "daily";
  /** Local hour, 0–23, at or after which the day's digest goes out. */
  hour: number;
  /** IANA zone resolved from Settings → General, or UTC when it cannot be read. */
  zone: string;
}

const DEFAULTS: DigestSettings = { mode: "off", hour: 8, zone: "UTC" };

// zoneFrom now lives in orgsettings.ts — a booking page and a digest must agree on what time it is.

export async function digestSettings(): Promise<DigestSettings> {
  try {
    const [row, org] = await Promise.all([
      prisma.appSetting.findUnique({ where: { key: "notifDigest" } }),
      prisma.appSetting.findUnique({ where: { key: "org" } }),
    ]);
    const v = (row?.value ?? {}) as Record<string, unknown>;
    const hour = Number(v.hour);
    return {
      mode: v.mode === "daily" ? "daily" : "off",
      hour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? Math.floor(hour) : DEFAULTS.hour,
      zone: zoneFrom((org?.value as any)?.timezone),
    };
  } catch {
    return DEFAULTS;
  }
}

/** The wall-clock day and hour in a given zone. */
export function localParts(zone: string, at: Date): { day: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(f.formatToParts(at).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export interface QueuedItem {
  email: string;
  rule: string;
  title: string;
  detail?: string | null;
  url?: string | null;
  orphan?: boolean;
}

/** Park a reminder until the digest goes out. Never throws — a queue failure must not break a job. */
export async function queueForDigest(item: QueuedItem): Promise<boolean> {
  try {
    await prisma.digestItem.create({
      data: {
        email: item.email, rule: item.rule,
        title: item.title, detail: item.detail ?? null, url: item.url ?? null,
        orphan: !!item.orphan, createdAt: new Date().toISOString(),
      },
    });
    return true;
  } catch (e: any) {
    console.error(`[digest] could not queue for ${item.email}: ${e?.message ?? e}`);
    return false;
  }
}

const consoleUrl = () => process.env.CONSOLE_URL || "https://pro.ionob.in";

/** Human order — what somebody should deal with first, not alphabetical. */
const RULE_ORDER = ["Follow-up due", "New website enquiry", "Quotation needs chasing", "Renewal became a deal", "Deal has gone quiet"];
const rank = (r: string) => { const i = RULE_ORDER.indexOf(r); return i < 0 ? RULE_ORDER.length : i; };

function buildLines(items: { rule: string; title: string; detail: string | null; url: string | null; orphan: boolean }[]) {
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    if (!groups.has(it.rule)) groups.set(it.rule, []);
    groups.get(it.rule)!.push(it);
  }
  const lines: string[] = [];
  for (const rule of [...groups.keys()].sort((a, b) => rank(a) - rank(b))) {
    const rows = groups.get(rule)!;
    lines.push(`<b style="text-transform:uppercase;letter-spacing:.05em;font-size:11px;color:#8C8899;">${esc(rule)} · ${rows.length}</b>`);
    for (const r of rows) {
      const link = r.url ? ` <a href="${esc(r.url)}" style="color:#7C00FF;">open</a>` : "";
      const detail = r.detail ? `<br><span style="color:#6F6C7A;">${esc(r.detail)}</span>` : "";
      lines.push(`${esc(r.title)}${link}${detail}`);
    }
  }
  return lines;
}

export interface DigestOutcome {
  mode: string;
  /** People who received a digest this run. */
  sent: number;
  items: number;
  /** Queued items still waiting because it is not their hour yet. */
  waiting: number;
  details: string[];
}

/**
 * Send whatever is due. Called from the hourly tick.
 *
 * Runs even when the mode is OFF, and that is on purpose: switching digest mode off must not strand
 * whatever was already queued. In that case everything waiting is flushed immediately rather than
 * held for an hour that will never be checked again.
 */
export async function sendDueDigests(now = new Date()): Promise<DigestOutcome> {
  const cfg = await digestSettings();
  const out: DigestOutcome = { mode: cfg.mode, sent: 0, items: 0, waiting: 0, details: [] };

  const pending = await prisma.digestItem.findMany({ where: { sentAt: null }, orderBy: { createdAt: "asc" }, take: 2000 });
  if (!pending.length) return out;

  const { day, hour } = localParts(cfg.zone, now);
  // Mode off = flush now. Mode daily = only once the local hour has arrived.
  if (cfg.mode === "daily" && hour < cfg.hour) {
    out.waiting = pending.length;
    out.details.push(`${pending.length} waiting until ${String(cfg.hour).padStart(2, "0")}:00 ${cfg.zone} (now ${String(hour).padStart(2, "0")}:00)`);
    return out;
  }

  const byPerson = new Map<string, typeof pending>();
  for (const p of pending) {
    if (!byPerson.has(p.email)) byPerson.set(p.email, []);
    byPerson.get(p.email)!.push(p);
  }

  const ctx = await emailContext();
  const org = ctx.org;
  for (const [email, items] of byPerson) {
    // Claim the day BEFORE sending. The unique index makes this the whole concurrency story: if two
    // ticks overlap, exactly one insert survives and the other gets nothing to do.
    try {
      await prisma.digestRun.create({ data: { email, day, items: items.length, sentAt: new Date().toISOString() } });
    } catch {
      out.details.push(`${email}: already sent today`);
      continue;
    }

    const orphanCount = items.filter(i => i.orphan).length;
    const { html, text } = renderEmail(ctx, {
      heading: items.length === 1 ? "One thing needs you today" : `${items.length} things need you today`,
      preheader: `${items.length} item${items.length === 1 ? "" : "s"} from ${org}.`,
      lines: [
        ...(orphanCount ? [`<b>${orphanCount} of these belong to nobody.</b> They come to you because the record has no owner — assigning one sends them to that person instead.`] : []),
        ...buildLines(items),
      ],
      cta: { label: "Open the console", url: `${consoleUrl()}/dashboard` },
      note: cfg.mode === "daily"
        ? `This is your daily summary, sent at ${String(cfg.hour).padStart(2, "0")}:00 ${esc(cfg.zone)}. Change it in Settings → Notifications.`
        : "Daily summaries are switched off — this is the last batch that was still waiting.",
    });

    try {
      await sendMail({ to: email, subject: `${org} — ${items.length} thing${items.length === 1 ? "" : "s"} for you today`, html, text });
      await prisma.digestItem.updateMany({ where: { id: { in: items.map(i => i.id) } }, data: { sentAt: new Date().toISOString() } });
      out.sent++;
      out.items += items.length;
      out.details.push(`${email}: ${items.length} item(s)`);
    } catch (e: any) {
      // The DigestRun row stays, so this person is not retried in a loop today — but the items keep
      // sentAt = null, so tomorrow's digest still carries them. A mail outage delays, never deletes.
      console.error(`[digest] failed to email ${email}: ${e?.message ?? e}`);
      out.details.push(`${email}: FAILED — ${e?.message ?? e}`);
    }
  }
  return out;
}

/**
 * Housekeeping. Sent items are kept for a week so a "did they get told?" question can be answered,
 * then dropped — this table would otherwise grow forever for no reader.
 */
export async function pruneDigests(days = 7): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const a = await prisma.digestItem.deleteMany({ where: { sentAt: { not: null, lt: cutoff } } });
  await prisma.digestRun.deleteMany({ where: { sentAt: { lt: cutoff } } });
  return a.count;
}
