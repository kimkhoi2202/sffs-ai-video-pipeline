/**
 * llm.ts — the "brain": OpenAI SDK pointed at the TrueFoundry gateway.
 * Model: claude-opus-4-8 (design/validation), claude-haiku-4-5 (routine copy).
 *
 * SAFETY: the LLM only ever produces DATA (experiment specs, captions, validation
 * verdicts). It never edits code, and nothing it returns is executed. Any future
 * code suggestions must go through a human PR — never auto-applied.
 */
import OpenAI from "openai";
import { CONFIG } from "./config.ts";
import { warn, info } from "./log.ts";

const client = new OpenAI({ baseURL: CONFIG.TFY_BASE_URL, apiKey: CONFIG.TFY_API_KEY });

export interface ChatOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Model to try when `model` is exhausted. Exists for the SHARED daily budget: the
   * gateway's cap is per virtual account and is spent by workloads that are nothing to
   * do with this loop, so an Opus 429 here says "someone else is busy", not "this
   * question is unjudgeable". Falling back to the cheap model keeps a real verdict
   * instead of degrading to the structural check.
   */
  fallbackModel?: string;
}

// ── Call accounting ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS. The TrueFoundry billing view showed daily spend through 25 July and
// then flat zero, which reads like an agent that has stopped thinking. Answering it
// took an afternoon of log archaeology, because a SUCCESSFUL call logged nothing at
// all — only failures were visible, so the logs could prove the loop was broken and
// could not prove it was working. The gateway returns `costInUSD` on every response;
// recording it makes the next version of that question a one-line lookup.
export interface LlmUsage {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUSD: number;
}
const usage = new Map<string, LlmUsage>();

function record(model: string, patch: Partial<LlmUsage>): void {
  const u = usage.get(model) ?? { calls: 0, failedCalls: 0, promptTokens: 0, completionTokens: 0, costUSD: 0 };
  u.calls += patch.calls ?? 0;
  u.failedCalls += patch.failedCalls ?? 0;
  u.promptTokens += patch.promptTokens ?? 0;
  u.completionTokens += patch.completionTokens ?? 0;
  u.costUSD += patch.costUSD ?? 0;
  usage.set(model, u);
}

/** Everything this process has spent, per model, plus a total. Cheap; call anytime. */
export function llmUsageReport(): { by_model: Record<string, LlmUsage>; total: LlmUsage } {
  const by_model: Record<string, LlmUsage> = {};
  const total: LlmUsage = { calls: 0, failedCalls: 0, promptTokens: 0, completionTokens: 0, costUSD: 0 };
  for (const [m, u] of usage) {
    by_model[m] = { ...u, costUSD: Math.round(u.costUSD * 1e6) / 1e6 };
    total.calls += u.calls;
    total.failedCalls += u.failedCalls;
    total.promptTokens += u.promptTokens;
    total.completionTokens += u.completionTokens;
    total.costUSD += u.costUSD;
  }
  total.costUSD = Math.round(total.costUSD * 1e6) / 1e6;
  return { by_model, total };
}

/** Test seam: forget everything recorded so far. */
export function resetLlmUsage(): void {
  usage.clear();
}

/** One model, up to `attempts` tries. Throws when they are all spent. */
async function chatOnce(model: string, system: string, user: string, opts: ChatOpts, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // NOTE: the Claude models on the TrueFoundry gateway REJECT the `temperature`
      // param, so we omit it by default and only send it if explicitly opted in via
      // HERMES_SEND_TEMPERATURE=1. On claude-opus-5 the failure is especially
      // misleading: sending temperature makes the primary route refuse, the gateway
      // fails over to an unsubscribed Bedrock copy, and the caller sees a 403 about
      // AWS Marketplace permissions rather than anything about the parameter.
      const body: Record<string, unknown> = {
        model,
        max_tokens: opts.maxTokens ?? 1200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      if (process.env.HERMES_SEND_TEMPERATURE === "1" && opts.temperature !== undefined) {
        body.temperature = opts.temperature;
      }
      const res = await client.chat.completions.create(body as any);
      const u = (res as any)?.usage ?? {};
      record(model, {
        calls: 1,
        promptTokens: Number(u.prompt_tokens) || 0,
        completionTokens: Number(u.completion_tokens) || 0,
        // Non-standard, and the whole point: TrueFoundry prices the call for us, so we
        // never have to keep a price table in sync with the gateway's routing.
        costUSD: Number(u.costInUSD) || 0,
      });
      return res.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      lastErr = e;
      record(model, { failedCalls: 1 });
      warn(`llm chat attempt ${attempt + 1} failed`, { model, err: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function chat(system: string, user: string, opts: ChatOpts = {}): Promise<string> {
  const model = opts.model ?? CONFIG.MODEL;
  try {
    return await chatOnce(model, system, user, opts);
  } catch (e) {
    const fb = opts.fallbackModel;
    if (!fb || fb === model) {
      throw new Error(`LLM chat failed after retries: ${e instanceof Error ? e.message : String(e)}`);
    }
    warn(`llm: ${model} exhausted — falling back to ${fb}`, { err: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    try {
      const out = await chatOnce(fb, system, user, opts);
      info(`llm: ${fb} answered in place of ${model}`);
      return out;
    } catch (e2) {
      throw new Error(`LLM chat failed after retries on ${model} and ${fb}: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
}

/** Extract the first JSON object/array from a model response (tolerates fences/prose). */
export function extractJSON<T = any>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // find the outermost {...} or [...]
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(t.slice(start, i + 1)) as T;
      }
    }
  }
  throw new Error(`Unbalanced JSON in LLM response: ${text.slice(0, 200)}`);
}

export async function chatJSON<T = any>(system: string, user: string, opts: ChatOpts = {}): Promise<T> {
  const raw = await chat(system + "\n\nRespond with ONLY valid JSON. No prose, no code fences.", user, {
    ...opts,
    temperature: opts.temperature ?? 0.2,
  });
  return extractJSON<T>(raw);
}

/** One line for the cycle log + the run state: what this process actually spent. */
export function logLlmUsage(): ReturnType<typeof llmUsageReport> {
  const r = llmUsageReport();
  info("LLM usage this cycle", {
    calls: r.total.calls,
    failed: r.total.failedCalls,
    prompt_tokens: r.total.promptTokens,
    completion_tokens: r.total.completionTokens,
    cost_usd: r.total.costUSD,
    by_model: Object.fromEntries(Object.entries(r.by_model).map(([m, u]) => [m, `${u.calls} calls, $${u.costUSD}`])),
  });
  return r;
}

/** Cheap connectivity probe used by cycle preflight + the dashboard. */
export async function ping(): Promise<{ ok: boolean; model: string; reply?: string; error?: string }> {
  try {
    const reply = await chat("You are a health check.", "Reply with the single word: pong", { maxTokens: 8, temperature: 0 });
    return { ok: /pong/i.test(reply), model: CONFIG.MODEL, reply: reply.trim().slice(0, 40) };
  } catch (e) {
    return { ok: false, model: CONFIG.MODEL, error: e instanceof Error ? e.message : String(e) };
  }
}
