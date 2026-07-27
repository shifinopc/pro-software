// Minimal, dependency-free ZIP writer (PKZIP, deflate) — produces forward-slash entry names and
// includes dotfiles (.htaccess), so archives extract correctly on Linux/cPanel.
//   node scripts/zipdir.mjs <sourceDir> <output.zip>
import { readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { join, relative, sep } from "path";
import { deflateRawSync } from "zlib";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ full, name: relative(base, full).split(sep).join("/") });
  }
  return out;
}

const [srcDir, outZip] = process.argv.slice(2);
if (!srcDir || !outZip) { console.error("usage: node zipdir.mjs <sourceDir> <output.zip>"); process.exit(1); }

const files = walk(srcDir).sort((a, b) => a.name.localeCompare(b.name));
const chunks = [];
const central = [];
let offset = 0;
const DOSDATE = 0x0021, DOSTIME = 0x0000; // 1980-01-01 00:00

for (const f of files) {
  const data = readFileSync(f.full);
  const crc = crc32(data);
  const comp = deflateRawSync(data);
  const useStore = comp.length >= data.length;
  const body = useStore ? data : comp;
  const method = useStore ? 0 : 8;
  const nameBuf = Buffer.from(f.name, "utf8");

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(method, 8); lh.writeUInt16LE(DOSTIME, 10); lh.writeUInt16LE(DOSDATE, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  chunks.push(lh, nameBuf, body);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(method, 10); ch.writeUInt16LE(DOSTIME, 12); ch.writeUInt16LE(DOSDATE, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([ch, nameBuf]));

  offset += lh.length + nameBuf.length + body.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);

writeFileSync(outZip, Buffer.concat([...chunks, cdBuf, eocd]));
console.log(`${outZip} — ${files.length} files, ${(Buffer.concat([...chunks, cdBuf, eocd]).length / 1024).toFixed(1)} KB`);
