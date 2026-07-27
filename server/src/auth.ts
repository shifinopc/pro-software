import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "./db.js";

// ── Secrets: fail fast rather than silently booting with a known key ──
// Falling back to a published default in production means anyone can forge a super_admin token and
// the credential vault is encrypted with an all-zero key. That must never start silently.
const DEV_JWT = "dev-secret-change-me";
const DEV_CRED = "0".repeat(64);
const rawJwt = process.env.JWT_SECRET;
const rawCred = process.env.CRED_KEY;
const isProd = process.env.NODE_ENV === "production";
{
  const fatal: string[] = [];
  if (isProd) {
    if (!rawJwt || rawJwt === DEV_JWT) fatal.push("JWT_SECRET is missing or still the insecure dev default");
    if (!rawCred || rawCred === DEV_CRED) fatal.push("CRED_KEY is missing or still the insecure dev default");
  }
  // A malformed CRED_KEY breaks the vault at runtime (AES-256 needs exactly 32 bytes) — reject in any
  // env. Validate the DECODED length, not the string length: Node decodes hex in pairs, so a stray
  // trailing character is ignored and the key is still valid.
  if (rawCred && Buffer.from(rawCred, "hex").length !== 32) {
    fatal.push("CRED_KEY must decode to 32 bytes (64 hex characters) for AES-256");
  }
  if (fatal.length) {
    console.error("\nFATAL — refusing to start:\n  - " + fatal.join("\n  - ") +
      "\n\nGenerate them with:  npm run gen-secrets\nThen set JWT_SECRET and CRED_KEY in the environment.\n");
    process.exit(1);
  }
  if (!isProd && (!rawJwt || !rawCred)) {
    console.warn("⚠  JWT_SECRET/CRED_KEY not set — using INSECURE dev defaults. Never deploy this way.");
  }
}
const JWT_SECRET = rawJwt || DEV_JWT;
const CRED_KEY = Buffer.from(rawCred || DEV_CRED, "hex");

// One-time password for portal provisioning/resets. Always random — never a shared constant, which
// would be guessable for every client that hasn't logged in yet.
export const generateTempPassword = () => crypto.randomBytes(9).toString("base64url");

// ── Passwords ──
export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

// ── JWT (carries tokenVersion `tv` so a bump invalidates all issued tokens) ──
export interface AuthPayload { sub: string; type: "staff" | "portal"; role?: string; companyId?: string; tv?: number; }
export const signToken = (payload: AuthPayload, ttlHours = 12) => jwt.sign(payload, JWT_SECRET, { expiresIn: `${ttlHours}h` });
export const verifyToken = (token: string): AuthPayload => jwt.verify(token, JWT_SECRET) as AuthPayload;

// ── Audit log helper ──
export async function logAudit(entry: { action: string; actorId?: string | null; actorEmail?: string | null; target?: string | null; detail?: string | null; ip?: string | null; }) {
  try {
    await prisma.audit.create({ data: { ...entry, at: new Date().toISOString() } });
  } catch { /* never let audit logging break a request */ }
}

// ── Activity feed (persisted so all staff see the same history) ──
export async function logActivity(entry: { type: string; message: string; user?: string | null }) {
  try {
    await prisma.activity.create({ data: { type: entry.type, message: entry.message, user: entry.user ?? "System", time: "Just now", date: new Date().toISOString() } });
  } catch { /* non-fatal */ }
}

// ── Notification (feeds the bell) ──
export async function logNotification(entry: { type: string; title: string; message?: string }) {
  try {
    await prisma.notification.create({ data: { type: entry.type, title: entry.title, message: entry.message ?? null, time: "Just now", read: false } });
  } catch { /* non-fatal */ }
}
export const clientIp = (req: Request) =>
  (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;

// ── Credential vault: AES-256-GCM (iv:tag:ciphertext) ──
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CRED_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}
export function decrypt(payload: string): string {
  try {
    const [ivH, tagH, dataH] = payload.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", CRED_KEY, Buffer.from(ivH, "hex"));
    decipher.setAuthTag(Buffer.from(tagH, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataH, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// ── Middleware ──
// Verifies the JWT, then confirms against the DB that the account is still active and the
// token hasn't been invalidated (tokenVersion bump on password change / disable).
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });
  let payload: AuthPayload;
  try {
    payload = verifyToken(h.slice(7));
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== "active") return res.status(401).json({ error: "Account inactive" });
    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) return res.status(401).json({ error: "Session expired — please sign in again" });
    (req as any).auth = payload;
    next();
  } catch {
    res.status(401).json({ error: "Auth check failed" });
  }
}

export function requireStaff(req: Request, res: Response, next: NextFunction) {
  if ((req as any).auth?.type !== "staff") return res.status(403).json({ error: "Staff access only" });
  next();
}

export function requirePortal(req: Request, res: Response, next: NextFunction) {
  if ((req as any).auth?.type !== "portal") return res.status(403).json({ error: "Client portal access only" });
  next();
}

// ── Custom-role resolution ──
// Admin-defined roles (roleId "custom_<ts>", stored in AppSetting "roles" with a `base` built-in
// role) are ENFORCED by resolving them to their base role for every gate below. Cached 30s so the
// hot path stays synchronous-cheap.
let _customRoleCache: { at: number; map: Record<string, string> } = { at: 0, map: {} };
export async function resolveEffectiveRole(role: string | undefined): Promise<string | undefined> {
  if (!role || !role.startsWith("custom_")) return role;
  if (Date.now() - _customRoleCache.at > 30000) {
    try {
      const row = await prisma.appSetting.findUnique({ where: { key: "roles" } });
      const arr = Array.isArray(row?.value) ? (row!.value as any[]) : [];
      const LABEL_TO_ID: Record<string, string> = { "Super Admin": "super_admin", "Admin": "admin", "PRO Officer": "pro_officer", "Accountant": "accountant", "Client Admin": "client_admin" };
      const map: Record<string, string> = {};
      arr.forEach((r: any) => { if (r && r.id) map[r.id] = LABEL_TO_ID[r.base] || "pro_officer"; });
      _customRoleCache = { at: Date.now(), map };
    } catch { /* keep stale cache */ }
  }
  return _customRoleCache.map[role] || "pro_officer"; // unknown custom role → least-privileged staff
}

export function requireWriteRole(req: Request, res: Response, next: NextFunction) {
  const a = (req as any).auth;
  const writeRoles = ["admin", "super_admin"];
  if (!["POST", "PUT", "DELETE"].includes(req.method)) return next();
  resolveEffectiveRole(a?.role).then(eff => {
    if (!writeRoles.includes(eff || "")) return res.status(403).json({ error: "Write access requires admin role" });
    next();
  }).catch(() => res.status(403).json({ error: "Write access requires admin role" }));
}

// Role-scoped READ guard. requireWriteRole only gates writes, so without this any staff token
// can GET every resource. Apply to sensitive collections (credentials, users, client org) so
// reads honor the same role model the UI shows. Blocks ALL methods for roles not in `roles`.
// Custom roles are resolved to their base built-in role before the check.
export function requireReadRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const a = (req as any).auth;
    resolveEffectiveRole(a?.role).then(eff => {
      if (!roles.includes(eff || "")) return res.status(403).json({ error: "Your role does not have access to this resource" });
      next();
    }).catch(() => res.status(403).json({ error: "Your role does not have access to this resource" }));
  };
}
