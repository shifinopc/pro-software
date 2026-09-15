/**
 * The documents a client request still needs, and the one way files are added to a request.
 *
 * Until this existed a client could attach files only when first filing a request. Asked later for a
 * missing passport copy, all they could do was type a reply — so "we still need X" had no way to be
 * answered inside the system, and nothing could tell when it had been. Now:
 *   · `requestDocStatus` says what is required, what has arrived and what is still missing;
 *   · `attachToRequest` adds files — at filing and afterwards — and ticks the matching item on the
 *     request's live workflow step, so the officer's checklist moves the moment the client uploads.
 * A tick here means RECEIVED only. Verifying the document stays with the officer.
 */
import { prisma } from "./db.js";

export async function requestDocStatus(requestId: string) {
  const rq = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
  if (!rq) return null;
  const files = await prisma.requestAttachment.findMany({ where: { requestId }, orderBy: { at: "asc" } });
  const svc = rq.serviceItemId
    ? await prisma.serviceItem.findUnique({ where: { id: rq.serviceItemId } })
    : await prisma.serviceItem.findFirst({ where: { name: String(rq.type ?? ""), retired: false } });
  const required = (Array.isArray(svc?.requiredDocs) ? (svc!.requiredDocs as any[]) : []).filter(d => d && d.key);
  const have = new Set(files.map(f => f.docKey));
  return {
    request: rq,
    service: svc ? { id: svc.id, name: svc.name } : null,
    files,
    required: required.map(d => ({ key: String(d.key), label: String(d.label ?? d.key), required: d.required !== false, hint: d.hint ?? null, received: have.has(d.key) })),
    missing: required.filter(d => d.required !== false && !have.has(d.key)).map(d => ({ key: String(d.key), label: String(d.label ?? d.key) })),
  };
}

/**
 * Attach uploaded files to a request against the documents they answer. Only files the uploader owns
 * are accepted — a file id is checked, never a path. Returns what attached.
 */
export async function attachToRequest(requestId: string, wanted: { fileId: string; key?: string; label?: string }[], uploaderId: string) {
  const list = wanted.slice(0, 25);
  const ids = list.map(x => String(x?.fileId ?? "")).filter(Boolean);
  if (!ids.length) return { attached: [] as { key: string; label: string | null }[], refused: 0 };
  const owned = await prisma.fileAsset.findMany({ where: { id: { in: ids }, uploadedBy: uploaderId } });
  const byId = new Map(owned.map(f => [f.id, f]));
  const at = new Date().toISOString();
  const rows = list
    .map(x => ({ x, f: byId.get(String(x?.fileId ?? "")) }))
    .filter(({ f }) => !!f)
    .map(({ x, f }) => ({
      requestId, docKey: String(x.key || "other").slice(0, 60), label: x.label ? String(x.label).slice(0, 120) : null,
      path: f!.path, name: f!.name, size: f!.size, at,
    }));
  if (rows.length) await prisma.requestAttachment.createMany({ data: rows });

  // The live step of the request's run, if it is waiting for these very documents.
  const rq = await prisma.serviceRequest.findUnique({ where: { id: requestId }, select: { workflowInstanceId: true } });
  if (rq?.workflowInstanceId && rows.length) {
    const steps = await prisma.workflowTask.findMany({ where: { instanceId: rq.workflowInstanceId, status: "active" } });
    for (const step of steps) {
      const items = (Array.isArray(step.checklist) ? step.checklist : []) as any[];
      const state = { ...((step.checklistState ?? {}) as Record<string, any>) };
      const ticked: string[] = [];
      for (const r of rows) {
        const item = items.find(i => i?.key === r.docKey);
        if (!item || state[r.docKey]?.received) continue;
        state[r.docKey] = { ...(state[r.docKey] ?? {}), received: true, verified: false, rejected: false, fileRef: r.name, note: "Uploaded by the client in the portal" };
        ticked.push(r.docKey);
      }
      if (!ticked.length) continue;
      await prisma.workflowTask.update({ where: { id: step.id }, data: { checklistState: state } });
      await prisma.workflowLog.create({ data: { instanceId: step.instanceId, nodeId: step.nodeId, action: "checklist.item.received", detail: `${ticked.join(", ")} — uploaded by the client`, actor: "Client (portal)", at } });
    }
  }
  return { attached: rows.map(r => ({ key: r.docKey, label: r.label })), refused: ids.length - rows.length };
}
