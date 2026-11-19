/**
 * PROPOSALS ARE THE FIRM'S OWN WORD FILE, FILLED IN.
 *
 * The brief was "do not change anything in the design", and the cheapest way to honour that is not
 * to redraw the design at all. The firm's `.docx` — its fonts, its page backgrounds, its eleven
 * images, its exact spacing — is uploaded as the template, its `{{tokens}}` are replaced with the
 * quotation's values, and what comes out is their document with this client's name on it.
 *
 * Which also answers "support any proposal" without a designer screen: a second kind of proposal is
 * a second upload. Nothing here knows anything about business setup, MISA or Outland.
 *
 * Delimiters are `{{ }}` rather than the library's single braces, because a proposal full of
 * currency and percentages has enough lone braces in it already.
 */
import { TemplateHandler, TemplateHandlerOptions } from "easy-template-x";
import { prisma } from "./db.js";

const handler = new TemplateHandler(new TemplateHandlerOptions({
  delimiters: { tagStart: "{{", tagEnd: "}}" },
}));

/** Every token a template asks for, so the picker can say what it needs before it is used. */
export async function tokensIn(docx: Buffer): Promise<string[]> {
  const tags = await handler.parseTags(docx);
  return [...new Set(tags.map(t => t.name).filter(Boolean))].sort();
}

/**
 * A template's own stored values, as the `param.*` tokens the document asks for.
 *
 * Merged over the quotation's data at render time rather than inside `proposalData`, because these
 * belong to the TEMPLATE and `proposalData` is given a quotation. Values are stringified: a number
 * typed into a form arrives as a string anyway, and a document prints text.
 */
export function paramTokens(params: unknown): Record<string, string> {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[`param.${k}`] = String(v);
  }
  return out;
}

export async function renderDocx(docx: Buffer, data: Record<string, unknown>): Promise<Buffer> {
  return handler.process(docx, data as any);
}

/**
 * The same document as a PDF, for previewing and for sending.
 *
 * LibreOffice converts it, because nothing else reproduces the firm's design — and the design is
 * the one thing this feature promised not to touch. It is driven as a command rather than a library
 * since there is no binding worth the dependency, and it insists on writing to a directory rather
 * than a stream, so the file goes to a temporary one and is cleaned up either way.
 *
 * `-env:UserInstallation` gives each run its own profile directory. Without it two conversions at
 * once fight over one profile in $HOME and the second fails with a lock error — which on a screen
 * that previews on open means the second person to click sees nothing and no reason why.
 *
 * Returns null rather than throwing when LibreOffice is absent: an installation without it should
 * still be able to download the .docx, which is what it did before this existed.
 */
let converting: Promise<unknown> = Promise.resolve();   // conversions run one at a time

/** Where soffice is: the env override, then PATH, then where the Windows installer puts it. */
function sofficeCandidates(): string[] {
  return [
    process.env.SOFFICE_PATH,
    "soffice",
    "C:\Program Files\LibreOffice\program\soffice.exe",
    "C:\Program Files (x86)\LibreOffice\program\soffice.exe",
  ].filter(Boolean) as string[];
}

/** Throw away the shared profile, so the next conversion starts from a clean one. */
async function resetProfile(dir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * The same document as a PDF, for previewing and for sending.
 *
 * LibreOffice converts it, because nothing else reproduces the firm's design — and the design is
 * the one thing this feature promised not to touch. It is driven as a command rather than a library
 * since there is no binding worth the dependency.
 *
 * WHAT THE FOUR SECONDS ARE, measured on the live box with the real 2.8 MB proposal: 5,961 ms with
 * a brand-new profile, 5,171 ms reusing one, and 1,598 ms of that is simply starting LibreOffice —
 * a one-line text file costs the same to convert. The rest is the document, which is mostly
 * oversized embedded images.
 *
 * Only the profile is recoverable here, and it is: one directory for the life of the process rather
 * than a fresh one per request. (Leaving an instance RUNNING to skip the startup does not work —
 * `soffice --convert-to` against a live instance shuts it down when it finishes, so the next
 * conversion starts cold anyway, having paid for the spawn. Skipping the startup needs a UNO client
 * that does not terminate the server, which is more machinery than this has earned.) The rest of
 * the win is in not converting the same document twice — see the cache in the route.
 *
 * ONE AT A TIME. Conversions are chained onto a single promise: they share one profile now, and on
 * two cores two renders at once would be slower than two in a row as well as racing for its lock.
 *
 * Returns null rather than throwing when LibreOffice is absent: an installation without it should
 * still be able to download the .docx, which is what it did before this existed.
 */
export async function docxToPdf(docx: Buffer): Promise<Buffer | null> {
  const next = converting.then(() => convertOnce(docx, true));
  // The queue must survive a failure, or one bad conversion wedges every one after it.
  converting = next.catch(() => {});
  return next;
}

async function convertOnce(docx: Buffer, mayRetry: boolean): Promise<Buffer | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const run = promisify(execFile);

  // One profile directory for the life of the process, not one per conversion. The per-run profile
  // was there to stop two conversions fighting over a lock; the queue above does that job now, and
  // does it without rebuilding the profile every time.
  const profile = path.join(os.tmpdir(), "stimes-lo-profile");
  await fs.mkdir(profile, { recursive: true }).catch(() => {});

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-"));
  const src = path.join(dir, "in.docx");
  try {
    await fs.writeFile(src, docx);
    let lastErr: any = null;
    for (const bin of sofficeCandidates()) {
      try {
        await run(bin, [
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, src,
        ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
        return await fs.readFile(path.join(dir, "in.pdf"));
      } catch (e: any) {
        lastErr = e;
        // ENOENT means "not at this path" — try the next one. Anything else is a real failure of a
        // converter that IS there, so stop rather than hiding it behind three more attempts.
        if (e?.code !== "ENOENT") break;
      }
    }
    // A SHARED PROFILE CAN GO BAD — a conversion killed half way through leaves a lock behind, and
    // every conversion after it then fails while the .docx itself is perfectly fine. So one failure
    // throws the profile away and tries again with a new one, which is the state this was in when
    // it built a fresh profile every time.
    if (mayRetry && lastErr && lastErr.code !== "ENOENT") {
      console.warn("[proposal] conversion failed; rebuilding the LibreOffice profile and retrying once:",
                   lastErr?.message ?? lastErr);
      await resetProfile(profile);
      return convertOnce(docx, false);
    }
    if (lastErr && lastErr.code !== "ENOENT") {
      console.error("[proposal] could not convert to PDF:", lastErr?.message ?? lastErr);
    }
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Money ─────────────────────────────────────────────────────────────────────

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function under1000(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  return ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " and " + under1000(n % 100) : "");
}

/**
 * "Thirty-Five Thousand Saudi Riyals Only" — the line the sample proposal prints under its total.
 *
 * Written out here rather than pulled from a package: this is one sentence in one document, and the
 * halala half needs saying in the local idiom ("and Fifty Halalas") which a generic library gets
 * wrong as often as right.
 */
export function amountInWords(minor: number, currency = "SAR"): string {
  const NAMES: Record<string, [string, string]> = {
    SAR: ["Saudi Riyals", "Halalas"], AED: ["UAE Dirhams", "Fils"], USD: ["US Dollars", "Cents"],
  };
  const [major, sub] = NAMES[currency] ?? [currency, "Cents"];
  const whole = Math.floor(Math.abs(minor) / 100);
  const frac = Math.abs(minor) % 100;

  const groups: Array<[number, string]> = [[1_000_000_000, "Billion"], [1_000_000, "Million"], [1000, "Thousand"]];
  let rest = whole;
  const parts: string[] = [];
  for (const [size, label] of groups) {
    if (rest >= size) { parts.push(under1000(Math.floor(rest / size)) + " " + label); rest %= size; }
  }
  if (rest) parts.push(under1000(rest));
  const words = parts.length ? parts.join(" ") : "Zero";
  return `${words} ${major}` + (frac ? ` and ${under1000(frac)} ${sub}` : "") + " Only";
}

const money = (minor: number) => (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * One date format for the whole document, matching the sample's "06. 10. 2026".
 *
 * The validity line reads as prose ("5th November 2026") and the reference block as digits, so both
 * shapes are offered and the template chooses by which token it uses.
 */
const fmtDots = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(String(iso) + (String(iso).length === 10 ? "T00:00:00Z" : ""));
  if (isNaN(+d)) return String(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}. ${p(d.getUTCMonth() + 1)}. ${d.getUTCFullYear()}`;
};
const fmtLong = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(String(iso) + (String(iso).length === 10 ? "T00:00:00Z" : ""));
  if (isNaN(+d)) return String(iso);
  const day = d.getUTCDate();
  const ord = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${ord} ${d.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
};

/**
 * Everything a template may ask for, built from the quotation.
 *
 * Deliberately flat and generous: a template is somebody else's Word file, and the cost of offering
 * a token nobody uses is nothing, while the cost of missing one is a document that cannot be
 * produced until a developer adds a line here.
 */
/**
 * `overrides` are what the person typed in the proposal dialog but has not committed to the
 * quotation yet. The preview has to show what WILL be printed while they are still editing, and
 * writing to the record on every keystroke to achieve that would be the wrong trade.
 */
export async function proposalData(
  quotationId: string,
  overrides?: { presentedBy?: string | null; date?: string | null; validUntil?: string | null },
  /**
   * Tokens the chosen template actually asks for, so a stage can say which fee it bills.
   *
   * Left out, the base is folded into the label — the safe default, because every template in
   * existence uses {{milestone.label}} and none of them uses {{milestone.of}}.
   */
  templateTokens?: string[],
  /** The stage rows configured on the chosen template, used when the quotation has none of its own. */
  templateStages?: any[],
): Promise<Record<string, unknown> | null> {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) return null;
  const o = overrides ?? {};
  const ovDate = o.date?.trim() || q.date;
  const ovValid = o.validUntil?.trim() || q.validUntil;

  const co = q.companyId ? await prisma.company.findUnique({ where: { id: q.companyId } }) : null;
  const org = (await prisma.appSetting.findUnique({ where: { key: "org" } }))?.value as any ?? {};
  const currency = String(org.currency ?? "SAR").split(/[\s—-]/)[0] || "SAR";

  // "PRESENTED BY" IS WHOEVER WROTE THE OFFER.
  //
  // It used to be the client's standing PRO officer, which is a different person and a different
  // fact: the officer handles the client's government work, while the proposal is put together by
  // whoever is selling. On a document somebody signs, the name has to be the person the client will
  // reply to.
  //
  // Falls back to the client's officer and then the firm, for quotations written before this was
  // recorded — a proposal presented by nobody reads as unfinished.
  const creator = q.createdById
    ? await prisma.user.findUnique({ where: { id: q.createdById }, select: { name: true, email: true } })
    : null;
  const ownerId = (co?.roleOwners as any)?.pro_officer ?? null;
  const officer = !creator && ownerId
    ? await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true, email: true } })
    : null;
  // WHOEVER OWNS THE LEAD, which is the salesperson — and "whoever is selling" is exactly what
  // this field is for. It was missing from the chain entirely: the chain asked for the client's
  // PRO officer, who handles their government work, and never for the person whose name is on
  // the lead. Every quotation on live reached the end of the chain and printed nothing, on
  // records that all had an owner sitting one column away.
  //
  // Above the officer, below the creator: the person who wrote it beats the person who owns the
  // relationship, and both beat the officer who was never involved in the sale.
  const salesOwner = !creator && !q.createdByName && co?.ownerId
    ? await prisma.user.findUnique({ where: { id: co.ownerId }, select: { name: true, email: true } })
    : null;
  // …and the firm itself at the end of the chain. A quotation written before the creator was
  // recorded, for a client with no officer named, printed "Presented by :" and then nothing — which
  // on a document somebody signs looks like a fault rather than a gap in old data.
  const owner = creator
    ?? (q.createdByName ? { name: q.createdByName, email: "" } : null)
    ?? salesOwner
    ?? officer
    ?? ((org.legalName ?? org.orgName) ? { name: String(org.legalName ?? org.orgName), email: "" } : null);
  // Typed in the dialog wins over all of it: the person sending it knows whose name belongs on
  // the document better than any record does.
  const presentedBy = o.presentedBy?.trim() || owner?.name || "";

  const rawItems: any[] = Array.isArray(q.items) ? (q.items as any[]) : [];
  const items = rawItems.map((it, i) => {
    // `price` is stored in MAJOR units on the line (225 = SAR 225) while the document totals are in
    // minor (22500). Mixing the two is how a proposal prints a hundredth of its own total.
    const units = Number(it.units ?? it.qty ?? 1) || 1;
    const lineMinor = Math.round(Number(it.price ?? 0) * 100) * units;
    return {
      "item.no": String(i + 1),
      "item.description": String(it.name ?? it.description ?? ""),
      "item.units": String(units),
      "item.amount": money(lineMinor),
    };
  });

  // FALL BACK TO THE LINES WHEN THE STORED TOTALS SAY NOTHING.
  //
  // The console's builder computes subtotal/vat/total as you type, but a quotation created any other
  // way — the API, an import, an older row — can carry five priced lines and a total of zero. A
  // proposal that prints "Total 0" and "In Words: Zero Saudi Riyals Only" under five real services
  // is worse than one that refuses to print, so the lines are the fallback and they are already
  // here.
  const linesMinor = items.reduce((a, _it, i) => {
    const raw = rawItems[i] ?? {};
    return a + Math.round(Number(raw.price ?? 0) * 100) * (Number(raw.units ?? raw.qty ?? 1) || 1);
  }, 0);
  // THE DOCUMENT PRINTS MONEY EXCLUSIVE OF TAX.
  //
  // The line amounts always were — they are the prices as entered — but the total was taken from
  // `totalMinor`, which the quotation stores with VAT added. So a proposal listing 10.00 and 22.00
  // footed up to 36.80, under terms that say in as many words "all fees are exclusive of VAT and
  // government fees". Three figures, two of them disagreeing with the third and with the paragraph
  // beneath them.
  //
  // `total.gross` is still published for a template that wants to show the tax-inclusive figure —
  // this fixes which number the standard `total.amount` carries, it does not decide for every firm.
  const netMinor = q.subtotalMinor || linesMinor
    || q.totalMinor || Math.round(Number(q.amount ?? 0) * 100);
  const grossMinor = q.totalMinor || netMinor;
  const totalMinor = netMinor;
  const subtotalMinor = netMinor;

  /**
   * PROFESSIONAL FEES AND GOVERNMENT FEES ARE BILLED AT DIFFERENT STAGES.
   *
   * The firm's own terms say so in as many words: "50% of Professional Fees upon signing", "100% of
   * Government Fees upon approval of the MISA Licence". Those are percentages of two DIFFERENT
   * subtotals, so a schedule computed off the grand total bills the wrong money at every stage —
   * on the quotation that prompted this, 50% of the total was 30% more than 50% of the fees.
   *
   * The only thing that can tell the two apart is the line's own `kind`, which is why it exists.
   * A line with no `kind` counts as professional: every quotation written before the field existed
   * was quoting fees, and "100% of professional fees" is the honest reading of an unmarked line.
   */
  const kindMinor = (want: string) => rawItems.reduce((a, raw) => {
    if (String(raw?.kind ?? "prof") !== want) return a;
    return a + Math.round(Number(raw?.price ?? 0) * 100) * (Number(raw?.units ?? raw?.qty ?? 1) || 1);
  }, 0);
  const profMinor = kindMinor("prof");
  const govMinor = kindMinor("gov");
  /**
   * AND A THIRD: THE FOREIGN COMPANY ITSELF.
   *
   * A Saudi entity with a foreign parent often needs that parent acquired or incorporated first,
   * and the firm's own quotations have always carried it as its own line - "Indian Company
   * takeover", "Company Acquire Oman", "US Company Formation" - at SAR 10,000 to 16,000, beside a
   * separate professional fee. It is neither: not the firm's Saudi fee, and not a Saudi ministry
   * charge, and the firm's terms bill it on its own schedule ("100% for Foreign Company
   * Incorporation") because the money leaves for a foreign agent before the Saudi work starts.
   *
   * Folding it into the professional fees would bill it at 50/30/20 - on a real quotation of
   * 15,000 fees + 16,000 acquisition, 50% on signing collects 15,500 where the terms ask for
   * 16,000 + 7,500. Wrong at every stage, and short exactly when the foreign agent must be paid.
   */
  const foreignMinor = kindMinor("foreign");
  /**
   * With no lines at all there is nothing to split, so every basis falls back to the total — a
   * quotation carrying only a figure still prints a schedule that foots up to it. With lines, a
   * basis of zero is a true answer and is printed as zero rather than quietly becoming the total.
   */
  const baseFor = (basis: string) => {
    if (!rawItems.length) return totalMinor;
    if (basis === "gov") return govMinor;
    if (basis === "foreign") return foreignMinor;
    if (basis === "prof") return profMinor;
    return totalMinor;
  };
  const OF_LABEL: Record<string, string> = {
    prof: "Professional Fees", gov: "Government Fees", foreign: "Foreign Company Fees", total: "",
  };

  /**
   * WHICH FEE A STAGE BILLS HAS TO SURVIVE ONTO THE PAGE.
   *
   * Every template in use prints a stage as amount + label and nothing else, so two stages at the
   * same milestone against different fees came out as the same sentence twice:
   *
   *     SAR 3,000.00/- Upon approval of the MISA Licence      <- 30% of professional fees
   *     SAR 4,000.00/- Upon approval of the MISA Licence      <- 100% of government fees
   *
   * Identical wording, different money, on a document somebody signs. The base is therefore folded
   * into the label unless the template asks for {{milestone.of}} and places it itself.
   *
   * Only the base, never the percentage: one template already prints "({{milestone.pct}}%)" and
   * would say it twice. A stage against the whole quotation has no base to name, so its label is
   * untouched — which is also every proposal written before schedules existed.
   */
  const ofInTemplate = Array.isArray(templateTokens) && templateTokens.includes("milestone.of");
  const amountOf = (m: any) => m.amountMinor != null
    ? Number(m.amountMinor)
    : Math.round(baseFor(String(m.basis ?? "total")) * (Number(m.pct ?? 0) / 100));

  /**
   * WHOSE SCHEDULE THIS IS: the quotation's, else the template's, else the whole amount.
   *
   * Terms belong to the kind of work being sold — business setup is billed 50/30/20 with the
   * government fees on licence approval, a PRO retainer is not — so they are configured once on
   * the proposal template. A quotation that was given its own stages keeps them: somebody typed
   * those for this deal, and a default must never quietly replace a negotiated term.
   *
   * A TEMPLATE's stage billing a fee the quotation does not carry is dropped rather than printed
   * as SAR 0.00. The template is a general rule meeting a particular deal, and "100% of Government
   * Fees — SAR 0.00" on a client's offer reads as a mistake. A stage the quotation itself names is
   * never dropped: a zero there is somebody's own arithmetic, and hiding it would hide the error.
   */
  const rawMs: any[] = Array.isArray(q.milestones) ? (q.milestones as any[]) : [];
  const tplMs: any[] = Array.isArray(templateStages) ? templateStages : [];
  const fromTemplate = !rawMs.length && tplMs.length > 0;
  const chosen = rawMs.length ? rawMs : (fromTemplate ? tplMs.filter(m => amountOf(m) > 0) : []);
  // Never an empty payment-terms section: no schedule at all, or a template whose every stage came
  // to nothing, still has to say what the client owes.
  const source = chosen.length ? chosen : [{ label: "upon signing", pct: 100, basis: "total" }];

  const milestones = source.map((m, i) => {
    const pct = Number(m.pct ?? 0);
    const basis = String(m.basis ?? "total");
    // A stored amount still wins, for a stage agreed as a flat sum rather than a percentage.
    const amountMinor = amountOf(m);
    const of = OF_LABEL[basis] ?? "";
    const label = String(m.label ?? "");
    return {
      "milestone.no": String(i + 1),
      "milestone.label": of && !ofInTemplate ? `${label} (${of})` : label,
      "milestone.pct": pct ? String(pct) : "",
      "milestone.of": of,
      "milestone.amount": money(amountMinor),
      // WHAT THE STAGE ASKS FOR, as the firm wants it printed: the percentage, not the money.
      //
      // The amount is derivable from the total and the percentage is not — "50% of professional
      // fees" survives a renegotiated figure, where "SAR 30,000/-" has to be re-agreed with it.
      // Both templates printed the money, one of them twice over ("SAR 30,000/- (50%)").
      //
      // Falls back to the amount for a stage agreed as a flat sum, which has no percentage to
      // print: an empty share would leave a line reading only "Upon signing of the agreement".
      "milestone.share": pct ? `${pct}%` : `SAR ${money(amountMinor)}/-`,
    };
  });

  return {
    "client.name": q.clientName ?? co?.name ?? "",
    "client.cr": co?.cr ?? "",
    "client.contact": co?.contact ?? "",
    "client.email": co?.email ?? "",
    "client.phone": co?.phone ?? "",

    "owner.name": presentedBy,
    "owner.email": owner?.email ?? "",

    "org.name": org.legalName ?? org.orgName ?? "",
    "org.vat": org.vat ?? "",
    "org.cr": org.cr ?? "",
    "org.phone": org.supportPhone ?? "",

    "proposal.ref": q.number ?? "",
    "proposal.date": fmtDots(ovDate),
    "proposal.dateLong": fmtLong(ovDate),
    "proposal.validUntil": fmtLong(ovValid),
    "proposal.validUntilShort": fmtDots(ovValid),
    "proposal.subject": q.service ?? "",
    "proposal.notes": q.notes ?? "",

    "total.amount": money(totalMinor),
    "total.subtotal": money(subtotalMinor),
    "total.vat": money(q.vatMinor ?? 0),
    // The tax-inclusive figure, for a template whose prices are quoted with VAT in them.
    "total.gross": money(grossMinor),
    "total.words": amountInWords(totalMinor, currency),
    "total.currency": currency,

    // The two subtotals the schedule above is computed from, so a template can show the split it
    // bills against instead of leaving the reader to add the lines up themselves.
    "fees.professional": money(profMinor),
    "fees.foreign": money(foreignMinor),
    "fees.government": money(govMinor),

    items,
    milestones,
  };
}
