/**
 * THE PASSPORT RENEWAL WORKFLOW.
 *
 *   npx tsx scripts/add-passport-renewal.ts          # say what would change
 *   npx tsx scripts/add-passport-renewal.ts --write  # create or update it
 *
 * A passport crossing its lead time did nothing: the renewal trigger walks TEMPLATES, not document
 * types, and no template was bound to Passport. The document turned "expiring", Compliance showed
 * it, and no work was ever created. This is that template.
 *
 * THE SHAPE THE FIRM ASKED FOR
 *   1. Tell the employee and the management, and record what management says.
 *   2. They answer "the employee is doing it themselves", or "go ahead and renew it".
 *   3. Going ahead: book the embassy appointment, record its date, tell the employee what to bring.
 *   4. When the passport comes back: its new issue date and expiry, and Jawazat updated.
 *
 * WHY THE "DOING IT THEMSELVES" BRANCH DOES NOT JUST END. The trigger releases a document the
 * moment its run stops, and the passport is still past its lead time — so a run that ends there
 * would start another one an hour later, and another every hour after that. It instead opens a step
 * that waits for the employee to hand the new passport over. That step is where the dates the firm
 * wants to "update later" are entered, and while it is open the document stays claimed. An
 * outstanding item stays visible as an outstanding item.
 *
 * NO `days` IN THE TRIGGER CONFIG, on purpose. A template's own `days` overrides the document
 * type's lead time, which is how Iqama ended up renewing at the template's 60 rather than the
 * type's 14. Leaving it out means Passport renews at whatever the type says — one place to change.
 */
import { prisma } from "../src/db.js";

const NAME = "Passport Renewal";
const OFFICER = "pro_officer";

const graph = {
  nodes: [
    { id: "start", type: "start", label: "Renewal Created", config: {} },

    {
      id: "notify_both", type: "task", label: "Notify Employee and Management",
      config: {
        assigneeRole: OFFICER, slaHours: 24,
        instructions: "Tell the employee their passport is coming up for renewal, and ask the management how they want it handled. Record their answer below.",
        checklist: [
          { key: "told_employee", label: "Employee told", source: "manual", required: true },
          { key: "told_management", label: "Management told", source: "manual", required: true },
        ],
        captures: [
          { var: "mgmtReply", type: "select", label: "Management's answer", options: "proceed,self", required: true },
          { var: "mgmtNote", type: "text", label: "Anything they said worth keeping", required: false },
        ],
      },
    },

    {
      id: "d_reply", type: "decision", label: "Who is renewing it?",
      config: { branches: [{ op: "eq", key: "proceed", var: "mgmtReply", value: "proceed" }] },
    },

    {
      // The employee's own renewal. Open until they hand the passport over, which is both the log
      // the firm asked for and what stops the trigger starting this again every hour.
      id: "self_wait", type: "task", label: "Employee is renewing it themselves",
      config: {
        assigneeRole: OFFICER,
        instructions: "The management said the employee is renewing this passport themselves. Nothing to do until they send the new one — then enter its dates here and complete the step. This stays open on purpose: it is the outstanding item, and it keeps the renewal from starting itself again.",
        checklist: [{ key: "passport_seen", label: "New passport received from the employee", source: "manual", required: true }],
        captures: [
          { var: "newIssue", type: "date", label: "New passport issue date", required: true },
          { var: "newExpiry", type: "date", label: "New passport expiry date", required: true },
          { var: "newNumber", type: "text", label: "New passport number", required: false },
        ],
      },
    },

    {
      id: "appointment", type: "task", label: "Embassy Appointment",
      config: {
        assigneeRole: OFFICER, slaHours: 72,
        instructions: "Book the appointment at the embassy, put its date in, and tell the employee which documents to bring.",
        checklist: [
          { key: "appointment_taken", label: "Appointment taken at the embassy", source: "manual", required: true },
          { key: "docs_informed", label: "Employee informed to prepare the appropriate documents", source: "manual", required: true },
        ],
        captures: [{ var: "appointmentDate", type: "date", label: "Appointment date", required: true }],
      },
    },

    {
      id: "renewed", type: "task", label: "Passport Renewed",
      config: {
        assigneeRole: OFFICER, slaHours: 24,
        instructions: "Enter the new passport's dates exactly as issued, and tick Jawazat once the new passport is recorded there.",
        checklist: [{ key: "jawazat_updated", label: "Updated in Jawazat", source: "manual", required: true }],
        captures: [
          { var: "newIssue", type: "date", label: "New passport issue date", required: true },
          { var: "newExpiry", type: "date", label: "New passport expiry date", required: true },
          { var: "newNumber", type: "text", label: "New passport number", required: false },
        ],
      },
    },

    // Writes the result back onto the employee's passport: old number and expiry into history[],
    // new ones on the row. Both branches arrive here, so the record is updated the same way
    // whoever did the renewing.
    {
      id: "issue_passport", type: "issue_document", label: "Passport",
      config: { docType: "Passport", expiryVar: "newExpiry", issueVar: "newIssue", numberVar: "newNumber" },
    },

    { id: "end_done", type: "end", label: "Renewal Complete", config: {} },
  ],
  edges: [
    { from: "start", to: "notify_both", condition: "" },
    { from: "notify_both", to: "d_reply", condition: "" },
    { from: "d_reply", to: "appointment", condition: "proceed" },
    { from: "d_reply", to: "self_wait", condition: "else" },
    { from: "appointment", to: "renewed", condition: "" },
    { from: "renewed", to: "issue_passport", condition: "" },
    { from: "self_wait", to: "issue_passport", condition: "" },
    { from: "issue_passport", to: "end_done", condition: "" },
  ],
};

const write = process.argv.includes("--write");
const existing = await prisma.workflowTemplate.findFirst({ where: { name: NAME } });

if (!existing) {
  console.log(`${write ? "creating    " : "would create"}  ${NAME}  (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
  if (write) {
    await prisma.workflowTemplate.create({
      data: {
        name: NAME, trigger: "document_expiry", triggerConfig: { docType: "Passport" },
        entityType: "employee", country: "SA", active: true, createdAt: new Date().toISOString(),
        description: "Starts itself when a passport crosses its lead time. Management says whether the employee is renewing it themselves or the office is.",
        graph: graph as any,
      },
    });
  }
} else if (existing.packModified) {
  // Somebody has edited it since. Overwriting would throw their work away without asking.
  console.log(`left alone    ${NAME} — edited here since it was created; not overwritten`);
} else {
  // MySQL stores a JSON column with its keys reordered, so the graph that comes back is the same
  // graph with the keys in a different order. Compared key-order-independently, or every run would
  // report a change and bump the version for nothing.
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable)
    : (v && typeof v === "object") ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  const same = JSON.stringify(stable(existing.graph)) === JSON.stringify(stable(graph));
  console.log(`${same ? "already current" : write ? "updating    " : "would update"}  ${NAME}`);
  if (write && !same) {
    await prisma.workflowTemplate.update({
      where: { id: existing.id },
      data: { graph: graph as any, triggerConfig: { docType: "Passport" }, version: { increment: 1 } },
    });
  }
}

const dt = await prisma.documentType.findUnique({ where: { name: "Passport" }, select: { leadDays: true } });
console.log(`\nPassport renews ${dt?.leadDays ?? 30} days before expiry (the document type's own lead time).`);
await prisma.$disconnect();
