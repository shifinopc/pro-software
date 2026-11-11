/**
 * A VALUE THAT IS ONLY BUILT ON ITS OWN SCREEN MUST ONLY BE READ THERE.
 *
 *   npx tsx scripts/render-gate-check.ts
 *   npx tsx scripts/render-gate-check.ts --where ldRows     # which regions bind one value
 *
 * `renderVals()` builds every value the console binds — 4,278 of them — on EVERY state change, and
 * the template reads all of them every time, so nothing here can be made lazy; a read-recorder
 * proved it. The only thing left is to stop DOING the work, and almost all of the work is walking
 * rows for screens that are not displayed. So each block's SOURCE is gated: on another screen the
 * rows are empty and the block falls into the "it has not loaded yet" branch it has always had.
 * Measured on the Dashboard: 57.0ms → 42.0ms a render, and a third of all array work gone.
 *
 * THE REGRESSION THIS CATCHES, which is the whole reason the gates are allowed to exist. It is one
 * 24,000-line function, so every local is in scope everywhere below it. The day a dashboard tile
 * reads one of these values, it is EMPTY there — and the symptom is not a crash, it is a tile
 * quietly showing 0, which looks like a quiet week rather than like a bug. It has already happened
 * once in the building of this: `renewalsDue30` on the Dashboard counted compliance rows that are
 * now only built on the Compliance screen, and it read 0. It counts documents directly now.
 *
 * GATED is the measured list: every value that changes when the gates are turned off, captured by
 * running renderVals twice in one page load and diffing. The regions come from the markup itself.
 * A value in that list bound anywhere outside the regions its gate names fails this check.
 *
 * Reads the file. Imports nothing, runs no browser.
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const UI = path.join(import.meta.dirname, "../../index.html");
const src = fs.readFileSync(UI, "utf8").replace(/\r\n/g, "\n");
const lines = src.split("\n");
const TPL_END = lines.findIndex(l => l.includes('<script type="text/x-dc"'));

/** Screens and overlays a gated value may be read on. Anything else is a bug this check reports. */
const ALLOWED_SCREENS = [
  // sales — one block, gated together
  "Sales Dashboard", "Activities", "Pipeline", "Follow-ups", "Leads", "Contacts", "Inbox",
  "Targets &amp; Forecast", "Sales Teams", "Sales Settings", "Setup Check", "Team Performance",
  "Teams", "Agents",
  // the per-screen sources
  "Appointments", "Documents", "Compliance", "Renewals", "Employees", "Receipts", "Support Center",
  "Requests Queue", "Government Centers", "Service Catalog", "Service Packages",
];

/**
 * Every value that changes when the gates are off, measured in the browser rather than guessed:
 *
 *   window.__gateOff = true;  const A = logic.renderVals();
 *   window.__gateOff = false; const B = logic.renderVals();
 *   Object.keys(A).filter(k => hash(A[k]) !== hash(B[k]))
 *
 * Re-capture it the same way after changing a gate. The hatch exists for exactly this.
 */
const GATED = `compCirc compScore complianceEmpty complianceRows complianceSummary complianceTabs
ctEmpty ctEmptyBody ctEmptyTitle ctHasPages ctNextOp ctPageBtns ctPageLabel ctPageShown ctRows
ctTabs cxGroups cxHorizon cxKindTabs cxNothing cxOutlook cxScopeLine cxScoreLine cxShown cxStats
cxTiles cxWExp cxWProg cxWSoon cxWValid ddDlfCoRows ddIgCoRows emKindTabs emNextOp emPageShown
emPagerShown emPages emRows emShown emTiles empChipExpired empSubtitle employees employeesEmpty
fuEmpty fuEmptyBody fuEmptyTitle fuGroups fuHasAny fuRows fuShowOwners fuStats govCenters
govCentersEmpty govHasCenters govPendingTotal govSubs govSubsEmpty igCompanies ldEmpty ldEmptyBody
ldEmptyTitle ldFilters ldNextOp ldPageLabel ldPageShown ldPagerShown ldPages ldRows packages2
payMonth payMonthCount payYtd pipCanAdd pipColumns pipHasStages pipShowKanban pipStats pipSub
pipTblCount pipTblGroups pkSvcChips pkSvcChipsEmpty queueEmpty queueRows queueTabs renewalsEmpty
renewalsOverdue renewalsProcessing renewalsRows rnKindTabs rnNextOp rnNothing rnPageLabel
rnPageShown rnPagerShown rnPages rnRows rnShown rnTiles services slaCols svcGapLine svcGapOk
svcHasGap svcIncludedCount svcTotalCount tickets ticketsEmpty wzServices`.split(/\s+/).filter(Boolean);

// ── the regions the markup itself declares ────────────────────────────────────────────────────
const MODAL_FLAGS: string[] = (() => {
  const a = src.indexOf("const MODAL_FLAGS = [");
  return [...src.slice(a, src.indexOf("];", a)).matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]);
})();

/** Three pairs that are only misindented — checked by hand, the pairing is right. */
const KNOWN_INDENT = new Set(["2200-2207", "7680-7772", "15223-15346"]);

type Region = { kind: "screen" | "modal"; name: string; from: number; to: number };
const regions: Region[] = [];
const balance: string[] = [];
{
  // NOT `<sc-if[^>]*>`: a few of these tags are broken across lines, and requiring the closing
  // bracket on the same line drops those opens and mispairs every region after them.
  const TAG = /<sc-if\b|<\/sc-if>/g;
  const NAME = /<sc-if value="\{\{\s*([A-Za-z0-9_.]+)\s*\}\}"/;
  const stack: { kind: "screen" | "modal" | null; name: string; from: number; indent: number; alone: boolean }[] = [];
  for (let i = 0; i < TPL_END; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    for (const m of line.matchAll(TAG)) {
      if (m[0] === "</sc-if>") {
        const top = stack.pop();
        if (!top) { balance.push(`an extra </sc-if> at index.html:${i + 1}`); continue; }
        // Both alone on their lines and indented differently: the pairing is almost certainly wrong,
        // which is how a modal came to swallow the three that followed it.
        if (top.alone && line.trim() === "</sc-if>" && top.indent !== indent
            && !KNOWN_INDENT.has(`${top.from}-${i + 1}`)) {
          balance.push(`<sc-if> at index.html:${top.from} (indent ${top.indent}) is closed at :${i + 1} (indent ${indent})`);
        }
        if (top.kind) regions.push({ kind: top.kind, name: top.name, from: top.from, to: i + 1 });
        continue;
      }
      const flag = NAME.exec(lines.slice(i, i + 3).join(" ").slice(m.index))?.[1] ?? "";
      const label = /data-screen-label="([^"]+)"/.exec(lines.slice(i, i + 2).join(" "))?.[1];
      const alone = line.trimStart().startsWith("<sc-if") && m.index === indent;
      stack.push(label ? { kind: "screen", name: label, from: i + 1, indent, alone }
        : MODAL_FLAGS.includes(flag) ? { kind: "modal", name: flag, from: i + 1, indent, alone }
        : { kind: null, name: "", from: i + 1, indent, alone });
    }
  }
  if (stack.length) balance.push(`${stack.length} <sc-if> left open, first at index.html:${stack[0].from}`);
}
const where = (key: string) => {
  const re = new RegExp(`\\{\\{\\s*${key}(?![A-Za-z0-9_$])`);
  const out: { line: number; regions: string[] }[] = [];
  for (let i = 0; i < TPL_END; i++) {
    if (!re.test(lines[i])) continue;
    out.push({ line: i + 1, regions: regions.filter(r => i + 1 >= r.from && i + 1 <= r.to).map(r => `${r.kind}:${r.name}`) });
  }
  return out;
};

if (process.argv.includes("--where")) {
  const k = process.argv[process.argv.indexOf("--where") + 1];
  for (const b of where(k)) console.log(`index.html:${b.line}  ${b.regions.join(" / ") || "chrome (on screen always)"}`);
  process.exit(0);
}

console.log("the markup's regions are well formed, so the rest of this check means anything:");
ok(balance.length === 0, balance.length ? `${balance.length} problem(s), first: ${balance[0]}` : "every <sc-if> closes where its indentation says it does");
balance.slice(0, 6).forEach(b => console.log(`        ${b}`));
ok(regions.filter(r => r.kind === "screen").length > 40, `${regions.filter(r => r.kind === "screen").length} screens found`);

console.log("\nno gated value is read outside the screens its gate names:");
const allowed = new Set(ALLOWED_SCREENS.map(s => `screen:${s}`));
const strays: string[] = [];
let boundCount = 0;
for (const k of GATED) {
  for (const b of where(k)) {
    boundCount++;
    if (!b.regions.length) { strays.push(`${k} is bound in chrome (index.html:${b.line}), which is on screen always`); continue; }
    if (b.regions.some(r => r.startsWith("modal:"))) continue;   // overlays are named on their gate
    if (!b.regions.some(r => allowed.has(r))) {
      strays.push(`${k} is bound in ${b.regions.join(" / ")} (index.html:${b.line}) — add that screen to the gate, or feed the value from state`);
    }
  }
}
ok(strays.length === 0, strays.length
  ? `${strays.length} stray binding(s), first: ${strays[0]}`
  : `all ${boundCount} bindings of the ${GATED.length} gated values sit inside the ${ALLOWED_SCREENS.length} screens the gates name`);
strays.slice(0, 10).forEach(s => console.log(`        ${s}`));

console.log("\nand the gates themselves are still in the file:");
ok(/const _onScreen9 = \(names9\) =>/.test(src), "the shared gate helper exists");
ok(/window\.__gateOff/.test(src), "…with the measurement hatch, which is the only way to re-capture the list above");
ok(/const _svcOverlay9 = !!\(this\.state\.wizard \|\| this\.state\.upgradeModal \|\| this\.state\.pkOpen\);/.test(src),
  "the three overlays that read the service catalogue are named");
for (const [name, screens] of [
  ["empData", "'Employees'"], ["payData", "'Receipts'"], ["gcData", "'Government Centers'"],
  ["docsData", "'Compliance', 'Renewals'"], ["_cxDocs", "'Compliance', 'Renewals'"],
] as const) {
  ok(src.includes(`${name} = _srcOn9(this.state.`) || src.includes(`${name} = _rowsOn9(this.state.`),
    `${name} is gated`);
  ok(src.includes(screens), `…to ${screens}`);
}
ok(/const _nRows = Array\.isArray\(this\.state\.notificationsData\) \? this\.state\.notificationsData : null;/.test(src),
  "the notification rows are NOT gated — the bell badge is in the header, which is on every screen");
ok(/renewalsDue30: _need9\(\(Array\.isArray\(this\.state\.documentsData\)/.test(src),
  "the Dashboard's renewals tile counts documents, not the compliance rows a gate can empty");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
