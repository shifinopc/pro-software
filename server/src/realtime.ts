// ─────────────────────────────────────────────────────────────
// REALTIME — Server-Sent Events for live threads (typing + instant delivery).
//
// SSE rather than WebSockets: the traffic is one-way server→client (a "typing" ping and a new
// message), it survives proxies as ordinary HTTP, and it auto-reconnects in the browser for free.
// Client→server events (typing, sending) stay on the existing REST routes.
//
// AUTH: EventSource cannot send an Authorization header, and putting a JWT in the query string
// would leak it into access logs and Referer headers. So the client exchanges its bearer token for
// a single-use, 30-second TICKET and connects with that instead.
// ─────────────────────────────────────────────────────────────
import crypto from "crypto";
import type { Request, Response } from "express";

export type Audience =
  | { kind: "staff"; userId: string }
  | { kind: "portal"; userId: string; companyId: string };

type Client = { id: string; res: Response; who: Audience };

const clients = new Map<string, Client>();

// ── Tickets ──────────────────────────────────────────────────
type Ticket = { who: Audience; expires: number };
const tickets = new Map<string, Ticket>();
const TICKET_TTL_MS = 30_000;

export function issueTicket(who: Audience): string {
  const t = crypto.randomBytes(24).toString("base64url");
  tickets.set(t, { who, expires: Date.now() + TICKET_TTL_MS });
  return t;
}

/** Single-use: redeeming removes it, so a leaked URL can't be replayed. */
export function redeemTicket(raw: unknown): Audience | null {
  const t = typeof raw === "string" ? raw : "";
  const found = tickets.get(t);
  if (!found) return null;
  tickets.delete(t);
  if (found.expires < Date.now()) return null;
  return found.who;
}

// Expired tickets are dropped lazily; this sweep just stops the map growing unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
}, 60_000).unref?.();

// ── Connections ──────────────────────────────────────────────
export function addClient(req: Request, res: Response, who: Audience): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx must not buffer an event stream
  });
  res.write(`retry: 3000\n\n`);

  const id = crypto.randomUUID();
  clients.set(id, { id, res, who });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  // Keepalive comment — proxies drop idle connections, and it also detects a dead socket.
  const beat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { cleanup(); }
  }, 25_000);
  beat.unref?.();

  const cleanup = () => { clearInterval(beat); clients.delete(id); };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

export const connectionCount = () => clients.size;

// ── Publishing ───────────────────────────────────────────────
/**
 * Fan out one event. Staff see everything; a portal client only ever receives events tagged with
 * its own companyId — the filter lives here so no caller can accidentally leak across tenants.
 */
export function publish(event: string, payload: Record<string, unknown> & { companyId?: string | null }, opts?: { to?: "staff" | "portal" | "all" }) {
  const to = opts?.to ?? "all";
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients.values()) {
    if (to === "staff" && c.who.kind !== "staff") continue;
    if (to === "portal" && c.who.kind !== "portal") continue;
    if (c.who.kind === "portal") {
      if (!payload.companyId || payload.companyId !== c.who.companyId) continue; // tenant isolation
    }
    try { c.res.write(frame); } catch { /* dropped on next heartbeat */ }
  }
}
