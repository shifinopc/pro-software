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
import { PACKS_DIR, buildPack } from "../src/packs.js";
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
  // The pack itself is built by src/packs.ts, which the Export button in the console also calls.
  // This script is now the command line around it: arguments in, a file and a report out.
  const { pack, dropped, unresolved, rekeyed, dangling, empty } =
    await buildPack(country, { version, exclude, clean });

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
