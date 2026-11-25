/**
 * THE RUN OF STEPS ONE OFFICER FILLS IN ONE GO.
 *
 *   npx tsx scripts/step-chain-check.ts
 *
 * Two halves, because the feature has two ways to be wrong:
 *
 *  1. WHERE THE CHAIN STOPS. `stepChain` is pure, so every rule it enforces is asserted against a
 *     hand-built graph: a fork, an approval, a change of owner, a checklist, a rework target and
 *     the length cap each end it. Getting this wrong does not throw — it silently offers an officer
 *     a form for work that is somebody else's to do, or for a branch nobody has chosen yet.
 *
 *  2. THAT THE ENGINE REALLY HANDS THE NEXT TASK OVER. The whole feature rests on one unproven
 *     assumption: completing a step creates the next step's task, there and then, so the next
 *     answers have somewhere to go. That is asserted against the real engine on a real run, not
 *     mocked — if it ever stops being true the chain endpoint would complete step one and strand
 *     the rest, with the officer believing all four were filed.
 *
 * LOCAL DATABASES ONLY: it creates a client, a template and a run, and deletes all three.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask, stepChain } from "../src/workflow.js";

const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  process.exit(1);
}

const TAG = "ZZ Chain Check";
let failures = 0;
const ok = (cond: any, what: string) => {
  if (cond) console.log("  ok   " + what);
  else { console.log("  FAIL " + what); failures++; }
};

const task = (id: string, extra: any = {}) => ({ id, type: "task", label: id, config: { assigneeRole: "pro_officer", ...extra } });
const g = (nodes: any[], edges: any[]) => ({ nodes, edges } as any);
const ids = (ns: any[]) => ns.map(n => n.id).join(",");

const cleanup = async () => {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const cids = cos.map(c => c.id);
  if (cids.length) {
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: { in: cids } }, select: { id: true } });
    const rids = runs.map(r => r.id);
    if (rids.length) {
      await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } });
      await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
      await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
    }
    await prisma.document.deleteMany({ where: { companyId: { in: cids } } });
    await prisma.company.deleteMany({ where: { id: { in: cids } } });
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
};

(async () => {
  console.log("where the chain stops");
  const straight = g([task("a"), task("b"), task("c")], [{ from: "a", to: "b" }, { from: "b", to: "c" }]);
  ok(ids(stepChain(straight, "a")) === "b,c", "a straight run of same-owner tasks is offered whole");

  ok(stepChain(g([task("a"), task("b"), task("c")],
    [{ from: "a", to: "b" }, { from: "a", to: "c" }]), "a").length === 0,
    "a fork ends it — nobody has chosen the branch yet");

  ok(stepChain(g([task("a"), { id: "b", type: "approval", label: "b", config: { assigneeRole: "pro_officer" } }],
    [{ from: "a", to: "b" }]), "a").length === 0,
    "an approval ends it — a gate is a second person by design");

  ok(stepChain(g([task("a"), task("b", { assigneeRole: "accountant" })],
    [{ from: "a", to: "b" }]), "a").length === 0,
    "a change of role ends it");

  // DOCUMENTS NO LONGER END IT. They did, because a tick is written against a task and the later
  // steps' tasks do not exist yet — the form holds them now and `complete-chain` writes them on as
  // each task is created. Nearly every Business Setup step between two gates collects something, so
  // with the old rule that workflow could never offer more than one step at a time.
  ok(ids(stepChain(g([task("a"), task("b", { checklist: [{ key: "x", label: "X" }] })],
    [{ from: "a", to: "b" }]), "a")) === "b",
    "a step with documents to receive is offered — the form collects them for it");

  // Nothing is offered at all here, not "b and stop": b IS the rework target, so the very first
  // step after `a` is one that will be visited again. Answering it now answers the wrong visit.
  ok(stepChain(g([task("a"), task("b"), task("c")],
    [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "b" }]), "a").length === 0,
    "a rework target ends it — that node gets visited twice and this is the wrong visit");

  ok(stepChain(g([task("a"), { id: "b", type: "end", label: "b" }], [{ from: "a", to: "b" }]), "a").length === 0,
    "an automatic node ends it — there is nobody to ask");

  const long = Array.from({ length: 12 }, (_, i) => task("n" + i));
  ok(stepChain(g(long, long.slice(1).map((n, i) => ({ from: "n" + i, to: n.id }))), "n0").length === 6,
    "and it is capped — past six this is a batch tool, not a form");

  console.log("\nand the engine hands the next task over");
  await cleanup();
  const co = await prisma.company.create({ data: { name: `${TAG} Client`, lifecycle: "client", status: "active", country: "SA" } });
  const tpl = await prisma.workflowTemplate.create({
    data: {
      name: `${TAG} Template`, country: "SA", trigger: "manual", entityType: "company",
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Start" },
          task("one", { captures: [{ var: "oneVal", label: "One", type: "text", required: true }] }),
          task("two", { captures: [{ var: "twoVal", label: "Two", type: "text", required: true }] }),
          task("three", { captures: [{ var: "threeVal", label: "Three", type: "text", required: true }] }),
          { id: "gate", type: "approval", label: "Gate", config: { approverRole: "admin", assigneeRole: "admin" } },
          { id: "end", type: "end", label: "Done" },
        ],
        edges: [{ from: "start", to: "one" }, { from: "one", to: "two" }, { from: "two", to: "three" },
                { from: "three", to: "gate" }, { from: "gate", to: "end" }],
      },
    },
  });

  const chain = stepChain({ nodes: (tpl.graph as any).nodes, edges: (tpl.graph as any).edges }, "one");
  ok(ids(chain) === "two,three", "the fixture offers two more steps and stops at the gate");

  const inst = await startInstance(tpl.id, { companyId: co.id, clientName: co.name });
  const active = async (nodeId: string) =>
    prisma.workflowTask.findFirst({ where: { instanceId: inst.id, nodeId, status: "active" } });

  const t1 = await active("one");
  ok(!!t1, "starting the run opens step one");
  await completeTask(t1!.id, { actor: "chain-check", variables: { oneVal: "a" } });
  const t2 = await active("two");
  ok(!!t2, "completing step one opens step two IMMEDIATELY — the chain rests on this");
  await completeTask(t2!.id, { actor: "chain-check", variables: { twoVal: "b" } });
  const t3 = await active("three");
  ok(!!t3, "and step two opens step three");
  await completeTask(t3!.id, { actor: "chain-check", variables: { threeVal: "c" } });

  const gate = await active("gate");
  ok(!!gate, "the gate is open at the end, and is NOT part of the run");
  const vars = ((await prisma.workflowInstance.findUnique({ where: { id: inst.id } }))?.variables ?? {}) as any;
  ok(vars.oneVal === "a" && vars.twoVal === "b" && vars.threeVal === "c",
    "every step's answers landed on the run, each against its own step");

  await cleanup();
  console.log(failures ? `\n${failures} FAILED` : "\nok: the chain stops where it should, and the engine hands each next task over");
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(String(e?.message ?? e)); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
