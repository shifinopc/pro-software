/**
 * What is still pointing at a piece of configuration, in the words a person would use.
 *
 * WHY THIS EXISTS
 *
 * Deleting configuration that something still references does not fail. The references are names and
 * ids held in strings and JSON — `Document.docType`, `ServiceItem.docType`, an `issue_document`
 * node's `config.docType`, `DocumentType.authority` — so there is no foreign key to refuse, and the
 * row simply goes. What is left behind reads perfectly and does nothing:
 *
 *   · an issue_document step naming a type that no longer exists still runs, and creates a document
 *     with no authority and default lead days
 *   · a client document whose type was removed drops out of every list that joins on the type
 *   · an authority nothing can name leaves its documents saying they came from nowhere
 *
 * That is not hypothetical here. Six issue_document steps were left pointing at nothing when the
 * document types were removed, and separately a soft-deleted customer dropped approved orders out of
 * a list that inner-joined it. Same shape both times: a delete that nothing objected to.
 *
 * So: a row that is still referenced is RETIRED rather than deleted — it stops appearing in pickers,
 * and everything already pointing at it keeps working. This is the rule the picklists already follow;
 * it just never reached the tables that go through the generic CRUD.
 *
 * One implementation, because the console asks "may I delete this?" before offering the button and
 * the API decides again when the button is pressed. Two of them is how a screen offers a delete that
 * then fails.
 *
 * SERVICE ITEMS ARE DELIBERATELY NOT HERE. They already have their own DELETE in index.ts that
 * refuses with 409 and names the plans, clients and open requests holding them — a refusal rather
 * than a retire, which is right for something being sold: a service inside a plan should be taken
 * out of the plan by a person who knows what that plan is for. Adding them here would be a second
 * opinion on the same question, and the routes are registered such that this one would never even
 * be consulted.
 */
import { prisma } from "./db.js";

/** Config tables that must not lose a referenced row. Anything not listed keeps plain delete. */
export const GUARDED = new Set(["documentType", "govCenter"]);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Sentences naming what still points at `id`. Empty means it is safe to delete outright.
 * Unknown models return empty — a guard that invents reasons for tables it does not understand
 * would block deletes nobody asked it to block.
 */
export async function configUsage(model: string, id: string): Promise<string[]> {
  const out: string[] = [];
  const add = (s: string) => out.push(s);

  if (model === "documentType") {
    const row = await prisma.documentType.findUnique({ where: { id } });
    if (!row) return out;
    const name = row.name;

    const docs = await prisma.document.count({ where: { docType: name } });
    if (docs) add(`${plural(docs, "client document")} of this type`);

    const svcs = await prisma.serviceItem.findMany({ where: { docType: name }, select: { name: true } });
    for (const s of svcs) add(`Service "${s.name}"`);

    // Both spellings: a node may name the type or carry its id.
    for (const t of await prisma.workflowTemplate.findMany({ select: { name: true, graph: true } })) {
      for (const n of (((t.graph as any)?.nodes ?? []) as any[])) {
        const dt = String(n?.config?.docType ?? "").trim();
        if (dt && (dt === name || dt === id)) add(`Workflow "${t.name}" → step "${n.label ?? n.id}"`);
      }
    }

    // A checklist row can ask for a document BY TYPE (source: "document"), which is a reference the
    // rule editor shows as a picker and stores as a name.
    for (const r of await prisma.checklistRule.findMany({ select: { name: true, rows: true } })) {
      const rows: any[] = Array.isArray(r.rows) ? (r.rows as any[]) : [];
      const hit = rows.some(rw => (rw?.documents ?? rw?.items ?? []).some((it: any) => it?.source === "document" && String(it?.docType ?? "") === name));
      if (hit) add(`Checklist rule "${r.name}"`);
    }
  }

  if (model === "govCenter") {
    const row = await prisma.govCenter.findUnique({ where: { id } });
    if (!row) return out;
    const name = row.name;

    const dts = await prisma.documentType.findMany({ where: { authority: name }, select: { name: true } });
    for (const d of dts) add(`Document type "${d.name}"`);
    const tasks = await prisma.task.count({ where: { govCenter: name } });
    if (tasks) add(`${plural(tasks, "task")} filed under this authority`);
    const wtasks = await prisma.workflowTask.count({ where: { govCenter: name } });
    if (wtasks) add(`${plural(wtasks, "workflow step")} filed under this authority`);
    const creds = await prisma.siteCredential.count({ where: { govCenter: name } });
    if (creds) add(`${plural(creds, "stored credential")} for this authority`);
  }

  return out;
}
