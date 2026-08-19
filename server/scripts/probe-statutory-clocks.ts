/**
 * Throwaway check on the deadlines the law sets, as opposed to the ones this office sets itself.
 *
 * Three clocks run through a single onboarding and none of them was modelled: 90 days from entry to
 * issue the Iqama, GOSI registration by the 15th of the month after work starts, and the first wage
 * on WPS within 30 days. A sweep across all the workflow's nodes found no deadline field anywhere.
 *
 * MOST OF THIS PROBE IS ABOUT NOT INVENTING ONE. A deadline the platform made up would be enforced
 * with exactly the same confidence as a real one and be wrong — it would raise alerts, escalate
 * priorities and eventually be believed. So the cases that matter here are the ones where the answer
 * has to be silence: no starting date, no number in Country Rules, a date nobody has captured yet.
 *
 * Creates its own template, instance and task for the breach test. Deletes them.
 */
import { prisma } from "../src/db.js";
import { clocksFor, earliest } from "../src/statutory.js";
import { watchStatutory } from "../src/jobs.js";

const TAG = "ZS statutory probe";

async function sweep() {
  const insts = await prisma.workflowInstance.findMany({ where: { title: TAG }, select: { id: true } });
  const ids = insts.map(i => i.id);
  if (ids.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: TAG } });
  await prisma.notification.deleteMany({ where: { title: { contains: "ZS Probe Iqama" } } }).catch(() => {});
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  const shows = (label: string, got: any, want: any) => {
    const ok = String(got) === String(want);
    console.log(`  ${label.padEnd(52)} ${String(got ?? "none").padEnd(12)} ${ok ? "" : `— expected ${want}`}`);
    if (!ok) fail(`${label}: got ${got}, expected ${want}`);
  };
  await sweep();

  // ── the arithmetic ────────────────────────────────────────────────────────────────────────────
  console.log("counting the days:");
  const one = (spec: any, vars: any) => clocksFor([spec], vars)[0]?.due ?? null;
  shows("90 days from an entry on 2026-01-01",
    one({ key: "k", days: 90, from: "entryDate" }, { entryDate: "2026-01-01" }), "2026-04-01");

  // A month is not 30 days and is not the same length twice. Adding days to 31 January lands in
  // March in a leap year and in February otherwise — the deadline would move with the calendar.
  console.log("");
  console.log("the 15th of the month after work starts:");
  shows("work starting 2026-01-31",
    one({ key: "k", rule: "by_15th_next_month", from: "start" }, { start: "2026-01-31" }), "2026-02-15");
  shows("work starting 2026-02-01",
    one({ key: "k", rule: "by_15th_next_month", from: "start" }, { start: "2026-02-01" }), "2026-03-15");
  shows("work starting 2026-12-20 (over the year end)",
    one({ key: "k", rule: "by_15th_next_month", from: "start" }, { start: "2026-12-20" }), "2027-01-15");
  shows("work starting 2027-01-31 (no leap year to trip on)",
    one({ key: "k", rule: "by_15th_next_month", from: "start" }, { start: "2027-01-31" }), "2027-02-15");

  // ── the silences ──────────────────────────────────────────────────────────────────────────────
  console.log("");
  console.log("what it refuses to guess:");
  const none = (label: string, got: any) => {
    console.log(`  ${label.padEnd(52)} ${got === null || got === undefined ? "no deadline" : "INVENTED " + got}`);
    if (got !== null && got !== undefined) fail(`${label}: a deadline was invented where there is nothing to count from`);
  };
  none("the date it counts from has not been captured yet",
    one({ key: "k", days: 90, from: "entryDate" }, {}));
  none("the date captured is not a date",
    one({ key: "k", days: 90, from: "entryDate" }, { entryDate: "soon" }));
  none("Country Rules gives no number of days",
    one({ key: "k", from: "entryDate" }, { entryDate: "2026-01-01" }));

  // ── the fallback ──────────────────────────────────────────────────────────────────────────────
  console.log("");
  const wps = { key: "wps", days: 30, from: "firstWageDue,expectedJoining" };
  shows("counted from the wage date when payroll has set one",
    one(wps, { firstWageDue: "2026-03-01", expectedJoining: "2026-01-01" }), "2026-03-31");
  shows("...and from the joining date when they have not",
    one(wps, { expectedJoining: "2026-01-01" }), "2026-01-31");

  // ── the binding one ───────────────────────────────────────────────────────────────────────────
  const two = clocksFor([
    { key: "late", days: 90, from: "d" },
    { key: "early", days: 30, from: "d" },
  ], { d: "2026-01-01" });
  console.log("");
  console.log(`two clocks on one step, earliest first:      ${two.map(c => `${c.key} ${c.due}`).join("  ·  ")}`);
  shows("the binding deadline is the earliest", earliest(two), "2026-01-31");
  if (two[0]?.key !== "early") fail("the clocks are not ordered by date, so the first one read is not the binding one");

  // ── the number comes from Country Rules ───────────────────────────────────────────────────────
  const iqamaType = await prisma.documentType.findFirst({ where: { name: "Iqama", country: "SA" } });
  const types = new Map<string, any>([["Iqama", iqamaType]]);
  const fromRules = clocksFor([{ key: "iqama_90", docType: "Iqama", from: "entryDate" }], { entryDate: "2026-01-01" }, types);
  console.log("");
  console.log("the workflow states no number of its own:");
  console.log(`  Country Rules says Iqama = ${iqamaType?.statutoryDays ?? "—"} days from ${iqamaType?.statutoryFrom ?? "—"}`);
  shows("so an entry on 2026-01-01 is due", fromRules[0]?.due, "2026-04-01");
  console.log(`  and it carries its source: ${fromRules[0]?.basis ? `"${String(fromRules[0].basis).slice(0, 72)}"` : "NONE"}`);
  if (!iqamaType?.statutoryDays) fail("Country Rules holds no statutory period for the Iqama, so the workflow has nothing to count with");
  if (!fromRules[0]?.basis) fail("the deadline names no source — a deadline nobody can check is a number the platform made up");

  // ── the graph declares them, on steps that can know the date ──────────────────────────────────
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  const g: any = tpl?.graph ?? {};
  const nodes: any[] = g.nodes ?? [], edges: any[] = g.edges ?? [];
  const byId = new Map<string, any>(nodes.map(n => [n.id, n]));
  const declared = nodes.filter(n => n?.config?.statutory);
  console.log("\nsteps carrying a statutory deadline:");
  for (const n of declared) {
    const list = Array.isArray(n.config.statutory) ? n.config.statutory : [n.config.statutory];
    console.log(`  ${n.id.padEnd(12)} ${list.map((c: any) => `${c.key} (from ${c.from})`).join("  ·  ")}`);
  }
  if (declared.length < 2) fail("fewer than two steps declare a deadline — the three clocks are not modelled");

  // THE ORDERING TRAP. A clock counted from a date captured DOWNSTREAM of the step that owes the
  // deadline can never be computed while it still matters. The date has to be known first.
  const capturedAt = new Map<string, string>();
  for (const n of nodes) for (const c of (n?.config?.captures ?? [])) capturedAt.set(String(c.var), n.id);
  const reaches = (from: string, to: string) => {
    const q = [from], seen = new Set<string>();
    while (q.length) {
      const id = q.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (id === to) return true;
      for (const e of edges.filter(x => x.from === id)) q.push(e.to);
    }
    return false;
  };
  console.log("");
  for (const n of declared) {
    const list = Array.isArray(n.config.statutory) ? n.config.statutory : [n.config.statutory];
    for (const c of list) {
      for (const v of String(c.from ?? "").split(",").map(x => x.trim()).filter(Boolean)) {
        const src = capturedAt.get(v);
        if (!src) { console.log(`  ${c.key}: "${v}" is captured nowhere`); fail(`"${c.key}" counts from ${v}, which no step ever captures`); continue; }
        const before = reaches(src, n.id) || src === n.id;
        console.log(`  ${String(c.key).padEnd(10)} counts from ${v.padEnd(16)} captured at ${src.padEnd(14)} ${before ? "before the deadline it feeds" : "AFTER — too late to matter"}`);
        if (!before) fail(`"${c.key}" counts from ${v}, captured at "${src}", which the run only reaches after "${n.id}" — the deadline could never be computed while it still mattered`);
      }
    }
  }

  // ── a deadline that has passed is raised, once ────────────────────────────────────────────────
  const t2 = await prisma.workflowTemplate.create({ data: { name: TAG, trigger: "manual", entityType: "employee", active: false, graph: { nodes: [], edges: [] } as any, createdAt: new Date().toISOString() } });
  const inst = await prisma.workflowInstance.create({ data: { templateId: t2.id, title: TAG, status: "running", variables: {} as any, startedAt: new Date().toISOString() } });
  const task = await prisma.workflowTask.create({ data: {
    instanceId: inst.id, nodeId: "iqama_task", nodeType: "task", title: "ZS Probe Iqama Issuance",
    status: "active", priority: "medium", createdAt: new Date().toISOString(),
    statutory: [{ key: "iqama_90", label: "ZS Probe Iqama — 90 days from entry", due: "2026-01-01", basis: "probe" }] as any,
    statutoryDue: "2026-01-01",
  } });

  const first = await watchStatutory();
  const afterOne = await prisma.workflowTask.findUnique({ where: { id: task.id }, select: { statutoryState: true, priority: true } });
  console.log("");
  console.log(`a deadline that has passed is raised:       ${first.raised.some(r => r.includes("ZS Probe")) ? "YES" : "NO"}`);
  console.log(`  the step is marked and made urgent:       ${afterOne?.statutoryState === "breached" ? `YES (${afterOne?.priority})` : "NO"}`);
  if (afterOne?.statutoryState !== "breached") fail("a statutory deadline passed with the step still open and nothing was recorded on it");
  if (afterOne?.priority !== "urgent") fail("a breached statutory deadline did not raise the step's priority");

  const second = await watchStatutory();
  console.log(`...and not raised again on the next tick:   ${second.raised.some(r => r.includes("ZS Probe")) ? "NO" : "YES"}`);
  if (second.raised.some(r => r.includes("ZS Probe"))) fail("the same breach is raised every hour — the alert becomes noise and stops being read");

  const logged = await prisma.workflowLog.count({ where: { instanceId: inst.id, action: "statutory.breached" } });
  console.log(`  the run's own log says so:               ${logged === 1 ? "YES" : `NO (${logged} entries)`}`);
  if (logged !== 1) fail(`the breach is written to the run log ${logged} times instead of once`);

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
