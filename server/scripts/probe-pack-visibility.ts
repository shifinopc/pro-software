/**
 * Throwaway check that a pack shipped in the image can actually be seen by a running server.
 *
 * This is the bug that hid for a fortnight and never once looked like a bug. /app/packs is a named
 * docker volume, and docker seeds a named volume from the image exactly once — at creation. After
 * that the volume shadows the image completely. So the corrected Saudi pack was built into every
 * release from 10 August onward and the server kept offering the broken one from 5 August, with no
 * error, no log line, and a console that looked entirely normal. It was only found by comparing the
 * file on the server against the file in the repo.
 *
 * Nothing about that is specific to Saudi Arabia. Any future correction shipped the same way would
 * have been swallowed the same way, which is why this exists rather than a one-off repair.
 *
 * Uses its own temporary directories and its own fake packs. Touches no database and no real pack.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pack = (country: string, version: string, docName: string) => JSON.stringify({
  country, countryName: country, version,
  documentTypes: [{ key: `${country.toLowerCase()}.doctype.x`, name: docName, subjectKind: "employee" }],
});

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };

  const vol = mkdtempSync(join(tmpdir(), "pv-vol-"));      // the docker volume
  const img = mkdtempSync(join(tmpdir(), "pv-img-"));      // the image's own copy

  // A correction that only ever existed in the image, plus a name that exists in both.
  writeFileSync(join(img, "pack-zz-2026.9.json"), pack("ZZ", "2026.9", "Corrected In Image"));
  writeFileSync(join(img, "pack-zy-1.0.json"), pack("ZY", "1.0", "Image Copy"));
  writeFileSync(join(vol, "pack-zy-1.0.json"), pack("ZY", "1.0", "Uploaded Copy"));
  writeFileSync(join(vol, "pack-zx-3.0.json"), pack("ZX", "3.0", "Uploaded Only"));

  // The directories are resolved once at module load, so they must be set before the import.
  process.env.PACKS_DIR = vol;
  process.env.PACKS_BUILTIN_DIR = img;
  const { listPacks, readPack } = await import("../src/packs.js");

  const files = listPacks().map(p => p.file).sort();
  console.log("packs this server can offer:");
  for (const p of listPacks()) console.log(`  ${p.file.padEnd(22)} ${p.countryName} ${p.version}`);

  // ── the one that matters ───────────────────────────────────────────────────────────────────
  const imageOnly = files.includes("pack-zz-2026.9.json");
  console.log(`\na pack shipped only in the image is offered: ${imageOnly ? "YES" : "NO"}`);
  if (!imageOnly) fail("a correction shipped in the image is invisible — this is the original bug, unfixed");

  const volOnly = files.includes("pack-zx-3.0.json");
  console.log(`an uploaded pack is still offered:          ${volOnly ? "YES" : "NO"}`);
  if (!volOnly) fail("adding the image directory broke runtime uploads, which is why the volume exists");

  // ── a name in both must resolve to the upload, not the image ───────────────────────────────
  const dup = files.filter(f => f === "pack-zy-1.0.json").length;
  console.log(`a name in both is listed once:              ${dup === 1 ? "YES" : "NO (" + dup + ")"}`);
  if (dup !== 1) fail("the same pack is offered twice — the install screen would show a duplicate");

  const which = readPack("pack-zy-1.0.json").documentTypes?.[0]?.name;
  console.log(`...and reads from the upload, not the image: ${which === "Uploaded Copy" ? "YES" : "NO (" + which + ")"}`);
  if (which !== "Uploaded Copy") fail("a redeploy silently reverted a pack somebody uploaded on purpose");

  const corrected = readPack("pack-zz-2026.9.json").documentTypes?.[0]?.name;
  console.log(`the image-only pack reads its real content: ${corrected === "Corrected In Image" ? "YES" : "NO"}`);
  if (corrected !== "Corrected In Image") fail("listed but unreadable, which is worse than absent");

  // ── a name that exists nowhere must say so ─────────────────────────────────────────────────
  let threw = "";
  try { readPack("pack-nope-9.json"); } catch (e: any) { threw = String(e?.message ?? e); }
  console.log(`a pack that does not exist is refused:      ${threw ? "YES" : "NO"}`);
  if (!threw) fail("reading a missing pack did not fail, so the caller gets nonsense instead of an error");

  // ── path traversal must still be impossible through either directory ───────────────────────
  let traversed = false;
  try { readPack("../../.env"); traversed = true; } catch { /* expected */ }
  console.log(`"../../.env" is still not readable:         ${traversed ? "NO" : "YES"}`);
  if (traversed) fail("a second search directory reopened the traversal hole");

  rmSync(vol, { recursive: true, force: true });
  rmSync(img, { recursive: true, force: true });
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
