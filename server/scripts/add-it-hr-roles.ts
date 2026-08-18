/**
 * Two roles the app did not have: IT and HR.
 *
 * Onboarding assigned "System Access" and "Assets & Accommodation" to pro_officer because those were
 * the only roles that existed. Neither is PRO work — a PRO officer deals with government, not with
 * mailbox accounts and desks — and one person owning both is how a joiner arrives to no laptop and
 * nobody accountable for it.
 *
 * Created on the BASE role whose defaults are closest, so nothing has to be ticked cell by cell:
 * permissions.ts resolves an unset cell through `base`. HR then gets one deliberate departure —
 * Approve on Approvals — because HR owning the hiring approval is the whole point of the role, and
 * PRO Officer's preset does not include it.
 *
 * The grid is MERGED, never replaced. Writing this key set wholesale would silently drop every
 * toggle an admin has set on every other role.
 *
 * Idempotent.
 */
import { prisma } from "../src/db.js";

const ROLES = [
  { id: "it_officer", label: "IT Officer", base: "PRO Officer", color: "#0284C7",
    desc: "Accounts, devices and access — not government work" },
  { id: "hr_officer", label: "HR Officer", base: "PRO Officer", color: "#0E9355",
    desc: "Hiring, joining and probation" },
];
/** HR owns the hiring approval, which the PRO Officer preset does not grant. */
const EXTRA_GRANTS: Record<string, string[]> = { "HR Officer": ["Approvals|Approve"] };

async function main() {
  const row = await prisma.appSetting.findUnique({ where: { key: "roles" } });
  const existing: any[] = Array.isArray(row?.value) ? (row!.value as any[]) : [];
  const kept = existing.filter(r => !ROLES.some(n => n.id === r.id));
  const next = [...kept, ...ROLES];
  await prisma.appSetting.upsert({ where: { key: "roles" }, create: { key: "roles", value: next as any }, update: { value: next as any } });
  console.log(`roles: ${next.map(r => r.label ?? r.name).join(", ")}`);

  const permRow = await prisma.appSetting.findUnique({ where: { key: "perms" } });
  const grid: Record<string, boolean> = (permRow?.value && typeof permRow.value === "object" && !Array.isArray(permRow.value))
    ? { ...(permRow.value as any) } : {};
  const before = Object.keys(grid).length;
  for (const [label, cells] of Object.entries(EXTRA_GRANTS)) for (const c of cells) grid[`${label}|${c}`] = true;
  await prisma.appSetting.upsert({ where: { key: "perms" }, create: { key: "perms", value: grid as any }, update: { value: grid as any } });
  console.log(`perms grid: ${before} stored toggles -> ${Object.keys(grid).length} (merged, nothing replaced)`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
