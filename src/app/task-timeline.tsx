// ─────────────────────────────────────────────────────────────
// MY TASK — schedule timeline (Settings-free; lives inside the Tasks hub)
// Department → assignee rows, with each task drawn as a bar across a date axis.
//
// Why days and not hours: a Task carries a dueDate (a date) and no start time or duration, so an
// hour axis has nothing to position against. PRO work also spans weeks, not 06:00–09:59 — a visa
// renewal is a multi-day case. Bars therefore run [start → due], where start is the task's own
// createdAt if it has one, else a lane-stable estimate from its priority.
// ─────────────────────────────────────────────────────────────
import React, { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Calendar as CalIcon } from "lucide-react";
import type { Task, Role } from "./types";

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s?: string): Date | null => { if (!s || s === "—") return null; const d = new Date(s); return isNaN(+d) ? null : d; };

// How long a task is assumed to take when we only know when it's due.
const SPAN_DAYS: Record<string, number> = { critical: 2, high: 3, medium: 5, low: 8 };

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Administration", admin: "Administration", pro_officer: "PRO Officers",
  accountant: "Finance", sales: "Sales", client_admin: "Client",
};
const LANE_TINT = [
  { bar: "#10b981", soft: "#ecfdf5", text: "#065f46" }, // emerald
  { bar: "#3b82f6", soft: "#eff6ff", text: "#1e40af" }, // blue
  { bar: "#8b5cf6", soft: "#f5f3ff", text: "#5b21b6" }, // violet
  { bar: "#f59e0b", soft: "#fffbeb", text: "#92400e" }, // amber
  { bar: "#ef4444", soft: "#fef2f2", text: "#991b1b" }, // red
];

type Staff = { name: string; roleId?: string };

export function MyTaskTimeline({ tasks, staff, role, me, onOpen }: {
  tasks: Task[]; staff: Staff[]; role: Role; me: string;
  onOpen?: (t: Task) => void;
}) {
  const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [days, setDays] = useState(14);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [statusF, setStatusF] = useState("All");
  const [deptF, setDeptF] = useState("All");

  const isAdmin = role === "admin" || role === "super_admin";
  const cols = useMemo(() => Array.from({ length: days }, (_, i) => new Date(+anchor + i * DAY)), [anchor, days]);
  const start0 = +anchor, end0 = +anchor + days * DAY;

  // Bar geometry, in % of the timeline width.
  const barFor = (t: Task) => {
    const due = parse(t.dueDate);
    if (!due) return null;
    due.setHours(0, 0, 0, 0);
    const span = SPAN_DAYS[t.priority] ?? 4;
    const s = +due - (span - 1) * DAY;
    const e = +due + DAY; // inclusive of the due day
    if (e <= start0 || s >= end0) return null; // outside the window
    const left = ((Math.max(s, start0) - start0) / (end0 - start0)) * 100;
    const width = ((Math.min(e, end0) - Math.max(s, start0)) / (end0 - start0)) * 100;
    return { left, width: Math.max(width, 1.5), clippedLeft: s < start0, clippedRight: e > end0 };
  };

  // Rows: department (role) → the people in it. Non-admins only ever see their own lane.
  const groups = useMemo(() => {
    const visible = isAdmin ? tasks : tasks.filter(t => t.assignee === me);
    const pool = visible.filter(t => !t.archived)
      .filter(t => statusF === "All" || t.status === statusF);
    const byName = new Map(staff.map(s => [s.name, s.roleId ?? "pro_officer"]));
    const out = new Map<string, Map<string, Task[]>>();
    for (const t of pool) {
      const who = t.assignee || "Unassigned";
      const dept = who === "Unassigned" ? "Unassigned" : (ROLE_LABEL[byName.get(who) ?? ""] ?? "PRO Officers");
      if (deptF !== "All" && dept !== deptF) continue;
      if (!out.has(dept)) out.set(dept, new Map());
      const g = out.get(dept)!;
      if (!g.has(who)) g.set(who, []);
      g.get(who)!.push(t);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tasks, staff, statusF, deptF, isAdmin, me]);

  const depts = useMemo(() => {
    const byName = new Map(staff.map(s => [s.name, s.roleId ?? "pro_officer"]));
    return [...new Set(tasks.map(t => t.assignee === "Unassigned" || !t.assignee ? "Unassigned" : (ROLE_LABEL[byName.get(t.assignee) ?? ""] ?? "PRO Officers")))];
  }, [tasks, staff]);

  const shift = (n: number) => setAnchor(a => new Date(+a + n * DAY));
  const fmtCol = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit" });
  const fmtMon = (d: Date) => d.toLocaleDateString("en-GB", { month: "short" });
  const isToday = (d: Date) => iso(d) === iso(new Date());
  const isWeekend = (d: Date) => [5, 6].includes(d.getDay()); // Fri/Sat — Saudi week
  const sel = "px-2.5 py-1.5 text-xs bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring/40";

  const total = groups.reduce((n, [, g]) => n + [...g.values()].flat().length, 0);

  return (
    <div>
      {/* controls */}
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <button onClick={() => shift(-days)} className="p-1.5 rounded-lg border border-border bg-card hover:bg-muted text-muted-foreground" title="Earlier"><ChevronRight className="w-3.5 h-3.5 rotate-180" /></button>
          <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold bg-card border border-border rounded-lg text-foreground">
            <CalIcon className="w-3.5 h-3.5 text-muted-foreground" />
            {anchor.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – {new Date(+anchor + (days - 1) * DAY).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          </span>
          <button onClick={() => shift(days)} className="p-1.5 rounded-lg border border-border bg-card hover:bg-muted text-muted-foreground" title="Later"><ChevronRight className="w-3.5 h-3.5" /></button>
          <button onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d); }} className="ml-1 px-2 py-1.5 text-[11px] font-semibold text-primary border border-primary/40 rounded-lg hover:bg-primary/5">Today</button>
        </div>
        <div className="flex items-center gap-1.5">
          <select value={days} onChange={e => setDays(Number(e.target.value))} className={sel}>
            <option value={7}>Week</option><option value={14}>2 weeks</option><option value={30}>Month</option>
          </select>
          <select value={statusF} onChange={e => setStatusF(e.target.value)} className={sel}>
            {["All", "todo", "in_progress", "review", "done"].map(s => <option key={s} value={s}>{s === "All" ? "Status" : s.replace("_", " ")}</option>)}
          </select>
          {isAdmin && (
            <select value={deptF} onChange={e => setDeptF(e.target.value)} className={sel}>
              <option value="All">All Departments</option>
              {depts.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* timeline */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 720 }}>
            {/* header */}
            <div className="flex border-b border-border bg-muted/30 sticky top-0">
              <div className="flex-shrink-0 px-4 py-2.5 text-[11px] font-bold text-muted-foreground uppercase tracking-wide" style={{ width: 190 }}>Department</div>
              <div className="flex-1 flex">
                {cols.map(d => (
                  <div key={+d} className={`flex-1 text-center py-2.5 border-l border-border/50 ${isToday(d) ? "bg-primary/5" : isWeekend(d) ? "bg-muted/40" : ""}`}>
                    <p className={`text-[10px] font-semibold ${isToday(d) ? "text-primary" : "text-foreground"}`}>{fmtCol(d)}</p>
                    <p className="text-[8px] text-muted-foreground uppercase">{fmtMon(d)}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* groups */}
            {groups.map(([dept, people], gi) => {
              const tint = LANE_TINT[gi % LANE_TINT.length];
              const open = !collapsed[dept];
              return (
                <div key={dept}>
                  <button onClick={() => setCollapsed(c => ({ ...c, [dept]: !c[dept] }))}
                    className="flex items-center gap-1.5 w-full px-4 py-2 bg-muted/40 border-b border-border hover:bg-muted/60 transition-colors">
                    {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                    <span className="text-xs font-bold text-foreground">{dept}</span>
                    <span className="text-[10px] text-muted-foreground">{[...people.values()].flat().length}</span>
                  </button>
                  {open && [...people.entries()].map(([who, list]) => (
                    <div key={who} className="flex border-b border-border/60 hover:bg-muted/20 transition-colors" style={{ minHeight: 44 }}>
                      <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2" style={{ width: 190 }}>
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tint.bar }} />
                        <span className="text-xs text-foreground truncate">{who}</span>
                      </div>
                      <div className="flex-1 relative">
                        {/* day grid */}
                        <div className="absolute inset-0 flex pointer-events-none">
                          {cols.map(d => <div key={+d} className={`flex-1 border-l border-border/40 ${isToday(d) ? "bg-primary/5" : isWeekend(d) ? "bg-muted/30" : ""}`} />)}
                        </div>
                        {/* bars */}
                        <div className="relative py-1.5 space-y-1">
                          {list.map(t => {
                            const b = barFor(t);
                            if (!b) return null;
                            const done = t.status === "done";
                            return (
                              <div key={t.id} onClick={() => onOpen?.(t)}
                                title={`${t.title} · ${t.client} · due ${t.dueDate}`}
                                className="relative h-6 rounded-md flex items-center px-2 cursor-pointer hover:brightness-95 transition-all"
                                style={{
                                  marginLeft: `${b.left}%`, width: `${b.width}%`,
                                  background: done ? "#f1f5f9" : tint.soft,
                                  border: `1px solid ${done ? "#e2e8f0" : tint.bar}`,
                                  borderLeftWidth: b.clippedLeft ? 1 : 3,
                                  borderLeftColor: done ? "#cbd5e1" : tint.bar,
                                  opacity: done ? 0.65 : 1,
                                }}>
                                <span className="text-[10px] font-medium truncate" style={{ color: done ? "#64748b" : tint.text, textDecoration: done ? "line-through" : undefined }}>
                                  {t.title}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}

            {!groups.length && (
              <div className="py-16 text-center">
                <p className="text-sm font-semibold text-foreground">Nothing scheduled</p>
                <p className="text-xs text-muted-foreground mt-1">{isAdmin ? "No tasks fall in this window." : "You have no tasks in this window."}</p>
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground mt-2">
        {total} task{total === 1 ? "" : "s"} · bars run from the estimated start to the due date{isAdmin ? "" : " · showing only your tasks"}. Click a bar to open it.
      </p>
    </div>
  );
}
