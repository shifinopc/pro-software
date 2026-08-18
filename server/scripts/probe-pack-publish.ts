/**
 * Throwaway check for the publish → notice → apply chain.
 *
 * The question this answers is the one the owner actually asked: when I change something for a
 * country in future, does it reach a running installation and can the user apply it there?
 *
 *   1. upload a NEW version through the API           (how it reaches the server at all)
 *   2. it appears in the list and in /packs/updates   (how anyone finds out)
 *   3. upgrading applies it                            (how it takes effect)
 *
 * Run against a COPY of the real database. Restores the packs folder afterwards.
 *
 * That sentence used to be the only thing standing between this probe and the working database, and
 * it did not hold: run against dev on 18 August it installed the whole Saudi pack — seventeen
 * workflow templates into an installation deliberately kept at one, a pipeline stage, and pack
 * provenance stamped onto fourteen rows the firm had made by hand — and then reported PASS. It reads
 * as a test and behaves as an install. The guard below is now what enforces the header.
 */
import { prisma } from "../src/db.js";
import { readPack, savePack, listPacks, applyInstall, planUpgrade, applyUpgrade, installedPacks, PACKS_DIR } from "../src/packs.js";
import { newestPackFile } from "./_pickpack.js";
import { requireScratchDatabase } from "./_scratch-guard.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await requireScratchDatabase("This probe", "copy");
  const NEW_FILE = join(PACKS_DIR, "pack-sa-2026.9.json");

  try {
    // Install the current version so there is something to update FROM.
    const v1 = readPack(newestPackFile());
    await applyInstall(v1, { adopt: true });
    const inst0 = (await installedPacks())["SA"];
    console.log(`installed: SA ${inst0?.version} · ${inst0?.rows} rows`);

    // ── 1. publish a new version, the way the console does ──
    const v2: any = JSON.parse(JSON.stringify(v1));
    v2.version = "2026.9";
    v2.documentTypes[0].defaultFee = (v2.documentTypes[0].defaultFee ?? 0) + 75;
    const saved = savePack(v2);
    console.log(`\npublished: ${saved.file} (${saved.replaced ? "replaced" : "new"})`);
    if (!existsSync(NEW_FILE)) fail("the uploaded pack was not written to the packs folder");

    // ── it must be refused if it is not a pack ──
    for (const [label, junk] of [
      ["a random object", { hello: "world" }],
      ["a pack with no country", { version: "1", documentTypes: [{ key: "a", name: "A" }] }],
      ["a file carrying client data", { country: "SA", version: "9", documentTypes: [{ key: "a", name: "A" }], employees: [{ name: "someone" }] }],
    ] as const) {
      let refused = false, why = "";
      try { savePack(junk); } catch (e: any) { refused = true; why = e.message; }
      console.log(`  refuses ${String(label).padEnd(28)} ${refused ? "YES — " + why : "NO — IT WAS ACCEPTED"}`);
      if (!refused) fail(`${label} was accepted as a country pack`);
    }

    // ── 2. it shows up as available, and as an update ──
    const listed = listPacks().some(p => p.file === saved.file);
    console.log(`\n  appears in the pack list:           ${listed ? "YES" : "NO"}`);
    if (!listed) fail("the uploaded pack is not listed");

    // Same computation the /packs/updates route runs.
    const inst = await installedPacks();
    const avail = listPacks().filter(p => !p.error);
    const newer = avail.filter(p => p.country === "SA" && String(p.version).localeCompare(inst["SA"].version, undefined, { numeric: true }) > 0);
    console.log(`  reported as an update:              ${newer.length ? inst["SA"].version + " → " + newer[0].version : "NO"}`);
    if (!newer.length) fail("a newer pack on the server is not reported as an update");

    // ── 3. applying it takes effect ──
    const plan = await planUpgrade(v2);
    console.log(`\n  upgrade plan: add ${plan.totals.add} · update ${plan.totals.update} · yours ${plan.totals.yours} · unchanged ${plan.totals.unchanged}`);
    const out = await applyUpgrade(v2);
    const after = (await installedPacks())["SA"];
    console.log(`  applied: ${out.updated} updated · ${out.yours} left as yours`);
    console.log(`  country now reports:                ${after?.version}`);
    if (after?.version !== "2026.9") fail(`after upgrading the country still reports ${after?.version}`);

    // and nothing is left to update
    const inst2 = await installedPacks();
    const still = listPacks().filter(p => !p.error && p.country === "SA" && String(p.version).localeCompare(inst2["SA"].version, undefined, { numeric: true }) > 0);
    console.log(`  updates still outstanding:          ${still.length}`);
    if (still.length) fail("it still reports an update after being applied");
  } finally {
    // Leave the packs folder exactly as it was.
    if (existsSync(NEW_FILE)) unlinkSync(NEW_FILE);
    console.log(`\npacks folder restored: ${listPacks().map(p => p.file).join(", ")}`);
  }

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
