/**
 * Export this installation's configuration as a country pack.
 *
 * Read-only. It opens the database, writes a JSON file, and touches nothing — which is why it is the
 * first half of the pack work to exist: an export that goes wrong costs you a file, an import that
 * goes wrong costs you a configuration.
 *
 * WHAT TRAVELS
 *   Document types (with their fields and prerequisites), workflow templates, service items,
 *   government centers, packages, checklist rules.
 *
 * WHAT NEVER TRAVELS
 *   Companies, employees, documents, invoices, credentials, users. A pack describes how work is done
 *   in a country; it must never carry somebody's client list.
 *
 * IDENTITY
 *   Every row gets a `key` derived from its name — `sa.doctype.iqama` — never its cuid. A cuid means
 *   nothing on another installation, and re-importing on cuids would duplicate everything rather than
 *   recognise what is already there. Stable keys are what make an install idempotent and an upgrade
 *   able to find the row it is upgrading.
 *
 * REFERENCES
 *   Most already travel by name (a service names its document type; a step names its authority), so
 *   they survive untouched. Two are cuids and are rewritten to keys: ServiceItem.workflowId and
 *   Package.serviceIds. An unresolvable reference is reported, never silently dropped.
 *
 * Usage:
 *   npx tsx scripts/export-country-pack.ts --country SA --version 2026.1 [--out pack.json]
 *                                          [--exclude "test,QA PROBE,new"]
 */
import { prisma } from "../src/db.js";
import { countryName } from "../src/countries.js";
import { PACKS_DIR } from "../src/packs.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const arg = (name: string, dflt = "") => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

/** `Commercial Register Renewal` → `commercial-register-renewal`. Deterministic, so re-exporting the
 *  same configuration produces the same keys and an import can recognise what it already has. */
const slug = (s: string) =>
  String(s ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unnamed";

/**
 * Rows that look like somebody's scratch work rather than a country's configuration.
 *
 * Not deleted and not silently skipped — REPORTED, so the decision to ship "QA PROBE (INERT — do not
 * use)" inside a Saudi country pack is a deliberate one. Shipping it by accident is how a pack starts
 * looking untrustworthy.
 */
const SUSPECT = (name: string) => {
  const n = String(name ?? "").trim();
  // A whole name that is just "test" or "new" is scratch work. A word inside a real name is not:
  // matching "new" anywhere flagged "New Company Formation" and "New Employment Visa", and "test"
  // flagged "Medical Test" — all legitimate. A warning that fires on real rows teaches people to
  // ignore it, which costs more than not having one.
  if (/^(test|new|tmp|temp|demo|sample|dummy|untitled|copy)\b/i.test(n) && n.length < 14) return true;
  return /\b(probe|inert|do not use|placeholder)\b/i.test(n);
};

async function main() {
  const country = (arg("country", "SA") || "SA").toUpperCase();
  const version = arg("version", new Date().toISOString().slice(0, 7).replace("-", "."));
  // Default into the folder the installer reads. A bare filename lands in whatever directory the
  // command happened to run from — which is server/ — so an exported pack never appeared in the
  // install list and had to be moved by hand for anyone to notice it existed.
  const out = arg("out", join(PACKS_DIR, `pack-${country.toLowerCase()}-${version}.json`));
  const exclude = arg("exclude").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const excluded = (name: string) => exclude.some(e => String(name ?? "").toLowerCase().includes(e));

  const where = { country };
  const [docTypes, templates, services, centers, packages, checklists, bands] = await Promise.all([
    prisma.documentType.findMany({ where }),
    prisma.workflowTemplate.findMany({ where }),
    prisma.serviceItem.findMany({ where }),
    prisma.govCenter.findMany({ where }),
    prisma.package.findMany({ where }),
    prisma.checklistRule.findMany({ where }),
    prisma.workforceBand.findMany({ where }),
  ]);

  const p = country.toLowerCase();
  // cuid → key, so the id-based references can be rewritten.
  const tplKey = new Map(templates.map(t => [t.id, `${p}.workflow.${slug(t.name)}`]));
  const svcKey = new Map(services.map(s => [s.id, `${p}.service.${slug(s.name)}`]));
  const chkKey = new Map(checklists.map(c => [c.id, `${p}.checklist.${slug(c.name)}`]));

  const dropped: string[] = [];
  const unresolved: string[] = [];

  /**
   * Swap database ids inside a workflow graph for pack keys.
   *
   * Only touches what it recognises; every other node property is copied through untouched, because a
   * builder that gains a new config field must not have it silently dropped by the exporter.
   */
  const rewriteGraph = (graph: any, tplName: string) => {
    const g = (graph && typeof graph === "object") ? graph : {};
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    return {
      ...g,
      nodes: nodes.map((n: any) => {
        const c = n?.config;
        if (!c || typeof c !== "object" || !c.checklistRuleId) return n;
        const { checklistRuleId, ...rest } = c;
        const key = chkKey.get(String(checklistRuleId));
        if (!key) {
          unresolved.push(`workflow "${tplName}" step "${n.label ?? n.id}" → checklist rule ${checklistRuleId} (not in this country)`);
          return { ...n, config: rest };   // dropped deliberately, and reported — never left as a dead id
        }
        return { ...n, config: { ...rest, checklistRuleKey: key } };
      }),
    };
  };
  const keep = <T extends { name: string }>(rows: T[], kind: string) =>
    rows.filter(r => { if (excluded(r.name)) { dropped.push(`${kind}: ${r.name}`); return false; } return true; });

  const pack = {
    pack: p,
    country,
    countryName: countryName(country),
    version,
    generatedAt: new Date().toISOString(),
    // Stated in the file itself so nobody has to take it on trust.
    contains: "configuration only — no companies, employees, documents, invoices or credentials",

    documentTypes: keep(docTypes, "document type").map(d => ({
      key: `${p}.doctype.${slug(d.name)}`,
      // subjectKind decides whether a type belongs to an employee or to the company. It was written
      // here as "entity", which is not a column, so it exported as undefined and JSON.stringify
      // dropped it — every pack shipped without it and every installed type defaulted to employee.
      name: d.name, subjectKind: d.subjectKind, defaultFee: d.defaultFee,
      leadDays: d.leadDays, authority: d.authority,
      fields: d.fields ?? [], prereqs: d.prereqs ?? [],
      requiresApproval: d.requiresApproval, defaultAssigneeRole: d.defaultAssigneeRole,
    })),

    workflowTemplates: keep(templates, "workflow").map(t => ({
      key: tplKey.get(t.id),
      name: t.name, trigger: t.trigger, triggerConfig: t.triggerConfig ?? null,
      entityType: t.entityType, active: t.active,
      // The graph mostly names things as strings — document types, authorities — so those survive.
      // One node config does NOT: a checklist step points at its rule by cuid, which would arrive on
      // another installation pointing at nothing. Found by the leak check rather than by reading the
      // schema, which is the argument for having the leak check.
      graph: rewriteGraph(t.graph, t.name),
    })),

    serviceItems: keep(services, "service").map(s => {
      // The one place a service points at a workflow by id.
      let workflowKey: string | null = null;
      if (s.workflowId) {
        workflowKey = tplKey.get(s.workflowId) ?? null;
        if (!workflowKey) unresolved.push(`service "${s.name}" → workflow ${s.workflowId} (not in this country)`);
      }
      return {
        key: svcKey.get(s.id),
        name: s.name, govFee: s.govFee, time: s.time, sla: s.sla,
        docType: s.docType, included: s.included, docs: s.docs,
        requiredDocs: s.requiredDocs ?? [],
        workflowKey,
      };
    }),

    govCenters: keep(centers, "authority").map(g => ({
      key: `${p}.center.${slug(g.name)}`,
      name: g.name, sub: g.sub, color: g.color, bg: g.bg,
      // `officer` is a person at THIS firm, not a fact about the country.
    })),

    packages: keep(packages, "package").map(k => {
      const ids: string[] = Array.isArray(k.serviceIds) ? (k.serviceIds as any[]).map(String) : [];
      const keys = ids.map(id => {
        const key = svcKey.get(id);
        if (!key) unresolved.push(`package "${k.name}" → service ${id} (not in this country)`);
        return key;
      }).filter(Boolean) as string[];
      return {
        key: `${p}.package.${slug(k.name)}`,
        name: k.name, tier: k.tier, basePrice: k.basePrice, billingCycle: k.billingCycle,
        empMin: k.empMin, empMax: k.empMax, features: k.features ?? [], color: k.color,
        serviceKeys: keys,
      };
    }),

    checklistRules: keep(checklists, "checklist rule").map(c => ({
      key: `${p}.checklist.${slug(c.name)}`,
      name: c.name, rows: c.rows ?? [],
    })),

    // Nationalisation bands. The install side already knew how to receive these; the exporter did
    // not produce them, so a pack carried a market's workflows but not the thresholds it is judged
    // by — and an installation on the far end would compute no band at all.
    workforceBands: keep(bands, "workforce band").map(b => ({
      key: `${p}.band.${slug(b.name)}`,
      name: b.name, color: b.color, bg: b.bg, minBp: b.minBp, maxBp: b.maxBp, sort: b.sort,
    })),
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(pack, null, 2));

  const n = (a: any[]) => String(a.length).padStart(3);
  console.log(`\n${pack.countryName} · ${version}  →  ${out}\n`);
  console.log(`  ${n(pack.documentTypes)} document types`);
  console.log(`  ${n(pack.workflowTemplates)} workflow templates`);
  console.log(`  ${n(pack.serviceItems)} services`);
  console.log(`  ${n(pack.govCenters)} authorities`);
  console.log(`  ${n(pack.packages)} packages`);
  console.log(`  ${n(pack.checklistRules)} checklist rules`);

  if (dropped.length) {
    console.log(`\n  excluded by --exclude (${dropped.length}):`);
    for (const d of dropped) console.log(`    ${d}`);
  }

  // Flagged, not removed. Shipping a country pack containing "QA PROBE (INERT)" should be a choice.
  const suspects = [
    ...pack.documentTypes.map(d => ["document type", d.name] as const),
    ...pack.workflowTemplates.map(t => ["workflow", t.name] as const),
    ...pack.serviceItems.map(s => ["service", s.name] as const),
    ...pack.packages.map(k => ["package", k.name] as const),
  ].filter(([, name]) => SUSPECT(name));
  if (suspects.length) {
    console.log(`\n  ⚠ ${suspects.length} row${suspects.length === 1 ? "" : "s"} look like scratch work and ARE included:`);
    for (const [kind, name] of suspects) console.log(`    ${kind}: ${name}`);
    console.log(`    Re-run with --exclude "test,probe,demo" to leave them out.`);
  }

  if (unresolved.length) {
    console.log(`\n  ⚠ references that could not be resolved (kept out rather than guessed):`);
    for (const u of unresolved) console.log(`    ${u}`);
  }

  console.log(`\n  no client data included — ${pack.contains}\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
