/**
 * ONE RENEWAL PER SUBJECT, UNLESS SOMEBODY SAYS OTHERWISE.
 *
 *   npx tsx scripts/duplicate-run-check.ts
 *
 * The expiry job has always deduplicated — it claims the document with `renewalRunId` and skips
 * anything claimed. Every other way a run can start went straight to `startInstance`, which asked
 * nothing, so the New task dialog put two Baladiya renewals for one client thirty-five minutes
 * apart into the same officer's queue. Nothing links the two, so both get worked, and whichever
 * finishes second overwrites the first one's answers.
 *
 * What makes this worth a check rather than a one-line `findFirst` is everything it must NOT block:
 * one client legitimately has seventy-two Iqama renewals open at once, one per employee, and a
 * client with two CRs renews two Baladiya licences side by side. The comparison is the SUBJECT.
 *
 * Everything it creates, it deletes.
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const TAG = "ZZ duplicate-run-check";

async function sweep() {
  const ids = (await prisma.workflowTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map(t => t.id);
  if (!ids.length) return;
  const rids = (await prisma.workflowInstance.findMany({ where: { templateId: { in: ids } }, select: { id: true } })).map(r => r.id);
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: ids } } });
}

/** Start a run; returns "" when it went through, or the refusal with its duplicate payload. */
async function start(templateId: string, companyId: string | null, variables: any, force = false) {
  try { await startInstance(templateId, { title: TAG, companyId, clientName: TAG, variables, force }); return { blocked: false, message: "", dup: null as any }; }
  catch (e: any) { return { blocked: true, message: String(e?.message ?? e), dup: e?.duplicate ?? null }; }
}

await sweep();
try {
  const tpl = await prisma.workflowTemplate.create({ data: { name: `${TAG} tpl`, graph: {
    nodes: [{ id: "start", type: "start", label: "Start" }, { id: "t", type: "task", label: "Do it" }, { id: "end", type: "end", label: "Done" }],
    edges: [{ from: "start", to: "t" }, { from: "t", to: "end" }],
  } } } as any);
  const [coA, coB, coC] = await prisma.company.findMany({ take: 3, select: { id: true } });
  if (!coA || !coB || !coC) throw new Error("needs three companies in the database to tell client-scoped runs apart");

  console.log("a second renewal of the same thing for the same client is refused:");
  ok(!(await start(tpl.id, coA.id, {})).blocked, "the first one starts");
  const second = await start(tpl.id, coA.id, {});
  ok(second.blocked, "the second one does not");
  ok(/already running/.test(second.message) && /ZZ duplicate-run-check/.test(second.message),
    "…and the refusal names the run that is already open, which is the only way to go and look at it");
  ok(!!second.dup?.id, "…and carries its id, so the console can offer to open it");

  console.log("\n…but it is a question, not a wall:");
  ok(!(await start(tpl.id, coA.id, {}, true)).blocked, "force starts the second one — two licences, two branches, somebody's judgement");

  console.log("\nand none of the things that legitimately run side by side are touched:");
  ok(!(await start(tpl.id, coB.id, {})).blocked, "a different client");
  ok(!(await start(tpl.id, coA.id, { employeeId: "zz-emp-1" })).blocked, "the first employee at a client already renewing something");
  ok(!(await start(tpl.id, coA.id, { employeeId: "zz-emp-2" })).blocked, "a second employee — this is the seventy-two-Iqamas case");
  ok((await start(tpl.id, coA.id, { employeeId: "zz-emp-2" })).blocked, "…while the SAME employee twice is still refused");
  ok(!(await start(tpl.id, coC.id, { establishmentId: "zz-cr-main" })).blocked, "a client's main CR");
  ok(!(await start(tpl.id, coC.id, { establishmentId: "zz-cr-branch" })).blocked, "and its branch CR alongside — two real licences, two renewals");
  ok((await start(tpl.id, coC.id, { establishmentId: "zz-cr-branch" })).blocked, "…while the same CR twice is refused");
  // The case that matters most in practice: the expiry job names the CR, a hand-started run never
  // does. Requiring an exact match would let the manual one sit beside the automatic one for the
  // very same licence — which is the duplicate this guard exists to stop.
  ok((await start(tpl.id, coC.id, {})).blocked, "a run naming NO CR is held by one that names a CR — a missing CR matches any");
  ok(!(await start(tpl.id, null, {})).blocked, "a run naming no client at all — nothing identifies a subject, so nothing is claimed");

  console.log("\nand a finished renewal never blocks the next one:");
  const co = await prisma.company.findFirst({ where: { id: coA.id }, select: { id: true } });
  await prisma.workflowInstance.updateMany({ where: { clientName: TAG, companyId: co!.id, status: "running" }, data: { status: "completed" } });
  ok(!(await start(tpl.id, coA.id, {})).blocked, "last year's renewal is history, not an obstacle");

  console.log("\nand the refusal reaches the person, instead of dying in a log:");
  const api = (await import("node:fs")).readFileSync((await import("node:path")).join(import.meta.dirname, "../src/workflow.ts"), "utf8");
  const uiSrc = (await import("node:fs")).readFileSync((await import("node:path")).join(import.meta.dirname, "../../index.html"), "utf8");
  ok(/if \(e\?\.duplicate\) return res\.status\(409\)\.json\(\{ error: e\.message, duplicate: e\.duplicate \}\);/.test(api),
    "the route answers 409 with the open run attached, not a bare 400");
  ok(/status === 409 && j8 && j8\.duplicate && !force9/.test(uiSrc),
    "the New task dialog recognises it rather than printing it as a failure");
  ok(/okLabel: 'Start another anyway'/.test(uiSrc), "…and offers the way past, since a second one is sometimes right");
  ok(/\.\.\.\(force9 \? \{ force: true \} : \{\}\)/.test(uiSrc), "…which sends force, so the retry is not refused again");
} finally {
  await sweep();
}
await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
