/**
 * One-off: move already-uploaded identity documents out of the publicly served folder.
 *
 * Uploads used to land in `uploads-files/`, which is served at /files/<name> with no authentication,
 * under names like `document-1785237354372.png`. A millisecond timestamp is guessable inside a known
 * window, so anyone could walk the folder and pull other clients' passport scans.
 *
 * New uploads of these kinds now go straight to `uploads-private/` (not served) and are addressed as
 * /api/files/<id>, which checks who is asking. This script brings the files that predate that change
 * across, and repoints their FileAsset rows.
 *
 * Safe to run more than once: it only looks at rows still marked `private: false`, and skips any
 * whose file is already gone from disk.
 *
 *   docker compose -f stack/docker-compose.yml exec api npx tsx scripts/migrate-private-files.ts
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();
const PUBLIC_DIR = path.resolve(process.cwd(), "uploads-files");
const PRIVATE_DIR = path.resolve(process.cwd(), "uploads-private");
// Must match PRIVATE_KINDS in src/index.ts. Branding (logos, print headers) stays public on purpose:
// an <img> tag carries no Authorization header, so a logo behind auth simply would not render.
const PRIVATE_KINDS = ["document", "attachment"];

async function main() {
  if (!fs.existsSync(PRIVATE_DIR)) fs.mkdirSync(PRIVATE_DIR, { recursive: true });

  const rows = await prisma.fileAsset.findMany({ where: { kind: { in: PRIVATE_KINDS }, private: false } });
  if (!rows.length) {
    console.log("Nothing to move — every identity document is already private.");
    return;
  }
  console.log(`${rows.length} file(s) to move out of the public folder.`);

  let moved = 0, missing = 0;
  for (const asset of rows) {
    const base = String(asset.path || "").split("/").pop() || "";
    const src = path.join(PUBLIC_DIR, base);
    if (!base || !fs.existsSync(src)) {
      // The row outlived its file. Mark it private anyway so it stops advertising a public URL.
      await prisma.fileAsset.update({ where: { id: asset.id }, data: { private: true, path: "/api/files/" + asset.id } });
      console.log(`  · ${asset.name} — file already gone from disk, row repointed`);
      missing++;
      continue;
    }
    const ext = path.extname(base) || ".png";
    fs.renameSync(src, path.join(PRIVATE_DIR, asset.id + ext));
    // Scope it to the uploader's company where the uploader is a real user; otherwise staff-only,
    // which is the safe answer for an upload whose owner cannot be established.
    const uploader = asset.uploadedBy
      ? await prisma.user.findUnique({ where: { id: asset.uploadedBy } }).catch(() => null)
      : null;
    await prisma.fileAsset.update({
      where: { id: asset.id },
      data: { private: true, path: "/api/files/" + asset.id, companyId: uploader?.companyId ?? null },
    });
    console.log(`  · ${asset.name} → /api/files/${asset.id} ${uploader?.companyId ? "(company-scoped)" : "(staff only)"}`);
    moved++;
  }

  const left = fs.existsSync(PUBLIC_DIR) ? fs.readdirSync(PUBLIC_DIR) : [];
  console.log(`\nMoved ${moved}, repointed ${missing} with no file.`);
  console.log(`Still public (branding only, as intended): ${left.length ? left.join(", ") : "nothing"}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
