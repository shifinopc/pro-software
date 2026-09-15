/**
 * THE MODEL CONNECTION.
 *
 * Every agent that uses a model goes through this file, so there is one place that knows how the
 * server reaches a model, one place that turns failures into sentences, and one switch that decides
 * whether any client data leaves the building at all.
 *
 * TWO KINDS OF CONNECTION
 *   · Anthropic (Claude) — `ANTHROPIC_API_KEY`.
 *   · Any OpenAI-compatible server — a self-hosted llama.cpp `llama-server`, vLLM, a GPU box in the
 *     office, or a cloud endpoint that speaks the same API:
 *       OPENAI_COMPAT_BASE_URL   e.g. http://10.8.0.2:8080/v1   (over WireGuard, never the open internet)
 *       OPENAI_COMPAT_API_KEY    the server's --api-key
 *       OPENAI_COMPAT_MODELS     comma-separated model names it serves, e.g. qwen3.5-4b
 *       OPENAI_COMPAT_LABEL      what to call it on screen, e.g. "Office GPU"
 *
 * CONFIGURED IN THE SERVER ENVIRONMENT, NOT THE CONSOLE — deliberately. Where a passport scan is sent
 * is a security decision: if the address lived in the database, anyone who got into an admin account
 * could point every scan at a server of their own. The console shows what is configured and lets an
 * admin choose between the models on offer; it cannot add a destination.
 *
 * Agents that can work without a model always do their checking in code. A model writes the words; it
 * never decides whether a passport is valid or which invoice a payment belongs to.
 */
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db.js";

export const CLAUDE_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5", note: "Most capable. Best for reading scans and answering questions." },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "Balanced speed and quality. Good for drafting messages." },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", note: "Fastest and cheapest Claude. Fine for short drafts." },
] as const;
/** Models on an OpenAI-compatible server are stored as "oc:<name>" so they can never collide with Claude ids. */
const OC = "oc:";

const env = (k: string) => String(process.env[k] ?? "").trim();
export const anthropicReady = () => !!env("ANTHROPIC_API_KEY");
function compat() {
  const baseUrl = env("OPENAI_COMPAT_BASE_URL").replace(/\/+$/, "");
  const models = env("OPENAI_COMPAT_MODELS").split(",").map(s => s.trim()).filter(Boolean);
  let host = "";
  try { host = baseUrl ? new URL(baseUrl).host : ""; } catch { host = ""; }
  return { baseUrl: host ? baseUrl : "", host, apiKey: env("OPENAI_COMPAT_API_KEY"), models, label: env("OPENAI_COMPAT_LABEL") || "Self-hosted model" };
}
export const compatReady = () => { const c = compat(); return !!c.baseUrl && c.models.length > 0; };

/** Every model an agent may be set to right now. */
export function availableModels() {
  const c = compat();
  return [
    ...(anthropicReady() ? CLAUDE_MODELS.map(m => ({ id: m.id, label: m.label, provider: "anthropic" as const, note: m.note })) : []),
    ...(compatReady() ? c.models.map(m => ({ id: OC + m, label: m, provider: "openai-compatible" as const, note: `Served by ${c.label} (${c.host}).` })) : []),
  ];
}
export const isAvailableModel = (id: string | null | undefined) => !!id && availableModels().some(m => m.id === id);
/** Whether a stored id is a model id at all — kept even when its provider is not configured right now. */
export const isKnownModelId = (id: string | null | undefined) => !!id && (CLAUDE_MODELS.some(m => m.id === id) || (id.startsWith(OC) && id.length > OC.length));
export const anyModelReady = () => availableModels().length > 0;
/** Kept for callers that only need "is any model connected". */
export const keyPresent = anyModelReady;
export function modelLabel(id: string | null | undefined) {
  if (!id) return "No model";
  if (id.startsWith(OC)) return `${compat().label}: ${id.slice(OC.length)}`;
  return CLAUDE_MODELS.find(m => m.id === id)?.label ?? id;
}
export const isSelfHosted = (id: string | null | undefined) => !!id && id.startsWith(OC);

/** A failure worth showing the person who pressed the button, as opposed to a bug. */
export class AiError extends Error {
  constructor(message: string, public status = 502) { super(message); this.name = "AiError"; }
}

export async function aiConnection() {
  const row = await prisma.appSetting.findUnique({ where: { key: "aiConnection" } }).catch(() => null);
  const v = (row?.value ?? {}) as any;
  const c = compat();
  return {
    providers: [
      { kind: "anthropic", label: "Anthropic (Claude)", configured: anthropicReady(), where: "ANTHROPIC_API_KEY", dataLeaves: "Sent to Anthropic's API (outside Saudi Arabia)." },
      { kind: "openai-compatible", label: c.label, configured: compatReady(), host: c.host || null, models: c.models, hasKey: !!c.apiKey,
        where: "OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY, OPENAI_COMPAT_MODELS", dataLeaves: c.host ? `Sent to ${c.host} — wherever that machine is.` : null,
        insecure: !!c.baseUrl && c.baseUrl.startsWith("http://") && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost|\[?::1)/.test(c.host) },
    ],
    models: availableModels(),
    // Kept for older screens.
    keyPresent: anyModelReady(),
    lastTest: v.lastTest ?? null as null | { ok: boolean; at: string; model: string; ms: number; error: string | null },
  };
}

// ── Anthropic ─────────────────────────────────────────────────────────────────────────────────

function translateAnthropic(e: unknown): never {
  if (e instanceof AiError) throw e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new AiError("The model API key was rejected. Check ANTHROPIC_API_KEY on the server.", 502);
  if (e instanceof Anthropic.NotFoundError) throw new AiError("That model is not available to this API key. Pick another model.", 502);
  if (e instanceof Anthropic.RateLimitError) throw new AiError("The model is busy. Try again in a minute.", 503);
  if (e instanceof Anthropic.BadRequestError) throw new AiError("The model refused the request as malformed — the file may be damaged or too large.", 400);
  if (e instanceof Anthropic.APIConnectionError) throw new AiError("Could not reach the model. Check the server's internet connection.", 502);
  if (e instanceof Anthropic.APIError) throw new AiError(`The model returned an error (${e.status}). Try again.`, 502);
  throw e;
}
function anthropic() {
  if (!anthropicReady()) throw new AiError("Claude is not connected: the server has no ANTHROPIC_API_KEY.", 409);
  return new Anthropic();
}

// ── OpenAI-compatible ─────────────────────────────────────────────────────────────────────────

/** Self-hosted models on a CPU can take minutes on one scan; a cloud GPU answers in seconds. */
const COMPAT_TIMEOUT_MS = Number(env("OPENAI_COMPAT_TIMEOUT_MS")) || 240_000;

async function compatChat(body: Record<string, unknown>) {
  const c = compat();
  if (!compatReady()) throw new AiError("No self-hosted model is connected: OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODELS are not set on the server.", 409);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), COMPAT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({ temperature: 0, ...body }),
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new AiError(`${c.label} took longer than ${Math.round(COMPAT_TIMEOUT_MS / 1000)} seconds to answer.`, 504);
    throw new AiError(`Could not reach ${c.label} at ${c.host}. Check that it is running and the private link (WireGuard) is up.`, 502);
  } finally { clearTimeout(timer); }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new AiError(`${c.label} rejected the API key. Check OPENAI_COMPAT_API_KEY.`, 502);
  if (res.status === 404) throw new AiError(`${c.label} does not serve that model (or the base URL is wrong — it should end in /v1).`, 502);
  if (res.status === 400) throw new AiError(`${c.label} refused the request: ${text.slice(0, 200)}`, 400);
  if (!res.ok) throw new AiError(`${c.label} returned an error (${res.status}).`, 502);
  try { return JSON.parse(text); } catch { throw new AiError(`${c.label} returned something that is not JSON.`, 502); }
}

/** Reasoning models may wrap their answer in <think> and fences even when told not to. */
function cleanJsonText(s: string) {
  return String(s ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

// ── the calls the agents make ─────────────────────────────────────────────────────────────────

/** One tiny request, recorded, so the Agents screen can say whether the connection actually works. */
export async function testConnection(model: string) {
  const started = Date.now();
  let result: { ok: boolean; at: string; model: string; ms: number; error: string | null };
  try {
    if (!isAvailableModel(model)) throw new AiError("That model is not configured on this server.", 400);
    if (isSelfHosted(model)) {
      await compatChat({ model: model.slice(OC.length), max_tokens: 8, messages: [{ role: "user", content: "Reply with the single word: connected" }], chat_template_kwargs: { enable_thinking: false } });
    } else {
      try { await anthropic().messages.create({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: connected" }] }); }
      catch (e) { translateAnthropic(e); }
    }
    result = { ok: true, at: new Date().toISOString(), model, ms: Date.now() - started, error: null };
  } catch (e: any) {
    result = { ok: false, at: new Date().toISOString(), model, ms: Date.now() - started, error: e instanceof AiError ? e.message : "The test failed." };
  }
  await prisma.appSetting.upsert({ where: { key: "aiConnection" }, create: { key: "aiConnection", value: { lastTest: result } }, update: { value: { lastTest: result } } });
  return result;
}

export type AiFile = { data: Buffer; mediaType: string };

/** Structured output: the reply is JSON matching `schema`, or an AiError explains why not. */
export async function askJson<T>(a: { model: string; system: string; prompt: string; schema: object; maxTokens?: number; file?: AiFile }): Promise<T> {
  if (!isAvailableModel(a.model)) throw new AiError(`${modelLabel(a.model)} is not configured on this server.`, 409);
  let text = "";
  if (isSelfHosted(a.model)) {
    if (a.file && !a.file.mediaType.startsWith("image/")) throw new AiError("The self-hosted model reads images only. Upload a JPG, PNG or WEBP instead of a PDF.", 400);
    const content = a.file
      ? [{ type: "image_url", image_url: { url: `data:${a.file.mediaType};base64,${a.file.data.toString("base64")}` } }, { type: "text", text: a.prompt }]
      : a.prompt;
    const out = await compatChat({
      model: a.model.slice(OC.length),
      max_tokens: a.maxTokens ?? 4000,
      messages: [{ role: "system", content: a.system }, { role: "user", content }],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: a.schema } },
      // Qwen-style models "think" before answering by default: slower, and no better at copying fields.
      chat_template_kwargs: { enable_thinking: false },
    });
    const choice = out?.choices?.[0];
    if (choice?.finish_reason === "length") throw new AiError("The model ran out of room before finishing.", 422);
    text = cleanJsonText(choice?.message?.content ?? "");
  } else {
    let res: Anthropic.Beta.Messages.BetaMessage;
    const block: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    if (a.file) {
      const b64 = a.file.data.toString("base64");
      block.push(a.file.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
        : { type: "image", source: { type: "base64", media_type: a.file.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: b64 } });
    }
    try {
      res = await anthropic().beta.messages.create({
        model: a.model,
        max_tokens: a.maxTokens ?? 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: a.system,
        output_config: { format: { type: "json_schema", schema: a.schema as any } },
        messages: [{ role: "user", content: [...block, { type: "text", text: a.prompt }] }],
      });
    } catch (e) { translateAnthropic(e); }
    if (res!.stop_reason === "refusal") throw new AiError("The model declined this request.", 422);
    if (res!.stop_reason === "max_tokens") throw new AiError("The model ran out of room before finishing.", 422);
    text = res!.content.find((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")?.text ?? "";
  }
  try { return JSON.parse(text) as T; } catch { throw new AiError("The model's answer could not be understood.", 502); }
}

export type ToolDef = { name: string; description: string; input_schema: object; run: (input: any) => Promise<unknown> };

/**
 * A question answered with tools. The loop is ours, so every tool call goes through `run` — where the
 * caller's permissions are enforced — and the number of turns is capped.
 */
export async function askWithTools(a: { model: string; system: string; question: string; tools: ToolDef[]; maxTurns?: number }) {
  if (!isAvailableModel(a.model)) throw new AiError(`${modelLabel(a.model)} is not configured on this server.`, 409);
  const used: { tool: string; input: unknown }[] = [];
  const runTool = async (name: string, input: unknown) => {
    const def = a.tools.find(t => t.name === name);
    used.push({ tool: name, input });
    try { return { ok: true, content: JSON.stringify(def ? await def.run(input) : { error: "No such tool" }).slice(0, 60_000) }; }
    catch (e: any) { return { ok: false, content: String(e?.message ?? "The lookup failed.") }; }
  };

  if (isSelfHosted(a.model)) {
    const messages: any[] = [{ role: "system", content: a.system }, { role: "user", content: a.question }];
    const tools = a.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    for (let turn = 0; turn < (a.maxTurns ?? 8); turn++) {
      const out = await compatChat({ model: a.model.slice(OC.length), max_tokens: 3000, messages, tools, chat_template_kwargs: { enable_thinking: false } });
      const msg = out?.choices?.[0]?.message ?? {};
      const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) return { answer: cleanJsonText(msg.content ?? "").trim(), used };
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
      for (const c of calls) {
        let input: unknown = {};
        try { input = JSON.parse(c.function?.arguments || "{}"); } catch { input = {}; }
        const r = await runTool(String(c.function?.name ?? ""), input);
        messages.push({ role: "tool", tool_call_id: c.id, content: r.content });
      }
    }
    throw new AiError("The question needed too many lookups. Ask something narrower.", 422);
  }

  const api = anthropic();
  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: a.question }];
  const tools = a.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema as any }));
  for (let turn = 0; turn < (a.maxTurns ?? 8); turn++) {
    let res: Anthropic.Messages.Message;
    try { res = await api.messages.create({ model: a.model, max_tokens: 4000, system: a.system, tools, messages }); }
    catch (e) { translateAnthropic(e); }
    if (res!.stop_reason === "refusal") throw new AiError("The model declined this question.", 422);
    messages.push({ role: "assistant", content: res!.content });
    const calls = res!.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      return { answer: res!.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map(b => b.text).join("\n").trim(), used };
    }
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const c of calls) {
      const r = await runTool(c.name, c.input);
      results.push({ type: "tool_result", tool_use_id: c.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new AiError("The question needed too many lookups. Ask something narrower.", 422);
}
