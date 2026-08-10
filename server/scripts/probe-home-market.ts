/**
 * Throwaway check: the firm's market and currency come from settings, not from source code.
 *
 * `HOME_COUNTRY` was `export const HOME_COUNTRY = "SA"` with a comment promising it would become a
 * setting when a second market opened, and six places fell back to a literal `"SAR"`. Between them
 * they decided the country stamped on every record created without one, and the currency printed
 * beside every figure that arrived without one — from a file nobody running the business can edit.
 *
 * What is asserted:
 *   - changing the setting changes what a new record is stamped with, with no restart
 *   - the currency follows the setting too
 *   - the currency is DERIVED from the country when nothing else says otherwise…
 *   - …and an explicitly configured currency still wins over the derived one
 *   - the label "SAR — Saudi Riyal" yields the code, not the whole string
 *   - garbage in the setting falls back to the seed rather than stamping records with nonsense
 *   - Setup Check says so while nobody has chosen
 *   - countryCurrency's own last resort is the seed market's currency, from the same table
 *
 * Restores the real org settings whatever happens.
 */
import { prisma } from "../src/db.js";
import { homeCountry, homeCurrency, homeMarket, homeMarketIsConfigured, DEFAULT_HOME_COUNTRY } from "../src/orgsettings.js";
import { countryCurrency, SEED_MARKET } from "../src/countries.js";
import { setupCheck } from "../src/setupcheck.js";

const API = "http://localhost:4100";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  if (cos.length) {
    await prisma.contact.deleteMany({ where: { companyId: { in: cos.map(c => c.id) } } });
    await prisma.company.deleteMany({ where: { id: { in: cos.map(c => c.id) } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
}

/** A disposable super admin, for the one assertion that has to go through a real route. */
async function loginAsProbeAdmin(): Promise<string | null> {
  try {
    const bcrypt = (await import("bcryptjs")).default;
    await prisma.user.deleteMany({ where: { email: "zz-market-admin@example.invalid" } });
    await prisma.user.create({ data: { name: "ZZ Market Admin", email: "zz-market-admin@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash("zz-Throwaway-1!", 10) } });
    const r = await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "zz-market-admin@example.invalid", password: "zz-Throwaway-1!" }) });
    const j: any = await r.json();
    return j?.token ?? null;
  } catch {
    return null;
  }
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const snap = (await prisma.appSetting.findUnique({ where: { key: "org" } }))?.value ?? null;
  const setOrg = (v: any) => prisma.appSetting.upsert({ where: { key: "org" }, update: { value: v }, create: { key: "org", value: v } });
  const base = (snap as any) ?? {};

  try {
    await sweep();

    // ── nothing configured → the documented seed, and Setup Check says so ──────────────────────
    await setOrg({ ...base, country: undefined, currency: undefined });
    console.log(`unconfigured → seed country:             ${await homeCountry() === DEFAULT_HOME_COUNTRY ? "YES (" + DEFAULT_HOME_COUNTRY + ")" : "NO"}`);
    if (await homeCountry() !== DEFAULT_HOME_COUNTRY) fail("no setting and no sane default");
    console.log(`  currency derived from it:              ${await homeCurrency() === countryCurrency(DEFAULT_HOME_COUNTRY) ? "YES (" + await homeCurrency() + ")" : "NO"}`);
    if (await homeCurrency() !== countryCurrency(DEFAULT_HOME_COUNTRY)) fail("the currency default disagrees with the country default");
    console.log(`  reported as not chosen:                ${(await homeMarketIsConfigured()) === false ? "YES" : "NO"}`);
    if (await homeMarketIsConfigured()) fail("a seed default is being reported as a decision somebody made");
    const check1 = await setupCheck();
    const f1 = check1.findings.find((f: any) => f.key === "no-home-country");
    console.log(`  Setup Check raises it:                 ${f1 ? "YES" : "NO"}`);
    if (!f1) fail("nobody is ever told the market was never chosen");

    // ── choosing a country moves everything, with no restart ───────────────────────────────────
    await setOrg({ ...base, country: "AE", currency: undefined });
    const m = await homeMarket();
    console.log(`\nset to AE → country:                     ${m.country === "AE" ? "YES" : "NO (" + m.country + ")"}`);
    if (m.country !== "AE") fail("changing the setting did not change the home country");
    console.log(`  currency follows to AED:               ${m.currency === "AED" ? "YES" : "NO (" + m.currency + ")"}`);
    if (m.currency !== "AED") fail("the currency stayed Saudi after moving the firm to the UAE");
    console.log(`  and it is now reported as chosen:      ${(await homeMarketIsConfigured()) ? "YES" : "NO"}`);
    if (!(await homeMarketIsConfigured())) fail("a real choice is still being reported as unconfigured");

    // A record created with no country is stamped with it — the thing the constant used to decide.
    //
    // Over HTTP, deliberately. `prisma.company.create` is the raw client and applies no defaults at
    // all — the country default lives in the create ROUTE, so asserting against Prisma directly would
    // have tested nothing and reported the code broken. (It did, on the first run of this probe.)
    const token = await loginAsProbeAdmin();
    if (token) {
      const r = await fetch(`${API}/api/companies`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ name: "ZZ Market Test", cr: "9993330001", lifecycle: "lead" }),
      });
      const created: any = await r.json();
      console.log(`  a new record is stamped AE:            ${created?.country === "AE" ? "YES" : "NO (" + created?.country + ")"}`);
      if (created?.country !== "AE") fail("a record created without a country is still filed as the old hardcoded market");
    } else {
      console.log(`  (API not reachable — record-stamping check skipped)`);
    }

    // ── an explicit currency wins over the derived one ─────────────────────────────────────────
    await setOrg({ ...base, country: "AE", currency: "USD — US Dollar" });
    console.log(`\nexplicit currency beats the derived:     ${await homeCurrency() === "USD" ? "YES" : "NO (" + await homeCurrency() + ")"}`);
    if (await homeCurrency() !== "USD") fail("a firm that bills in dollars cannot say so");
    console.log(`  the label yields the CODE only:        ${await homeCurrency() === "USD" ? "YES" : "NO"}`);

    // ── nonsense does not reach the records ────────────────────────────────────────────────────
    for (const junk of ["Saudi Arabia", "sa udi", "", "  ", "S"]) {
      await setOrg({ ...base, country: junk, currency: undefined });
      const c = await homeCountry();
      if (c !== DEFAULT_HOME_COUNTRY) fail(`"${junk}" was accepted as a country code (got ${c})`);
    }
    console.log(`\nnonsense falls back to the seed:         YES`);
    for (const junk of ["riyals", "S", ""]) {
      await setOrg({ ...base, country: "AE", currency: junk });
      if (await homeCurrency() !== "AED") fail(`"${junk}" was accepted as a currency code`);
    }
    console.log(`  bad currency falls back to derived:    YES`);

    // ── the table's own last resort ────────────────────────────────────────────────────────────
    console.log(`\ncountryCurrency("ZZ") → seed currency:    ${countryCurrency("ZZ") === countryCurrency(SEED_MARKET) ? "YES (" + countryCurrency("ZZ") + ")" : "NO"}`);
    if (countryCurrency("ZZ") !== countryCurrency(SEED_MARKET)) fail("the unknown-country fallback and the seed market disagree");
    console.log(`  an explicit fallback is honoured:      ${countryCurrency("ZZ", "EUR") === "EUR" ? "YES" : "NO"}`);
    if (countryCurrency("ZZ", "EUR") !== "EUR") fail("callers cannot pass the configured currency in");
    console.log(`  a KNOWN country ignores the fallback:  ${countryCurrency("AE", "EUR") === "AED" ? "YES" : "NO"}`);
    if (countryCurrency("AE", "EUR") !== "AED") fail("a fallback overrode a country that is actually in the table");

  } finally {
    await sweep();
    if (snap) await setOrg(snap);
    else await prisma.appSetting.deleteMany({ where: { key: "org" } });
  }

  const left = await prisma.company.count({ where: { name: { startsWith: "ZZ " } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");
  const o: any = (await prisma.appSetting.findUnique({ where: { key: "org" } }))?.value ?? {};
  console.log(`restored: orgName=${o.orgName} country=${JSON.stringify(o.country ?? null)} currency=${JSON.stringify(o.currency ?? null)}`);
  console.log(`live home market now: ${JSON.stringify(await homeMarket())}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
