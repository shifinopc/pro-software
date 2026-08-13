/**
 * Throwaway check that uploaded branding can actually be DISPLAYED.
 *
 * The letterhead never appeared — not in the Print Layout preview, not on a printed invoice. The
 * upload worked, the file was on disk, and the URL answered 200. helmet's default
 * `Cross-Origin-Resource-Policy: same-origin` was set on every response, so the browser fetched the
 * image, saw it was not allowed to be used by another origin, and threw it away. The console is a
 * different origin from the API (pro.ionob.in vs proapi.ionob.in; :5188 vs :4100 locally), so every
 * <img> pointing at /files came out blank. No error, no failed request, just a broken-image glyph.
 *
 * A missing response header is invisible, which is why this exists:
 *   - a public file may be embedded cross-origin
 *   - it is still served with the hardening that has nothing to do with embedding
 *   - private files are NOT widened; they are fetched with a token, never embedded
 *
 * Own user, own upload. Deletes both afterwards.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";

const PW = "ProbeOnly!2026";
const API = "http://localhost:4100";
const EMAIL = "zf-files@example.invalid";

// A real 1x1 PNG, so the upload is a genuine image rather than bytes with a name.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const sweep = async () => {
  const mine = await prisma.fileAsset.findMany({ where: { name: "zf-probe.png" } });
  for (const f of mine) {
    const p = String(f.path || "");
    if (p.startsWith("/files/")) {
      const disk = path.resolve(process.cwd(), "uploads-files", p.slice("/files/".length));
      if (fs.existsSync(disk)) fs.unlinkSync(disk);
    }
    await prisma.fileAsset.delete({ where: { id: f.id } });
  }
  await prisma.user.deleteMany({ where: { email: EMAIL } });
};

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "ZF Files", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) }).then(r => r.json())).token as string;
  if (!tok) { console.log("could not sign in - is the API running?"); process.exit(1); }

  const up = await fetch(API + "/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
    body: JSON.stringify({ kind: "print-footer", name: "zf-probe.png", data: PNG }),
  }).then(r => r.json());
  console.log(`branding upload returns a path:          ${up.path ? up.path : "NO (" + JSON.stringify(up).slice(0, 90) + ")"}`);
  if (!up.path) { fail("the upload did not return a path"); await sweep(); process.exit(1); }
  console.log(`...and it is a PUBLIC one:               ${String(up.path).startsWith("/files/") ? "YES" : "NO"}`);
  if (!String(up.path).startsWith("/files/")) fail("branding went to the private folder - an <img> carries no token and could never load it");

  const res = await fetch(API + up.path);
  const corp = res.headers.get("cross-origin-resource-policy");
  console.log(`\nthe file answers:                        ${res.status}`);
  console.log(`Cross-Origin-Resource-Policy:            ${corp ?? "(absent)"}`);
  // THE ASSERTION THIS FILE EXISTS FOR. `same-origin` here is a silent failure: 200, right bytes,
  // and the browser discards it because the console is served from somewhere else.
  if (corp !== "cross-origin") fail("public files are not embeddable cross-origin - every letterhead will render as a broken image");
  console.log(`embeddable by the console's origin:      ${corp === "cross-origin" ? "YES" : "NO"}`);

  // Widening CORP must not have taken the rest of the hardening with it.
  console.log(`\nstill nosniff:                           ${res.headers.get("x-content-type-options") === "nosniff" ? "YES" : "NO"}`);
  if (res.headers.get("x-content-type-options") !== "nosniff") fail("nosniff was lost");
  console.log(`still sandboxed by its own CSP:          ${/sandbox/.test(res.headers.get("content-security-policy") ?? "") ? "YES" : "NO"}`);
  if (!/sandbox/.test(res.headers.get("content-security-policy") ?? "")) fail("the per-response CSP was lost");
  console.log(`served as an image:                      ${res.headers.get("content-type")}`);

  // A private file must NOT have been widened: it is read with a token, never embedded.
  const priv = await fetch(API + "/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
    body: JSON.stringify({ kind: "document", name: "zf-probe.png", data: PNG }),
  }).then(r => r.json());
  const privRes = await fetch(API + priv.path, { headers: { Authorization: "Bearer " + tok } });
  const privCorp = privRes.headers.get("cross-origin-resource-policy");
  console.log(`\na private file stays same-origin:        ${privCorp !== "cross-origin" ? "YES (" + privCorp + ")" : "NO - it was widened too"}`);
  if (privCorp === "cross-origin") fail("private files were widened - only the public folder should be embeddable");
  const anon = await fetch(API + priv.path);
  console.log(`...and still refuses an anonymous read:  ${anon.status === 401 || anon.status === 403 ? "YES (" + anon.status + ")" : "NO (" + anon.status + ")"}`);
  if (anon.status < 400) fail("a private file was readable without a token");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
