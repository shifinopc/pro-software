/**
 * NITAQAT ADVISOR.
 *
 * The band job already says when a client HAS dropped. This agent looks ahead: it takes each client's
 * workforce as it stands, removes the exits already in progress and adds the hires already in the
 * pipeline, and asks where that leaves the band. When the answer is lower it says so, names the
 * people, and works out the cheapest way to stay where they are:
 *   · how many Saudi hires would hold the band,
 *   · fewer if a hire qualifies under a counting rule on the client's ladder (a Saudi with a
 *     disability counts as four under Nitaqat), and
 *   · whether keeping a departing Saudi on the books would hold it on its own.
 *
 * Everything uses the client's own ladder and counting rules, through the same weighFor() the band
 * figure uses — so the advice cannot disagree with the number on the client's screen. No model.
 *
 * WHAT IT CANNOT SEE: a hire that has not been started as a workflow, or an exit nobody has requested.
 * The projection is only as good as the pipeline, and the finding says what it counted.
 */
import { prisma } from "./db.js";
import { upsertFinding, closeMissing, markRun, decide, requirePerm, AgentActionError, daysFromToday, type AgentActor } from "./agent-core.js";
import { bandSetForCompany, bandsInSet } from "./workforce.js";
import { normalizeRules, weighFor, weightWord, type CountingRule } from "./counting.js";
import { sameCountry } from "./countries.js";
import { ACTIVE_CLIENT } from "./validate.js";

export const KEY = "nitaqat-advisor";
const HORIZON_DAYS = 60;
const HIRE_TEMPLATES = /work visa|transfer \(sponsorship\)|onboarding/i;

type Person = { id?: string; name: string; nationality: string | null; workCountry?: string | null; employmentType?: string | null; jobCategory?: string | null; countingTraits?: unknown };
const bp = (part: number, whole: number) => (whole > 0 ? Math.round((part * 10000) / whole) : 0);

function measure(people: Person[], rules: CountingRule[], country: string | null) {
  let num = 0, den = 0;
  for (const p of people) {
    const isNational = !!p.nationality && sameCountry(p.nationality, country);
    const w = weighFor(rules, p, isNational);
    num += w.num; den += w.den;
  }
  return { num, den, ratioBp: bp(num, den), total: people.length };
}

/** Fewest extra people of one kind that lift the ratio back to `targetBp`. */
function hiresNeeded(num: number, den: number, targetBp: number, perHire: { num: number; den: number }, cap = 200) {
  for (let n = 1; n <= cap; n++) if (bp(num + n * perHire.num, den + n * perHire.den) >= targetBp) return n;
  return null;
}

export async function runNitaqat() {
  const out = { checked: 0, dropsAhead: 0, closed: 0, details: [] as string[] };
  const clients = await prisma.company.findMany({ where: { lifecycle: ACTIVE_CLIENT }, select: { id: true, name: true, country: true, workforceBandSetId: true } });
  const seen = new Set<string>();

  for (const co of clients) {
    const scheme = await bandSetForCompany(co as any);
    if (!scheme) continue;
    const bands = (await bandsInSet(scheme.set.id)).sort((a, b) => a.minBp - b.minBp);
    if (bands.length < 2) continue;
    const rules = normalizeRules(scheme.set.counting);
    const country = co.country ?? null;
    const staffAll = await prisma.employee.findMany({
      where: { companyId: co.id, archived: false, exitStatus: { not: "exited" } },
      select: { id: true, name: true, nationality: true, workCountry: true, employmentType: true, jobCategory: true, countingTraits: true, exitStatus: true, exitDate: true },
    });
    const staff = staffAll.filter(e => sameCountry(e.workCountry ?? country, country));
    if (!staff.length) continue;
    out.checked++;

    const place = (ratio: number) => bands.findIndex(b => ratio >= b.minBp && (b.maxBp == null || ratio < b.maxBp));
    const now = measure(staff, rules, country);
    const nowIdx = place(now.ratioBp);
    if (nowIdx < 0) continue;

    const exits = staff.filter(e => ["exit_requested", "exiting"].includes(String(e.exitStatus)) && (() => { const d = daysFromToday(e.exitDate); return d === null || d <= HORIZON_DAYS; })());
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: co.id, status: "running" }, select: { id: true, title: true, variables: true, template: { select: { name: true } } } });
    const hires: (Person & { runTitle: string })[] = runs
      .filter(r => HIRE_TEMPLATES.test(r.template?.name ?? "") && !/exit/i.test(r.template?.name ?? ""))
      .map(r => {
        const v = (r.variables ?? {}) as any;
        const national = v.hiringType === "saudi_national" || (v.nationality && sameCountry(v.nationality, country));
        return { name: String(v.person ?? v.applicant ?? v.employeeName ?? r.title), nationality: national ? country : (v.nationality ?? "XX"), runTitle: r.title };
      });
    if (!exits.length && !hires.length) continue;

    const exitIds = new Set(exits.map(e => e.id));
    const projected = [...staff.filter(e => !exitIds.has(e.id)), ...hires];
    const next = measure(projected, rules, country);
    const nextIdx = place(next.ratioBp);
    if (nextIdx < 0 || nextIdx >= nowIdx) continue;

    const from = bands[nowIdx], to = bands[nextIdx];
    const isNat = (p: Person) => !!p.nationality && sameCountry(p.nationality, country);
    const nationalExits = exits.filter(isNat);

    // The ways back, cheapest (fewest people) first.
    const options: { text: string; people: number }[] = [];
    const plain = weighFor(rules, { nationality: country }, true);
    const nPlain = hiresNeeded(next.num, next.den, from.minBp, plain);
    if (nPlain) options.push({ text: `Hire ${nPlain} Saudi employee${nPlain === 1 ? "" : "s"} before the exits take effect.`, people: nPlain });
    for (const r of rules) {
      if (r.countsAs <= 100) continue;
      const w = weighFor(rules, { nationality: country, countingTraits: [r.key] }, true);
      if (w.num <= plain.num) continue;
      const n = hiresNeeded(next.num, next.den, from.minBp, w);
      if (n && (!nPlain || n < nPlain)) options.push({ text: `Hire ${n} Saudi employee${n === 1 ? "" : "s"} registered under "${r.label}" (${weightWord(r.countsAs)}) — ${nPlain ? `${nPlain - n} fewer than ordinary hires` : "the only hire count that works"}.`, people: n });
    }
    if (nationalExits.length) {
      const kept = measure([...projected, ...nationalExits], rules, country);
      if (place(kept.ratioBp) >= nowIdx) options.push({ text: `Keep ${nationalExits.map(e => e.name).join(" and ")} on the books — ${nationalExits.length === 1 ? "that exit alone" : "those exits alone"} cause${nationalExits.length === 1 ? "s" : ""} the drop.`, people: 0 });
    }
    options.sort((a, b) => a.people - b.people);

    const soonest = exits.map(e => e.exitDate).filter(Boolean).sort()[0];
    const when = soonest ? (() => { const d = daysFromToday(soonest)!; return d <= 31 ? (d < 0 ? "now" : `within ${d} days`) : "in the next two months"; })() : "once they leave";
    const cause = [exits.length ? `${exits.length} exit${exits.length === 1 ? "" : "s"}` : "", hires.length ? `${hires.length} expat hire${hires.length === 1 ? "" : "s"} in progress` : ""].filter(Boolean).join(" and ");
    const key = `drop:${co.id}:${from.name}->${to.name}`;
    seen.add(key);
    const r = await upsertFinding(KEY, key, {
      kind: "band-drop", companyId: co.id, refType: "company", refId: co.id,
      title: `${co.name}: ${from.name} → ${to.name} ${when}`,
      summary: `${exits.length + hires.length === 1 ? "This" : "These"} ${cause} ${exits.length + hires.length === 1 ? "takes" : "take"} ${co.name} from ${from.name} (${(now.ratioBp / 100).toFixed(1)}%) to ${to.name} (${(next.ratioBp / 100).toFixed(1)}%). ${options[0] ? `Cheapest way to hold ${from.name}: ${options[0].text}` : "No single change holds the band."}`,
      output: {
        now: { band: from.name, ratioPct: now.ratioBp / 100, counted: now.den / 100, nationals: now.num / 100, total: now.total },
        projected: { band: to.name, ratioPct: next.ratioBp / 100, total: next.total },
        threshold: { band: from.name, minPct: from.minBp / 100 },
        exits: exits.map(e => ({ id: e.id, name: e.name, national: isNat(e), status: e.exitStatus, date: e.exitDate })),
        hires: hires.map(h => ({ name: h.name, national: isNat(h), run: h.runTitle })),
        options,
        ladder: scheme.set.name,
        caveat: "Counts only exits already requested and hires already started as workflows. Unknown nationalities are counted as expats.",
      },
    });
    if (r.opened) out.dropsAhead++;
    out.details.push(`${co.name}: ${from.name} → ${to.name}`);
  }
  out.closed = await closeMissing(KEY, "band-drop", seen, "No longer projected to drop");
  await markRun(KEY);
  return out;
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That warning no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This warning is already ${t.status}.`, 409);
  await requirePerm(actor, "Clients", "View", "act on workforce warnings");
  if (action === "done") return decide(t.id, "done", actor, { note: String(input?.note ?? "") || "Handled" });
  if (action === "dismiss") return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || null });
  throw new AgentActionError("Unknown action.");
}
