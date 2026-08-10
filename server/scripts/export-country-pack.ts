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
 *   Every row gets a `key` — `sa.doctype.iqama` — never its cuid. A cuid means nothing on another
 *   installation, and re-importing on cuids would duplicate everything rather than recognise what is
 *   already there. Stable keys are what make an install idempotent and an upgrade able to find the
 *   row it is upgrading.
 *
 *   A row that ALREADY carries a packKey keeps it. The key is only derived from the name when there
 *   is none. This matters because the installer matches on packKey and nothing else: rename "Iqama
 *   Renewal" to "Iqama Renewal (KSA)" and a name-derived key mints `sa.workflow.iqama-renewal-ksa`,
 *   which matches no installed row — so the next upgrade would ADD a second copy rather than upgrade
 *   the one people have been editing. Renaming a row is the most ordinary thing a customer does, and
 *   it must not silently fork their configuration.
 *
 * WHAT IS REFUSED
 *   Retired rows never travel. `applyInstall` creates rows without a retired flag, so a retired row
 *   that ships comes back alive on the far end — retiring it locally and exporting would undo itself.
 *   And a pack missing a kind the installer expects is refused outright rather than written: a pack
 *   with no pipeline stages installs a market with nowhere to put a deal, and that is discovered on
 *   somebody else's installation rather than here.
 *
 * REFERENCES
 *   Most travel by name (a service names its document type; a step names its authority). Those names
 *   are CHECKED against what this pack actually contains, because a name that resolves here resolves
 *   only by accident of what else happens to be in this database. Two references are cuids and are
 *   rewritten to keys: ServiceItem.workflowId and Package.serviceIds. Nothing unresolvable is ever
 *   silently dropped.
 *
 * Usage:
 *   npx tsx scripts/export-country-pack.ts --country SA --version 2026.1 [--out pack.json]
 *                                          [--clean] [--exclude "test,QA PROBE,new"] [--allow-empty]
 *
 *   --clean       leave out the rows that look like scratch work, instead of only warning about them
 *   --allow-empty write the file even though a kind the installer expects has nothing in it
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
  // An ALL-CAPS marker is somebody labelling their own scratch work, and it is never how a real row
  // gets named. Checked before the length rule below, which was letting "DEMO — Issue Iqama" (18
  // characters) through and shipping two demo templates inside a country pack.
  if (/^(TEST|DEMO|SAMPLE|DUMMY|TEMP|TMP|XX+|ZZ+)\b/.test(n)) return true;
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
  const clean = process.argv.includes("--clean");
  const allowEmpty = process.argv.includes("--allow-empty");

  // Retired rows are refused at the query, not filtered later, so nothing downstream can point at one.
  // `applyInstall` creates rows with retired at its default of false, so a retired row that travelled
  // would arrive alive — retiring something here and exporting would quietly undo the retirement.
  const where = { country, retired: false };
  const [docTypes, templates, services, centers, packages, checklists, bands, stages, sources, reasons] = await Promise.all([
    prisma.documentType.findMany({ where }),
    prisma.workflowTemplate.findMany({ where }),
    prisma.serviceItem.findMany({ where }),
    prisma.govCenter.findMany({ where }),
    prisma.package.findMany({ where }),
    prisma.checklistRule.findMany({ where }),
    prisma.workforceBand.findMany({ where }),
    prisma.pipelineStage.findMany({ where }),
    prisma.leadSource.findMany({ where }),
    prisma.lostReason.findMany({ where }),
  ]);

  const p = country.toLowerCase();
  const dropped: string[] = [];
  const unresolved: string[] = [];
  const rekeyed: string[] = [];

  /**
   * Leave out the rows that should not travel — and say which, every time.
   *
   * Runs BEFORE the key maps below are built, so a service can never end up holding a valid-looking
   * key for a workflow this pack does not contain. Filtering after the maps were built produced
   * exactly that: a reference that resolves on the machine it was exported from and nowhere else.
   */
  const keep = <T extends { name: string }>(rows: T[], kind: string) =>
    rows.filter(r => {
      if (excluded(r.name)) { dropped.push(`${kind}: ${r.name}  (--exclude)`); return false; }
      if (clean && SUSPECT(r.name)) { dropped.push(`${kind}: ${r.name}  (--clean)`); return false; }
      return true;
    });

  const kDocTypes  = keep(docTypes,  "document type");
  const kTemplates = keep(templates, "workflow");
  const kServices  = keep(services,  "service");
  const kCenters   = keep(centers,   "authority");
  const kPackages  = keep(packages,  "package");
  const kChecklists= keep(checklists,"checklist rule");
  const kBands     = keep(bands,     "workforce band");
  const kStages    = keep(stages,    "pipeline stage");
  const kSources   = keep(sources,   "lead source");
  const kReasons   = keep(reasons,   "loss reason");

  /**
   * The key this row travels under.
   *
   * An existing packKey WINS over anything derived from the name, because the installer matches on
   * packKey alone. Rename a row and a name-derived key matches nothing on the far end, so the next
   * upgrade adds a second copy beside the one people have been editing rather than upgrading it.
   *
   * The exception is a key from another country's prefix, which happens when a row was filed under
   * the wrong country and later moved. Carrying `sa.doctype.emirates-id` into an AE pack would make
   * the two packs fight over one row, so the key is re-derived and the change is reported.
   */
  const keyOf = (row: { name: string; packKey?: string | null }, seg: string) => {
    const derived = `${p}.${seg}.${slug(row.name)}`;
    const existing = String(row.packKey ?? "").trim();
    if (!existing) return derived;
    if (!existing.startsWith(`${p}.`)) {
      rekeyed.push(`${seg} "${row.name}": ${existing} → ${derived} (key belonged to another country)`);
      return derived;
    }
    if (existing !== derived) rekeyed.push(`${seg} "${row.name}": kept ${existing} (name would have derived ${derived})`);
    return existing;
  };

  // cuid → key, so the id-based references can be rewritten. Built from the KEPT rows only.
  const tplKey = new Map(kTemplates.map(t => [t.id, keyOf(t, "workflow")]));
  const svcKey = new Map(kServices.map(s => [s.id, keyOf(s, "service")]));
  const chkKey = new Map(kChecklists.map(c => [c.id, keyOf(c, "checklist")]));

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
  const pack = {
    pack: p,
    country,
    countryName: countryName(country),
    version,
    generatedAt: new Date().toISOString(),
    // Stated in the file itself so nobody has to take it on trust.
    contains: "configuration only — no companies, employees, documents, invoices or credentials",

    documentTypes: kDocTypes.map(d => ({
      key: keyOf(d, "doctype"),
      // subjectKind decides whether a type belongs to an employee or to the company. It was written
      // here as "entity", which is not a column, so it exported as undefined and JSON.stringify
      // dropped it — every pack shipped without it and every installed type defaulted to employee.
      name: d.name, subjectKind: d.subjectKind, defaultFee: d.defaultFee,
      leadDays: d.leadDays, authority: d.authority,
      fields: d.fields ?? [], prereqs: d.prereqs ?? [],
      requiresApproval: d.requiresApproval, defaultAssigneeRole: d.defaultAssigneeRole,
    })),

    workflowTemplates: kTemplates.map(t => ({
      key: tplKey.get(t.id),
      name: t.name, trigger: t.trigger, triggerConfig: t.triggerConfig ?? null,
      entityType: t.entityType, active: t.active,
      // The graph mostly names things as strings — document types, authorities — so those survive.
      // One node config does NOT: a checklist step points at its rule by cuid, which would arrive on
      // another installation pointing at nothing. Found by the leak check rather than by reading the
      // schema, which is the argument for having the leak check.
      graph: rewriteGraph(t.graph, t.name),
    })),

    serviceItems: kServices.map(s => {
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

    govCenters: kCenters.map(g => ({
      key: keyOf(g, "center"),
      name: g.name, sub: g.sub, color: g.color, bg: g.bg,
      // `officer` is a person at THIS firm, not a fact about the country.
    })),

    packages: kPackages.map(k => {
      const ids: string[] = Array.isArray(k.serviceIds) ? (k.serviceIds as any[]).map(String) : [];
      const keys = ids.map(id => {
        const key = svcKey.get(id);
        if (!key) unresolved.push(`package "${k.name}" → service ${id} (not in this country)`);
        return key;
      }).filter(Boolean) as string[];
      return {
        key: keyOf(k, "package"),
        name: k.name, tier: k.tier, basePrice: k.basePrice, billingCycle: k.billingCycle,
        empMin: k.empMin, empMax: k.empMax, features: k.features ?? [], color: k.color,
        serviceKeys: keys,
      };
    }),

    checklistRules: kChecklists.map(c => ({
      key: keyOf(c, "checklist"),
      name: c.name, rows: c.rows ?? [],
    })),

    // Nationalisation bands. The install side already knew how to receive these; the exporter did
    // not produce them, so a pack carried a market's workflows but not the thresholds it is judged
    // by — and an installation on the far end would compute no band at all.
    workforceBands: kBands.map(b => ({
      key: keyOf(b, "band"),
      name: b.name, color: b.color, bg: b.bg, minBp: b.minBp, maxBp: b.maxBp, sort: b.sort,
    })),

    // Sales stages. Same lesson as the bands above: the install side accepts these, so an exporter
    // that does not produce them ships a market with nowhere to put a deal.
    pipelineStages: kStages.map(s => ({
      key: keyOf(s, "stage"),
      name: s.name, color: s.color, bg: s.bg, sort: s.sort,
      probabilityBp: s.probabilityBp, isWon: s.isWon, isLost: s.isLost,
      followUpDays: s.followUpDays, followUpAction: s.followUpAction,
    })),

    // Where business comes from and why it is lost. Wording is exactly the thing that differs
    // between markets, which is why these travel with the country rather than living in code.
    leadSources: kSources.map(x => ({
      key: keyOf(x, "source"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
    })),
    lostReasons: kReasons.map(x => ({
      key: keyOf(x, "lostreason"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
    })),
  };

  /**
   * The references that travel as plain names, checked against what this pack actually contains.
   *
   * A workflow step naming the document type "Trade License", or the authority "ICP", resolves fine
   * on the machine it was exported from — because that machine also holds the rows of every OTHER
   * country. On a fresh installation of this one pack there is nothing behind the name. The export is
   * the only moment both halves are visible together, so it is the only place this can be caught.
   */
  const docTypeNames = new Set(pack.documentTypes.map(d => String(d.name).trim().toLowerCase()));
  const centerNames = new Set(pack.govCenters.map(g => String(g.name).trim().toLowerCase()));
  // Everything of that kind ANYWHERE in this database, so the report can tell the two cases apart: a
  // name filed under another country is a tagging mistake, a name that exists nowhere is a typo or a
  // row somebody never created. They read the same in a pack and need completely different fixes.
  const [allDocs, allCenters] = await Promise.all([
    prisma.documentType.findMany({ select: { name: true, country: true, retired: true } }),
    prisma.govCenter.findMany({ select: { name: true, country: true, retired: true } }),
  ]);
  const elsewhere = (rows: { name: string; country: string; retired: boolean }[], v: string) =>
    rows.filter(r => String(r.name).trim().toLowerCase() === v.toLowerCase())
        .map(r => r.country + (r.retired ? " (retired)" : ""));

  const dangling: string[] = [];
  const needs = (value: unknown, pool: Set<string>, what: string, where: string) => {
    const v = String(value ?? "").trim();
    if (!v || pool.has(v.toLowerCase())) return;
    const found = elsewhere(what === "authority" ? allCenters : allDocs, v);
    dangling.push(`${where} → ${what} "${v}"  —  ${found.length ? `exists, but filed under ${found.join(", ")}` : "exists nowhere in this database"}`);
  };
  for (const t of pack.workflowTemplates) {
    // The TRIGGER names a document type too, and checking only the steps missed it entirely: a
    // renewal template can sit there looking configured while triggering on a document type nothing
    // will ever create, so it simply never fires and nobody is told why.
    needs((t.triggerConfig as any)?.docType, docTypeNames, "document type", `workflow "${t.name}" trigger`);
    for (const node of ((t.graph as any)?.nodes ?? [])) {
      const c = node?.config ?? {};
      const at = `workflow "${t.name}" step "${node.label ?? node.id}"`;
      needs(c.docType, docTypeNames, "document type", at);
      needs(c.govCenter, centerNames, "authority", at);
    }
  }
  for (const s of pack.serviceItems) needs(s.docType, docTypeNames, "document type", `service "${s.name}"`);
  for (const d of pack.documentTypes) {
    // A document type's authority is the government body that issues it, and it is shown on screen.
    needs(d.authority, centerNames, "authority", `document type "${d.name}"`);
    // A prerequisite names the document it waits for. Pointing at nothing does not fail loudly — it
    // simply never blocks anything, so the rule reads as satisfied every time it is evaluated.
    for (const pre of ((d.prereqs as any[]) ?? []))
      needs(pre?.requiresDocType, docTypeNames, "document type", `document type "${d.name}" prerequisite`);
  }

  // A kind the installer expects but this pack has nothing for. Refused rather than written, because
  // the cost lands on whoever installs it — a country with no pipeline stages has nowhere to put a
  // deal, and they have no way to know the pack was the reason.
  const empty = ([
    ["document types", pack.documentTypes], ["workflow templates", pack.workflowTemplates],
    ["services", pack.serviceItems], ["authorities", pack.govCenters],
    ["packages", pack.packages], ["checklist rules", pack.checklistRules],
    ["workforce bands", pack.workforceBands], ["pipeline stages", pack.pipelineStages],
    ["lead sources", pack.leadSources], ["loss reasons", pack.lostReasons],
  ] as const).filter(([, rows]) => !rows.length).map(([label]) => label);

  const n = (a: any[]) => String(a.length).padStart(3);
  if (empty.length && !allowEmpty) {
    console.log(`\n✗ Not written. ${countryName(country)} has nothing for: ${empty.join(", ")}.`);
    console.log(`  The installer expects every one of these. Add the missing configuration, or pass`);
    console.log(`  --allow-empty if this pack is deliberately partial.\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(pack, null, 2));

  console.log(`\n${pack.countryName} · ${version}  →  ${out}\n`);
  console.log(`  ${n(pack.documentTypes)} document types`);
  console.log(`  ${n(pack.workflowTemplates)} workflow templates`);
  console.log(`  ${n(pack.serviceItems)} services`);
  console.log(`  ${n(pack.govCenters)} authorities`);
  console.log(`  ${n(pack.packages)} packages`);
  console.log(`  ${n(pack.checklistRules)} checklist rules`);
  // Both of these were exported and then not mentioned. A summary that omits a section is how
  // "0 workforce bands" goes unnoticed until somebody installs the pack in another country.
  console.log(`  ${n(pack.workforceBands)} workforce bands`);
  console.log(`  ${n(pack.pipelineStages)} pipeline stages`);
  console.log(`  ${n(pack.leadSources)} lead sources`);
  console.log(`  ${n(pack.lostReasons)} loss reasons`);

  if (empty.length) console.log(`\n  ⚠ written with --allow-empty; nothing for: ${empty.join(", ")}`);

  if (dropped.length) {
    console.log(`\n  left out (${dropped.length}) — every one named, so none of this is a surprise:`);
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
    console.log(`    Re-run with --clean to leave them out.`);
  }

  // Not an error: a row can be renamed after install and keeping its old key is the WHOLE point. It
  // is printed because a key that no longer resembles the name is confusing later, and finding out
  // then is worse than being told now.
  if (rekeyed.length) {
    console.log(`\n  keys that do not match their current name (kept on purpose — an upgrade matches on the key):`);
    for (const r of rekeyed) console.log(`    ${r}`);
  }

  if (dangling.length) {
    console.log(`\n  ⚠ ${dangling.length} reference${dangling.length === 1 ? "" : "s"} name something this pack does NOT contain:`);
    for (const d of dangling) console.log(`    ${d}`);
    console.log(`    A name filed under another country resolves here only because this database`);
    console.log(`    holds them all; on a fresh install of this pack alone it resolves to nothing.`);
    console.log(`    A name that exists nowhere is already broken, here as well as everywhere else.`);
  }

  if (unresolved.length) {
    console.log(`\n  ⚠ references that could not be resolved (kept out rather than guessed):`);
    for (const u of unresolved) console.log(`    ${u}`);
  }

  console.log(`\n  no client data included — ${pack.contains}\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
