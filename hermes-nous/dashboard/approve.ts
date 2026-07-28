/**
 * approve.ts — the dashboard's ONLY mutation, deliberately kept as small as it can be.
 *
 * THE THREAT MODEL, stated plainly
 * The dashboard is on a public IP over plain HTTP behind one shared word. So the design
 * assumption is that the password WILL eventually be guessed or sniffed, and the job is
 * to make that outcome boring. Everything below exists to bound the blast radius:
 *
 *   - Exactly two verbs: approve, reject. There is no delete, no caption edit, no time
 *     edit, no config write, no "post this content" — nothing that accepts caller-supplied
 *     content at all. The ONLY caller input is a uuid and which of the two verbs to run.
 *   - The target must ALREADY be an unapproved loop draft. approve() and reject() both
 *     re-read the post and refuse anything that is not `draft:true, autoPublish:false`,
 *     so neither can touch a live post, a published post, or the 21 human-reviewed reels
 *     already on the calendar — those are not drafts, so they are structurally out of reach.
 *   - Reject is a SOFT delete, which Metricool keeps restorable.
 *
 * The worst a stranger can do is approve or reject videos the user was already going to
 * decide on, and every decision is recoverable.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** Chosen by the user with the HTTP/guessability tradeoff already explained and accepted. */
const PASSWORD = process.env.HERMES_APPROVAL_PASSWORD || "alphaaiengineering";
const MAX_BODY = 2048; // a uuid and a password; anything larger is not a real request.

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // also accept a form post, so the UI can work without JS if it ever needs to
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

export interface ApprovalOutcome {
  status: number;
  body: { ok: boolean; action?: string; uuid?: string; reason: string };
}

/**
 * Handle one approve/reject request. Pure enough to test directly: `act` is injected so
 * the guardrail suite can exercise the auth and scoping rules without a live account.
 */
export async function handleApproval(
  action: "approve" | "reject",
  req: IncomingMessage,
  act?: { approve: (u: string) => Promise<{ ok: boolean; reason: string }>; reject: (u: string) => Promise<{ ok: boolean; reason: string }> },
): Promise<ApprovalOutcome> {
  if (req.method !== "POST") {
    return { status: 405, body: { ok: false, reason: "POST only" } };
  }
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    return { status: 413, body: { ok: false, reason: "request too large" } };
  }
  if (!constantTimeEq(String(body.password ?? ""), PASSWORD)) {
    return { status: 401, body: { ok: false, reason: "wrong password" } };
  }
  const uuid = String(body.uuid ?? "").trim();
  // A Metricool uuid is a (possibly negative) integer string. Constraining the shape here
  // means nothing else can be smuggled into the id position.
  if (!/^-?\d{1,25}$/.test(uuid)) {
    return { status: 400, body: { ok: false, reason: "a single numeric post uuid is required" } };
  }
  const impl = act ?? (await import("../../hermes/src/approval.ts"));
  const r = action === "approve" ? await impl.approve(uuid) : await impl.reject(uuid);
  return { status: r.ok ? 200 : 409, body: { ok: r.ok, action, uuid, reason: r.reason } };
}

/** Wire the two routes. Returns true when it handled the request. */
export async function routeApproval(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const action = pathname === "/api/approve" ? "approve" : pathname === "/api/reject" ? "reject" : null;
  if (!action) return false;
  const out = await handleApproval(action, req);
  const payload = JSON.stringify(out.body);
  res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
  return true;
}

/** The two paths that may mutate. Asserted against in the guardrail suite. */
export const MUTATING_ROUTES = ["/api/approve", "/api/reject"] as const;
