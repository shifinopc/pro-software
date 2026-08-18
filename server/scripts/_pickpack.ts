/**
 * The newest pack for a country on this server.
 *
 * Probes used to name a file — `pack-sa-2026.2.json` — which meant every pack release silently broke
 * four of them, and the failure ("No pack named …") looks nothing like the stale reference it is.
 * Ask the server what it has instead.
 */
import { listPacks } from "../src/packs.js";

export function newestPackFile(country = "SA"): string {
  const mine = listPacks().filter(p => p.country === country && !p.error);
  if (!mine.length) throw new Error(`no ${country} pack on this server — export one first`);
  const num = (v: string) => v.split(".").map(n => parseInt(n, 10) || 0);
  mine.sort((a, b) => { const x = num(a.version), y = num(b.version);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0; });
  return mine[0].file;
}
