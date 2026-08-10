/**
 * People at a company — and the one function allowed to write the company's contact columns.
 *
 * WHY A MIRROR AT ALL
 *
 * `Company.contact/email/phone` predate this module and are read in eight places, including the one
 * that provisions a portal login and the one that decides who an invoice notification goes to.
 * Dropping them would mean changing all eight in the same commit as introducing contacts, and any
 * one of them missed is a client who silently stops receiving mail.
 *
 * So they stay — as a MIRROR of whichever contact is primary, written by `syncPrimaryContact` and by
 * nothing else. That is the whole discipline: two editable copies of a phone number is the bug this
 * module exists to prevent, and a mirror is only safe while it has exactly one writer. Everything
 * that changes a contact ends by calling sync.
 *
 * WHY PRIMARY IS NOT A DATABASE CONSTRAINT
 *
 * A unique index on (companyId, isPrimary) would have to be dropped and recreated to move the flag
 * from one person to another, and would reject the intermediate state where both are set. It is held
 * here instead, in a transaction: clear, then set.
 */
import { prisma } from "./db.js";

/** Contacts that count: not archived. Oldest first, which is the order primary is inherited in. */
const live = (companyId: string) =>
  prisma.contact.findMany({
    where: { companyId, archived: false },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });

/**
 * Copy the primary contact onto the company's mirror columns.
 *
 * With no contacts left the mirror is CLEARED rather than left standing. A company whose only
 * contact has gone has nobody to write to, and a stale name there means invoices keep being
 * addressed to somebody who left — the failure is silent, which is what makes it worth preventing.
 */
export async function syncPrimaryContact(companyId: string) {
  const contacts = await live(companyId);
  const primary = contacts.find(c => c.isPrimary) ?? contacts[0] ?? null;

  // Inherit the flag when the primary was archived or deleted, so a company is never left with
  // contacts but no primary — the state where the mirror and the list disagree about who matters.
  if (primary && !primary.isPrimary) {
    await prisma.contact.update({ where: { id: primary.id }, data: { isPrimary: true } });
  }

  await prisma.company.update({
    where: { id: companyId },
    data: {
      contact: primary?.name ?? null,
      email: primary?.email ?? null,
      phone: primary?.phone ?? null,
    },
  });
  return primary;
}

/** Move the primary flag to one person. Clear then set, so the intermediate state is never stored. */
export async function setPrimaryContact(companyId: string, contactId: string) {
  const target = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!target || target.companyId !== companyId) throw new Error("No such contact for this client");
  if (target.archived) throw new Error("An archived contact cannot be the primary one");
  await prisma.$transaction([
    prisma.contact.updateMany({ where: { companyId, isPrimary: true }, data: { isPrimary: false } }),
    prisma.contact.update({ where: { id: contactId }, data: { isPrimary: true } }),
  ]);
  return syncPrimaryContact(companyId);
}

/**
 * Add a person.
 *
 * The first contact a company gets is its primary whether or not anyone said so — otherwise the
 * mirror stays empty until somebody remembers to press a button, and the company looks contactless
 * while a contact is sitting right there.
 */
export async function addContact(companyId: string, data: {
  name: string; jobTitle?: string | null; email?: string | null; phone?: string | null;
  whatsapp?: string | null; notes?: string | null; isPrimary?: boolean; userId?: string | null;
}) {
  const existing = await live(companyId);
  const first = existing.length === 0;
  const wantsPrimary = first || !!data.isPrimary;

  const created = await prisma.contact.create({
    data: {
      companyId,
      name: data.name,
      jobTitle: data.jobTitle ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      whatsapp: data.whatsapp ?? null,
      notes: data.notes ?? null,
      userId: data.userId ?? null,
      isPrimary: false, // set below through the one path that maintains the invariant
      createdAt: new Date().toISOString(),
    },
  });
  if (wantsPrimary) await setPrimaryContact(companyId, created.id);
  else await syncPrimaryContact(companyId);
  return prisma.contact.findUnique({ where: { id: created.id } });
}

/** Edit a person. `undefined` leaves a field alone; `null` clears it. */
export async function editContact(contactId: string, data: Record<string, any>) {
  const before = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!before) throw new Error("No such contact");
  const { isPrimary, companyId: _ignored, id: _id, ...rest } = data;

  await prisma.contact.update({
    where: { id: contactId },
    data: {
      name: rest.name ?? undefined,
      jobTitle: rest.jobTitle,
      email: rest.email,
      phone: rest.phone,
      whatsapp: rest.whatsapp,
      notes: rest.notes,
      userId: rest.userId,
      archived: rest.archived ?? undefined,
    },
  });
  if (isPrimary === true) await setPrimaryContact(before.companyId, contactId);
  else await syncPrimaryContact(before.companyId);
  return prisma.contact.findUnique({ where: { id: contactId } });
}

/**
 * Remove a person.
 *
 * Archived rather than deleted when they hold a portal login: the login points at a human, and
 * deleting the record that says who that human is leaves an account nobody can account for.
 */
export async function removeContact(contactId: string) {
  const c = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!c) throw new Error("No such contact");
  if (c.userId) await prisma.contact.update({ where: { id: contactId }, data: { archived: true, isPrimary: false } });
  else await prisma.contact.delete({ where: { id: contactId } });
  return syncPrimaryContact(c.companyId);
}
