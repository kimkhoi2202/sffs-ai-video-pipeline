/**
 * log.ts — tiny structured logger. Every decision + gate result is logged both to
 * stdout (journald via systemd) and appended to the current run's JSONL log so the
 * dashboard can show exactly what the loop decided and why.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let RUN_LOG: string | null = null;

export function setRunLog(path: string): void {
  RUN_LOG = path;
  mkdirSync(dirname(path), { recursive: true });
}

export type Level = "info" | "warn" | "error" | "gate" | "decision";

export function log(level: Level, msg: string, data?: unknown): void {
  const rec = { ts: new Date().toISOString(), level, msg, ...(data !== undefined ? { data } : {}) };
  const line = JSON.stringify(rec);
  const tag = level.toUpperCase().padEnd(8);
  // eslint-disable-next-line no-console
  console.log(`${rec.ts} ${tag} ${msg}${data !== undefined ? " " + safe(data) : ""}`);
  if (RUN_LOG) {
    try {
      appendFileSync(RUN_LOG, line + "\n");
    } catch {
      /* best-effort */
    }
  }
}

function safe(d: unknown): string {
  try {
    const s = JSON.stringify(d);
    return s.length > 600 ? s.slice(0, 600) + "…" : s;
  } catch {
    return String(d);
  }
}

export const info = (m: string, d?: unknown) => log("info", m, d);
export const warn = (m: string, d?: unknown) => log("warn", m, d);
export const error = (m: string, d?: unknown) => log("error", m, d);
export const gate = (m: string, d?: unknown) => log("gate", m, d);
export const decision = (m: string, d?: unknown) => log("decision", m, d);
