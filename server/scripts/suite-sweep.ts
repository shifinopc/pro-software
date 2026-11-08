/**
 * CLEAR THE THROWAWAY NAMESPACE, SO ONE SCRIPT'S RESIDUE CANNOT FAIL THE NEXT TWENTY.
 *
 * Imported by suite-run.ts and called between scripts. Also runnable on its own:
 *   npx tsx scripts/suite-sweep.ts
 *
 * WHY THIS EXISTS — the measurement that found it.
 *
 * Running all 178 scripts in one sequence produced 30 failures, and 25 of them were the same
 * Prisma error: P2003, foreign key, `Company.companyId`. Not twenty-five problems. One.
 *
 * Nearly every probe begins by sweeping its own namespace — `company.deleteMany({ name: {
 * startsWith: "ZZ " } })` — because they share a convention: throwaway clients are named "ZZ …"
 * and throwaway people get @example.invalid addresses (53 and 51 of the scripts respectively).
 * `probe-pack-uninstall` creates a Document against "ZZ Probe Client" and never deletes it, and it
 * fails partway for its own reasons, so the document outlives it. From that point on every later
 * probe died on its FIRST line: the company cannot be deleted while a document points at it, and
 * the probe never got as far as the thing it was checking.
 *
 * The clean answer is a fresh database per script. At 178 scripts that is hours, so this is the
 * cheap equivalent: delete the namespace itself — children before parents, which `deleteMany` on
 * the parent cannot do — so each script starts from the same floor whatever the one before it left.
 *
 * IT IS NOT A SUBSTITUTE FOR A SCRIPT CLEANING UP AFTER ITSELF. A probe that leaves rows behind is
 * still a probe with a bug, and this hides it. What it buys is that the bug costs one failure
 * instead of twenty-five, which is the difference between a suite somebody reads and a suite
 * somebody ignores.
 *
 * SCOPED BY NAME, NOT BY TIME. It never touches a row it cannot identify as throwaway, so running
 * it against a database with real clients in it does nothing to them — though suite-run.ts and
 * suite-seed.ts both refuse to point anywhere real in the first place.
 */
import { PrismaClient } from "@prisma/client";

/** The names and addresses the probes use for anything disposable. */
const COMPANY_PREFIXES = ["ZZ ", "شركة ZZ", "ZZ-"];
const USER_EMAIL_FRAGMENT = "example.invalid";

/**
 * Every model carrying a `companyId`, children first. Order matters: a Document blocks its
 * Company, and an Establishment blocks the Employees that name it. Taken from the schema rather
 * than guessed — if a model gains a companyId and is not listed, the sweep leaves it and the
 * company delete starts failing again, which is why suite-run.ts reports what it could not clear.
 */
const COMPANY_CHILDREN = [
  "agentTask", "documentSuggestion", "errorReport", "fileAsset", "emailMessage",
  "disbursement", "payment", "quotation", "invoice", "courierShipment", "appointment",
  "interaction", "opportunity", "ownerAssignment", "lifecycleTransition", "workforceSnapshot",
  "workflowInstance", "serviceRequest", "siteCredential", "upgradeRequest",
  "task", "document", "employee", "establishment", "subscription", "contact",
] as const;

export type SweepResult = { companies: number; rows: number; users: number; stuck: string[] };

export async function sweep(prisma: PrismaClient): Promise<SweepResult> {
  const companies = await prisma.company.findMany({
    where: { OR: COMPANY_PREFIXES.map(p => ({ name: { startsWith: p } })) },
    select: { id: true },
  });
  const ids = companies.map(c => c.id);
  let rows = 0;
  const stuck: string[] = [];

  if (ids.length) {
    for (const model of COMPANY_CHILDREN) {
      const delegate = (prisma as any)[model];
      if (!delegate?.deleteMany) continue;           // model renamed or gone — not this file's problem
      try {
        const { count } = await delegate.deleteMany({ where: { companyId: { in: ids } } });
        rows += count;
      } catch (e: any) {
        // Report rather than throw: a sweep that dies halfway leaves MORE residue than one that
        // keeps going and says what it could not shift.
        stuck.push(`${model}: ${String(e?.code ?? e?.message ?? e).slice(0, 60)}`);
      }
    }
    try { await prisma.company.deleteMany({ where: { id: { in: ids } } }); }
    catch (e: any) { stuck.push(`company: ${String(e?.code ?? e?.message ?? e).slice(0, 60)}`); }
  }

  // Throwaway staff and portal logins. Done after the companies so a portal user's company is
  // already gone; `user` carries a companyId and is in neither list by accident — it is swept here.
  let users = 0;
  try {
    const { count } = await prisma.user.deleteMany({ where: { email: { contains: USER_EMAIL_FRAGMENT } } });
    users = count;
  } catch (e: any) { stuck.push(`user: ${String(e?.code ?? e?.message ?? e).slice(0, 60)}`); }

  return { companies: ids.length, rows, users, stuck };
}

// Runnable on its own, which is also how to clear a local scratch database by hand.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("suite-sweep.ts")) {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) { console.error("refusing: DATABASE_URL is not on localhost"); process.exit(1); }
  const prisma = new PrismaClient();
  sweep(prisma)
    .then(r => { console.log(`swept ${r.companies} company(ies), ${r.rows} child row(s), ${r.users} user(s)` + (r.stuck.length ? `\ncould not clear: ${r.stuck.join("; ")}` : "")); return prisma.$disconnect(); })
    .catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
}
