/**
 * THE TOP-LEVEL STATEMENTS OF renderVals(), WITH REAL LINE NUMBERS.
 *
 *   npx tsx scripts/render-map.ts               # the statement map, biggest first
 *   npx tsx scripts/render-map.ts --order       # in file order, which is what a gate needs
 *   npx tsx scripts/render-map.ts --cp 24       # checkpoint lines for an instrumented copy
 *
 * `renderVals()` is one 6,500-line method and the console recomputes all of it on every state
 * change. Deciding what to gate means knowing where its statements begin and end, and indentation
 * does not answer that — the file has misindented lines inside nested functions, so "four spaces
 * means top level" is wrong and quietly picks boundaries inside a closure.
 *
 * So it is parsed. TypeScript is already a dependency and parses plain JavaScript, which turns the
 * question into a fact rather than a regex that is nearly right.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const UI = path.join(import.meta.dirname, "../../index.html");
const src = fs.readFileSync(UI, "utf8").replace(/\r\n/g, "\n");

/** The app's own script, and the line it starts on, so every offset can be reported as a file line. */
const open = src.indexOf('<script type="text/x-dc"');
const bodyAt = src.indexOf(">", src.indexOf('data-props="', open)) + 1;
const close = src.indexOf("</script>", bodyAt);
if (open < 0 || close < 0) throw new Error("render-map: could not find the app script");
const code = src.slice(bodyAt, close);
const FIRST = src.slice(0, bodyAt).split("\n").length - 1;   // 0-based line of the script's first line

const sf = ts.createSourceFile("app.js", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const lineOf = (pos: number) => FIRST + sf.getLineAndCharacterOfPosition(pos).line + 1;

let method: ts.MethodDeclaration | null = null;
const walk = (n: ts.Node) => {
  if (ts.isMethodDeclaration(n) && n.name.getText(sf) === "renderVals") method = n;
  else ts.forEachChild(n, walk);
};
walk(sf);
if (!method) throw new Error("render-map: no renderVals() in the file");

const stmts = ((method as ts.MethodDeclaration).body?.statements ?? []).map(st => {
  const from = lineOf(st.getStart(sf)), to = lineOf(st.getEnd());
  // The name is what the statement binds, which is what a gate and a scope check both talk about.
  let name = "(statement)";
  if (ts.isVariableStatement(st)) name = st.declarationList.declarations.map(d => d.name.getText(sf)).join(", ");
  else if (ts.isReturnStatement(st)) name = "return";
  else if (ts.isIfStatement(st)) name = "if " + st.expression.getText(sf).slice(0, 48);
  else if (ts.isExpressionStatement(st)) name = st.expression.getText(sf).split("\n")[0].slice(0, 48);
  return { from, to, lines: to - from + 1, name };
});

const total = stmts.reduce((n, s) => n + s.lines, 0);
const arg = (f: string) => process.argv.indexOf(f);

if (arg("--cp") > 0) {
  // Checkpoint lines for an instrumented copy: evenly spaced by LINE COUNT, not by statement count,
  // so each segment is a comparable slice of the work rather than a comparable number of names.
  const want = Number(process.argv[arg("--cp") + 1] || 24);
  const step = total / want;
  const out: { line: number; label: string }[] = [];
  let acc = 0, next = 0;
  for (const s of stmts) {
    if (acc >= next) { out.push({ line: s.from, label: s.name.slice(0, 28) }); next += step; }
    acc += s.lines;
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const rows = arg("--order") > 0 ? stmts : [...stmts].sort((a, b) => b.lines - a.lines);
console.log(`renderVals: lines ${stmts[0].from}-${stmts[stmts.length - 1].to}, ${stmts.length} top-level statements, ${total} lines\n`);
console.log("  lines   from     to   binds");
for (const s of rows.slice(0, arg("--order") > 0 ? rows.length : 40)) {
  console.log(`${String(s.lines).padStart(7)}${String(s.from).padStart(7)}${String(s.to).padStart(7)}   ${s.name}`);
}
