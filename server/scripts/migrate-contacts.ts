/**
 * One-off, idempotent: turn each client's three contact columns into a Contact record.
 *
 * `Company.contact/email/phone` held one unnamed-role person per client. Those values are real data
 * — they are who the firm actually calls — so they are moved INTO the new table rather than left
 * behind for someone to retype. After this runs the columns keep the same values, but as a mirror
 * of the row that now owns them (see contacts.ts).
 *
 * Safe to run twice: a company that already has a contact is skipped, not duplicated.
 *
 *   pnpm tsx scripts/migrate-contacts.ts          # report only
 *   pnpm tsx scripts/migrate-contacts.ts --apply
 */
import { prisma } from "../src/db.js";
import { syncPrimaryContact } from "../src/contacts.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const companies = await prisma.company.findMany({
    select: { id: true, name: true, contact: true, email: true, phone: true, lifecycle: true },
    orderBy: { name: "asc" },
  });

  const existing = await prisma.contact.groupBy({ by: ["companyId"], _count: { _all: true } });
  const hasContacts = new Set(existing.map(e => e.companyId));

  const toCreate = companies.filter(c => !hasContacts.has(c.id) && (c.contact || c.email || c.phone));
  const noDetails = companies.filter(c => !hasContacts.has(c.id) && !c.contact && !c.email && !c.phone);
  const notClient = companies.filter(c => c.lifecycle !== "client");

  console.log(`companies: ${companies.length}`);
  console.log(`  already have a contact: ${hasContacts.size}`);
  console.log(`  contact details to migrate: ${toCreate.length}`);
  console.log(`  no contact details at all: ${noDetails.length}`);
  console.log(`  lifecycle not 'client': ${notClient.length}${notClient.length ? " — " + notClient.map(c => `${c.name}=${c.lifecycle}`).join(", ") : ""}`);

  for (const c of toCreate) {
    console.log(`  ${APPLY ? "→" : "would"} ${c.name}: ${c.contact ?? "(no name)"} · ${c.email ?? "—"} · ${c.phone ?? "—"}`);
    if (!APPLY) continue;
    await prisma.contact.create({
      data: {
        companyId: c.id,
        // A contact row with no name is worse than none — it renders as a blank line in every
        // picker. The company name is the honest stand-in until somebody types the real one.
        name: c.contact?.trim() || c.name,
        email: c.email ?? null,
        phone: c.phone ?? null,
        isPrimary: true,
        createdAt: new Date().toISOString(),
      },
    });
    await syncPrimaryContact(c.id);
  }

  // Existing rows are all real clients — the column defaults to 'client', so this only ever repairs
  // a row that was written before the default existed.
  if (APPLY) {
    const fixed = await prisma.company.updateMany({ where: { lifecycle: "" }, data: { lifecycle: "client" } });
    if (fixed.count) console.log(`repaired ${fixed.count} blank lifecycle value(s)`);
  }

  console.log(APPLY ? "\napplied." : "\nnothing written — re-run with --apply");
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
