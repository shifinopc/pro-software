/**
 * Country packs — planning and installing.
 *
 * This lives here rather than in the script because the console needs it too, and copying it would
 * give the API and the command line two implementations that drift. One of them would then be right
 * and the other would look right, which is the failure this whole area exists to avoid.
 *
 * The CLI in scripts/install-country-pack.ts is a thin wrapper over these functions, so what you see
 * in a terminal and what you see in the browser are the same decisions.
 */
import { prisma } from "./db.js";
import { COUNTRIES, countryName, countryFlag } from "./countries.js";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where packs are kept.
 *
 * In dev the API runs from server/ and packs sit beside it at the repo root. In the container only
 * server/ is copied, so the image gets its own copy at /app/packs and the "../packs" guess resolves
 * to nothing — the pack list would just come back empty with no error to explain why. So try each
 * known location and let the deployment override it outright.
 */
export const PACKS_DIR = (() => {
  if (process.env.PACKS_DIR) return resolve(process.env.PACKS_DIR);
  const candidates = [resolve(process.cwd(), "..", "packs"), resolve(process.cwd(), "packs")];
  return candidates.find(existsSync) ?? candidates[0];
})();

export type PackRow = { key: string; name: string; [k: string]: any };
export type Pack = {
  pack: string; country: string; countryName: string; version: string;
  generatedAt?: string; contains?: string;
  documentTypes?: PackRow[]; govCenters?: PackRow[]; checklistRules?: PackRow[];
  workflowTemplates?: PackRow[]; serviceItems?: PackRow[]; packages?: PackRow[]; workforceBands?: PackRow[];
  pipelineStages?: PackRow[]; leadSources?: PackRow[]; lostReasons?: PackRow[];
};

/**
 * Which pack collection maps to which model, and exactly which fields travel.
 *
 * Listed rather than spread wholesale: a column added to a model later should be a deliberate decision
 * to ship, not something that starts travelling because nobody noticed.
 */
export const KINDS = [
  // subjectKind, not "entity": there is no entity column, so the name that used to be here shipped
  // nothing — undefined is dropped by JSON.stringify on the way out and ignored by Prisma on the way
  // in, so every installed type silently took the default and company-scoped types (CR, GOSI, VAT)
  // arrived pointing at employees. "sub" was not a column either.
  { key: "documentTypes", model: "documentType", label: "document types", one: "document type",
    fields: (r: any) => ({ name: r.name, subjectKind: r.subjectKind, defaultFee: r.defaultFee, leadDays: r.leadDays, authority: r.authority, fields: r.fields, prereqs: r.prereqs, requiresApproval: r.requiresApproval, defaultAssigneeRole: r.defaultAssigneeRole }) },
  { key: "govCenters", model: "govCenter", label: "authorities", one: "authority",
    fields: (r: any) => ({ name: r.name, sub: r.sub, color: r.color, bg: r.bg }) },
  { key: "checklistRules", model: "checklistRule", label: "checklist rules", one: "checklist rule",
    fields: (r: any) => ({ name: r.name, rows: r.rows }) },
  { key: "workflowTemplates", model: "workflowTemplate", label: "workflow templates", one: "workflow",
    fields: (r: any) => ({ name: r.name, trigger: r.trigger, triggerConfig: r.triggerConfig, entityType: r.entityType, active: r.active, graph: r.graph }) },
  { key: "serviceItems", model: "serviceItem", label: "services", one: "service",
    fields: (r: any) => ({ name: r.name, govFee: r.govFee, time: r.time, sla: r.sla, docType: r.docType, included: r.included, docs: r.docs, requiredDocs: r.requiredDocs }) },
  // Nationalisation bands. A country pack that carries the workflows for a market but not the bands
  // it is measured by would be half a market.
  { key: "workforceBands", model: "workforceBand", label: "workforce bands", one: "workforce band",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, minBp: r.minBp, maxBp: r.maxBp, sort: r.sort }) },
  // Sales stages. Same argument as the bands: a pack that sets up how work is DONE in a market but
  // not how it is SOLD there leaves the new country with an empty pipeline board.
  // followUpDays/followUpAction travel too: how soon a market expects a reply after a quotation is
  // part of how business is done there, and a pack that set up the columns but not the chasing
  // would install a pipeline that never reminds anybody of anything.
  { key: "pipelineStages", model: "pipelineStage", label: "pipeline stages", one: "pipeline stage",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort, probabilityBp: r.probabilityBp, isWon: r.isWon, isLost: r.isLost, followUpDays: r.followUpDays, followUpAction: r.followUpAction }) },
  // Where business comes from and why it is lost. Both are wording, and wording is exactly the thing
  // that differs between markets — "walk-in" means something in Riyadh that it does not in Dubai.
  { key: "leadSources", model: "leadSource", label: "lead sources", one: "lead source",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort }) },
  { key: "lostReasons", model: "lostReason", label: "loss reasons", one: "loss reason",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort }) },
  { key: "packages", model: "package", label: "packages", one: "package",
    fields: (r: any) => ({ name: r.name, tier: r.tier, basePrice: r.basePrice, billingCycle: r.billingCycle, empMin: r.empMin, empMax: r.empMax, features: r.features, color: r.color }) },
] as const;

export type KindPlan = {
  key: string; label: string; one: string;
  create: PackRow[];
  installed: PackRow[];
  adopt: { row: PackRow; existingId: string; existingName: string }[];
};
export type InstallPlan = {
  country: string; countryName: string; version: string;
  kinds: KindPlan[];
  totals: { create: number; installed: number; adopt: number };
};

/** Packs available to install, newest name first. Unreadable files are reported, not thrown. */
export function listPacks(): { file: string; country: string; countryName: string; version: string; error?: string }[] {
  if (!existsSync(PACKS_DIR)) return [];
  return readdirSync(PACKS_DIR)
    .filter(f => f.toLowerCase().endsWith(".json"))
    .map(file => {
      try {
        const p = JSON.parse(readFileSync(join(PACKS_DIR, file), "utf8"));
        return { file, country: p.country, countryName: p.countryName ?? p.country, version: p.version };
      } catch (e: any) {
        // A malformed file is listed with its problem rather than hidden — a pack that silently
        // vanishes from the list is harder to diagnose than one that says it cannot be read.
        return { file, country: "", countryName: file, version: "", error: String(e?.message ?? e) };
      }
    });
}

/**
 * Accept a new pack file onto this server.
 *
 * This is how a country's updates REACH an installation. Without it a new version means rebuilding
 * and redeploying the image, which puts publishing a corrected Saudi fee behind a release — so in
 * practice it would not happen, and the upgrade flow would have nothing to upgrade to.
 *
 * Validated before it is written: a file that is not a pack must be refused here rather than appear
 * in the install list and fail later, when somebody is halfway through expecting it to work.
 */
export function savePack(raw: unknown): { file: string; country: string; version: string; replaced: boolean } {
  const p: any = raw;
  if (!p || typeof p !== "object") throw new Error("That is not a pack file");
  const country = String(p.country || "").trim().toUpperCase();
  const version = String(p.version || "").trim();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("The pack does not say which country it is for");
  if (!version) throw new Error("The pack does not carry a version");
  if (!KINDS.some(k => Array.isArray(p[k.key]) && p[k.key].length)) {
    throw new Error("The pack contains no configuration — nothing to install");
  }
  // Client data must never arrive this way. A pack describes how work is done in a country; a file
  // carrying somebody's client list would be a privacy incident dressed as configuration.
  for (const banned of ["companies", "employees", "documents", "invoices", "users", "credentials"]) {
    if (Array.isArray(p[banned]) && p[banned].length) throw new Error(`That file carries ${banned}, which a country pack must never contain`);
  }

  if (!existsSync(PACKS_DIR)) mkdirSync(PACKS_DIR, { recursive: true });
  // Name derived from the pack's own country and version, never from anything the caller sends —
  // a filename is user input and "../../.env" is a valid string.
  const file = `pack-${country.toLowerCase()}-${version.replace(/[^A-Za-z0-9._-]/g, "")}.json`;
  const full = join(PACKS_DIR, file);
  const replaced = existsSync(full);
  writeFileSync(full, JSON.stringify(p, null, 2));
  return { file, country, version, replaced };
}

export function readPack(file: string): Pack {
  // Basename only: a file name is user input, and "../../.env" must not be readable through it.
  const safe = String(file).replace(/[\\/]/g, "");
  return JSON.parse(readFileSync(join(PACKS_DIR, safe), "utf8"));
}

/**
 * What installing this pack would do. Read-only.
 *
 * Three outcomes per row: already installed (matched by packKey), adopt (a row with the same name
 * exists but was made here), or new. Nothing else is possible, and nothing is decided later —
 * applying re-runs this and acts on it, so the preview cannot disagree with the result.
 */
export async function planInstall(pack: Pack): Promise<InstallPlan> {
  const kinds: KindPlan[] = [];
  for (const kind of KINDS) {
    const rows: PackRow[] = (pack as any)[kind.key] ?? [];
    const existing = await (prisma as any)[kind.model].findMany();
    const byKey = new Set(existing.filter((e: any) => e.packKey).map((e: any) => e.packKey));
    const byName = new Map<string, any>(
      existing.filter((e: any) => !e.packKey).map((e: any) => [String(e.name).trim().toLowerCase(), e]),
    );

    const plan: KindPlan = { key: kind.key, label: kind.label, one: kind.one, create: [], installed: [], adopt: [] };
    for (const r of rows) {
      if (byKey.has(r.key)) { plan.installed.push(r); continue; }
      const local = byName.get(String(r.name).trim().toLowerCase());
      if (local) { plan.adopt.push({ row: r, existingId: local.id, existingName: local.name }); continue; }
      plan.create.push(r);
    }
    kinds.push(plan);
  }
  const totals = kinds.reduce((a, k) => ({
    create: a.create + k.create.length, installed: a.installed + k.installed.length, adopt: a.adopt + k.adopt.length,
  }), { create: 0, installed: 0, adopt: 0 });

  return { country: pack.country, countryName: pack.countryName ?? pack.country, version: pack.version, kinds, totals };
}

/**
 * Install. Creates what is missing, optionally adopts what matches by name, then wires references.
 *
 * Adoption keeps the LOCAL values and only stamps provenance — an installation configured by hand
 * must not have its work replaced by a pack, and must not end up with two of everything either.
 */
export async function applyInstall(pack: Pack, opts: { adopt?: boolean } = {}): Promise<{ created: number; adopted: number; unresolved: string[] }> {
  const plan = await planInstall(pack);
  const country = pack.country;
  let created = 0, adopted = 0;

  for (const kind of KINDS) {
    const kp = plan.kinds.find(k => k.key === kind.key)!;
    const model = (prisma as any)[kind.model];
    for (const r of kp.create) {
      await model.create({ data: { ...kind.fields(r), country, packKey: r.key, packVersion: pack.version, packModified: false } });
      created++;
    }
    if (opts.adopt) {
      for (const a of kp.adopt) {
        // Only provenance. packModified: true says plainly that this row does not match the pack, so a
        // future upgrade offers a diff rather than overwriting somebody's work.
        await model.update({ where: { id: a.existingId }, data: { packKey: a.row.key, packVersion: pack.version, packModified: true } });
        adopted++;
      }
    }
  }

  const unresolved = await wireReferences(pack);
  await registerCountryRow(pack.country);
  return { created, adopted, unresolved };
}

/**
 * Put the country on the Country Rules screen.
 *
 * That list is a separate hand-maintained setting, so installing a pack used to leave the screen
 * completely unchanged: seventeen document types and thirty workflows arrived, and the one page that
 * is supposed to show which markets are configured still said nothing was. With no row there was also
 * no Uninstall button, so an install could not be undone from the UI it was started in.
 *
 * Only ever ADDS. The row carries a name, flag, currency and status the user can edit afterwards, and
 * an existing row is left exactly as they set it.
 */
async function registerCountryRow(country: string) {
  const code = String(country || "").toUpperCase();
  if (!code) return;
  const row = await prisma.appSetting.findUnique({ where: { key: "countryRules" } });
  const value: any = (row?.value && typeof row.value === "object") ? row.value : {};
  const list: any[] = Array.isArray(value.countries) ? value.countries : [];

  const name = countryName(code);
  // Stored as a tuple — [name, flag, currency, clients, portals, docs, status] — which is the shape
  // the screen destructures. An object here renders "object is not iterable" and blanks the page.
  if (list.some(c => Array.isArray(c) && String(c[0]).trim().toLowerCase() === name.trim().toLowerCase())) return;

  const meta = COUNTRIES.find(c => c.code === code);
  // First country in becomes Primary; anything after it is Active. Status is theirs to change.
  list.push([name, countryFlag(code), meta?.currency ?? "", 0, [], 0, list.length ? "Active" : "Primary"]);
  await prisma.appSetting.upsert({
    where: { key: "countryRules" },
    create: { key: "countryRules", value: { ...value, countries: list } },
    update: { value: { ...value, countries: list } },
  });
}

/** Look up the row a pack key became. Used wherever a reference has to be resolved. */
const idFor = async (model: string, key: string) =>
  (await (prisma as any)[model].findFirst({ where: { packKey: key }, select: { id: true } }))?.id ?? null;

/**
 * Point the cross-references at real rows, once every row exists.
 *
 * Anything unresolvable is reported and LEFT UNSET — a reference pointed at a plausible wrong row is
 * worse than one that is obviously missing.
 *
 * `skipKeys` exists for upgrades: a row the user edited keeps its own wiring. Re-pointing an edited
 * service at the pack's workflow would quietly undo a deliberate choice, which is precisely what
 * "you edited this" is supposed to protect against.
 */
async function wireReferences(pack: Pack, skipKeys: Set<string> = new Set()): Promise<string[]> {
  const unresolved: string[] = [];

  for (const s of pack.serviceItems ?? []) {
    if (!s.workflowKey || skipKeys.has(s.key)) continue;
    const svc = await prisma.serviceItem.findFirst({ where: { packKey: s.key } });
    if (!svc) continue;
    const wf = await idFor("workflowTemplate", s.workflowKey);
    if (!wf) { unresolved.push(`service "${s.name}" → ${s.workflowKey}`); continue; }
    await prisma.serviceItem.update({ where: { id: svc.id }, data: { workflowId: wf } });
  }

  for (const k of pack.packages ?? []) {
    if (skipKeys.has(k.key)) continue;
    const pkg = await prisma.package.findFirst({ where: { packKey: k.key } });
    if (!pkg) continue;
    const ids: string[] = [];
    for (const sk of (k as any).serviceKeys ?? []) {
      const id = await idFor("serviceItem", sk);
      if (id) ids.push(id); else unresolved.push(`package "${k.name}" → ${sk}`);
    }
    await prisma.package.update({ where: { id: pkg.id }, data: { serviceIds: ids } });
  }

  for (const t of pack.workflowTemplates ?? []) {
    if (skipKeys.has(t.key)) continue;
    const tpl = await prisma.workflowTemplate.findFirst({ where: { packKey: t.key } });
    if (!tpl) continue;
    const g: any = tpl.graph ?? {};
    const nodes: any[] = Array.isArray(g.nodes) ? g.nodes : [];
    let touched = false;
    const next: any[] = [];
    for (const n of nodes) {
      const c = n?.config;
      if (!c?.checklistRuleKey) { next.push(n); continue; }
      const { checklistRuleKey, ...rest } = c;
      const id = await idFor("checklistRule", checklistRuleKey);
      touched = true;
      if (!id) { unresolved.push(`workflow "${t.name}" step "${n.label ?? n.id}" → ${checklistRuleKey}`); next.push({ ...n, config: rest }); continue; }
      next.push({ ...n, config: { ...rest, checklistRuleId: id } });
    }
    if (touched) await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { graph: { ...g, nodes: next } } });
  }

  return unresolved;
}

export type UninstallRow = { model: string; one: string; id: string; name: string; outcome: "remove" | "retire" | "keep"; why: string };
export type UninstallPlan = { country: string; version: string; rows: UninstallRow[]; totals: { remove: number; retire: number; keep: number } };

/**
 * What uninstalling would do, row by row.
 *
 * Three outcomes, and which one a row gets is decided by what points at it:
 *
 *   keep    a human edited it after install (packModified). It is theirs now — the packKey is dropped
 *           so it stops being managed, and the row itself is left completely alone.
 *   retire  real records depend on it. NOT deleted: a document type with documents captured under it
 *           still defines their fields, and removing it would orphan them — the same orphaning this
 *           codebase was already bitten by when field ids were regenerated.
 *   remove  nothing references it and nobody changed it. Safe to delete.
 *
 * Client data is never read for anything except counting these dependencies, and never written.
 */
export async function planUninstall(country: string): Promise<UninstallPlan> {
  const candidates: Record<string, any[]> = {};
  for (const kind of KINDS) {
    candidates[kind.model] = await (prisma as any)[kind.model].findMany({ where: { country, packKey: { not: null } } });
  }
  return planRemoval(country, candidates);
}

/**
 * The shared "what happens to these rows if they go away" pass.
 *
 * Uninstall hands it every row the pack manages. An upgrade hands it only the rows the new version
 * dropped. The rules are identical in both cases, so they live here once — a second copy would be
 * the same drift this module was created to avoid.
 */
async function planRemoval(country: string, candidates: Record<string, any[]>): Promise<UninstallPlan> {
  const rows: UninstallRow[] = [];
  let version = "";

  /**
   * Everything this pass is about to take away.
   *
   * A dependency only counts if it comes from OUTSIDE that set. Without this the pack keeps itself
   * alive: a service is retired because a package needs it, while that same package is being deleted
   * in the same breath — so the service survives pointing at nothing, and an uninstall leaves most of
   * itself behind. Only a reference from something that will still exist afterwards is a real reason
   * to keep a row.
   */
  const going = new Set<string>();
  for (const kind of KINDS) {
    for (const r of candidates[kind.model] ?? []) {
      if (!r.packModified) going.add(kind.model + ":" + r.id);
    }
  }
  const survives = (model: string, id: string) => !going.has(model + ":" + id);

  // Many references are BY NAME rather than by id — a document carries its docType as a string, a task
  // its authority. Both have to be checked, or "nothing references this" is a claim about ids only.
  for (const kind of KINDS) {
    const managed = candidates[kind.model] ?? [];
    for (const row of managed) {
      if (row.packVersion) version = row.packVersion;

      if (row.packModified) {
        rows.push({ model: kind.model, one: kind.one, id: row.id, name: row.name, outcome: "keep", why: "you edited this after it was installed" });
        continue;
      }

      let uses = 0;
      const reasons: string[] = [];
      const note = (n: number, what: string) => { if (n > 0) { uses += n; reasons.push(`${n} ${what}`); } };

      if (kind.model === "documentType") {
        // Documents are client data and always count. Services only count if they are staying.
        note(await prisma.document.count({ where: { docType: row.name } }), "documents");
        const svcs = await prisma.serviceItem.findMany({ where: { docType: row.name }, select: { id: true } });
        note(svcs.filter(s => survives("serviceItem", s.id)).length, "services");
      } else if (kind.model === "workflowTemplate") {
        note(await prisma.workflowInstance.count({ where: { templateId: row.id } }), "runs");
        const svcs = await prisma.serviceItem.findMany({ where: { workflowId: row.id }, select: { id: true } });
        note(svcs.filter(s => survives("serviceItem", s.id)).length, "services");
      } else if (kind.model === "serviceItem") {
        note(await prisma.serviceRequest.count({ where: { type: row.name } }), "client requests");
        note(await prisma.upgradeRequest.count({ where: { serviceId: row.id } }), "add-on requests");
        // A package holds service ids in JSON, so it cannot be counted with a where clause.
        const pkgs = await prisma.package.findMany({ select: { id: true, serviceIds: true } });
        note(pkgs.filter(p => survives("package", p.id) && Array.isArray(p.serviceIds) && (p.serviceIds as any[]).map(String).includes(row.id)).length, "packages");
      } else if (kind.model === "package") {
        note(await prisma.subscription.count({ where: { packageId: row.id } }), "subscriptions");
      } else if (kind.model === "govCenter") {
        note(await prisma.task.count({ where: { govCenter: row.name } }), "tasks");
        note(await prisma.workflowTask.count({ where: { govCenter: row.name } }), "workflow steps");
        note(await prisma.siteCredential.count({ where: { govCenter: row.name } }), "stored credentials");
      } else if (kind.model === "checklistRule") {
        // Referenced from inside workflow graphs, so it has to be looked for there — and only in the
        // templates that will still be here afterwards.
        const tpls = await prisma.workflowTemplate.findMany({ select: { id: true, graph: true } });
        const used = tpls.filter(t => {
          if (!survives("workflowTemplate", t.id)) return false;
          const nodes: any[] = Array.isArray((t.graph as any)?.nodes) ? (t.graph as any).nodes : [];
          return nodes.some(n => n?.config?.checklistRuleId === row.id);
        }).length;
        note(used, "workflow steps");
      }

      rows.push(uses > 0
        ? { model: kind.model, one: kind.one, id: row.id, name: row.name, outcome: "retire", why: reasons.join(" · ") + " depend on it" }
        : { model: kind.model, one: kind.one, id: row.id, name: row.name, outcome: "remove", why: "nothing uses it" });
    }
  }

  const totals = rows.reduce((a, r) => ({ ...a, [r.outcome]: a[r.outcome] + 1 }), { remove: 0, retire: 0, keep: 0 } as any);
  return { country, version, rows, totals };
}

/** Carry out an uninstall. Deletes only what the plan marked `remove`. */
export async function applyUninstall(country: string): Promise<{ removed: number; retired: number; kept: number }> {
  const plan = await planUninstall(country);
  let removed = 0, retired = 0, kept = 0;
  for (const r of plan.rows) {
    const model = (prisma as any)[r.model];
    if (r.outcome === "remove") { await model.delete({ where: { id: r.id } }); removed++; }
    // Retired rows keep their packKey: they came from a pack and still did, which is what lets a
    // re-install recognise them instead of creating duplicates beside the retired ones.
    else if (r.outcome === "retire") { await model.update({ where: { id: r.id }, data: { retired: true } }); retired++; }
    // Kept rows lose theirs — they are the user's now, and a future pack must not claim them silently.
    else { await model.update({ where: { id: r.id }, data: { packKey: null, packVersion: null, packModified: false } }); kept++; }
  }
  return { removed, retired, kept };
}

/**
 * Compare two values the way a person would.
 *
 * MySQL stores JSON columns with its own key order, so a graph read back from the database does not
 * stringify the same as the identical graph in the pack file. Comparing them raw would report every
 * template as changed on every upgrade, which is indistinguishable from a real change and therefore
 * useless. Sorting keys first makes the comparison about content only.
 */
function stable(v: any): any {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: any = {};
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
    return out;
  }
  return v === undefined ? null : v;
}
const same = (a: any, b: any) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

export type UpgradeChange = { field: string; from: any; to: any };
export type UpgradeRow = {
  model: string; one: string; label: string; key: string; name: string;
  outcome: "add" | "update" | "unchanged" | "yours" | "revive";
  changes: UpgradeChange[];
  id?: string;
};
export type UpgradePlan = {
  country: string; countryName: string; from: string; to: string;
  rows: UpgradeRow[];
  gone: UninstallRow[];
  totals: { add: number; update: number; unchanged: number; yours: number; revive: number; remove: number; retire: number; keep: number };
};

/**
 * What moving to this version of the pack would do.
 *
 * Five outcomes for rows the new version still has:
 *
 *   add        the version introduces it — created like a fresh install
 *   update     the pack changed it and nobody here did — the new values win, field by field
 *   unchanged  identical to what is already installed — only the version stamp moves
 *   yours      edited here after installing. LEFT COMPLETELY ALONE. The pack's version of the change
 *              is still listed so the difference can be applied by hand if it is wanted.
 *   revive     it was retired by an earlier uninstall and this version brings it back
 *
 * Rows the new version DROPPED go through the same remove/retire/keep rules as an uninstall, because
 * withdrawing one row is the same problem as withdrawing all of them.
 */
export async function planUpgrade(pack: Pack): Promise<UpgradePlan> {
  const country = pack.country;
  const rows: UpgradeRow[] = [];
  const dropped: Record<string, any[]> = {};
  let from = "";

  for (const kind of KINDS) {
    const packRows: PackRow[] = (pack as any)[kind.key] ?? [];
    const byKey = new Map(packRows.map(r => [r.key, r]));
    const local = await (prisma as any)[kind.model].findMany({ where: { country, packKey: { not: null } } });
    const localByKey = new Map<string, any>(local.map((r: any) => [r.packKey, r]));

    for (const r of local) if (r.packVersion) from = r.packVersion;

    for (const r of packRows) {
      const cur = localByKey.get(r.key);
      const base = { model: kind.model, one: kind.one, label: kind.label, key: r.key, name: r.name };

      if (!cur) { rows.push({ ...base, outcome: "add", changes: [] }); continue; }

      // What the pack wants this row to look like. Templates carry checklist references by KEY, while
      // the stored graph holds resolved ids — comparing those two directly would flag every template
      // as changed forever, so the pack's keys are resolved first and the comparison is like for like.
      const want: any = kind.fields(r as any);
      if (kind.model === "workflowTemplate") want.graph = await resolveGraph(want.graph);

      const changes: UpgradeChange[] = [];
      for (const [field, to] of Object.entries(want)) {
        // A field the pack does not carry at all is not an instruction to clear it. Packs written
        // before a field existed would otherwise read as "set it to null" and wipe it on upgrade.
        // Deliberately clearing a value is still possible — that arrives as null, not undefined.
        if (to === undefined) continue;
        if (!same((cur as any)[field], to)) changes.push({ field, from: (cur as any)[field], to });
      }

      if (cur.packModified) { rows.push({ ...base, id: cur.id, outcome: "yours", changes }); continue; }
      if (cur.retired) { rows.push({ ...base, id: cur.id, outcome: "revive", changes }); continue; }
      rows.push({ ...base, id: cur.id, outcome: changes.length ? "update" : "unchanged", changes });
    }

    dropped[kind.model] = local.filter((r: any) => !byKey.has(r.packKey));
  }

  const gonePlan = await planRemoval(country, dropped);
  const totals: any = { add: 0, update: 0, unchanged: 0, yours: 0, revive: 0, ...gonePlan.totals };
  for (const r of rows) totals[r.outcome]++;

  return { country, countryName: pack.countryName ?? country, from, to: pack.version, rows, gone: gonePlan.rows, totals };
}

/** Translate a pack graph's checklist keys into the ids they resolve to here, for comparison. */
async function resolveGraph(graph: any): Promise<any> {
  const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const next: any[] = [];
  for (const n of nodes) {
    const c = n?.config;
    if (!c?.checklistRuleKey) { next.push(n); continue; }
    const { checklistRuleKey, ...rest } = c;
    const id = await idFor("checklistRule", checklistRuleKey);
    next.push(id ? { ...n, config: { ...rest, checklistRuleId: id } } : { ...n, config: rest });
  }
  return { ...(graph ?? {}), nodes: next };
}

/**
 * Carry out an upgrade.
 *
 * Re-plans rather than trusting a plan passed in, so what happens is decided against the database as
 * it is at this moment — a preview looked at ten minutes ago cannot authorise a change to something
 * that has since been edited.
 */
export async function applyUpgrade(pack: Pack): Promise<{ added: number; updated: number; revived: number; yours: number; removed: number; retired: number; kept: number; unresolved: string[] }> {
  const plan = await planUpgrade(pack);
  const country = pack.country;
  const byKind = new Map<string, (typeof KINDS)[number]>(KINDS.map(k => [k.model as string, k]));
  let added = 0, updated = 0, revived = 0;

  for (const r of plan.rows) {
    const kind = byKind.get(r.model)!;
    const model = (prisma as any)[kind.model];
    const src = ((pack as any)[kind.key] as PackRow[]).find(x => x.key === r.key)!;

    if (r.outcome === "add") {
      await model.create({ data: { ...kind.fields(src as any), country, packKey: r.key, packVersion: pack.version, packModified: false } });
      added++;
    } else if (r.outcome === "update") {
      await model.update({ where: { id: r.id }, data: { ...kind.fields(src as any), packVersion: pack.version } });
      updated++;
    } else if (r.outcome === "revive") {
      await model.update({ where: { id: r.id }, data: { ...kind.fields(src as any), retired: false, packVersion: pack.version } });
      revived++;
    } else {
      // unchanged and yours: only the version stamp moves. An edited row keeps packModified so it
      // stays recognisable as a local variant rather than quietly becoming pack-owned again.
      await model.update({ where: { id: r.id }, data: { packVersion: pack.version } });
    }
  }

  // Rows the new version dropped, under the uninstall rules.
  let removed = 0, retired = 0, kept = 0;
  for (const g of plan.gone) {
    const model = (prisma as any)[g.model];
    if (g.outcome === "remove") { await model.delete({ where: { id: g.id } }); removed++; }
    else if (g.outcome === "retire") { await model.update({ where: { id: g.id }, data: { retired: true } }); retired++; }
    else { await model.update({ where: { id: g.id }, data: { packKey: null, packVersion: null, packModified: false } }); kept++; }
  }

  const skip = new Set(plan.rows.filter(r => r.outcome === "yours").map(r => r.key));
  const unresolved = await wireReferences(pack, skip);

  return { added, updated, revived, yours: plan.totals.yours, removed, retired, kept, unresolved };
}

/**
 * Which pack each installed country came from, for the Country Rules rows.
 *
 * The version is the one most of the live rows agree on, not whichever row happened to be read last.
 * Rows retired by an upgrade keep the version that last contained them — correctly, since a withdrawn
 * row is not part of the new version — so a last-wins read could report the old version after a
 * perfectly good upgrade. Where live rows genuinely disagree, `mixed` says so instead of picking one
 * and looking confident about it.
 */
export async function installedPacks(): Promise<Record<string, { version: string; rows: number; edited: number; mixed: boolean }>> {
  const acc: Record<string, { rows: number; edited: number; versions: Record<string, number> }> = {};
  for (const kind of KINDS) {
    const rows = await (prisma as any)[kind.model].findMany({
      where: { packKey: { not: null } },
      select: { country: true, packVersion: true, packModified: true, retired: true },
    });
    for (const r of rows) {
      const c = r.country ?? "";
      if (!c) continue;
      acc[c] ??= { rows: 0, edited: 0, versions: {} };
      acc[c].rows++;
      if (r.packModified) acc[c].edited++;
      if (r.packVersion && !r.retired) acc[c].versions[r.packVersion] = (acc[c].versions[r.packVersion] ?? 0) + 1;
    }
  }

  const out: Record<string, { version: string; rows: number; edited: number; mixed: boolean }> = {};
  for (const [c, a] of Object.entries(acc)) {
    const ranked = Object.entries(a.versions).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? 1 : -1));
    out[c] = { version: ranked[0]?.[0] ?? "", rows: a.rows, edited: a.edited, mixed: ranked.length > 1 };
  }
  return out;
}
