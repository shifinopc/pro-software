/**
 * THE `money` CAPTURE: an answer that is a payment, not a number.
 *
 * A PRO officer pays a ministry fee at the counter and the client is re-charged it later. That was
 * already being recorded — as loose variables on the run, under whatever name the template author
 * invented. Iqama Renewal spelled ONE payment four times (`permitAmount`, `permitPaid`, `permitRef`,
 * `permitPaidOn`) and the only thing tying the four together was a person reading them.
 *
 * A money capture is that quartet as a single question. The officer still types one amount, but the
 * reference, the date and whether it has actually been handed over travel with it, and the answer
 * becomes a Disbursement row rather than four strings in a JSON blob.
 *
 * WHY THE PLAIN AMOUNT IS STILL WRITTEN TO THE VARIABLE. Changing `permitAmount` from `number` to
 * `money` must not break a decision that reads `permitAmount`. So the capture keeps its name and the
 * variable keeps holding the number; everything else is extra. That is what lets the templates be
 * migrated field by field instead of all at once.
 */
import { prisma } from "./db.js";

const nowISO = () => new Date().toISOString();

export const MONEY = "money";

/** What the form sends for a money capture. Amount is in whole currency units, as typed. */
export type MoneyAnswer = {
  amount: string | number;
  reference?: string;
  paidOn?: string;
  paid?: boolean;
  /** "firm" | "client" — whose money actually went to the ministry. */
  payer?: string;
  receiptFileId?: string;
};

/**
 * Parse what arrived for a money capture.
 *
 * Accepts the object, or a JSON string of it, or a bare number — the last because a step migrated
 * from `number` to `money` may still be completed by an older client, or by a script, and refusing
 * the answer it used to accept would lose the payment rather than record it plainly.
 */
export function parseMoney(raw: unknown): MoneyAnswer | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  let v: any = raw;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{")) {
      try { v = JSON.parse(s); } catch { return null; }
    } else {
      return { amount: s };
    }
  }
  if (typeof v === "number") return { amount: v };
  if (typeof v !== "object") return null;
  return {
    amount: v.amount ?? "",
    reference: v.reference ? String(v.reference).trim() : undefined,
    paidOn: v.paidOn ? String(v.paidOn).trim() : undefined,
    // Absent means paid: recording a payment is the ordinary case, and a step that does not ask
    // the question should not mark every fee outstanding.
    paid: v.paid === undefined ? true : !!v.paid,
    // Absent means the firm paid it, because that is what a PRO office does by default and what
    // every step recorded before this field existed. Only "client" moves it.
    payer: String(v.payer ?? "firm") === "client" ? "client" : "firm",
    receiptFileId: v.receiptFileId ? String(v.receiptFileId) : undefined,
  };
}

/**
 * Minor units from what somebody typed.
 *
 * Returns null rather than 0 for anything that is not a number, because 0 is a real amount a
 * waiver produces and "not a number" is a refusal. Rounds rather than truncates: 12.345 is
 * 1234 halalas (trunc) or 1235 (round), and the second is the one that does not quietly lose money.
 */
export function minorFromTyped(raw: unknown): number | null {
  // Strip grouping and any currency text somebody typed in front of the figure.
  const s = String(raw ?? "").replace(/[,\s]/g, "").replace(/^[^\d.-]+/, "");
  if (!s || !/^-?\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** The amount a money answer carries, for writing back to the run variable. */
export const moneyAmountText = (m: MoneyAnswer): string => String(m.amount ?? "").trim();

type Cap = { var?: string; label?: string; type?: string; chargeTypeId?: string | null };

/**
 * Record every money capture a step just answered.
 *
 * UPSERT, not create. Completing a step twice — a re-opened task, a retried request — must correct
 * the payment rather than record it a second time, which is why (workflowTaskId, varName) is unique
 * in the schema rather than enforced by a lookup here.
 *
 * Never throws into the completion path: a payment that fails to file is worth a log line, not a
 * refused step with the ministry fee already paid in cash.
 */
export async function recordDisbursements(args: {
  captures: Cap[];
  supplied: Record<string, any>;
  instanceId: string;
  taskId: string;
  companyId: string | null;
  clientName: string | null;
  actor?: string | null;
}): Promise<number> {
  const money = args.captures.filter(c => c && String(c.type) === MONEY && c.var);
  if (!money.length) return 0;
  let n = 0;
  for (const cap of money) {
    try {
      const m = parseMoney(args.supplied[cap.var!]);
      if (!m) continue;
      const amountMinor = minorFromTyped(m.amount);
      if (amountMinor === null) continue; // validated on the way in; here it means "nothing usable"
      // A fee the client paid straight to the ministry is recorded, because it is what the job cost
      // and the reference is the proof — but it is not the firm's money, so it must never reach an
      // invoice. Billing it would charge them a second time for something already paid.
      const fromClient = m.payer === "client";
      await prisma.disbursement.upsert({
        where: { workflowTaskId_varName: { workflowTaskId: args.taskId, varName: cap.var! } },
        create: {
          companyId: args.companyId, clientName: args.clientName,
          workflowInstanceId: args.instanceId, workflowTaskId: args.taskId,
          chargeTypeId: cap.chargeTypeId ?? null,
          label: cap.label || cap.var!, varName: cap.var!,
          amountMinor, reference: m.reference ?? null,
          payer: fromClient ? "client" : "firm",
          recharge: !fromClient,
          paid: m.paid !== false, paidAt: m.paidOn ?? null,
          receiptFileId: m.receiptFileId ?? null,
          recordedBy: args.actor ?? null, at: nowISO(),
        },
        update: {
          chargeTypeId: cap.chargeTypeId ?? null,
          label: cap.label || cap.var!,
          amountMinor, reference: m.reference ?? null,
          // Correcting WHO paid corrects whether it is billable, in both directions. Leaving it
          // one-way looked safer and was worse: payer is the only thing that turns `recharge` off,
          // so a mis-tap on a busy step would have made a real fee unbillable for good, with no
          // screen anywhere to put it right.
          payer: fromClient ? "client" : "firm",
          recharge: !fromClient,
          paid: m.paid !== false, paidAt: m.paidOn ?? null,
          ...(m.receiptFileId ? { receiptFileId: m.receiptFileId } : {}),
        },
      });
      n++;
    } catch (e) {
      console.warn(`[disbursement] could not record "${cap.var}" on task ${args.taskId}:`, e);
    }
  }
  return n;
}
