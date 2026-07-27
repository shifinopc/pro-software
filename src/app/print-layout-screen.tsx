// ─────────────────────────────────────────────────────────────
// PRINT LAYOUT DESIGNER (Settings → Configure → Print Layout)
// Free-form: click anywhere on the page to drop in any field, then drag it where you want.
// The canvas and the PDF share one coordinate space (millimetres on A4), so what you position on
// screen is exactly where it prints — the preview is the real jsPDF document.
// ─────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Eye, X, FileText, Copy } from "lucide-react";
import { api } from "./lib/api";
import {
  DEFAULT_INVOICE_ELEMENTS, DEFAULT_INVOICE_SETTINGS, INVOICE_FIELD_CATALOG,
  elementPreviewUrl, elementData, isElementLayout, PAGE_W, PAGE_H,
  type PrintEl, type PrintElKind, type ElementLayoutDef,
} from "./pdf";

const SAMPLE = {
  number: "INV-2026-001", client: "IONOB INNOVATIONS LLP", clientCity: "Riyadh",
  clientEmail: "accounts@ionob.com", clientPhone: "+966 50 123 4567", clientCr: "1010123456",
  services: "Work Visa Processing — Ahmed Al-Rashid", qty: "1",
  amountNum: 2000, currency: "SAR", date: "15 Jul 2026", dueDate: "15 Aug 2026", status: "PAID",
};

const uid = (n: number) => `e${n.toString(36)}${Math.floor(performance.now() % 1e6).toString(36)}`;

export function PrintLayoutScreen() {
  const [layouts, setLayouts] = useState<any[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<(ElementLayoutDef & { id?: string; isDefault?: boolean }) | null>(null);
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null); // insertion point (mm)
  const [selEl, setSelEl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [tab, setTab] = useState<"page" | "business">("page");
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const load = async () => { try { const d = await api.get("/api/print-layouts"); setLayouts(Array.isArray(d) ? d : []); } catch { /* offline */ } };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!selId && layouts.length) setSelId(layouts[0].id); }, [layouts, selId]);
  useEffect(() => {
    const l = layouts.find(x => x.id === selId);
    if (!l) { setDraft(null); return; }
    const cand = { id: l.id, name: l.name, target: l.target, isDefault: l.isDefault, elements: Array.isArray(l.blocks) ? l.blocks : [], settings: l.settings ?? {} } as any;
    // Layouts saved in an older shape can't be edited here — start them from the default design so
    // opening repairs them (Save persists the repair) rather than showing a blank page.
    if (!isElementLayout(cand)) {
      cand.elements = JSON.parse(JSON.stringify(DEFAULT_INVOICE_ELEMENTS));
      cand.settings = { ...DEFAULT_INVOICE_SETTINGS, ...(cand.settings ?? {}) };
    }
    setDraft(cand); setSelEl(null);
  }, [selId, layouts]);

  // px ⇄ mm
  const scale = () => (canvasRef.current?.clientWidth ?? 1) / PAGE_W;
  const toMM = (px: number) => px / scale();

  const setEls = (fn: (e: PrintEl[]) => PrintEl[]) => setDraft(d => d ? { ...d, elements: fn(d.elements) } : d);
  const patchEl = (id: string, patch: Partial<PrintEl>) => setEls(es => es.map(e => e.id === id ? { ...e, ...patch } : e));
  const el = draft?.elements.find(e => e.id === selEl) ?? null;

  const insert = (kind: PrintElKind, field?: string, label?: string) => {
    if (!pick || !draft) return;
    const id = uid(draft.elements.length + 1);
    const base: PrintEl = { id, kind, x: Math.round(pick.x), y: Math.round(pick.y), w: kind === "table" ? 182 : 60, size: 10 };
    if (kind === "field") { base.field = field; base.label = label; }
    if (kind === "text") base.text = "Text";
    if (kind === "line") { base.w = 60; base.color = "#c8c8c8"; }
    if (kind === "box") { base.w = 60; base.h = 10; base.fill = "#eeeeee"; }
    if (kind === "table") base.columns = [{ key: "services", label: "Description", align: "left" }, { key: "amount", label: "Amount", align: "right" }];
    setEls(es => [...es, base]); setSelEl(id); setPick(null);
  };

  const onCanvasClick = (e: React.MouseEvent) => {
    if (drag.current) return;
    const r = canvasRef.current!.getBoundingClientRect();
    setPick({ x: toMM(e.clientX - r.left), y: toMM(e.clientY - r.top) });
    setSelEl(null);
  };
  const onPointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const r = canvasRef.current!.getBoundingClientRect();
    const target = draft!.elements.find(x => x.id === id)!;
    drag.current = { id, dx: toMM(e.clientX - r.left) - target.x, dy: toMM(e.clientY - r.top) - target.y };
    setSelEl(id); setPick(null);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(PAGE_W - 4, toMM(e.clientX - r.left) - drag.current.dx));
    const y = Math.max(0, Math.min(PAGE_H - 4, toMM(e.clientY - r.top) - drag.current.dy));
    patchEl(drag.current.id, { x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2 });
  };
  const onPointerUp = () => { setTimeout(() => { drag.current = null; }, 0); };

  const create = async () => {
    if (!newName.trim()) { toast.error("Layout name is required"); return; }
    try {
      const created = await api.post("/api/print-layouts", {
        name: newName.trim(), target: "invoice",
        blocks: DEFAULT_INVOICE_ELEMENTS, settings: DEFAULT_INVOICE_SETTINGS,
        isDefault: !layouts.some(l => l.target === "invoice" && l.isDefault),
      });
      setLayouts(p => [created, ...p]); setSelId(created.id); setShowNew(false); setNewName("");
      toast.success("Layout created — drag things around, or click the page to add a field");
    } catch (e: any) { toast.error(String(e?.message || "Could not create")); }
  };
  const save = async () => {
    if (!draft) return; setSaving(true);
    try {
      const up = await api.put(`/api/print-layouts/${draft.id}`, { name: draft.name, target: draft.target, blocks: draft.elements, settings: draft.settings, isDefault: !!draft.isDefault });
      setLayouts(p => p.map(l => l.id === up.id ? up : l)); toast.success("Layout saved");
    } catch (e: any) { toast.error(String(e?.message || "Save failed")); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!draft || !confirm(`Delete “${draft.name}”? Invoices fall back to the built-in design.`)) return;
    try { await api.del(`/api/print-layouts/${draft.id}`); const rest = layouts.filter(l => l.id !== draft.id); setLayouts(rest); setSelId(rest[0]?.id ?? null); toast.success("Layout deleted"); }
    catch (e: any) { toast.error(String(e?.message)); }
  };
  const makeDefault = async () => {
    if (!draft) return;
    try {
      await Promise.all(layouts.filter(l => l.target === draft.target && l.isDefault && l.id !== draft.id).map(l => api.put(`/api/print-layouts/${l.id}`, { isDefault: false })));
      await api.put(`/api/print-layouts/${draft.id}`, { isDefault: true });
      toast.success("This layout now prints your invoices"); await load();
    } catch (e: any) { toast.error(String(e?.message)); }
  };
  const openPreview = () => { if (draft) try { setPreview(elementPreviewUrl(draft, SAMPLE)); } catch { toast.error("Could not render"); } };
  const closePreview = () => { if (preview) URL.revokeObjectURL(preview); setPreview(null); };

  const inputCls = "w-full px-2.5 py-1.5 text-xs bg-muted border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring/40";
  const st = draft?.settings ?? {};
  const accent = st.accent ?? "#7105ef";
  const data = draft ? elementData(draft, SAMPLE) : {};
  const labelFor = (k?: string) => INVOICE_FIELD_CATALOG.flatMap(g => g.items).find(i => i.key === k)?.label ?? k ?? "";

  return (
    <div onClick={() => setPick(null)}>
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-base font-bold text-foreground" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Print Layout</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Click anywhere on the page to drop in a field, then drag it into place. The preview is the real PDF.</p>
        </div>
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <select value={selId ?? ""} onChange={e => setSelId(e.target.value || null)} className="px-2.5 py-1.5 text-xs bg-muted border border-border rounded-lg" style={{ minWidth: 180 }}>
            <option value="">{layouts.length ? "Select a layout…" : "No layouts yet"}</option>
            {layouts.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefault ? " (in use)" : ""}</option>)}
          </select>
          <button onClick={() => setShowNew(true)} className="flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:opacity-90"><Plus className="w-3.5 h-3.5" />New</button>
        </div>
      </div>

      {!draft ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center">
          <FileText className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-semibold text-foreground">No layout selected</p>
          <p className="text-xs text-muted-foreground mt-1">Create one — it starts from a ready-made modern invoice you can rearrange.</p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3 flex-wrap" onClick={e => e.stopPropagation()}>
            <input value={draft.name} onChange={e => setDraft(d => d ? { ...d, name: e.target.value } : d)} className={`${inputCls} font-semibold`} style={{ width: 170 }} />
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(["page", "business"] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-semibold ${tab === t ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>{t === "page" ? "Page" : "Business details"}</button>
              ))}
            </div>
            <label className="text-[10px] text-muted-foreground ml-1">Accent</label>
            <input type="color" value={accent} onChange={e => setDraft(d => d ? { ...d, settings: { ...d.settings, accent: e.target.value } } : d)} className="w-8 h-7 rounded border border-border bg-muted" />
            {draft.isDefault
              ? <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Printing your invoices</span>
              : <button onClick={makeDefault} className="text-[10px] font-semibold text-primary border border-primary/40 px-2 py-0.5 rounded-full hover:bg-primary/5">Use for invoices</button>}
            <div className="ml-auto flex gap-1.5">
              <button onClick={openPreview} className="flex items-center gap-1.5 text-xs bg-card border border-border px-2.5 py-1.5 rounded-lg hover:bg-muted"><Eye className="w-3.5 h-3.5" />Preview PDF</button>
              <button onClick={remove} className="flex items-center gap-1.5 text-xs bg-card border border-border px-2.5 py-1.5 rounded-lg hover:bg-muted text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
              <button onClick={save} disabled={saving} className="text-xs font-semibold bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:opacity-90 disabled:opacity-60">{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>

          {tab === "business" ? (
            <div className="bg-card rounded-xl border border-border p-4" onClick={e => e.stopPropagation()}>
              <p className="text-xs text-muted-foreground mb-3">Typed once, printed on every invoice. Drop them on the page from the <span className="font-semibold">Your business</span> group.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-3xl">
                {[["orgName", "Business name"], ["tagline", "Tagline"], ["orgAddress", "Address"], ["orgEmail", "Email"], ["orgPhone", "Phone"], ["orgVat", "VAT / CR number"], ["vatRate", "VAT rate (%)"], ["termsText", "Terms text"], ["footerText", "Footer text"]].map(([k, lb]) => (
                  <div key={k} className={k.endsWith("Text") ? "md:col-span-2" : ""}>
                    <label className="block text-[10px] font-semibold text-muted-foreground mb-1">{lb}</label>
                    {k.endsWith("Text")
                      ? <textarea rows={2} value={st[k] ?? ""} onChange={e => setDraft(d => d ? { ...d, settings: { ...d.settings, [k]: e.target.value } } : d)} className={inputCls} />
                      : <input type={k === "vatRate" ? "number" : "text"} value={st[k] ?? ""} onChange={e => setDraft(d => d ? { ...d, settings: { ...d.settings, [k]: k === "vatRate" ? Number(e.target.value) : e.target.value } } : d)} className={inputCls} />}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* ── The page ── */}
              <div className="lg:col-span-7" onClick={e => e.stopPropagation()}>
                <div className="bg-card rounded-xl border border-border p-3">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-2">A4 page — click empty space to add, drag to move</p>
                  <div ref={canvasRef} onClick={onCanvasClick} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                    className="relative bg-white rounded-lg border border-border shadow-sm mx-auto select-none"
                    style={{ width: "100%", maxWidth: 420, aspectRatio: `${PAGE_W} / ${PAGE_H}`, cursor: "crosshair", overflow: "hidden" }}>
                    {draft.elements.map(e => {
                      const pct = (v: number, total: number) => `${(v / total) * 100}%`;
                      const isSel = selEl === e.id;
                      const common: React.CSSProperties = {
                        position: "absolute", left: pct(e.x, PAGE_W), top: pct(e.y, PAGE_H), width: pct(e.w, PAGE_W),
                        outline: isSel ? "1.5px solid var(--primary)" : undefined,
                        outlineOffset: 1, cursor: "move", touchAction: "none",
                      };
                      if (e.kind === "box") return <div key={e.id} onPointerDown={ev => onPointerDown(ev, e.id)} style={{ ...common, height: pct(e.h ?? 10, PAGE_H), background: e.fill === "accent" ? accent : e.fill }} />;
                      if (e.kind === "line") return <div key={e.id} onPointerDown={ev => onPointerDown(ev, e.id)} style={{ ...common, height: 2, background: e.color ?? "#c8c8c8" }} />;
                      if (e.kind === "table") return (
                        <div key={e.id} onPointerDown={ev => onPointerDown(ev, e.id)} style={{ ...common, fontSize: 6 }}>
                          <div className="flex text-white font-semibold" style={{ background: accent }}>
                            {(e.columns ?? []).map(c => <div key={c.key} className="flex-1 px-1 py-0.5">{c.label}</div>)}
                          </div>
                          <div className="flex bg-slate-50 text-slate-600">
                            {(e.columns ?? []).map(c => <div key={c.key} className="flex-1 px-1 py-0.5 truncate">{String((data as any)[c.key] ?? "")}</div>)}
                          </div>
                        </div>
                      );
                      const v = e.kind === "field" ? String((data as any)[e.field ?? ""] ?? "") : (e.text ?? "");
                      return (
                        <div key={e.id} onPointerDown={ev => onPointerDown(ev, e.id)} style={{ ...common, textAlign: e.align ?? "left" }}>
                          {e.label && <div style={{ fontSize: 4.5, color: "#9a9a9a", textTransform: "uppercase", letterSpacing: .3 }}>{e.label}</div>}
                          <div style={{
                            fontSize: `${(e.size ?? 10) * 0.62}px`, fontWeight: e.bold ? 700 : 400, lineHeight: 1.15,
                            color: e.color === "accent" ? accent : (e.color ?? "#282828"),
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          }}>{v || <span style={{ color: "#cbd5e1", fontStyle: "italic" }}>{labelFor(e.field)}</span>}</div>
                        </div>
                      );
                    })}

                    {/* insertion marker */}
                    {pick && <div className="absolute rounded-full bg-primary" style={{ left: `${(pick.x / PAGE_W) * 100}%`, top: `${(pick.y / PAGE_H) * 100}%`, width: 6, height: 6, transform: "translate(-3px,-3px)" }} />}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-2 text-center">{draft.elements.length} elements · A4 210×297mm</p>
                </div>
              </div>

              {/* ── Right rail: insert picker or element properties ── */}
              <div className="lg:col-span-5" onClick={e => e.stopPropagation()}>
                <div className="bg-card rounded-xl border border-border p-4">
                  {pick ? (
                    <>
                      <p className="text-sm font-bold text-foreground mb-0.5" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Insert here</p>
                      <p className="text-[10px] text-muted-foreground mb-3">at {Math.round(pick.x)}mm, {Math.round(pick.y)}mm — pick what to place</p>
                      <div style={{ maxHeight: "46vh", overflowY: "auto" }} className="space-y-3">
                        {INVOICE_FIELD_CATALOG.map(g => (
                          <div key={g.group}>
                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-1">{g.group}</p>
                            <div className="grid grid-cols-2 gap-1">
                              {g.items.map(i => (
                                <button key={i.key} onClick={() => insert("field", i.key, i.label)}
                                  className="text-left text-[11px] px-2 py-1.5 rounded-lg border border-border hover:border-primary hover:bg-primary/5 text-foreground truncate">{i.label}</button>
                              ))}
                            </div>
                          </div>
                        ))}
                        <div>
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-1">Other</p>
                          <div className="grid grid-cols-2 gap-1">
                            {([["text", "Static text"], ["table", "Items table"], ["line", "Divider line"], ["box", "Colour block"]] as [PrintElKind, string][]).map(([k, lb]) => (
                              <button key={k} onClick={() => insert(k)} className="text-left text-[11px] px-2 py-1.5 rounded-lg border border-border hover:border-primary hover:bg-primary/5 text-foreground">{lb}</button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : el ? (
                    <>
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="text-sm font-bold text-foreground" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{el.kind === "field" ? labelFor(el.field) : el.kind === "text" ? "Static text" : el.kind === "table" ? "Items table" : el.kind === "line" ? "Divider" : "Colour block"}</p>
                          <p className="text-[10px] text-muted-foreground">{el.kind === "field" ? <>dynamic · <span className="font-mono">{el.field}</span></> : "fixed"}</p>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => { const c = { ...el, id: uid(Date.now()), x: el.x + 4, y: el.y + 4 }; setEls(es => [...es, c]); setSelEl(c.id); }} className="p-1.5 rounded hover:bg-muted text-muted-foreground" title="Duplicate"><Copy className="w-3.5 h-3.5" /></button>
                          <button onClick={() => { setEls(es => es.filter(x => x.id !== el.id)); setSelEl(null); }} className="p-1.5 rounded hover:bg-muted text-destructive" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {el.kind === "field" && (
                          <div>
                            <label className="block text-[10px] text-muted-foreground mb-0.5">Field</label>
                            <select value={el.field ?? ""} onChange={ev => patchEl(el.id, { field: ev.target.value })} className={inputCls}>
                              {INVOICE_FIELD_CATALOG.map(g => <optgroup key={g.group} label={g.group}>{g.items.map(i => <option key={i.key} value={i.key}>{i.label}</option>)}</optgroup>)}
                            </select>
                          </div>
                        )}
                        {el.kind === "text" && <div><label className="block text-[10px] text-muted-foreground mb-0.5">Text</label><input value={el.text ?? ""} onChange={ev => patchEl(el.id, { text: ev.target.value })} className={inputCls} /></div>}
                        {(el.kind === "field" || el.kind === "text") && (
                          <>
                            <div><label className="block text-[10px] text-muted-foreground mb-0.5">Caption above (optional)</label><input value={el.label ?? ""} onChange={ev => patchEl(el.id, { label: ev.target.value || undefined })} className={inputCls} placeholder="e.g. Bill to" /></div>
                            <div className="grid grid-cols-3 gap-1.5">
                              <div><label className="block text-[10px] text-muted-foreground mb-0.5">Size</label><input type="number" value={el.size ?? 10} onChange={ev => patchEl(el.id, { size: Number(ev.target.value) })} className={inputCls} /></div>
                              <div><label className="block text-[10px] text-muted-foreground mb-0.5">Weight</label><select value={el.bold ? "b" : "n"} onChange={ev => patchEl(el.id, { bold: ev.target.value === "b" })} className={inputCls}><option value="n">Normal</option><option value="b">Bold</option></select></div>
                              <div><label className="block text-[10px] text-muted-foreground mb-0.5">Align</label><select value={el.align ?? "left"} onChange={ev => patchEl(el.id, { align: ev.target.value as any })} className={inputCls}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div>
                            </div>
                            <div><label className="block text-[10px] text-muted-foreground mb-0.5">Colour</label>
                              <div className="flex gap-1.5 items-center">
                                <input type="color" value={el.color && el.color !== "accent" ? el.color : "#282828"} onChange={ev => patchEl(el.id, { color: ev.target.value })} className="w-8 h-7 rounded border border-border bg-muted" />
                                <button onClick={() => patchEl(el.id, { color: "accent" })} className={`text-[10px] px-2 py-1 rounded border ${el.color === "accent" ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>Use accent</button>
                                <button onClick={() => patchEl(el.id, { color: "#ffffff" })} className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground">White</button>
                              </div>
                            </div>
                          </>
                        )}
                        {el.kind === "box" && <div><label className="block text-[10px] text-muted-foreground mb-0.5">Fill</label><div className="flex gap-1.5 items-center"><input type="color" value={el.fill && el.fill !== "accent" ? el.fill : accent} onChange={ev => patchEl(el.id, { fill: ev.target.value })} className="w-8 h-7 rounded border border-border bg-muted" /><button onClick={() => patchEl(el.id, { fill: "accent" })} className={`text-[10px] px-2 py-1 rounded border ${el.fill === "accent" ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>Use accent</button></div></div>}
                        <div className="grid grid-cols-4 gap-1.5 pt-1">
                          {(["x", "y", "w"] as const).map(k => (
                            <div key={k}><label className="block text-[10px] text-muted-foreground mb-0.5">{k.toUpperCase()} mm</label><input type="number" value={(el as any)[k] ?? 0} onChange={ev => patchEl(el.id, { [k]: Number(ev.target.value) } as any)} className={inputCls} /></div>
                          ))}
                          {(el.kind === "box") && <div><label className="block text-[10px] text-muted-foreground mb-0.5">H mm</label><input type="number" value={el.h ?? 10} onChange={ev => patchEl(el.id, { h: Number(ev.target.value) })} className={inputCls} /></div>}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-10">
                      <Plus className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="text-xs font-semibold text-foreground">Click anywhere on the page</p>
                      <p className="text-[11px] text-muted-foreground mt-1">to insert a field there — or click an element to edit it.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowNew(false)}>
          <div className="bg-card rounded-2xl border border-border shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <p className="text-base font-bold text-foreground mb-3" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>New print layout</p>
            <label className="block text-xs font-medium text-foreground mb-1">Name *</label>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Invoice — VAT" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-muted" />
            <p className="text-[10px] text-muted-foreground mt-1">Starts from a ready-made modern invoice — rearrange rather than build from scratch.</p>
            <div className="flex gap-3 pt-4">
              <button onClick={create} className="flex-1 text-sm font-semibold bg-primary text-primary-foreground py-2 rounded-lg hover:opacity-90">Create</button>
              <button onClick={() => setShowNew(false)} className="text-sm bg-card border border-border px-4 py-2 rounded-lg hover:bg-muted">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={closePreview}>
          <div className="bg-card rounded-2xl border border-border shadow-2xl w-full max-w-3xl p-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-2 pb-2">
              <p className="text-sm font-bold text-foreground" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{draft?.name} — real PDF</p>
              <button onClick={closePreview} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
            <iframe src={preview} title="Layout preview" className="rounded-lg border border-border bg-white" style={{ width: "100%", height: "76vh", display: "block" }} />
          </div>
        </div>
      )}
    </div>
  );
}
