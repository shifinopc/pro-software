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

// `close` is the connection's own teardown — clear its keepalive, drop it from the map, end the
// response. Kept on the record so the per-user cap in addClient can retire a stale stream the same
// way a closing socket would, instead of ending the response and hoping the close handler notices.
type Client = { id: string; res: Response; who: Audience; close: () => void };

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
/**
 * How many streams one account may hold open.
 *
 * Each connection is a socket plus a keepalive timer held for as long as it stays open, and nothing
 * capped how many one person could start — the request limiter allows thousands per quarter hour, so
 * a single signed-in account could fill the process with its own connections. Four covers somebody
 * with the console open in several tabs; past that the oldest is closed rather than the new one
 * refused, so a browser reconnecting after a dropped socket is never locked out by its own ghost.
 */
const MAX_PER_USER = 4;

export function addClient(req: Request, res: Response, who: Audience): void {
  const mine = [...clients.values()].filter(c => c.who.userId === who.userId);
  // Map iteration is insertion order, so this retires the oldest first.
  for (const old of mine.slice(0, Math.max(0, mine.length - (MAX_PER_USER - 1)))) old.close();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx must not buffer an event stream
  });
  res.write(`retry: 3000\n\n`);

  const id = crypto.randomUUID();
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  // Keepalive comment — proxies drop idle connections, and it also detects a dead socket.
  const beat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { cleanup(); }
  }, 25_000);
  beat.unref?.();

  const cleanup = () => { clearInterval(beat); clients.delete(id); };
  clients.set(id, { id, res, who, close: () => { cleanup(); try { res.end(); } catch { /* already gone */ } } });
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
