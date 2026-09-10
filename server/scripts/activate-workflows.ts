/**
 * Turn workflows on — after saying out loud what that will cost.
 *
 * Activating is the moment a workflow stops being configuration and starts putting work on a real
 * team's board. On 10 September a tick opened 46 runs across two workflows the moment they were
 * armed, and nobody had a number in front of them beforehand. So this counts first, always, and
 * writes only when asked.
 *
 * WHAT ACTIVATION MEANS DIFFERS BY TRIGGER, and the difference is the whole risk:
 *
 *   manual            opens nothing by itself. It becomes available to start by hand, or from a
 *                     client request bound to the service. Activating these is close to free.
 *   document_expiry   the nightly tick opens a run for EVERY document of that type already inside
 *                     its lead window, including ones already expired — which open overdue. This is
 *                     where a burst comes from.
 *   recurring         opens nothing until a service is bound to it, because entitlement is what
 *                     selects the clients. Arming one now means that binding a service LATER arms it
 *                     retroactively, with no second confirmation. That is the trap worth naming.
 *
 * Dry-run by default. Pass --apply to write, and optionally a name filter:
 *
 *   npx tsx scripts/activate-workflows.ts                       # count everything, write nothing
 *   npx tsx scripts/activate-workflows.ts --apply               # activate every draft
 *   npx tsx scripts/activate-workflows.ts --apply "Final Exit"  # just the ones matching
 *   npx tsx scripts/activate-workflows.ts --off "VAT"           # turn some back off
 *
 * Idempotent.
 */
import { prisma } from "../src/db.js";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const OFF = argv.includes("--off");
const filter = argv.filter(a => !a.startsWith("--")).join(" ").trim().toLowerCase();

async function main() {
  const now = new Date();
  const all = await prisma.workflowTemplate.findMany({ where: { retired: false }, orderBy: { name: "asc" } });
  const targets = all.filter(t => (OFF ? t.active : !t.active) && (!filter || t.name.toLowerCase().includes(filter)));

  if (!targets.length) {
    console.log(filter ? `Nothing matching "${filter}" to ${OFF ? "deactivate" : "activate"}.` : `Nothing to ${OFF ? "deactivate" : "activate"}.`);
    await prisma.$disconnect();
    return;
  }

  let total = 0;
  const laterRisk: string[] = [];
  console.log(`${targets.length} workflow(s) to ${OFF ? "turn OFF" : "turn ON"}${filter ? ` (matching "${filter}")` : ""}:\n`);

  for (const t of targets as any[]) {
    let note = "";
    let n = 0;

    if (t.trigger === "manual") {
      note = "manual — opens nothing by itself";
    } else if (t.trigger === "recurring") {
      const svc = await prisma.serviceItem.findFirst({ where: { workflowId: t.id, retired: false } });
      if (!svc) {
        note = "recurring — no service bound, inert until one is";
        laterRisk.push(t.name);
      } else {
        note = `recurring — via "${svc.name}"; every entitled client opens a period`;
      }
    } else if (t.trigger === "document_expiry") {
      const cfg = (t.triggerConfig ?? {}) as any;
      const dtName = String(cfg.docType ?? "");
      const dt = await prisma.documentType.findFirst({ where: { name: dtName } });
      const lead = Number(cfg.days) > 0 ? Number(cfg.days) : (dt?.leadDays ?? 30);
      const docs = await prisma.document.findMany({
        where: { docType: dtName, renewalRunId: null, supersededAt: null, NOT: { expiryDate: null } },
        select: { expiryDate: true },
      });
      let overdue = 0;
      for (const d of docs) {
        const days = Math.floor((+new Date(d.expiryDate!) - +now) / 86400000);
        if (days <= lead) { n++; if (days < 0) overdue++; }
      }
      total += n;
      note = `expiry on "${dtName}" at ${lead}d — ${docs.length} on file, ${n} would open${overdue ? `, ${overdue} of them already overdue` : ""}`;
    } else {
      note = `${t.trigger} — opens nothing on a tick`;
    }

    console.log(`  ${String(n).padStart(3)}  ${t.name.padEnd(42)} ${note}`);
    if (APPLY) await prisma.workflowTemplate.update({ where: { id: t.id }, data: { active: !OFF } });
  }

  if (!OFF) {
    console.log(`\n  => about ${total} run(s) would open on the next tick`);
    if (laterRisk.length) {
      console.log(`\n  NOTE: ${laterRisk.length} recurring workflow(s) are being armed with no service bound —`);
      console.log(`  ${laterRisk.join(", ")}.`);
      console.log(`  They stay inert now, but binding a service to one LATER arms it with no further confirmation.`);
    }
  }
  console.log(APPLY ? `\n${OFF ? "DEACTIVATED" : "ACTIVATED"} ${targets.length}.` : "\nDRY RUN — nothing written. Re-run with --apply.");
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
