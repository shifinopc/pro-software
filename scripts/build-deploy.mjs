// Repeatable production build + packaging for STIMES PRO.
//   node scripts/build-deploy.mjs            → uses API_URL below
//   API_URL=https://api.example.com node scripts/build-deploy.mjs
//
// Prereq: run `pnpm build` first (this script consumes ./dist). It then:
//   1. Injects window.STIMES_API into the console + portal HTML (the self-contained Make apps read
//      `window.STIMES_API || 'http://localhost:4100'`, so WITHOUT this the live site calls localhost).
//   2. Stages deploy/console, deploy/portal (portal.html → index.html), deploy/api.
//   3. Leaves staging dirs ready to zip (zipping done by the caller / PowerShell Compress-Archive).
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const API_URL = process.env.API_URL || "https://proapi.ionob.in";
const dist = join(ROOT, "dist");
const deploy = join(ROOT, "deploy");
if (!existsSync(join(dist, "index.html"))) { console.error("dist/ not found — run `pnpm build` first."); process.exit(1); }

const HTACCESS = `<IfModule mod_rewrite.c>\n  RewriteEngine On\n  RewriteBase /\n  RewriteRule ^index\\.html$ - [L]\n  RewriteCond %{REQUEST_FILENAME} !-f\n  RewriteCond %{REQUEST_FILENAME} !-d\n  RewriteRule . /index.html [L]\n</IfModule>\n`;
const INJECT = `<script>window.STIMES_API=${JSON.stringify(API_URL)};</script>`;

// 1. Inject the API URL right after <head> (before any app script runs).
const inject = (file) => {
  const p = join(dist, file);
  let html = readFileSync(p, "utf8");
  html = html.replace(/window\.STIMES_API\s*=\s*"[^"]*";?<\/script>/g, ""); // drop a prior injection
  if (!html.includes("window.STIMES_API=")) html = html.replace(/<head>/i, `<head>\n${INJECT}`);
  writeFileSync(p, html);
  const n = (html.match(new RegExp(API_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  console.log(`  injected API_URL into ${file} (${n} ref${n === 1 ? "" : "s"} now present)`);
};
console.log(`API_URL = ${API_URL}`);
inject("index.html");
inject("portal.html");

// Shared web-root assets both front-ends need.
const SHARED = ["assets", "vendor", "support.js", "stimes-icon.svg", "stimes-logo.svg", "stimes-logo-white.svg", "uploads"];
const stageShared = (dir) => SHARED.forEach((a) => { const s = join(dist, a); if (existsSync(s)) cpSync(s, join(dir, a), { recursive: true }); });

// 2a. Console → serves index.html
const consoleDir = join(deploy, "console");
rmSync(consoleDir, { recursive: true, force: true }); mkdirSync(consoleDir, { recursive: true });
cpSync(join(dist, "index.html"), join(consoleDir, "index.html"));
stageShared(consoleDir);
writeFileSync(join(consoleDir, ".htaccess"), HTACCESS);
console.log("staged deploy/console");

// 2b. Portal → portal.html renamed to index.html (docroot default doc on cp.ionob.in)
const portalDir = join(deploy, "portal");
rmSync(portalDir, { recursive: true, force: true }); mkdirSync(portalDir, { recursive: true });
cpSync(join(dist, "portal.html"), join(portalDir, "index.html"));
stageShared(portalDir);
writeFileSync(join(portalDir, ".htaccess"), HTACCESS);
console.log("staged deploy/portal");

// 2c. API → server source + prisma (schema, the baseline migration, and BOTH seeds)
const apiDir = join(deploy, "api");
rmSync(apiDir, { recursive: true, force: true }); mkdirSync(apiDir, { recursive: true });
const S = join(ROOT, "server");
cpSync(join(S, "src"), join(apiDir, "src"), { recursive: true });
cpSync(join(S, "package.json"), join(apiDir, "package.json"));
["tsconfig.json", "tsconfig.build.json"].forEach((f) => { if (existsSync(join(S, f))) cpSync(join(S, f), join(apiDir, f)); });
const prismaOut = join(apiDir, "prisma");
mkdirSync(prismaOut, { recursive: true });
["schema.prisma", "seed.ts", "clean.ts", "seed-prod.ts", "seed-prod-data.json"].forEach((f) => cpSync(join(S, "prisma", f), join(prismaOut, f)));
cpSync(join(S, "prisma", "migrations"), join(prismaOut, "migrations"), { recursive: true });
if (existsSync(join(S, ".env.example"))) cpSync(join(S, ".env.example"), join(apiDir, ".env.example"));
console.log("staged deploy/api");

console.log("\nStaging complete. Now zip each folder's CONTENTS (files at root):");
console.log("  deploy/console → stimespro-console.zip");
console.log("  deploy/portal  → stimespro-portal.zip");
console.log("  deploy/api     → stimespro-api.zip");
