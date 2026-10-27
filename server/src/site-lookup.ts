/**
 * Paste a company's website, get a lead.
 *
 * Measured on two of this firm's own leads before a line of it was written, which is the only
 * honest way to size it: palmate.sa publishes a `LocalBusiness` block carrying name, telephone,
 * street, city, region, postcode, country and a logo — eight fields, pre-structured, no guessing.
 * giscosaudi.com publishes a bare `WebSite` block and gives you a name. Both are Wix sites; the
 * difference is whether the owner filled in the business-info panel, not the platform.
 *
 * So: worth doing, and inconsistent by nature. Everything here is a SUGGESTION a person accepts,
 * marked the same way the signature parser marks its own — "sure" for what a document structure
 * states outright, "guess" for what was inferred from a page.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * THE SECURITY PROBLEM, STATED, BECAUSE IT IS THE WHOLE JOB
 *
 * This fetches a URL a user typed, FROM THE SERVER. That is server-side request forgery unless it
 * is stopped on purpose: `http://localhost:4100/api/...` reaches this product's own API with
 * whatever the server can reach it with, `http://169.254.169.254/` is the cloud metadata endpoint
 * on most providers, and `http://10.0.0.5/` is whatever else shares the private network. A reply
 * from any of those is then displayed to whoever pasted it.
 *
 * Four rules, and none of them is optional:
 *   1. http and https only — no file:, no gopher:, no data:
 *   2. the host must resolve to a PUBLIC address, every address it resolves to, not just the first
 *   3. redirects are followed by hand and re-checked at every hop, because hop one being public
 *      says nothing about hop two
 *   4. a size cap and a time cap, so a hostile or merely enormous page cannot hold a worker
 *
 * shortcut: the address is checked and then fetched by hostname, leaving a small window in which
 * DNS could answer differently for the real request (a rebinding attack). Closing it means
 * connecting to the checked IP and carrying the hostname for TLS separately. Worth doing if this
 * is ever exposed to anyone but signed-in staff.
 */
import dns from "node:dns/promises";
import net from "node:net";
import type { SignatureField, ParsedSignature } from "./signature.js";
import { normalisePhone } from "./signature.js";

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8_000;
const MAX_HOPS = 4;

export class SiteLookupError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Is this address one the public internet can reach?
 *
 * Written as a deny-list of the ranges that are NOT public, because that is how the registries
 * define them — and an allow-list of "everything else" is the only way to avoid missing one.
 */
export function isPublicAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (!v) return false;

  if (v === 6) {
    const l = ip.toLowerCase();
    // An IPv4 address wearing an IPv6 coat — ::ffff:127.0.0.1 is still loopback.
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (l === "::" || l === "::1") return false;                 // unspecified, loopback
    if (/^f[cd][0-9a-f]{2}:/.test(l)) return false;              // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(l)) return false;              // fe80::/10 link-local
    if (/^ff/.test(l)) return false;                             // multicast
    return true;
  }

  const [a, b] = ip.split(".").map(Number);
  if (a === 0) return false;                                     // "this network"
  if (a === 10) return false;                                    // private
  if (a === 127) return false;                                   // loopback
  if (a === 169 && b === 254) return false;                      // link-local — the metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return false;             // private
  if (a === 192 && b === 168) return false;                      // private
  if (a === 100 && b >= 64 && b <= 127) return false;            // carrier-grade NAT
  if (a === 192 && b === 0) return false;                        // IETF protocol assignments / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false;         // benchmarking
  if (a === 198 && b === 51) return false;                       // TEST-NET-2
  if (a === 203 && b === 0) return false;                        // TEST-NET-3
  if (a >= 224) return false;                                    // multicast and reserved
  return true;
}

/** Every address this host answers with must be public — one private answer is enough to refuse. */
async function assertPublicHost(host: string) {
  // A literal address skips DNS entirely and is checked directly.
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new SiteLookupError(`${host} is not a public address.`);
    return;
  }
  let answers: Array<{ address: string }>;
  try {
    answers = await dns.lookup(host, { all: true });
  } catch {
    throw new SiteLookupError(`That address does not resolve — check the spelling of "${host}".`);
  }
  if (!answers.length) throw new SiteLookupError(`That address does not resolve — check the spelling of "${host}".`);
  for (const a of answers) {
    if (!isPublicAddress(a.address)) throw new SiteLookupError(`"${host}" points inside this network, so it will not be fetched.`);
  }
}

/** Accept what a person types — "palmate.sa", "www.palmate.sa", "https://palmate.sa/about". */
export function normaliseUrl(raw: string): URL {
  const text = String(raw ?? "").trim();
  if (!text) throw new SiteLookupError("Paste the website address first.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new SiteLookupError(`"${text}" is not a web address.`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SiteLookupError(`Only http and https addresses can be looked up, not ${u.protocol.replace(":", "")}.`);
  }
  if (!u.hostname.includes(".")) throw new SiteLookupError(`"${text}" does not look like a public website.`);
  return u;
}

/** Fetch, following redirects by hand so every hop is checked rather than only the first. */
async function getPage(start: URL): Promise<{ url: URL; html: string }> {
  let url = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    await assertPublicHost(url.hostname);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        redirect: "manual",
        signal: ctl.signal,
        headers: {
          // Named honestly. A site that would rather not be read this way can say so.
          "user-agent": "STIMES-PRO-LeadLookup/1.0 (+staff-initiated company lookup)",
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (e: any) {
      clearTimeout(timer);
      throw new SiteLookupError(e?.name === "AbortError"
        ? "That site took too long to answer."
        : `Could not reach ${url.hostname}.`, 502);
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new SiteLookupError(`${url.hostname} redirected to nowhere.`, 502);
      url = new URL(loc, url);                       // relative redirects are normal
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new SiteLookupError("That site redirected somewhere that cannot be fetched.");
      continue;
    }
    if (!res.ok) throw new SiteLookupError(`${url.hostname} answered ${res.status}.`, 502);

    const type = res.headers.get("content-type") ?? "";
    if (type && !/html|xml|text\/plain/i.test(type)) throw new SiteLookupError(`That address is a ${type.split(";")[0]}, not a web page.`);

    // Capped as it arrives, so an enormous page cannot be downloaded in full before being refused.
    const reader = res.body?.getReader();
    if (!reader) throw new SiteLookupError(`${url.hostname} sent nothing.`, 502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); size += value.byteLength; }
    }
    try { await reader.cancel(); } catch { /* already finished */ }
    return { url, html: Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8") };
  }
  throw new SiteLookupError("That site redirected too many times.", 502);
}

// ── Reading the page ─────────────────────────────────────────────────────────────────────────

const attr = (html: string, re: RegExp) => html.match(re)?.[1]?.trim() || "";
const metaOf = (html: string, name: string) =>
  attr(html, new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i")) ||
  attr(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i"));

/** Every JSON-LD block on the page, flattened — sites nest them in arrays and in @graph. */
export function jsonLdNodes(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const n = queue.shift();
        if (!n || typeof n !== "object") continue;
        out.push(n);
        if (Array.isArray(n["@graph"])) queue.push(...n["@graph"]);
      }
    } catch { /* a malformed block is not a reason to abandon the page */ }
  }
  return out;
}

const isOrg = (n: any) => /Organization|LocalBusiness|Corporation|Store|ProfessionalService/i.test(String(n?.["@type"] ?? ""));

/**
 * Logos that are not logos.
 *
 * Measured: giscosaudi.com's icon is `static.parastorage.com/client/pfavico.ico` — Wix's own
 * favicon, served to every site that never uploaded one. Pasting that into a client record is
 * worse than showing nothing, because nothing invites somebody to go and find the real one.
 */
const GENERIC_ICON = /parastorage\.com\/client\/pfavico|wix\.com\/favicon|squarespace\.com\/universal|shopify\.com\/favicon|\/favicon\.ico$/i;

export type SiteLookup = ParsedSignature & { url: string; title?: string };

export function readPage(html: string, url: URL): SiteLookup {
  const out: SiteLookup = { lines: 0, url: url.toString() };
  const put = (k: keyof ParsedSignature, value: unknown, confidence: SignatureField["confidence"], why: string) => {
    const v = String(value ?? "").replace(/\s+/g, " ").trim();
    if (v && !(out as any)[k]) (out as any)[k] = { value: v, confidence, why };
  };

  const org = jsonLdNodes(html).find(isOrg);
  if (org) {
    // Stated by the site in a structured format: this is the strongest thing on the page.
    put("companyName", org.name, "sure", "the site states its own name in its business listing");
    const tel = String(org.telephone ?? "");
    if (tel) put("phone", normalisePhone(tel), "sure", "the site lists this as its telephone number");
    put("email", String(org.email ?? "").replace(/^mailto:/i, ""), "sure", "the site lists this as its email address");
    const addr = org.address && typeof org.address === "object" ? org.address : null;
    if (addr) {
      put("city", addr.addressLocality, "sure", "from the address the site publishes");
      put("street", addr.streetAddress, "sure", "from the address the site publishes");
      put("postalCode", addr.postalCode, "sure", "from the address the site publishes");
      put("country", addr.addressCountry, "sure", "from the address the site publishes");
    }
    const img = typeof org.logo === "string" ? org.logo : (org.logo?.url || (typeof org.image === "string" ? org.image : org.image?.url));
    if (img && !GENERIC_ICON.test(String(img))) put("logo", new URL(String(img), url).toString(), "sure", "the site publishes this as its logo");
  }

  // Falling back through what a page says about itself, weakest last.
  put("companyName", metaOf(html, "og:site_name"), "sure", "the page names the site");
  const title = attr(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    out.title = title.replace(/\s+/g, " ").trim().slice(0, 200);
    // A title is a headline, not a name — "Home | Gisco Solutions Ind.co.ltd" needs the part that
    // is the company, and which part that is, is a judgement.
    const piece = out.title.split(/\s*[|·—–-]\s*/).filter(p => !/^(home|welcome|homepage)$/i.test(p.trim()))[0];
    put("companyName", piece, "guess", "taken from the page title, which is not always the legal name");
  }

  // Capped: this lands in a notes field somebody will read at a glance, and a site's meta
  // description can run to several hundred characters of keywords.
  const desc = (metaOf(html, "description") || metaOf(html, "og:description")).slice(0, 280);
  put("description", desc, "guess", "the site's own description of itself");

  if (!out.logo) {
    const og = metaOf(html, "og:image");
    const touch = attr(html, /<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
      || attr(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*apple-touch-icon/i);
    const icon = attr(html, /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i);
    const pick = [touch, og, icon].find(c => c && !GENERIC_ICON.test(c));
    if (pick) put("logo", new URL(pick, url).toString(), "guess", touch && pick === touch ? "the site's touch icon" : "the best image the page offers");
  }

  // Only from the visible text, and only when the structured data gave nothing.
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  if (!out.email) {
    const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    const best = found.find(e => e.toLowerCase().endsWith(url.hostname.replace(/^www\./, ""))) ?? found[0];
    if (best) put("email", best.toLowerCase(), "guess", "found in the page text");
  }
  if (!out.phone) {
    const found = (text.match(/\+?\d[\d\s()-]{8,16}\d/g) ?? []).map(p => p.trim());
    if (found[0]) put("phone", normalisePhone(found[0]), "guess", "found in the page text");
  }

  put("website", url.hostname.replace(/^www\./i, ""), "sure", "the address you pasted");
  return out;
}

export async function lookupSite(raw: string): Promise<SiteLookup> {
  const start = normaliseUrl(raw);
  const { url, html } = await getPage(start);
  return readPage(html, url);
}
