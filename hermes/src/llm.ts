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
import { warn } from "./log.ts";

const client = new OpenAI({ baseURL: CONFIG.TFY_BASE_URL, apiKey: CONFIG.TFY_API_KEY });

export interface ChatOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function chat(system: string, user: string, opts: ChatOpts = {}): Promise<string> {
  const model = opts.model ?? CONFIG.MODEL;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // NOTE: claude-opus-4-8 / claude-haiku-4-5 on the TrueFoundry gateway REJECT the
      // `temperature` param ("temperature is deprecated for this model"), so we omit it
      // by default and only send it if explicitly opted in via HERMES_SEND_TEMPERATURE=1.
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
      return res.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      lastErr = e;
      warn(`llm chat attempt ${attempt + 1} failed`, { model, err: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`LLM chat failed after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
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

/** Cheap connectivity probe used by cycle preflight + the dashboard. */
export async function ping(): Promise<{ ok: boolean; model: string; reply?: string; error?: string }> {
  try {
    const reply = await chat("You are a health check.", "Reply with the single word: pong", { maxTokens: 8, temperature: 0 });
    return { ok: /pong/i.test(reply), model: CONFIG.MODEL, reply: reply.trim().slice(0, 40) };
  } catch (e) {
    return { ok: false, model: CONFIG.MODEL, error: e instanceof Error ? e.message : String(e) };
  }
}
