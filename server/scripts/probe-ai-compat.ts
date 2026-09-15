/**
 * The OpenAI-compatible model connection, against a stand-in server.
 *
 * A real llama-server needs a model file and minutes of CPU; what this proves is everything on OUR
 * side of the wire, which is where a self-hosted model goes wrong in practice:
 *   1. Nothing is offered until the server environment configures it, and ids never collide with Claude's.
 *   2. The API key is sent; a wrong key, an unknown model and a slow server each become a plain sentence.
 *   3. Structured answers ask for a JSON schema with thinking switched off, images go as data URLs, and a
 *      reasoning model's <think> block and code fences are stripped before parsing.
 *   4. Tool calls go through our loop, so the console assistant runs its permission-checked lookups.
 * Restores settings and deletes what it creates.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);

const KEY = "probe-secret-key";
const seen: any[] = [];
let mode: "json" | "think" | "tools" | "alltools" | "slow" = "json";
let lastToolResults: { name: string; content: string }[] = [];
const ALL_TOOLS: [string, object][] = [
  ["find_clients", { name: "a" }],
  ["list_documents", { expiringWithinDays: 60, limit: 5 }],
  ["list_documents", { docType: "Iqama", expiryMonth: "2026-10" }],
  ["renewal_blockers", { documentId: "zz-missing" }],
  ["list_invoices", { status: "overdue", limit: 5 }],
  ["workforce_band", { client: "a" }],
  ["list_open_tasks", { limit: 5 }],
  ["list_requests", { status: "open" }],
];
let toolTurn = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const send = (status: number, obj: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url !== "/v1/chat/completions") return send(404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "bad key" });
    const j = JSON.parse(body || "{}");
    seen.push(j);
    if (j.model !== "qwen-probe") return send(404, { error: "model not found" });
    if (mode === "slow") return; // never answers
    const reply = (message: any, finish = "stop") => send(200, { choices: [{ message, finish_reason: finish }] });
    if (mode === "tools") {
      toolTurn++;
      if (toolTurn === 1) return reply({ role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "find_clients", arguments: JSON.stringify({ name: "zz-no-such-client-probe" }) } }] }, "tool_calls");
      const toolMsg = j.messages.find((m: any) => m.role === "tool");
      return reply({ role: "assistant", content: String(toolMsg?.content) === "[]" ? "No client matched." : `TOOL FAILED: ${String(toolMsg?.content).slice(0, 120)}` });
    }
    if (mode === "alltools") {
      toolTurn++;
      if (toolTurn === 1) return reply({ role: "assistant", content: "", tool_calls: ALL_TOOLS.map(([name, args], i) => ({ id: "t" + i, type: "function", function: { name, arguments: JSON.stringify(args) } })) }, "tool_calls");
      lastToolResults = j.messages.filter((m: any) => m.role === "tool").map((m: any, i: number) => ({ name: ALL_TOOLS[i][0], content: String(m.content) }));
      return reply({ role: "assistant", content: "done" });
    }
    if (mode === "think") return reply({ role: "assistant", content: "<think>let me look</think>\n```json\n{\"subject\":\"Hi\",\"body\":\"Body\"}\n```" });
    return reply({ role: "assistant", content: JSON.stringify({ subject: "Approval needed", body: "Please approve." }) });
  });
});

async function main() {
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  console.log("1. not configured → nothing offered");
  delete process.env.OPENAI_COMPAT_BASE_URL; delete process.env.OPENAI_COMPAT_MODELS;
  const savedAnthropic = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_COMPAT_TIMEOUT_MS = "1500";
  const ai = await import("../src/ai.js");
  const { prisma } = await import("../src/db.js");
  // Captured before any test runs: testConnection records its result, and restoring a value read later would keep the probe's own.
  const before = await prisma.appSetting.findUnique({ where: { key: "agents" } });
  const beforeConn = await prisma.appSetting.findUnique({ where: { key: "aiConnection" } });
  ai.availableModels().length === 0 ? ok("no key and no server: no models offered") : fail(JSON.stringify(ai.availableModels()));

  process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${port}/v1/`;
  process.env.OPENAI_COMPAT_MODELS = "qwen-probe, other-probe";
  process.env.OPENAI_COMPAT_API_KEY = KEY;
  process.env.OPENAI_COMPAT_LABEL = "Probe server";
  const ids = ai.availableModels().map(m => m.id);
  ids.join() === "oc:qwen-probe,oc:other-probe" ? ok(`configured in the environment: ${ids.join(", ")} (namespaced, cannot collide with Claude ids)`) : fail(ids.join());
  ai.modelLabel("oc:qwen-probe") === "Probe server: qwen-probe" ? ok("shown as \"Probe server: qwen-probe\"") : fail(ai.modelLabel("oc:qwen-probe"));
  const conn = await ai.aiConnection();
  const oc = conn.providers.find((p: any) => p.kind === "openai-compatible") as any;
  oc.configured && oc.host === `127.0.0.1:${port}` && oc.hasKey && !JSON.stringify(conn).includes(KEY) ? ok("the connection screen sees the host and that a key exists — never the key") : fail(JSON.stringify(conn));

  console.log("\n2. the wire");
  const t = await ai.testConnection("oc:qwen-probe");
  t.ok && seen.at(-1)?.chat_template_kwargs?.enable_thinking === false ? ok(`test connection works (${t.ms} ms), with thinking switched off`) : fail(JSON.stringify(t));
  process.env.OPENAI_COMPAT_API_KEY = "wrong";
  const t2 = await ai.testConnection("oc:qwen-probe");
  !t2.ok && /rejected the API key/.test(t2.error ?? "") ? ok(`wrong key: "${t2.error}"`) : fail(JSON.stringify(t2));
  process.env.OPENAI_COMPAT_API_KEY = KEY;
  const t3 = await ai.testConnection("oc:other-probe");
  !t3.ok && /does not serve that model/.test(t3.error ?? "") ? ok(`unknown model: "${t3.error}"`) : fail(JSON.stringify(t3));
  const t4 = await ai.testConnection("claude-opus-5");
  !t4.ok && /not configured/.test(t4.error ?? "") ? ok("a Claude model with no Anthropic key is refused, not attempted") : fail(JSON.stringify(t4));
  mode = "slow";
  const t5 = await ai.testConnection("oc:qwen-probe");
  !t5.ok && /took longer than/.test(t5.error ?? "") ? ok(`a hung server times out: "${t5.error}"`) : fail(JSON.stringify(t5));
  const savedUrl = process.env.OPENAI_COMPAT_BASE_URL;
  process.env.OPENAI_COMPAT_BASE_URL = "http://127.0.0.1:1/v1";
  const t6 = await ai.testConnection("oc:qwen-probe");
  !t6.ok && /Could not reach/.test(t6.error ?? "") ? ok(`server down: "${t6.error}"`) : fail(JSON.stringify(t6));
  process.env.OPENAI_COMPAT_BASE_URL = savedUrl;

  console.log("\n3. structured answers and images");
  mode = "json";
  const schema = { type: "object", additionalProperties: false, required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" } } };
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(80)]);
  const out = await ai.askJson<{ subject: string }>({ model: "oc:qwen-probe", system: "sys", prompt: "draft", schema, file: { data: png, mediaType: "image/png" } });
  const last = seen.at(-1);
  out.subject === "Approval needed" && last.response_format?.type === "json_schema" && last.response_format.json_schema.schema.required.includes("subject")
    ? ok("asks for the JSON schema and parses the answer") : fail(JSON.stringify({ out, last: last?.response_format }));
  String(last.messages?.[1]?.content?.[0]?.image_url?.url ?? "").startsWith("data:image/png;base64,") && last.messages[0].role === "system" && last.temperature === 0
    ? ok("the scan goes as a data URL, with the system prompt and temperature 0") : fail(JSON.stringify(last.messages?.[1]));
  try { await ai.askJson({ model: "oc:qwen-probe", system: "s", prompt: "p", schema, file: { data: png, mediaType: "application/pdf" } }); fail("a PDF was sent to an image-only model"); }
  catch (e: any) { /reads images only/.test(e.message) ? ok("a PDF is refused before sending — the self-hosted reader takes images") : fail(e.message); }
  mode = "think";
  const thought = await ai.askJson<{ subject: string }>({ model: "oc:qwen-probe", system: "s", prompt: "p", schema });
  thought.subject === "Hi" ? ok("a <think> block and ``` fences around the JSON are stripped") : fail(JSON.stringify(thought));

  console.log("\n4. tools: the console assistant through a self-hosted model");
  const { saveAgentSetting } = await import("../src/agent-core.js");
  await saveAgentSetting("console-assistant", { enabled: true, model: "oc:qwen-probe" });
  mode = "tools"; toolTurn = 0;
  const { ask } = await import("../src/agent-assistant.js");
  const answer = await ask("is there a client called zz-no-such-client-probe?", { id: null, name: "Probe", role: "super_admin" });
  const toolReq = seen.at(-1);
  /No client matched/.test(answer.answer) && answer.lookups === 1 && toolReq.tools?.some((x: any) => x.function?.name === "list_documents") && toolReq.messages.some((m: any) => m.role === "tool" && m.tool_call_id === "call_1")
    ? ok(`the model called find_clients, our loop ran it and returned the result: "${answer.answer.slice(0, 40)}…"`) : fail(JSON.stringify({ answer, msgs: toolReq?.messages?.map((m: any) => m.role) }));

  mode = "alltools"; toolTurn = 0;
  const all = await ask("run every lookup zz-no-such-client-probe", { id: null, name: "Probe", role: "super_admin" });
  const broken = lastToolResults.filter(r => /Invalid|Unknown arg|prisma|TypeError|is not a function/i.test(r.content));
  all.lookups === ALL_TOOLS.length && broken.length === 0
    ? ok(`all ${ALL_TOOLS.length} assistant lookups ran against the real database without error (${lastToolResults.map(r => r.name + ":" + r.content.length + "b").join(", ")})`)
    : fail(`broken lookups: ${broken.map(b => b.name + " → " + b.content.slice(0, 160)).join(" | ") || "lookups " + all.lookups}`);
  await prisma.agentTask.deleteMany({ where: { agent: "console-assistant", title: { contains: "zz-no-such-client-probe" } } });

  // restore
  await prisma.agentTask.deleteMany({ where: { agent: "console-assistant", title: { contains: "zz-no-such-client-probe" } } });
  if (before) await prisma.appSetting.update({ where: { key: "agents" }, data: { value: before.value as any } });
  else await prisma.appSetting.deleteMany({ where: { key: "agents" } });
  if (beforeConn) await prisma.appSetting.update({ where: { key: "aiConnection" }, data: { value: beforeConn.value as any } });
  else await prisma.appSetting.deleteMany({ where: { key: "aiConnection" } });
  if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
  await prisma.$disconnect();
  server.close();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); server.close(); process.exit(1); });
