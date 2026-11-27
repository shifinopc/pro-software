/**
 * THE THIRD STEP OF A BUSINESS SETUP WITH AN ACQUISITION — who actually owns and runs it.
 *
 * Step 2 collects the partners buying the thing. This is the KYC pack the authorities ask for
 * afterwards and which nothing in the system held: the beneficial owners behind each organisation,
 * the managers whose iqamas have to be on file, and the owners' own identity papers — which differ
 * by what the owner IS. A resident shows an iqama, a Saudi national an ID, a foreign company its
 * certificate of incorporation, a Saudi company its CR.
 *
 * WHY THE DOCUMENT IS ATTACHED TO THE ROW rather than collected in a pile beside the names: the
 * pile and the list drift apart the moment somebody is removed or two are added at once, and
 * nothing afterwards can say whose passport is whose. Same rule as the partners' table in step 2.
 *
 * WHY THE TYPE IS A LIST rather than free text: "which organisation", "what kind of owner" typed
 * freely come back as four spellings of one thing, and no report can group them. Row columns learnt
 * a `select` type for this.
 *
 * The parent company's name is NOT asked for again. It is `fromVar: acqCompanyName` — the name the
 * officer typed in step 2 — so the field opens already filled and only has to be corrected if the
 * deal changed. Asked twice, two spellings is not a risk, it is a certainty.
 *
 * Conditional by position, not by its own rule: it sits on the `yes` arm after acq_partners, so a
 * setup with no acquisition never reaches it — the same branch step 2 already hangs off.
 *
 *   npx tsx scripts/add-acquisition-kyc.ts
 */
import { prisma } from "../src/db.js";

const NODE = {
  id: "acq_kyc",
  type: "task",
  label: "Acquisition KYC — owners, managers and beneficial owners",
  config: {
    // The same desk and the same clock as the steps either side of it. Without assigneeRole the
    // step is in nobody's queue; without slaHours it is never due and never breaches.
    assigneeRole: "pro_officer",
    slaHours: 72,
    whatToDo:
      "Collect the KYC pack for the acquisition: every beneficial owner behind the organisations, the managers whose iqamas go on file, and each owner's identity document — iqama, national ID, passport, certificate of incorporation or CR, depending on what the owner is. Attach the document against the person or company it belongs to, not in a pile.",
    captures: [
      {
        var: "acqParentCompany",
        label: "Parent company",
        type: "text",
        // Filled from what step 2 recorded. The officer corrects it only if the deal has changed.
        fromVar: "acqCompanyName",
      },
      {
        var: "acqBeneficialOwners",
        label: "Beneficial owners",
        type: "rows",
        columns: [
          { var: "name", label: "Full name", flex: 1.8 },
          { var: "org", label: "Organisation", flex: 1.3, type: "select", options: ["Parent company", "Acquired company", "Other"] },
          { var: "mobile", label: "Mobile", flex: 1.2 },
          { var: "idType", label: "ID type", flex: 1.2, type: "select", options: ["Resident ID (Iqama)", "National ID", "Passport", "Commercial Registration"] },
          { var: "idNumber", label: "ID number", flex: 1.2 },
          { var: "doc", label: "Document", flex: 1, type: "file" },
        ],
      },
      {
        var: "acqManagers",
        label: "Managers — iqama copies",
        type: "rows",
        columns: [
          { var: "name", label: "Manager", flex: 1.6 },
          { var: "iqama", label: "Iqama number", flex: 1.2 },
          { var: "mobile", label: "Mobile", flex: 1.2 },
          { var: "email", label: "Email", flex: 1.6 },
          { var: "address", label: "Short address", flex: 1.4 },
          { var: "doc", label: "Iqama copy", flex: 1, type: "file" },
        ],
      },
      {
        var: "acqOwners",
        label: "Owners — identity documents",
        type: "rows",
        columns: [
          { var: "name", label: "Owner", flex: 1.8 },
          // What the owner IS decides which paper is attached beside it, which is why the two
          // columns sit together: the file on its own cannot say what it is a scan of.
          { var: "kind", label: "Owner is", flex: 1.6, type: "select", options: ["Resident individual", "Saudi national", "Foreign individual", "Foreign company", "Saudi company"] },
          { var: "idNumber", label: "ID / CR number", flex: 1.3 },
          { var: "doc", label: "Document", flex: 1, type: "file" },
        ],
      },
      // The pile a deal like this always brings that no template could have named in advance.
      { var: "acqKycDocs", label: "Other documents", type: "files", required: false },
    ],
  },
};

async function main() {
  const t = await prisma.workflowTemplate.findFirst({ where: { name: { contains: "Business Setup" } } });
  if (!t) throw new Error("no Business Setup template");
  const g: any = t.graph;
  const nodes: any[] = g.nodes ?? [];
  const edges: any[] = g.edges ?? [];

  if (nodes.some(n => n.id === "acq_kyc")) { console.log("already applied — nothing to do"); return; }
  if (!nodes.some(n => n.id === "acq_partners")) throw new Error("acq_partners is missing — run add-acquisition-intake.ts first");

  // The wire this splits. Refused rather than guessed at: if the partners step no longer leads to
  // KYC, the template has been re-drawn and this script's idea of "third step" is out of date.
  const link = edges.filter(e => e.from === "acq_partners" && e.to === "kyc" && !e.condition);
  if (link.length !== 1) throw new Error(`expected exactly one unconditional acq_partners → kyc edge, found ${link.length}`);

  const next = {
    ...g,
    nodes: [...nodes, NODE],
    edges: [
      ...edges.filter(e => !(e.from === "acq_partners" && e.to === "kyc" && !e.condition)),
      { from: "acq_partners", to: "acq_kyc" },
      { from: "acq_kyc", to: "kyc" },
    ],
  };
  await prisma.workflowTemplate.update({ where: { id: t.id }, data: { graph: next as any } });
  console.log(`applied to "${t.name}": ${nodes.length} → ${next.nodes.length} nodes, ${edges.length} → ${next.edges.length} edges`);

  /**
   * THE RUNS ALREADY PAST THIS POINT.
   *
   * A graph change does not reach a case that has already walked by: the engine moves forward from
   * where each run stands. Said out loud because the opposite is the obvious assumption, and
   * because reenter-at-node.ts is the tool for putting one back — the same thing that had to be
   * done for step 2 on the case that was already running.
   */
  const past = await prisma.workflowInstance.count({ where: { templateId: t.id, status: "running" } });
  console.log(past
    ? `${past} run(s) in flight: any already past the partners step will NOT pick this up — reenter-at-node.ts acq_kyc <instanceId> puts one back`
    : "no runs in flight");
}

main().then(() => prisma.$disconnect()).catch(async e => { console.error(e.message ?? e); await prisma.$disconnect(); process.exit(1); });
