/**
 * Shared HTTP + formatting helpers. Replaces utils/exec.ts entirely.
 *
 * Uses Node 20's native fetch() — no Python subprocess overhead.
 * Retry/backoff matches ml-intern's papers_tool.py behavior exactly.
 */
const MAX_OUTPUT = 12_000;

export interface ToolOutput {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

// ── Retry/backoff (matches ml-intern: 3 tries, 60s on 429, 3s on 5xx) ──

export async function fetchWithRetry(
  url: string,
  opts: RequestInit & { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429 && attempt < retries) {
        await sleep(60_000);
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(3_000);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(3_000);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${url}`);
}

// ── Output formatting ──

export function ok(text: string, details: Record<string, unknown> = {}): ToolOutput {
  const truncated =
    text.length > MAX_OUTPUT
      ? text.slice(0, Math.floor(MAX_OUTPUT * 0.6)) +
        `\n...(truncated ${text.length - MAX_OUTPUT} chars)...\n` +
        text.slice(-Math.floor(MAX_OUTPUT * 0.4))
      : text;
  return {
    content: [{ type: "text", text: truncated }],
    details: { ...details, truncated: text.length > MAX_OUTPUT },
  };
}

export function err(msg: string, details: Record<string, unknown> = {}): ToolOutput {
  return {
    content: [{ type: "text", text: msg }],
    details: { isError: true, ...details },
  };
}

// ── Shared auth ──

export function hfHeaders(): Record<string, string> {
  const token = process.env.HF_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ml-intern-pi",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Inlined from @earendil-works/pi-ai ──

import { Type } from "typebox";

export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}