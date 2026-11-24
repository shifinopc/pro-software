/**
 * THE TWO THINGS A BUSINESS SETUP NEEDED TO ACTUALLY FINISH.
 *
 *   npx tsx scripts/fix-business-setup-cr.ts            say what is wrong, change nothing
 *   npx tsx scripts/fix-business-setup-cr.ts --apply    fix it
 *
 * 1. THE INSTALLED "Business Setup" TEMPLATE'S CR STEP FILES NOTHING. It asks for the CR number,
 *    the issue date and the expiry, and keeps all three as run variables: the node carries no
 *    `docType`, so the engine has no document to put them on, and its captures carry no `purpose`,
 *    so even with one it would not know which column each answer belongs in. A client could be
 *    walked through all 44 steps and still read `cr: null, crPending: true` at the end of it.
 *
 *    The template is NOT from a country pack (`packKey` is null) — it was built by
 *    `build-business-setup.ts`, which now emits both — so the installed row has to be corrected in
 *    place or a rebuild would be the only way to get it, and a rebuild discards the running cases.
 *
 * 2. CLIENTS HOLDING A REAL CR WHILE STILL FLAGGED `crPending`. The flag means "the firm is getting
 *    them one". `syncMainFromCompany` now clears it, so no new ones appear; these are the rows that
 *    were written before it did.
 *
 * Idempotent, and prints every row it touches. Safe to run twice.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const PURPOSE: Record<string, string> = { crNumber: "number", crIssued: "issue", crExpiry: "expiry" };

/** A CR number the registry would recognise, not a placeholder. Mirrors establishments.ts. */
const isRealCr = (v: unknown) => /^\d{8,}$/.test(String(v ?? "").replace(/\D/g, ""));

(async () => {
  let changed = 0;

  // ── 1 · the template's CR step ───────────────────────────────────────────────────────────
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Business Setup" } });
  if (!tpl) {
    console.log("· no 'Business Setup' template installed — nothing to correct");
  } else {
    const graph: any = tpl.graph ?? {};
    const node = (graph.nodes ?? []).find((n: any) => n?.id === "cr");
    if (!node) {
      console.log("! the template has no node 'cr' — it is not the one this script knows about, so it was left alone");
    } else {
      const cfg = node.config ?? (node.config = {});
      // Both keys, for the reason stepDocType() gives: the name alone is ignored unless the source
      // says it was chosen for this step rather than inherited from a run variable.
      const wantsDocType = cfg.docType !== "Commercial Registration" || cfg.docTypeSource !== "specific";
      const caps: any[] = Array.isArray(cfg.captures) ? cfg.captures : [];
      const wantsPurpose = caps.filter(c => PURPOSE[c?.var] && c.purpose !== PURPOSE[c.var]);
      if (!wantsDocType && !wantsPurpose.length) {
        console.log("· the CR step already files its certificate");
      } else {
        console.log(`${APPLY ? "FIXING" : "WOULD FIX"} the CR step:`);
        if (wantsDocType) console.log("    docTypeSource → specific, docType → Commercial Registration");
        for (const c of wantsPurpose) console.log(`    ${c.var} → purpose "${PURPOSE[c.var]}"`);
        if (APPLY) {
          cfg.docTypeSource = "specific";
          cfg.docType = "Commercial Registration";
          for (const c of caps) if (PURPOSE[c?.var]) c.purpose = PURPOSE[c.var];
          await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { graph } });
          changed++;
        }
      }
    }
  }

  // ── 2 · waivers left standing beside a real registration ─────────────────────────────────
  const stale = (await prisma.company.findMany({
    where: { crPending: true }, select: { id: true, name: true, cr: true },
  })).filter(c => isRealCr(c.cr));
  if (!stale.length) console.log("· no client is flagged 'CR pending' while holding a CR");
  else {
    console.log(`${APPLY ? "CLEARING" : "WOULD CLEAR"} the CR-pending flag on ${stale.length} client(s) that already hold one:`);
    for (const c of stale) console.log(`    ${c.name} — CR ${c.cr}`);
    if (APPLY) {
      await prisma.company.updateMany({ where: { id: { in: stale.map(c => c.id) } }, data: { crPending: false } });
      changed += stale.length;
    }
  }

  console.log(APPLY ? `\nDone — ${changed} change(s).` : "\nNothing was changed. Re-run with --apply.");
  await prisma.$disconnect();
})().catch(async (e) => { console.error(String(e?.message ?? e)); await prisma.$disconnect(); process.exit(1); });
