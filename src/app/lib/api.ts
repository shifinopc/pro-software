// ─────────────────────────────────────────────────────────────
// API / SESSION LAYER  (extracted from App.tsx)
// Authenticated fetch helpers for the staff console (`api`) and the
// client portal (`portalApi`), plus session/impersonation helpers.
//
// `api.get<T>()` / `api.post<T>()` are generic: pass a type argument to
// get a typed response (e.g. `api.get<Task[]>("/api/tasks")`). The default
// is `any` to preserve existing untyped call sites — tighten incrementally.
// ─────────────────────────────────────────────────────────────

// Backend API base. Uses VITE_API_BASE at build time (see .env.production), falls back to
// localhost for local dev. So the same code runs against local + live with no edits.
export const API_BASE = ((import.meta as any).env?.VITE_API_BASE as string) || "http://localhost:4100";

// Expired/invalid token → clear the session and bounce to the login screen (instead of silently showing stale mock).
export const clearStaffSession = () => {
  try {
    localStorage.removeItem("stimespro:token");
    localStorage.removeItem("stimespro:user");
    localStorage.setItem("stimespro:v1:session.loggedIn", "false");
  } catch {}
  if (typeof window !== "undefined") window.location.reload();
};
export const clearPortalSession = () => {
  try { localStorage.removeItem("stimespro:portalToken"); } catch {}
  if (typeof window !== "undefined") window.location.reload();
};

// Authenticated fetch helper — attaches the staff JWT, auto-logs-out on 401, throws on other non-2xx.
export const authHeaders = (): Record<string, string> => {
  const t = typeof localStorage !== "undefined" ? localStorage.getItem("stimespro:token") : null;
  return t ? { "Content-Type": "application/json", Authorization: `Bearer ${t}` } : { "Content-Type": "application/json" };
};
export const guard = (r: Response) => { if (r.status === 401) { clearStaffSession(); throw new Error("unauthorized"); } };
export const api = {
  get: async <T = any>(p: string): Promise<T> => { const r = await fetch(`${API_BASE}${p}`, { headers: authHeaders() }); guard(r); if (!r.ok) throw new Error(await r.text()); return r.json(); },
  post: async <T = any>(p: string, body: unknown): Promise<T> => { const r = await fetch(`${API_BASE}${p}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) }); guard(r); if (!r.ok) throw new Error(await r.text()); return r.json(); },
  put: async <T = any>(p: string, body: unknown): Promise<T> => { const r = await fetch(`${API_BASE}${p}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) }); guard(r); if (!r.ok) throw new Error(await r.text()); return r.json(); },
  del: async (p: string): Promise<void> => { const r = await fetch(`${API_BASE}${p}`, { method: "DELETE", headers: authHeaders() }); guard(r); if (!r.ok) throw new Error(await r.text()); },
};

// ── Super Admin impersonation ("log in as user") ──
export const ROLE_PERSIST_KEY = "stimespro:v1:session.role";
export const loginAsUser = async (userId: string): Promise<{ ok: boolean; msg?: string }> => {
  try {
    const res = await api.post<any>(`/api/users/${userId}/login-as`, {});
    if (!res?.token || !res?.user) return { ok: false, msg: "Unexpected response" };
    if (res.user.type === "portal" && res.user.companyId) {
      localStorage.setItem("stimespro:portalToken", res.token);
      window.location.href = "/portal.html"; // open the client portal as this user
      return { ok: true };
    }
    // Staff impersonation — back up the current admin session so we can return
    localStorage.setItem("stimespro:impersonator", JSON.stringify({
      token: localStorage.getItem("stimespro:token"),
      role: localStorage.getItem(ROLE_PERSIST_KEY),
      user: localStorage.getItem("stimespro:user"),
    }));
    localStorage.setItem("stimespro:token", res.token);
    localStorage.setItem(ROLE_PERSIST_KEY, JSON.stringify(res.user.role));
    localStorage.setItem("stimespro:user", JSON.stringify({ name: res.user.name, email: res.user.email, role: res.user.role, roleId: res.user.role }));
    window.location.reload();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, msg: typeof e?.message === "string" && /Super Admin/i.test(e.message) ? "Only a Super Admin can log in as another user" : "Could not log in as that user" };
  }
};
export const isImpersonating = () => { try { return !!localStorage.getItem("stimespro:impersonator"); } catch { return false; } };
export const currentUserEmail = (): string => { try { return (JSON.parse(localStorage.getItem("stimespro:user") || "{}").email || "").toLowerCase(); } catch { return ""; } };
export const returnToAdmin = () => {
  try {
    const raw = localStorage.getItem("stimespro:impersonator");
    if (raw) {
      const b = JSON.parse(raw);
      if (b.token) localStorage.setItem("stimespro:token", b.token); else localStorage.removeItem("stimespro:token");
      if (b.role) localStorage.setItem(ROLE_PERSIST_KEY, b.role);
      if (b.user) localStorage.setItem("stimespro:user", b.user);
    }
    localStorage.removeItem("stimespro:impersonator");
  } catch { /* ignore */ }
  window.location.reload();
};

// Same helper but with the CLIENT PORTAL token (separate login, companyId-scoped).
export const portalHeaders = (): Record<string, string> => {
  const t = typeof localStorage !== "undefined" ? localStorage.getItem("stimespro:portalToken") : null;
  return t ? { "Content-Type": "application/json", Authorization: `Bearer ${t}` } : { "Content-Type": "application/json" };
};
export const portalGuard = (r: Response) => { if (r.status === 401) { clearPortalSession(); throw new Error("unauthorized"); } };
export const portalApi = {
  get: async <T = any>(p: string): Promise<T> => { const r = await fetch(`${API_BASE}${p}`, { headers: portalHeaders() }); portalGuard(r); if (!r.ok) throw new Error(await r.text()); return r.json(); },
  post: async <T = any>(p: string, body: unknown): Promise<T> => { const r = await fetch(`${API_BASE}${p}`, { method: "POST", headers: portalHeaders(), body: JSON.stringify(body) }); portalGuard(r); if (!r.ok) throw new Error(await r.text()); return r.json(); },
  put: async <T = any>(p: string, body: unknown): Promise<T> => { const r = await fetch(`${API_BASE}${p}`, { method: "PUT", headers: portalHeaders(), body: JSON.stringify(body) }); portalGuard(r); if (!r.ok) throw new Error(await r.text()); return r.json(); },
  del: async (p: string): Promise<void> => { const r = await fetch(`${API_BASE}${p}`, { method: "DELETE", headers: portalHeaders() }); portalGuard(r); if (!r.ok) throw new Error(await r.text()); },
};
