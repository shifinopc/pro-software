/**
 * Exercises the master data sheet route end to end, against a throwaway client.
 *
 *   npx tsx scripts/probe-master-data-sheet.ts
 *
 * DELIBERATELY NOT AGAINST A REAL CLIENT. The revealed sheet writes plaintext government passwords
 * into a response, so this makes its own client with its own invented logins — and because it signs
 * its tokens with `_suite-auth`, it refuses to run anywhere but the scratch database.
 *
 * What it proves that the renderer's own check (master-data-pdf-check.ts) cannot:
 *   1. the masked sheet is what you get by default, and no password is in the bytes;
 *   2. `?reveal=1` writes one `credential.reveal` audit row PER LOGIN, so the existing
 *      "who has seen this password" view stays complete for the only bulk reveal in the product;
 *   3. a PRO officer is allowed the masked sheet and refused the other one.
 */
import "dotenv/config";
import { prisma } from "../src/db.js";
import { authHeader } from "./_suite-auth.js";
import crypto from "node:crypto";

const API = process.env.PROBE_API ?? "http://localhost:4100";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error("FAIL: " + what);
  console.log("  ok -", what);
};

const made: { companyId?: string; credIds: string[]; adminId?: string; officerId?: string } = { credIds: [] };
const SECRETS = ["qiwa-probe-" + crypto.randomUUID().slice(0, 8), "gosi-probe-" + crypto.randomUUID().slice(0, 8)];
const STAMP = Date.now();

(async () => {
  // Asked BEFORE anything is written. `authHeader` refuses off the scratch database anyway, but it
  // is called after the two users exist — so without this the refusal arrives having already made
  // rows in somebody's real data and left the cleanup to the `finally`.
  authHeader({ id: "probe-scratch-guard" });

  const admin = await prisma.user.create({ data: {
    name: "ZZ MD Admin", email: `zz-md-admin-${STAMP}@example.invalid`,
    roleId: "admin", status: "active", type: "staff",
  } });
  made.adminId = admin.id;
  const officer = await prisma.user.create({ data: {
    name: "ZZ MD Officer", email: `zz-md-officer-${STAMP}@example.invalid`,
    roleId: "pro_officer", status: "active", type: "staff",
  } });
  made.officerId = officer.id;
  const auth = authHeader(admin);
  const oAuth = authHeader(officer);

  const co = await prisma.company.create({ data: {
    name: `ZZ Master Data Probe ${STAMP}`, status: "active", cr: "7054114512", gosiNumber: "635228091",
  } });
  made.companyId = co.id;

  // Filed through the API, so the encryption path is the real one.
  for (const [i, label] of ["QIWA", "GOSI"].entries()) {
    const r = await fetch(API + "/api/credentials", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId: co.id, label, url: "https://example.invalid", username: "probe-user",
        fileNo: i === 1 ? "635228091" : null, password: SECRETS[i], notes: "R",
      }),
    });
    if (!r.ok) throw new Error(`could not file a credential (${r.status} ${await r.text()})`);
    made.credIds.push((await r.json()).id);
  }
  ok(made.credIds.length === 2, "two logins filed through the API");

  const fileNo = (await prisma.siteCredential.findUnique({ where: { id: made.credIds[1] }, select: { fileNo: true } }))?.fileNo;
  ok(fileNo === "635228091", "the portal's own file number survived the round trip");

  const sheet = async (query: string, headers: Record<string, string>) => {
    const r = await fetch(`${API}/api/companies/${co.id}/master-data.pdf${query}`, { headers });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  };

  // ── 1. masked by default ───────────────────────────────────────────────────────────────────
  const masked = await sheet("", auth);
  ok(masked.status === 200, "the masked sheet is served");
  ok(masked.body.subarray(0, 5).toString() === "%PDF-", "and it is a PDF");
  const mRaw = masked.body.toString("latin1");
  ok(!SECRETS.some(s => mRaw.includes(s)), "no plaintext password anywhere in the masked file");
  ok(await prisma.audit.count({ where: { action: "credential.reveal", detail: { contains: co.id } } }) === 0,
    "the masked sheet logged no reveal");

  // ── 2. reveal ──────────────────────────────────────────────────────────────────────────────
  const shown = await sheet("?reveal=1", auth);
  ok(shown.status === 200, "the revealed sheet is served to an admin");
  const reveals = await prisma.audit.count({ where: { action: "credential.reveal", detail: { contains: co.id } } });
  ok(reveals === 2, `one reveal row per login (${reveals})`);
  ok(await prisma.audit.count({ where: { action: "credential.sheet", target: co.name } }) === 2,
    "both sheets logged that they were printed");

  // ── 3. a PRO officer gets one document and not the other ───────────────────────────────────
  const oMasked = await sheet("", oAuth);
  ok(oMasked.status === 200, "a PRO officer may print the masked sheet");
  const oShown = await fetch(`${API}/api/companies/${co.id}/master-data.pdf?reveal=1`, { headers: oAuth });
  ok(oShown.status === 403, "a PRO officer is refused the passwords");
  ok(/admin access/i.test((await oShown.json()).error ?? ""), "and told which part needs admin");

  console.log("PASS");
})().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; })
  .finally(async () => {
    if (made.credIds.length) await prisma.siteCredential.deleteMany({ where: { id: { in: made.credIds } } });
    if (made.companyId) {
      await prisma.audit.deleteMany({ where: { OR: [{ detail: { contains: made.companyId } }, { target: { startsWith: "ZZ Master Data Probe" } }] } });
      await prisma.activity.deleteMany({ where: { message: { contains: "ZZ Master Data Probe" } } });
      await prisma.company.deleteMany({ where: { id: made.companyId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [made.adminId, made.officerId].filter(Boolean) as string[] } } });
    console.log("cleaned up");
    await prisma.$disconnect();
  });
