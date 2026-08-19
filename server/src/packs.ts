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

/**
 * The packs the IMAGE was built with, which is a different thing from the packs this server has.
 *
 * PACKS_DIR is a docker volume so that a pack uploaded on Tuesday still exists on Wednesday. But a
 * named volume is seeded from the image exactly once, when it is created, and shadows the image
 * forever after. That cost a real correction: the Saudi pack shipped in August carried five UAE
 * document types under sa.doctype.* keys, the repaired pack went out in the image five days later,
 * and the server went on offering the broken one because the volume still held it. Nothing failed
 * and nothing was logged — the fix simply never arrived, which is not visible from the console.
 *
 * So the image keeps its own read-only copy where the volume cannot cover it, and both are listed.
 * A name present in both wins from the volume: an upload is a deliberate act by somebody here and
 * must not be silently reverted by the next redeploy.
 */
export const PACKS_BUILTIN_DIR = (() => {
  if (process.env.PACKS_BUILTIN_DIR) return resolve(process.env.PACKS_BUILTIN_DIR);
  const candidates = [resolve(process.cwd(), "packs-builtin"), resolve(process.cwd(), "..", "packs-builtin")];
  return candidates.find(existsSync) ?? candidates[0];
})();

/** Where a pack file may be read from, most authoritative first. */
function packDirs(): string[] {
  return [PACKS_DIR, PACKS_BUILTIN_DIR].filter((d, i, a) => a.indexOf(d) === i && existsSync(d));
}

export type PackRow = { key: string; name: string; [k: string]: any };
export type Pack = {
  pack: string; country: string; countryName: string; version: string;
  generatedAt?: string; contains?: string;
  documentTypes?: PackRow[]; govCenters?: PackRow[]; checklistRules?: PackRow[]; fieldSets?: PackRow[];
  workflowTemplates?: PackRow[]; serviceItems?: PackRow[]; packages?: PackRow[]; workforceBands?: PackRow[];
  pipelineStages?: PackRow[]; leadSources?: PackRow[]; lostReasons?: PackRow[]; courierJobTypes?: PackRow[];
  appointmentTypes?: PackRow[]; courierStatuses?: PackRow[]; appointmentStatuses?: PackRow[];
  competitors?: PackRow[]; industries?: PackRow[]; campaigns?: PackRow[]; cancelReasons?: PackRow[];
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
    fields: (r: any) => ({ name: r.name, subjectKind: r.subjectKind, defaultFee: r.defaultFee, leadDays: r.leadDays, neverExpires: r.neverExpires, statutoryDays: r.statutoryDays, statutoryFrom: r.statutoryFrom, statutoryBasis: r.statutoryBasis, authority: r.authority, fields: r.fields, prereqs: r.prereqs, requiresApproval: r.requiresApproval, defaultAssigneeRole: r.defaultAssigneeRole }) },
  { key: "govCenters", model: "govCenter", label: "authorities", one: "authority",
    fields: (r: any) => ({ name: r.name, sub: r.sub, color: r.color, bg: r.bg }) },
  { key: "checklistRules", model: "checklistRule", label: "checklist rules", one: "checklist rule",
    fields: (r: any) => ({ name: r.name, rows: r.rows }) },
  // What a step RECORDS, alongside what it collects. Same shape, same reason for travelling: a
  // market's intake questions belong to the market, not to whoever last edited the graph.
  { key: "fieldSets", model: "fieldSet", label: "field sets", one: "field set",
    fields: (r: any) => ({ name: r.name, rows: r.rows, rules: r.rules }) },
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
  // What a market's courier runs are CALLED is part of that market, so the names travel with it
  // rather than being retyped per installation — the same argument the stages and the loss reasons make.
  { key: "courierJobTypes", model: "courierJobType", label: "courier job types", one: "courier job type",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort }) },
  { key: "appointmentTypes", model: "appointmentType", label: "appointment types", one: "appointment type",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort, icon: r.icon }) },
  // The status ladders travel too, because what a market calls the states of a run is part of how
  // that market works — a pack that ships the documents and the job types but not the ladder leaves
  // the receiving installation reading its own board in somebody else's words.
  { key: "courierStatuses", model: "courierStatus", label: "courier statuses", one: "courier status",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort, terminal: r.terminal, offLadder: r.offLadder }) },
  { key: "appointmentStatuses", model: "appointmentStatus", label: "appointment statuses", one: "appointment status",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort, terminal: r.terminal, offLadder: r.offLadder }) },
  { key: "leadSources", model: "leadSource", label: "lead sources", one: "lead source",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort }) },
  // The rest of the market's CRM vocabulary. These never travelled at all until now — a pack could
  // carry a country's authorities and workflows and still land somewhere that had never heard of its
  // competitors. Declared here as well as written by the exporter, because the installer walks THIS
  // list: a section in the file that is not named here is read and thrown away.
  { key: "competitors", model: "competitor", label: "competitors", one: "competitor",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort }) },
  { key: "industries", model: "industry", label: "industries", one: "industry",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort }) },
  { key: "campaigns", model: "campaign", label: "campaigns", one: "campaign",
    fields: (r: any) => ({ name: r.name, color: r.color, bg: r.bg, sort: r.sort }) },
  { key: "cancelReasons", model: "cancelReason", label: "cancellation reasons", one: "cancellation reason",
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
  const seen = new Set<string>();
  const out: { file: string; country: string; countryName: string; version: string; error?: string }[] = [];
  for (const dir of packDirs()) {
    for (const file of readdirSync(dir).filter(f => f.toLowerCase().endsWith(".json"))) {
      if (seen.has(file)) continue;   // the volume's copy was already listed
      seen.add(file);
      try {
        const p = JSON.parse(readFileSync(join(dir, file), "utf8"));
        out.push({ file, country: p.country, countryName: p.countryName ?? p.country, version: p.version });
      } catch (e: any) {
        // A malformed file is listed with its problem rather than hidden — a pack that silently
        // vanishes from the list is harder to diagnose than one that says it cannot be read.
        out.push({ file, country: "", countryName: file, version: "", error: String(e?.message ?? e) });
      }
    }
  }
  return out;
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
  for (const dir of packDirs()) {
    const full = join(dir, safe);
    if (existsSync(full)) return JSON.parse(readFileSync(full, "utf8"));
  }
  throw new Error(`No pack named ${safe} on this server`);
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
/**
 * Take a country off the Country Rules screen.
 *
 * The exact inverse of registerCountryRow, and it was missing — so Install added a row and Uninstall
 * left it there. A market with nothing configured went on being listed as Active, with Configure and
 * Export buttons leading to nothing, and no way to remove it from the screen it was added to.
 *
 * Only ever REMOVES, and only by name, so a country somebody added by hand is untouched unless it is
 * the one being forgotten.
 */
export async function forgetCountryRow(country: string) {
  const code = String(country || "").toUpperCase();
  if (!code) return;
  const row = await prisma.appSetting.findUnique({ where: { key: "countryRules" } });
  const value: any = (row?.value && typeof row.value === "object") ? row.value : {};
  const list: any[] = Array.isArray(value.countries) ? value.countries : [];
  if (!list.length) return;
  const name = countryName(code).trim().toLowerCase();
  const next = list.filter(c => !(Array.isArray(c) && String(c[0]).trim().toLowerCase() === name));
  if (next.length === list.length) return;
  await prisma.appSetting.update({ where: { key: "countryRules" }, data: { value: { ...value, countries: next } } });
}

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
      if (!c?.checklistRuleKey && !c?.captureRuleKey) { next.push(n); continue; }
      touched = true;
      // Both references are resolved in one pass. Written as a loop rather than a second copy of
      // the block because the copy is where the two would drift — a third reference added later
      // gets carried by the same code or not at all.
      const { checklistRuleKey, captureRuleKey, ...rest } = c;
      const cfg: any = { ...rest };
      for (const [key, model, prop] of [
        [checklistRuleKey, "checklistRule", "checklistRuleId"],
        [captureRuleKey, "fieldSet", "captureRuleId"],
      ] as const) {
        if (!key) continue;
        const id = await idFor(model, key);
        if (!id) { unresolved.push(`workflow "${t.name}" step "${n.label ?? n.id}" → ${key}`); continue; }
        cfg[prop] = id;
      }
      next.push({ ...n, config: cfg });
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
      } else if (kind.model === "checklistRule" || kind.model === "fieldSet") {
        // Referenced from inside workflow graphs, so it has to be looked for there — and only in the
        // templates that will still be here afterwards.
        const prop = kind.model === "checklistRule" ? "checklistRuleId" : "captureRuleId";
        const tpls = await prisma.workflowTemplate.findMany({ select: { id: true, graph: true } });
        const used = tpls.filter(t => {
          if (!survives("workflowTemplate", t.id)) return false;
          const nodes: any[] = Array.isArray((t.graph as any)?.nodes) ? (t.graph as any).nodes : [];
          return nodes.some(n => n?.config?.[prop] === row.id);
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
  // Off the screen only when there is genuinely nothing left. Rows that were kept (yours) or retired
  // (something depends on them) are still this country's configuration, and a market with
  // configuration belongs on the list.
  let left = 0;
  for (const kind of KINDS) left += await (prisma as any)[kind.model].count({ where: { country } });
  if (left === 0) await forgetCountryRow(country);

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
  outcome: "add" | "adopt" | "update" | "unchanged" | "yours" | "revive";
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

    // ROWS THIS INSTALLATION MADE BY HAND, loaded SEPARATELY and deliberately kept out of `local`.
    //
    // They are candidates for adoption and nothing else. `dropped` below is every row in `local`
    // whose key the new pack no longer carries — so widening that query to include unstamped rows
    // would classify every hand-made row as withdrawn and hand it to planRemoval, which deletes what
    // nothing depends on. An upgrade would quietly destroy the configuration somebody built.
    const unstamped = await (prisma as any)[kind.model].findMany({ where: { country, packKey: null } });
    const localByName = new Map<string, any>(unstamped.map((r: any) => [String(r.name).trim().toLowerCase(), r]));

    // ROWS FROM BEFORE CONFIGURATION HAD A COUNTRY.
    //
    // Early packs installed rows with no country at all. `local` above is scoped to this country, so
    // those rows are invisible to the planner and every one of them gets planned as an ADD — which,
    // on a table whose name is not unique, quietly creates a SECOND copy rather than failing. That is
    // where the duplicate Muqeem, GOSI, MHRSD and Qiwa on the live installation came from.
    //
    // Matched on packKey ONLY, and only for keys this pack actually carries: a packKey is already
    // country-prefixed (`sa.center.gosi`), so it identifies the row unambiguously where the null
    // country cannot. Deliberately NOT added to `local`, so they can never reach `dropped` — an
    // unmarked row belonging to some other market must not be removed by this country's upgrade.
    const legacy = await (prisma as any)[kind.model].findMany({ where: { country: null, packKey: { in: [...byKey.keys()] } } });
    for (const r of legacy) if (!localByKey.has(r.packKey)) localByKey.set(r.packKey, { ...r, __adoptCountry: true });

    for (const r of local) if (r.packVersion) from = r.packVersion;

    for (const r of packRows) {
      const cur = localByKey.get(r.key);
      const base = { model: kind.model, one: kind.one, label: kind.label, key: r.key, name: r.name };

      if (!cur) {
        // A pack row whose key is not installed, but whose NAME is already here on a row somebody
        // made by hand. Creating it is what the code used to do, and `name` is globally unique, so
        // the upgrade died on a raw Prisma constraint error partway through — after earlier rows had
        // already been written. Real case: Qiwa Employment Contract and GOSI Employee Registration
        // were built by the onboarding script, then exported into the pack with keys derived from
        // their names, so re-installing that same pack could not recognise its own rows.
        //
        // Adopting matches what planInstall has always done for the same situation.
        const mine = localByName.get(String(r.name).trim().toLowerCase());
        if (mine) { rows.push({ ...base, id: mine.id, outcome: "adopt", changes: [] }); continue; }
        rows.push({ ...base, outcome: "add", changes: [] });
        continue;
      }

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
  const totals: any = { add: 0, adopt: 0, update: 0, unchanged: 0, yours: 0, revive: 0, ...gonePlan.totals };
  for (const r of rows) totals[r.outcome]++;

  return { country, countryName: pack.countryName ?? country, from, to: pack.version, rows, gone: gonePlan.rows, totals };
}

/** Translate a pack graph's checklist keys into the ids they resolve to here, for comparison. */
async function resolveGraph(graph: any): Promise<any> {
  const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const next: any[] = [];
  for (const n of nodes) {
    const c = n?.config;
    if (!c?.checklistRuleKey && !c?.captureRuleKey) { next.push(n); continue; }
    const { checklistRuleKey, captureRuleKey, ...rest } = c;
    const cfg: any = { ...rest };
    if (checklistRuleKey) {
      const id = await idFor("checklistRule", checklistRuleKey);
      if (id) cfg.checklistRuleId = id;
    }
    if (captureRuleKey) {
      const id = await idFor("fieldSet", captureRuleKey);
      if (id) cfg.captureRuleId = id;
    }
    next.push({ ...n, config: cfg });
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
export async function applyUpgrade(pack: Pack): Promise<{ added: number; adopted: number; updated: number; revived: number; yours: number; removed: number; retired: number; kept: number; unresolved: string[] }> {
  const plan = await planUpgrade(pack);
  const country = pack.country;
  const byKind = new Map<string, (typeof KINDS)[number]>(KINDS.map(k => [k.model as string, k]));
  let added = 0, updated = 0, revived = 0, adopted = 0;

  for (const r of plan.rows) {
    const kind = byKind.get(r.model)!;
    const model = (prisma as any)[kind.model];
    const src = ((pack as any)[kind.key] as PackRow[]).find(x => x.key === r.key)!;

    if (r.outcome === "add") {
      await model.create({ data: { ...kind.fields(src as any), country, packKey: r.key, packVersion: pack.version, packModified: false } });
      added++;
    } else if (r.outcome === "adopt") {
      // Provenance only. The row keeps the values somebody set here and is marked as a local variant,
      // so this upgrade does not overwrite their work and the next one offers a diff instead.
      await model.update({ where: { id: r.id }, data: { packKey: r.key, packVersion: pack.version, packModified: true } });
      adopted++;
    } else if (r.outcome === "update") {
      // `country` is written here rather than left alone so a row installed before configuration had
      // a country stops being invisible to the next upgrade. Setting it is what makes the fix stick.
      await model.update({ where: { id: r.id }, data: { ...kind.fields(src as any), country, packVersion: pack.version } });
      updated++;
    } else if (r.outcome === "revive") {
      await model.update({ where: { id: r.id }, data: { ...kind.fields(src as any), retired: false, packVersion: pack.version } });
      revived++;
    } else {
      // unchanged and yours: only the version stamp moves, and the country if it was never set. An
      // edited row keeps packModified so it stays recognisable as a local variant rather than quietly
      // becoming pack-owned again.
      await model.update({ where: { id: r.id }, data: { country, packVersion: pack.version } });
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

  return { added, adopted, updated, revived, yours: plan.totals.yours, removed, retired, kept, unresolved };
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

/** `Commercial Register Renewal` → `commercial-register-renewal`. Deterministic, so re-exporting the
 *  same configuration produces the same keys and an import can recognise what it already has. */
const packSlug = (s: string) =>
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
const packSuspect = (name: string) => {
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

/**
 * BUILD A COUNTRY PACK FROM THIS INSTALLATION.
 *
 * Lifted out of scripts/export-country-pack.ts so the command line and the Export button in the
 * console run the same code. Two builders would be two answers to "what is in a pack", and the one
 * nobody runs is the one that quietly stops matching the installer.
 *
 * Read-only: it queries and returns. It writes no file and touches no row. The caller decides what
 * to do with the result, and whether an empty section is fatal.
 */
export type PackBuild = {
  pack: any;
  /** Rows deliberately left out, and why. */
  dropped: string[];
  /** References that could not be turned into a key, removed rather than left dead. */
  unresolved: string[];
  /** Keys kept or re-derived, with the reason. */
  rekeyed: string[];
  /** Names that resolve on THIS database only because it holds every country. */
  dangling: string[];
  /** Kinds the installer expects for which this country has nothing. */
  empty: string[];
};

export async function buildPack(
  countryRaw: string,
  opts: { version?: string; exclude?: string[]; clean?: boolean } = {},
): Promise<PackBuild> {
  const country = String(countryRaw || "").toUpperCase();
  const version = opts.version || new Date().toISOString().slice(0, 7).replace("-", ".");
  const exclude = (opts.exclude ?? []).map(s => s.trim().toLowerCase()).filter(Boolean);
  const excluded = (name: string) => exclude.some(e => String(name ?? "").toLowerCase().includes(e));
  const clean = opts.clean === true;
  const p = country.toLowerCase();

  const where = { country, retired: false };
  const [docTypes, templates, services, centers, packages, checklists, fieldSets, bands, stages, sources, reasons,
         courierTypes, apptTypes, courierStatuses, apptStatuses, competitors, industries, campaigns, cancelReasons] = await Promise.all([
    prisma.documentType.findMany({ where }),
    prisma.workflowTemplate.findMany({ where }),
    prisma.serviceItem.findMany({ where }),
    prisma.govCenter.findMany({ where }),
    prisma.package.findMany({ where }),
    prisma.checklistRule.findMany({ where }),
    prisma.fieldSet.findMany({ where }),
    prisma.workforceBand.findMany({ where }),
    prisma.pipelineStage.findMany({ where }),
    prisma.leadSource.findMany({ where }),
    prisma.lostReason.findMany({ where }),
    prisma.courierJobType.findMany({ where }),
    prisma.appointmentType.findMany({ where }),
    prisma.courierStatus.findMany({ where }),
    prisma.appointmentStatus.findMany({ where }),
    prisma.competitor.findMany({ where }),
    prisma.industry.findMany({ where }),
    prisma.campaign.findMany({ where }),
    prisma.cancelReason.findMany({ where }),
  ]);

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
      if (clean && packSuspect(r.name)) { dropped.push(`${kind}: ${r.name}  (--clean)`); return false; }
      return true;
    });

  const kDocTypes  = keep(docTypes,  "document type");
  const kTemplates = keep(templates, "workflow");
  const kServices  = keep(services,  "service");
  const kCenters   = keep(centers,   "authority");
  const kPackages  = keep(packages,  "package");
  const kChecklists= keep(checklists,"checklist rule");
  const kFieldSets = keep(fieldSets, "field set");
  const kBands     = keep(bands,     "workforce band");
  const kStages    = keep(stages,    "pipeline stage");
  const kSources   = keep(sources,   "lead source");
  const kReasons   = keep(reasons,   "loss reason");
  const kCourTypes = keep(courierTypes,   "courier job type");
  const kApptTypes = keep(apptTypes,      "appointment type");
  const kCourStat  = keep(courierStatuses,"courier status");
  const kApptStat  = keep(apptStatuses,   "appointment status");
  const kCompets   = keep(competitors,    "competitor");
  const kIndustries= keep(industries,     "industry");
  const kCampaigns = keep(campaigns,      "campaign");
  const kCancels   = keep(cancelReasons,  "cancellation reason");

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
    const derived = `${p}.${seg}.${packSlug(row.name)}`;
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
  const fsKey  = new Map(kFieldSets.map(f => [f.id, keyOf(f, "fieldset")]));

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
        if (!c || typeof c !== "object" || (!c.checklistRuleId && !c.captureRuleId)) return n;
        const { checklistRuleId, captureRuleId, ...rest } = c;
        const cfg: any = { ...rest };
        // An id is meaningless on another installation, so it is either translated to a stable key
        // or dropped AND reported. Never left behind: a dead id looks like a working reference and
        // resolves to nothing at run time, which is a step that silently asks for nothing.
        for (const [id, map, keyProp, what] of [
          [checklistRuleId, chkKey, "checklistRuleKey", "checklist rule"],
          [captureRuleId, fsKey, "captureRuleKey", "field set"],
        ] as const) {
          if (!id) continue;
          const key = map.get(String(id));
          if (!key) { unresolved.push(`workflow "${tplName}" step "${n.label ?? n.id}" → ${what} ${id} (not in this country)`); continue; }
          cfg[keyProp] = key;
        }
        return { ...n, config: cfg };
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
      leadDays: d.leadDays, neverExpires: d.neverExpires, statutoryDays: d.statutoryDays, statutoryFrom: d.statutoryFrom, statutoryBasis: d.statutoryBasis,
      authority: d.authority,
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

    fieldSets: kFieldSets.map(f => ({
      key: keyOf(f, "fieldset"),
      name: f.name, rows: f.rows ?? [], rules: (f as any).rules ?? [],
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

    // ── THE LISTS THAT WERE DECLARED AND NEVER WRITTEN ───────────────────────────
    // KINDS named these and the installer accepted them, but nothing here produced them — the same
    // omission the workforce bands and the pipeline stages each had before, for the same reason:
    // adding a kind to the install side is the visible half, and the export side is easy to forget.
    // A pack shipped without them installs a market that cannot say what state a courier run is in.
    courierJobTypes: kCourTypes.map(x => ({
      key: keyOf(x, "courierjob"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
    })),
    appointmentTypes: kApptTypes.map(x => ({
      key: keyOf(x, "appttype"), name: x.name, color: x.color, bg: x.bg, sort: x.sort, icon: x.icon,
    })),
    // The two ladders carry the shape of the track as well as its wording: which rungs end a job and
    // which are exceptions rather than steps. Ship the names alone and the far end gets a board whose
    // "Cancelled" is a stage everything passes through.
    courierStatuses: kCourStat.map(x => ({
      key: keyOf(x, "courierstatus"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
      terminal: x.terminal, offLadder: x.offLadder,
    })),
    appointmentStatuses: kApptStat.map(x => ({
      key: keyOf(x, "apptstatus"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
      terminal: x.terminal, offLadder: x.offLadder,
    })),

    // Country-scoped CRM vocabulary that has never travelled at all. A market's competitors and its
    // industries are as much a fact about that market as its authorities are.
    competitors: kCompets.map(x => ({
      key: keyOf(x, "competitor"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
    })),
    industries: kIndustries.map(x => ({
      key: keyOf(x, "industry"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
    })),
    campaigns: kCampaigns.map(x => ({
      key: keyOf(x, "campaign"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
    })),
    cancelReasons: kCancels.map(x => ({
      key: keyOf(x, "cancelreason"), name: x.name, color: x.color, bg: x.bg, sort: x.sort,
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
  const elsewhere = (rows: { name: string; country: string | null; retired: boolean }[], v: string) =>
    rows.filter(r => String(r.name).trim().toLowerCase() === v.toLowerCase())
        .map(r => (r.country ?? "no country") + (r.retired ? " (retired)" : ""));

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
  // FIELD SETS ARE NOT ON THIS LIST, deliberately. Everything here is something the installer
  // expects of every market, and a country with none of it is a pack somebody built by mistake. A
  // market can perfectly well record its intake questions on the steps themselves, so demanding a
  // field set would refuse a legitimate export — and would refuse every pack built before they
  // existed.
  const empty = ([
    ["document types", pack.documentTypes], ["workflow templates", pack.workflowTemplates],
    ["services", pack.serviceItems], ["authorities", pack.govCenters],
    ["packages", pack.packages], ["checklist rules", pack.checklistRules],
    ["workforce bands", pack.workforceBands], ["pipeline stages", pack.pipelineStages],
    ["lead sources", pack.leadSources], ["loss reasons", pack.lostReasons],
  ] as const).filter(([, rows]) => !rows.length).map(([label]) => label);
  return { pack, dropped, unresolved, rekeyed, dangling, empty: empty as unknown as string[] };
}
