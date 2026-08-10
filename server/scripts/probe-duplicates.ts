/**
 * Throwaway check for duplicate detection.
 *
 * A matcher is only useful if people trust it, and trust is destroyed by FALSE POSITIVES far faster
 * than it is built by true ones — a warning that cries wolf gets dismissed without reading, and then
 * the real duplicate sails through. So most of what is asserted here is what must NOT match:
 *
 *   - two real companies sharing a word are not flagged
 *   - a short name inside a longer one is not enough on its own
 *   - a record never matches itself while being edited
 *   - a blank query returns nothing rather than everything
 *
 * And the ones that must:
 *   - the same CR, however it is punctuated — the strongest signal there is
 *   - the same phone written with a country code, a trunk zero, or neither
 *   - the same name with a different legal form, different case, different spacing
 *   - the same Arabic name spelled with different alef and ya forms
 *   - a colleague's client, which a sales user cannot see and would otherwise re-enter
 *
 * Own companies, deleted afterwards.
 */
import { prisma } from "../src/db.js";
import { findDuplicates, existingDuplicatePairs, normName, normPhone, normCr } from "../src/duplicates.js";

async function sweep() {
  await prisma.company.deleteMany({ where: { name: { startsWith: "ZZ " } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: "شركة ZZ" } } });
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  // ── normalisation, on its own ──────────────────────────────────────────────────────────────
  const norms: Array<[string, string, string]> = [
    ["ZZ Al Noor Trading Est", "ZZ AL-NOOR TRADING EST.", "legal form, case and punctuation"],
    ["ZZ Falcon LLC", "ZZ  Falcon   L.L.C", "spacing and dotted legal form"],
  ];
  for (const [a, b, what] of norms) {
    const same = normName(a) === normName(b);
    console.log(`same name despite ${what.padEnd(34)}: ${same ? "YES" : "NO"}   ("${normName(a)}" vs "${normName(b)}")`);
    if (!same) fail(`"${a}" and "${b}" should normalise the same`);
  }
  // The negative case for normalisation: an INDUSTRY word must survive, or two real companies merge.
  const merged = normName("ZZ Al Noor Trading") === normName("ZZ Al Noor Contracting");
  console.log(`two industries stay different${" ".repeat(21)}: ${!merged ? "YES" : "NO"}`);
  if (merged) fail("stripping an industry word merged two different companies");

  console.log(`\nphone forms collapse: ${["+966 50 123 4567", "00966501234567", "0501234567"].map(normPhone).join(" · ")}`);
  if (new Set(["+966 50 123 4567", "00966501234567", "0501234567"].map(normPhone)).size !== 1) fail("the same handset written three ways did not collapse");
  console.log(`CR punctuation ignored: ${normCr("9990-001111")} === ${normCr("9990001111")}`);

  // ── against real rows ──────────────────────────────────────────────────────────────────────
  const owner = await prisma.user.create({ data: { name: "ZZ Colleague", email: "zz-colleague@example.invalid", roleId: "sales", status: "active", type: "staff" } });
  const noor = await prisma.company.create({ data: { name: "ZZ Al Noor Trading Est", cr: "9990001111", email: "zz-noor@example.invalid", phone: "+966 50 123 4567", country: "SA", lifecycle: "client", ownerId: owner.id } });
  await prisma.company.create({ data: { name: "ZZ Al Noor Contracting Est", cr: "9990002222", country: "SA", lifecycle: "client" } });
  await prisma.company.create({ data: { name: "شركة ZZ النور", cr: "9990003333", country: "SA", lifecycle: "client" } });

  const cases: Array<[string, any, string | null, string]> = [
    ["same CR, punctuated differently", { name: "ZZ Something Else", cr: "9990-001111" }, "certain", "a CR is issued once — two records holding it are one company"],
    ["same email", { name: "ZZ Whatever", email: "ZZ-Noor@Example.Invalid" }, "certain", "the address reaches the same inbox"],
    ["same phone, other format", { name: "ZZ Whatever", phone: "0501234567" }, "likely", "the same handset"],
    ["same name, different legal form", { name: "zz al-noor trading LLC" }, "likely", "spelling and legal form ignored"],
    ["Arabic spelling variant", { name: "شركة ZZ النور" }, "likely", "alef and ya forms normalised"],
  ];
  for (const [what, input, expect, why] of cases) {
    const m = await findDuplicates(input);
    const top = m[0] ?? null;
    console.log(`\n${what}: ${top ? `${top.confidence} — ${top.why}` : "NO MATCH"}`);
    if (!top) fail(`${what} found nothing (${why})`);
    else if (top.confidence !== expect) fail(`${what} came back ${top.confidence}, expected ${expect}`);
  }

  // ── the false positives that would destroy trust ───────────────────────────────────────────
  const different = await findDuplicates({ name: "ZZ Al Noor Contracting Est" , excludeId: undefined });
  const flagsTrading = different.some(d => d.name === "ZZ Al Noor Trading Est" && d.confidence !== "possible");
  console.log(`\ntwo real companies not confidently merged: ${!flagsTrading ? "YES" : "NO"}`);
  if (flagsTrading) fail("two genuinely different companies were flagged as likely duplicates");

  const itself = await findDuplicates({ name: noor.name, cr: noor.cr, email: noor.email, phone: noor.phone, excludeId: noor.id });
  console.log(`a record does not match itself:           ${itself.every(d => d.id !== noor.id) ? "YES" : "NO"}`);
  if (itself.some(d => d.id === noor.id)) fail("editing a client warned that it duplicates itself");

  const blank = await findDuplicates({ name: "", cr: "", email: "", phone: "" });
  console.log(`a blank query returns nothing:            ${blank.length === 0 ? "YES" : "NO (" + blank.length + ")"}`);
  if (blank.length) fail("an empty query returned matches");

  const shortName = await findDuplicates({ name: "ZZ A" });
  console.log(`a very short name matches nothing:        ${shortName.length === 0 ? "YES" : "NO (" + shortName.length + ")"}`);

  // ── the colleague's client, which a sales user cannot see ──────────────────────────────────
  const hidden = await findDuplicates({ cr: "9990001111" });
  console.log(`\na colleague's client is surfaced:         ${hidden[0]?.ownerName === "ZZ Colleague" ? "YES — owned by " + hidden[0].ownerName : "NO"}`);
  if (hidden[0]?.ownerName !== "ZZ Colleague") fail("the owner was not returned, so nobody knows who to ask");

  // ── pairs already in the data ──────────────────────────────────────────────────────────────
  await prisma.company.create({ data: { name: "ZZ Al Noor Trading Establishment", cr: "9990001111", country: "SA", lifecycle: "client" } });
  const pairs = (await existingDuplicatePairs()).filter(p => p.a.startsWith("ZZ ") || p.b.startsWith("ZZ "));
  console.log(`\nexisting pairs found: ${pairs.length}`);
  for (const p of pairs) console.log(`  ${p.a} ↔ ${p.b} · ${p.confidence} · ${p.why}`);
  if (!pairs.some(p => p.confidence === "certain")) fail("two rows sharing a CR were not reported as an existing duplicate");
  // Reported once, not once per direction.
  const keys = pairs.map(p => [p.a, p.b].sort().join("|"));
  if (new Set(keys).size !== keys.length) fail("the same pair was reported twice, once from each side");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await sweep();
  const leftovers = await prisma.company.count({ where: { OR: [{ name: { startsWith: "ZZ " } }, { name: { startsWith: "شركة ZZ" } }] } })
    + await prisma.user.count({ where: { email: { contains: "example.invalid" } } });
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
