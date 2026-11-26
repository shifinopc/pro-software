/**
 * A RENAMED PRODUCT, EVERYWHERE IT IS NAMED.
 *
 * `Product` is a configuration row; `Company.service` is the FREE TEXT that the lead form's Product
 * field writes — "pick as many as apply, or type your own" — stored as a comma-separated list of
 * names. Two stores of one fact, which is the shape the type-your-own contract forces: an id cannot
 * express "something the catalogue has never heard of", and that case is the field's whole reason
 * for being lenient.
 *
 * Measured: renaming the product "Company Formation" to "Business Setup" left 55 clients still
 * saying the old name, and so did the Clients list, the Leads list and the product filter built
 * from those values. The rename looked like it had worked because the one screen showing the
 * configuration row had changed.
 *
 * So a rename carries. Not a blind string replace: two of those 55 carried a LIST ("Auditing,
 * Company Formation"), and the other entries have to survive untouched and keep their order. The
 * token is matched whole and case-insensitively, the rest is left exactly as typed, and a client
 * that somehow named both old and new keeps one of them rather than gaining a duplicate.
 *
 * NOT DONE on a delete or a retire. Those say "stop offering this", not "this was never what we
 * sold" — the clients who bought it still did, and rewriting their record would erase that.
 */
import { prisma } from "./db.js";

export async function renameProductEverywhere(from: string, to: string): Promise<number> {
  const was = String(from ?? "").trim();
  const now = String(to ?? "").trim();
  if (!was || !now || was.toLowerCase() === now.toLowerCase()) return 0;

  // `contains` is the coarse filter the database can do; the token check below is what decides.
  // Without the fine check, renaming "VAT" would rewrite "VAT Registration" too.
  const rows = await prisma.company.findMany({
    where: { service: { contains: was } },
    select: { id: true, service: true },
  });

  let changed = 0;
  for (const row of rows) {
    const parts = String(row.service ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const out: string[] = [];
    for (const p of parts) {
      const v = p.toLowerCase() === was.toLowerCase() ? now : p;
      if (!out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
    const next = out.join(", ");
    if (next === row.service) continue;
    await prisma.company.update({ where: { id: row.id }, data: { service: next } });
    changed++;
  }
  return changed;
}
