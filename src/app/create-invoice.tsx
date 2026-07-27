// ─────────────────────────────────────────────────────────────
// CREATE / EDIT INVOICE — two-pane builder
// Left: collapsible sections you fill in. Right: the REAL PDF, re-rendered as you type (same
// renderer and layout the client receives — not a mock-up of one).
// ─────────────────────────────────────────────────────────────
import React, { useState, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronLeft, Plus, Trash2, FileText, Check } from "lucide-react";
import { api } from "./lib/api";
import { invoicePDFUrl, type PrintLayoutDef } from "./pdf";
import type { Client, Invoice, InvoiceStatus } from "./types";

export type InvoiceItem = { name: string; units: number; price: number };

const todayISO = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const money = (n: number, cur = "SAR") => `${cur} ${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

// A collapsible form section — the accordion the reference is built from.
function Section({ title, open, onToggle, done, children }: {
  title: string; open: boolean; onToggle: () => void; done?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <button onClick={onToggle} className="flex items-center justify-between w-full px-4 py-3 hover:bg-muted/40 transition-colors">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {done && <Check className="w-3.5 h-3.5 text-emerald-600" />}
        </span>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-3">{children}</div>}
    </div>
  );
}

export function CreateInvoiceScreen({ clients, invoices, onSaved, onCancel, editing }: {
  clients: Client[]; invoices: Invoice[];
  onSaved: (inv: Invoice) => void; onCancel: () => void;
  editing?: Invoice | null;
}) {
  const nextNumber = useMemo(() => {
    const y = new Date().getFullYear();
    const n = invoices.filter(i => (i.number || "").includes(`INV-${y}`)).length + 1;
    return `INV-${y}-${String(n).padStart(3, "0")}`;
  }, [invoices]);

  const [open, setOpen] = useState<string>("client");
  const [clientName, setClientName] = useState(editing?.client ?? "");
  const [clientQ, setClientQ] = useState(editing?.client ?? "");
  const [showSug, setShowSug] = useState(false);
  const [number, setNumber] = useState(editing?.number ?? nextNumber);
  const [subject, setSubject] = useState(editing?.services ?? "");
  const [issued, setIssued] = useState(editing?.date ?? todayISO());
  const [due, setDue] = useState(editing?.dueDate ?? plusDays(30));
  const [status, setStatus] = useState<InvoiceStatus>(editing?.status ?? "pending");
  const [notes, setNotes] = useState((editing as any)?.notes ?? "");
  const [items, setItems] = useState<InvoiceItem[]>(() => {
    const ex = (editing as any)?.items;
    if (Array.isArray(ex) && ex.length) return ex;
    return [{ name: editing?.services ?? "", units: 1, price: editing?.amount ?? 0 }];
  });
  const [saving, setSaving] = useState(false);
  const [layout, setLayout] = useState<PrintLayoutDef | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const lastUrl = useRef<string | null>(null);

  // Print with the admin-designed default layout, so the preview here is what actually prints.
  useEffect(() => { (async () => {
    try {
      const ls = await api.get("/api/print-layouts");
      const d = (Array.isArray(ls) ? ls : []).find((l: any) => l.target === "invoice" && l.isDefault);
      if (d) { const body = Array.isArray(d.blocks) ? d.blocks : []; setLayout({ name: d.name, target: d.target, elements: body, sections: body, settings: d.settings ?? {} } as any); }
    } catch { /* falls back to the built-in design */ }
  })(); }, []);

  const client = clients.find(c => c.name === clientName);
  const total = items.reduce((s, i) => s + (Number(i.units) || 0) * (Number(i.price) || 0), 0);

  // Live preview — debounced, and the previous object URL is revoked so we don't leak one per keystroke.
  useEffect(() => {
    const h = setTimeout(() => {
      try {
        const draft: any = {
          number, client: clientName || "—", amount: total, currency: "SAR", status,
          date: issued, dueDate: due, services: subject || items.map(i => i.name).filter(Boolean).join(", "),
          clientCity: client?.city ?? "", clientEmail: client?.email ?? "", clientPhone: client?.phone ?? "", clientCr: client?.cr ?? "",
          items: items.filter(i => i.name).map(i => ({ services: i.name, qty: String(i.units), rate: money(Number(i.price) || 0), amount: money((Number(i.units) || 0) * (Number(i.price) || 0)) })),
        };
        const url = invoicePDFUrl(draft, layout);
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = url;
        setPdfUrl(url);
      } catch { /* a half-typed field shouldn't break the preview */ }
    }, 400);
    return () => clearTimeout(h);
  }, [number, clientName, total, status, issued, due, subject, items, layout, client]);
  useEffect(() => () => { if (lastUrl.current) URL.revokeObjectURL(lastUrl.current); }, []);

  const suggestions = clients.filter(c => !clientQ || c.name.toLowerCase().includes(clientQ.toLowerCase())).slice(0, 6);
  const setItem = (i: number, patch: Partial<InvoiceItem>) => setItems(p => p.map((it, x) => x === i ? { ...it, ...patch } : it));

  const save = async (asDraft = false) => {
    if (!clientName) { toast.error("Pick a client"); setOpen("client"); return; }
    if (!number.trim()) { toast.error("Invoice number is required"); setOpen("details"); return; }
    if (total <= 0) { toast.error("Add at least one item with a price"); setOpen("details"); return; }
    setSaving(true);
    const body: any = {
      number: number.trim(), client: clientName, clientName, companyId: client?.id ?? null,
      amount: Math.round(total), currency: "SAR", status: asDraft ? "draft" : status,
      date: issued, dueDate: due,
      services: subject || items.map(i => i.name).filter(Boolean).join(", "),
      items: items.filter(i => i.name.trim()), notes: notes || null,
    };
    try {
      const saved = editing
        ? await api.put(`/api/invoices/${editing.id}`, body)
        : await api.post("/api/invoices", body);
      toast.success(editing ? "Invoice updated" : asDraft ? "Draft saved" : "Invoice created");
      onSaved({ ...(saved ?? body), id: saved?.id ?? editing?.id ?? `inv${Date.now()}`, client: clientName } as Invoice);
    } catch (e: any) { toast.error(String(e?.message || "Could not save")); } finally { setSaving(false); }
  };

  const inp = "w-full px-3 py-2 text-sm bg-muted border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40";
  const lbl = (t: string, req?: boolean) => <label className="block text-xs font-medium text-foreground mb-1">{t}{req && <span className="text-red-500 ml-0.5">*</span>}</label>;

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onCancel} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-fit">
        <ChevronLeft className="w-3.5 h-3.5" />Invoices
      </button>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* ── Form ── */}
        <div className="lg:col-span-5 space-y-3">
          <div>
            <h1 className="text-[22px] font-bold text-foreground tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{editing ? "Edit Invoice" : "Create New Invoice"}</h1>
            <p className="text-xs text-muted-foreground mt-1">Fill in invoice details</p>
            <p className="text-[11px] text-muted-foreground mt-2 flex items-start gap-1.5 rounded-lg bg-muted/60 border border-border px-2.5 py-2">
              <FileText className="w-3.5 h-3.5 mt-px flex-shrink-0 text-muted-foreground/70" />
              You can save an unfinished invoice as a draft and complete it later.
            </p>
          </div>

          {/* Client */}
          <Section title="Client Details" open={open === "client"} onToggle={() => setOpen(o => o === "client" ? "" : "client")} done={!!clientName}>
            <div className="relative">
              {lbl("Name", true)}
              <input value={clientQ} onChange={e => { setClientQ(e.target.value); setShowSug(true); }} onFocus={() => setShowSug(true)}
                placeholder="Search a client…" className={inp} />
              {showSug && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg py-1 z-20 max-h-52 overflow-auto">
                  {suggestions.map(c => (
                    <button key={c.id} onClick={() => { setClientName(c.name); setClientQ(c.name); setShowSug(false); }}
                      className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted text-left">
                      <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-[9px] font-bold flex items-center justify-center flex-shrink-0">{c.name.slice(0, 2).toUpperCase()}</span>
                      <span className="min-w-0"><span className="block text-xs font-medium text-foreground truncate">{c.name}</span><span className="block text-[10px] text-muted-foreground truncate">{c.email}</span></span>
                    </button>
                  ))}
                  {!suggestions.length && <p className="px-3 py-2 text-[11px] text-muted-foreground">No client matches.</p>}
                </div>
              )}
            </div>
            {client && (
              <div className="rounded-lg bg-muted/50 border border-border px-3 py-2 space-y-0.5">
                {[["Email", client.email], ["Phone", client.phone], ["City", client.city], ["CR", client.cr]].filter(([, v]) => v && v !== "—").map(([k, v]) => (
                  <p key={k as string} className="text-[11px]"><span className="text-muted-foreground">{k}: </span><span className="text-foreground">{v}</span></p>
                ))}
                <p className="text-[10px] text-muted-foreground/70 pt-1">Pulled from the client record — edit it under Clients.</p>
              </div>
            )}
            <button onClick={() => setOpen("details")} disabled={!clientName}
              className="text-xs font-semibold bg-primary text-primary-foreground px-4 py-1.5 rounded-lg disabled:opacity-50">Done</button>
          </Section>

          {/* Invoice details + items */}
          <Section title="Invoice Details" open={open === "details"} onToggle={() => setOpen(o => o === "details" ? "" : "details")} done={total > 0}>
            <div className="grid grid-cols-2 gap-2">
              <div>{lbl("Invoice Number", true)}<input value={number} onChange={e => setNumber(e.target.value)} className={inp} /></div>
              <div>{lbl("Status")}
                <select value={status} onChange={e => setStatus(e.target.value as InvoiceStatus)} className={inp}>
                  {["pending", "paid", "overdue", "draft"].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
            </div>
            <div>{lbl("Subject / Project")}<input value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Work Visa Processing" className={inp} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div>{lbl("Issued Date")}<input type="date" value={issued} onChange={e => setIssued(e.target.value)} className={inp} /></div>
              <div>{lbl("Due Date")}<input type="date" value={due} onChange={e => setDue(e.target.value)} className={inp} /></div>
            </div>

            <div className="pt-1 space-y-2">
              {items.map((it, i) => (
                <div key={i} className="rounded-lg border border-border bg-muted/40 p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">Item {i + 1}</span>
                    {items.length > 1 && <button onClick={() => setItems(p => p.filter((_, x) => x !== i))} className="p-1 rounded hover:bg-muted text-destructive"><Trash2 className="w-3 h-3" /></button>}
                  </div>
                  <input value={it.name} onChange={e => setItem(i, { name: e.target.value })} placeholder="Description" className={inp} />
                  <div className="grid grid-cols-3 gap-2 items-end">
                    <div>{lbl("Units")}<input type="number" min={0} value={it.units} onChange={e => setItem(i, { units: Number(e.target.value) })} className={inp} /></div>
                    <div>{lbl("Price")}<input type="number" min={0} value={it.price} onChange={e => setItem(i, { price: Number(e.target.value) })} className={inp} /></div>
                    <p className="text-xs font-semibold text-foreground pb-2 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>{money((Number(it.units) || 0) * (Number(it.price) || 0))}</p>
                  </div>
                </div>
              ))}
              <button onClick={() => setItems(p => [...p, { name: "", units: 1, price: 0 }])}
                className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"><Plus className="w-3 h-3" />Add Item</button>
            </div>

            <div className="flex items-center justify-between rounded-lg bg-primary/5 border border-primary/20 px-3 py-2">
              <span className="text-xs font-semibold text-foreground">Total</span>
              <span className="text-base font-bold text-primary" style={{ fontVariantNumeric: "tabular-nums" }}>{money(total)}</span>
            </div>
            <button onClick={() => setOpen("notes")} className="text-xs font-semibold bg-primary text-primary-foreground px-4 py-1.5 rounded-lg">Done</button>
          </Section>

          <Section title="Notes" open={open === "notes"} onToggle={() => setOpen(o => o === "notes" ? "" : "notes")} done={!!notes}>
            <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything the client should see on this invoice…" className={inp} />
            <p className="text-[10px] text-muted-foreground">Terms, footer and your business details come from the print layout (Settings → Configure → Print Layout).</p>
          </Section>

          <div className="flex gap-2 pt-1">
            <button onClick={() => save(false)} disabled={saving}
              className="flex-1 text-sm font-semibold bg-primary text-primary-foreground py-2.5 rounded-lg hover:opacity-90 disabled:opacity-60">{saving ? "Saving…" : editing ? "Save changes" : "Save Invoice"}</button>
            {!editing && <button onClick={() => save(true)} disabled={saving} className="text-sm font-semibold bg-card border border-border px-4 py-2.5 rounded-lg hover:bg-muted">Save as draft</button>}
          </div>
        </div>

        {/* ── Preview ── */}
        <div className="lg:col-span-7">
          <div className="bg-card rounded-xl border border-border p-3">
            <div className="flex items-center justify-between mb-2 px-1">
              <p className="text-sm font-bold text-foreground" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Preview</p>
              <span className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground bg-muted px-2 py-1 rounded-md"><FileText className="w-3 h-3" />PDF</span>
            </div>
            {pdfUrl
              ? <iframe src={pdfUrl} title="Invoice preview" className="rounded-lg border border-border bg-white" style={{ width: "100%", height: "72vh", display: "block" }} />
              : <div className="flex items-center justify-center rounded-lg border border-dashed border-border" style={{ height: "72vh" }}><p className="text-xs text-muted-foreground">Fill in the details to see the invoice</p></div>}
            <p className="text-[10px] text-muted-foreground mt-2 px-1">This is the real PDF, rendered with your default print layout.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
