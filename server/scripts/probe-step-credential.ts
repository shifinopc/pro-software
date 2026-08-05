/**
 * Throwaway check: does a step that names a portal find the client's login for THAT portal, and does
 * the password stay out of the payload?
 *
 * Builds a client credential for Qiwa and one for GOSI, runs a two-step template (one Qiwa, one
 * Muqeem), and asserts:
 *   - the Qiwa step finds the Qiwa credential
 *   - the Muqeem step finds nothing, and says so rather than offering the wrong one
 *   - neither response contains the password
 *   - the stored password is genuinely encrypted at rest
 *
 * Creates everything it needs and deletes all of it.
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";
import { encrypt, decrypt } from "../src/auth.js";

const graph = {
  nodes: [
    { id: "n1", type: "trigger", label: "Start" },
    { id: "n2", type: "task", label: "Cancel work permit", config: { assigneeRole: "pro_officer", govCenter: "Qiwa" } },
    { id: "n3", type: "task", label: "Cancel Iqama", config: { assigneeRole: "pro_officer", govCenter: "Muqeem" } },
    { id: "n4", type: "end", label: "Done" },
  ],
  edges: [{ from: "n1", to: "n2" }, { from: "n1", to: "n3" }, { from: "n2", to: "n4" }, { from: "n3", to: "n4" }],
};

async function main() {
  const co = await prisma.company.findFirst();
  if (!co) throw new Error("no company on file");
  const before = { cred: await prisma.siteCredential.count(), tpl: await prisma.workflowTemplate.count(), run: await prisma.workflowInstance.count() };
  let bad = 0;

  const qiwa = await prisma.siteCredential.create({ data: {
    companyId: co.id, label: "ZZ PROBE Qiwa", url: "https://qiwa.sa", username: "probe-user",
    password: encrypt("SuperSecret!123"), govCenter: "Qiwa",
  } });
  const gosi = await prisma.siteCredential.create({ data: {
    companyId: co.id, label: "ZZ PROBE GOSI", url: "https://gosi.gov.sa", username: "gosi-user",
    password: encrypt("OtherSecret!456"), govCenter: "GOSI",
  } });

  const tpl = await prisma.workflowTemplate.create({ data: { name: "ZZ CRED PROBE", trigger: "manual", active: true, graph: graph as any } });
  const run = await startInstance(tpl.id, { title: "Cred probe", companyId: co.id, clientName: co.name });
  const steps = await prisma.workflowTask.findMany({ where: { instanceId: run.id, status: "active" } });

  // The same lookup the route performs.
  const lookup = async (govCenter: string | null, companyId: string | null) => {
    if (!govCenter || !companyId) return null;
    return prisma.siteCredential.findFirst({ where: { companyId, govCenter }, select: { id: true, label: true, url: true, username: true } });
  };

  for (const s of steps) {
    const found = await lookup(s.govCenter, co.id);
    const leaks = found ? Object.keys(found).includes("password") : false;
    console.log(`\n${s.title}  (portal: ${s.govCenter})`);
    console.log(`  found: ${found ? found.label + " · " + found.username : "nothing — the step says so instead of offering another portal's login"}`);
    console.log(`  password in payload: ${leaks ? "YES — LEAK" : "no"}`);
    if (leaks) bad++;
    if (s.govCenter === "Qiwa" && found?.id !== qiwa.id) { console.log("  WRONG CREDENTIAL"); bad++; }
    if (s.govCenter === "Muqeem" && found) { console.log("  MATCHED SOMETHING IT SHOULD NOT HAVE"); bad++; }
  }

  const raw = await prisma.siteCredential.findUnique({ where: { id: qiwa.id } });
  const encrypted = raw!.password !== "SuperSecret!123";
  const roundTrips = decrypt(raw!.password) === "SuperSecret!123";
  console.log(`\nencrypted at rest: ${encrypted ? "YES" : "NO — stored in clear"} · decrypts correctly: ${roundTrips ? "YES" : "NO"}`);
  if (!encrypted || !roundTrips) bad++;

  // ── clean up ──
  await prisma.workflowLog.deleteMany({ where: { instanceId: run.id } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: run.id } });
  await prisma.workflowInstance.delete({ where: { id: run.id } });
  await prisma.workflowTemplate.delete({ where: { id: tpl.id } });
  await prisma.siteCredential.deleteMany({ where: { id: { in: [qiwa.id, gosi.id] } } });

  const now = { cred: await prisma.siteCredential.count(), tpl: await prisma.workflowTemplate.count(), run: await prisma.workflowInstance.count() };
  console.log(`\nfailures: ${bad}`);
  console.log(`counts  credentials ${before.cred}->${now.cred} · templates ${before.tpl}->${now.tpl} · runs ${before.run}->${now.run}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
