/**
 * WHAT A PASTED WEBSITE TURNS INTO — AND WHERE THE SERVER REFUSES TO GO.
 *
 *   npx tsx scripts/site-lookup-check.ts      (no network, no database)
 *
 * Two halves, and the second is the one that matters.
 *
 * THE READING half runs against saved HTML rather than the live sites, because a check that fetches
 * the internet fails on a Tuesday when somebody else redesigns their homepage, and a check that
 * cries wolf gets ignored. The two fixtures are the real shapes measured on this firm's own leads:
 * palmate.sa, which publishes a full LocalBusiness block, and giscosaudi.com, which publishes a bare
 * WebSite block and a platform favicon. One is the good case, one is the thin case, and both must
 * come out right — including the thin one coming out nearly empty rather than nearly wrong.
 *
 * THE REFUSAL half is the security of the feature. This fetches a URL a user typed, from the
 * server, so every address below is one somebody could paste to make the server read something it
 * should not: its own API, the cloud metadata endpoint, whatever else shares the private network.
 * If one of these ever starts being allowed, that is a hole, not a regression in a convenience.
 */
import { isPublicAddress, normaliseUrl, readPage, jsonLdNodes, SiteLookupError } from "../src/site-lookup.js";

const fails: string[] = [];
const ok = (cond: boolean, what: string, got?: unknown) => {
  if (cond) console.log(`    ok    ${what}`);
  else { fails.push(`${what} — got ${JSON.stringify(got)}`); console.log(`    FAIL  ${what} — got ${JSON.stringify(got)}`); }
};

// ── 1. Addresses the server must refuse ──────────────────────────────────────────────────────
console.log("addresses that must NOT be fetched:");
for (const ip of [
  "127.0.0.1", "127.1.2.3",            // loopback — this product's own API
  "169.254.169.254",                   // the cloud metadata endpoint
  "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
  "100.64.0.1",                        // carrier-grade NAT
  "0.0.0.0", "224.0.0.1", "255.255.255.255",
  "::1", "fe80::1", "fd00::1",         // IPv6 loopback, link-local, unique-local
  "::ffff:127.0.0.1",                  // IPv4 loopback wearing an IPv6 coat
]) ok(!isPublicAddress(ip), ip);

console.log("\naddresses that are public and may be fetched:");
for (const ip of ["8.8.8.8", "1.1.1.1", "51.36.0.1", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
  ok(isPublicAddress(ip), ip);
}

console.log("\nschemes and shapes:");
const refuses = (raw: string, why: string) => {
  try { normaliseUrl(raw); ok(false, why, "allowed"); }
  catch (e) { ok(e instanceof SiteLookupError, why, String((e as Error).message).slice(0, 50)); }
};
refuses("file:///etc/passwd", "file: is refused");
refuses("gopher://x.com", "gopher: is refused");
refuses("data:text/html,<h1>x", "data: is refused");
refuses("localhost:4100", "a bare hostname with no dot is refused");
ok(normaliseUrl("palmate.sa").toString() === "https://palmate.sa/", "a bare domain gets https");
ok(normaliseUrl("www.palmate.sa/about").pathname === "/about", "a path is kept");

// ── 2. Reading a page ────────────────────────────────────────────────────────────────────────
// The rich shape, as measured on palmate.sa.
const RICH = `<html><head>
<title>Palmate Technologies - Odoo Partners Saudi Arabia</title>
<meta property="og:site_name" content="Palmate Technologies">
<meta name="description" content="Odoo ERP implementation in Saudi Arabia.">
<link rel="apple-touch-icon" href="/touch.png">
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"LocalBusiness","name":"Palmate Technologies",
 "url":"https://www.palmate.sa","image":"https://static.wixstatic.com/media/logo.png",
 "address":{"@type":"PostalAddress","addressCountry":"SA","addressLocality":"Jeddah",
 "addressRegion":"Makkah Province","postalCode":"23435","streetAddress":"Al Kayyal"},
 "telephone":"+966 126017649"}
</script></head><body><p>Write to info@palmate.sa</p></body></html>`;

// The thin shape, as measured on giscosaudi.com — a bare WebSite block and Wix's own favicon.
const THIN = `<html><head>
<title>Home | Gisco Solutions Ind.co.ltd</title>
<meta property="og:site_name" content="GISCO SAUDI">
<link rel="shortcut icon" href="https://static.parastorage.com/client/pfavico.ico">
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"WebSite","name":"GISCO SAUDI","url":"https://www.giscosaudi.com"}
</script></head><body><p>Industrial solutions.</p></body></html>`;

console.log("\na site that publishes a business listing:");
{
  const r = readPage(RICH, new URL("https://www.palmate.sa/")) as any;
  ok(r.companyName?.value === "Palmate Technologies", "company name", r.companyName?.value);
  ok(r.companyName?.confidence === "sure", "and it is marked sure, not a guess", r.companyName?.confidence);
  ok(r.phone?.value === "+966 126017649", "phone, normalised", r.phone?.value);
  ok(r.city?.value === "Jeddah", "city", r.city?.value);
  ok(r.street?.value === "Al Kayyal", "street", r.street?.value);
  ok(r.postalCode?.value === "23435", "postcode", r.postalCode?.value);
  ok(r.country?.value === "SA", "country", r.country?.value);
  ok(r.logo?.value === "https://static.wixstatic.com/media/logo.png", "logo from the listing", r.logo?.value);
  ok(r.email?.value === "info@palmate.sa", "email from the page text", r.email?.value);
  ok(r.email?.confidence === "guess", "and that one IS a guess — it was scraped, not stated", r.email?.confidence);
  ok(r.website?.value === "palmate.sa", "website, without the www", r.website?.value);
}

console.log("\na site that publishes almost nothing:");
{
  const r = readPage(THIN, new URL("https://www.giscosaudi.com/")) as any;
  ok(r.companyName?.value === "GISCO SAUDI", "the name it does publish", r.companyName?.value);
  // THE POINT OF THIS FIXTURE. A platform's stock favicon is not the company's logo, and putting
  // it on a client record is worse than leaving it empty: nothing invites somebody to find the
  // real one, a wrong logo does not.
  ok(!r.logo, "the platform's stock favicon is NOT offered as a logo", r.logo?.value);
  ok(!r.phone, "no phone is invented", r.phone?.value);
  ok(!r.email, "no email is invented", r.email?.value);
  ok(!r.city, "no city is invented", r.city?.value);
}

console.log("\na title that is a headline, not a name:");
{
  const r = readPage(THIN.replace('<meta property="og:site_name" content="GISCO SAUDI">', ""), new URL("https://www.giscosaudi.com/")) as any;
  ok(r.companyName?.value === "Gisco Solutions Ind.co.ltd", "the Home| prefix is dropped", r.companyName?.value);
  ok(r.companyName?.confidence === "guess", "and a title-derived name is a guess", r.companyName?.confidence);
}

console.log("\nmalformed and nested structured data:");
ok(jsonLdNodes('<script type="application/ld+json">{ oops </script>').length === 0, "a broken block is skipped, not thrown");
ok(jsonLdNodes('<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"X"}]}</script>')
  .some(n => n["@type"] === "Organization"), "an @graph wrapper is unwrapped");

if (fails.length) {
  console.log(`\n${fails.length} failure(s):`);
  for (const f of fails) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log("\nin order — the reading is right, and nothing private can be fetched.");
}
