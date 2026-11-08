/**
 * THE STATE THE CHECK SUITE NEEDS, BUILT FROM NOTHING.
 *
 *   npx prisma db push --skip-generate        (CI does this; the schema comes first)
 *   npx tsx scripts/suite-seed.ts
 *
 * There are 178 scripts in this folder. Twenty-one ran in CI; the rest only ran when somebody
 * remembered, which is the same as not having them. Measured against a database with only the
 * schema pushed, 106 of them pass — so what was missing was never the scripts, it was somewhere to
 * run them.
 *
 * This builds that somewhere. Three things, in this order, because each needs the one before it:
 *
 *   1. seed-prod.ts    — the blank working system: one admin, packages, document types, government
 *                        centers, the production workflow templates.
 *   2. the country pack — services, pipeline stages, lead sources and loss reasons, which seed-prod
 *                        does not carry. Installed with --adopt, so the rows seed-prod already made
 *                        are linked to the pack rather than duplicated. Without this, everything
 *                        that touches a pipeline, a lead or a service fails on an empty table and
 *                        reads like a broken feature.
 *   3. one staff user per role — several probes assert that work reaches the right person, and the
 *                        answer to "who is the accountant" cannot be nobody. `probe-all-services`
 *                        failed with "Nobody holds the role accountant" for exactly this reason.
 *
 * IT REFUSES TO RUN ANYWHERE REAL. Guarded on both the host and the database name: this wipes and
 * rewrites configuration, and pointing it at a working system would take the firm's document types
 * out from under it. The name must look like a scratch database.
 *
 * NOT IDEMPOTENT BY DESIGN — seed-prod wipes and re-creates the rows it owns, and that is the point:
 * every run starts from the same state. The suite does NOT fully clean up after itself (several
 * scripts leave rows behind, which is why a shared database degrades as they run), so the answer is
 * a fresh database per run rather than tidier scripts.
 */
import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isScratchDb, dbNameOf, refusal } from "./_scratch-db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL ?? "";

// ── the guard ── one rule, in _scratch-db.ts, shared with suite-run and _suite-auth ──────────
if (!isScratchDb(url)) {
  console.error(refusal(url, "This wipes and rewrites document types, workflow templates and government centers."));
  process.exit(1);
}
const dbName = dbNameOf(url);

const prisma = new PrismaClient();
// One command string rather than argv + shell:true — Node 22 deprecates that combination
// (DEP0190) because the arguments are concatenated unescaped rather than passed through. Nothing
// here is user input, but a deprecation warning in the middle of CI output trains people to ignore
// CI output.
const run = (label: string, args: string[]) => {
  const r = spawnSync(["npx", ...args].join(" "), { cwd: path.join(here, ".."), encoding: "utf8", shell: true, env: process.env });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status !== 0) { console.error(`\n${label} FAILED:\n${out.slice(-1500)}`); process.exit(1); }
  console.log(`  ${label}: ${out.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 110) ?? "done"}`);
};

async function main() {
  console.log(`seeding ${dbName}`);

  // 1. the blank working system
  run("seed-prod", ["tsx", "prisma/seed-prod.ts"]);

  // 2. the country pack. --adopt links what seed-prod already created instead of making a second
  //    copy of every document type under a slightly different name.
  run("country pack", ["tsx", "scripts/install-country-pack.ts", "pack-sa-2026.11.json", "--apply", "--adopt"]);

  // 2b. THE RENEWAL WORKFLOWS, which the pack does not carry and several checks require BY NAME.
  //
  // Not a guess: the checks say so themselves. A run without these produced "No workflow template
  // named \"Iqama Renewal\"", "no template \"Commercial Registration Renewal\"", and three
  // separate "run add-employee-renewals.ts first" messages. These scripts build those templates
  // from the specifications in docs/planned-services.js, so they are reference configuration in
  // exactly the sense this seed exists to provide — they are setup, not tests, which is why they
  // sit in MIGRATIONS and are invoked here rather than run as part of the suite.
  //
  // After the pack, because they attach to document types it installs.
  run("employee renewals", ["tsx", "scripts/add-employee-renewals.ts"]);
  run("CR renewal", ["tsx", "scripts/add-cr-renewal.ts"]);
  run("MISA renewal", ["tsx", "scripts/add-misa-renewal.ts"]);

  // 3. somebody in every role. Passwords are a fixed throwaway string: these accounts exist only
  //    inside a database whose name this script insisted on, and the API probes need to sign in as
  //    them. Nothing here is reachable from outside the runner.
  const PASSWORD = "suite-seed-not-a-real-login";
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ROLES = ["admin", "pro_officer", "accountant", "sales"] as const;
  let made = 0;
  for (const roleId of ROLES) {
    const email = `suite-${roleId}@local.test`;
    const name = `Suite ${roleId.replace(/_/g, " ")}`;
    await prisma.user.deleteMany({ where: { email } });
    await prisma.user.create({ data: { name, email, passwordHash: hash, roleId, status: "active", type: "staff" } });
    made++;
  }
  console.log(`  staff: ${made} users, one per role (${ROLES.join(", ")})`);

  const counts = {
    documentTypes: await prisma.documentType.count(),
    workflowTemplates: await prisma.workflowTemplate.count(),
    govCenters: await prisma.govCenter.count(),
    pipelineStages: await prisma.pipelineStage.count(),
    leadSources: await prisma.leadSource.count(),
    lostReasons: await prisma.lostReason.count(),
    packages: await prisma.package.count(),
    users: await prisma.user.count(),
    companies: await prisma.company.count(),
  };
  console.log("\nseeded state:", JSON.stringify(counts));
  // A country pack that installed nothing leaves a database that looks fine and fails every
  // pipeline, lead and service check with an empty-table message. Say so here instead.
  if (!counts.pipelineStages || !counts.leadSources) {
    console.error("\nthe country pack left no pipeline stages or lead sources — the CRM checks will all fail on an empty table");
    process.exit(1);
  }
  console.log("\nSUITE_SEED_PASSWORD=" + PASSWORD);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
