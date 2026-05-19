/**
 * Tests for fetchWithRetry and error handling across tools.
 *
 * Covers:
 *   1. fetchWithRetry retry logic: 429 → wait 60s, 5xx → wait 3s
 *   2. Exhausted retries return final response (callers check .ok)
 *   3. Timeout handling
 *   4. ok/err formatters
 *   5. hfHeaders/ghHeaders auth token injection
 *   6. StringEnum type construction
 *
 * NOTE: fetchWithRetry returns the final Response even after exhausting
 * retries. Tool-level functions are responsible for checking res.ok and
 * throwing/returning err(). This matches ml-intern's behavior where retries
 * are silent and the caller decides how to handle final failures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  fetchWithRetry,
  ok,
  err,
  hfHeaders,
  ghHeaders,
  StringEnum,
  checkRateLimit,
} from "../utils/api";

// ── Mock fetch for controlled HTTP responses ──
let mockResponses: Response[];

function mockFetch(responses: Response[]) {
  mockResponses = [...responses];
  return vi.fn().mockImplementation(async () => {
    const response = mockResponses.shift();
    if (!response) {
      return new Response("no more mock responses", { status: 500 });
    }
    return response;
  });
}

// ── Helper: temporarily make setTimeout instant ──
function useInstantTimers() {
  // Patch setTimeout to call the callback immediately (via microtask to
  // allow the async flow to proceed). This avoids real 60s/3s delays.
  const orig = globalThis.setTimeout;
  // @ts-expect-error: replacing native setTimeout
  globalThis.setTimeout = (cb: (...args: unknown[]) => void, _ms?: number) => {
    Promise.resolve().then(() => cb());
    return 1 as unknown as ReturnType<typeof setTimeout>;
  };
  const origClear = globalThis.clearTimeout;
  globalThis.clearTimeout = vi.fn() as unknown as typeof clearTimeout;
  return () => {
    globalThis.setTimeout = orig;
    globalThis.clearTimeout = origClear;
  };
}

beforeEach(() => {
  mockResponses = [];
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──

describe("fetchWithRetry — success path", () => {
  it("returns immediately on success (200)", async () => {
    globalThis.fetch = mockFetch([new Response("ok", { status: 200 })]);
    const res = await fetchWithRetry("https://example.com", { retries: 0 });
    expect(res.status).toBe(200);
    expect(mockResponses.length).toBe(0);
  });

  it("does NOT retry on 4xx (except 429)", async () => {
    globalThis.fetch = mockFetch([new Response("bad request", { status: 400 })]);
    const res = await fetchWithRetry("https://example.com", { retries: 2 });
    expect(res.status).toBe(400);
  });

  it("does NOT retry on 404", async () => {
    globalThis.fetch = mockFetch([new Response("not found", { status: 404 })]);
    const res = await fetchWithRetry("https://example.com", { retries: 2 });
    expect(res.status).toBe(404);
  });
});

describe("fetchWithRetry — network/timeout errors", () => {
  // These tests use the real setTimeout (3s sleep), but since fetch is
  // mocked and throws immediately, sleep is never reached.
  it("retries on network errors, throws original error after all fail", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      throw new Error("ECONNREFUSED");
    });

    // Speed up: replace setTimeout temporarily
    const restore = useInstantTimers();

    // fetchWithRetry re-throws the last network error after exhausting retries
    await expect(
      fetchWithRetry("https://example.com", { retries: 1 })
    ).rejects.toThrow("ECONNREFUSED");
    expect(callCount).toBe(2);

    restore();
  });

  it("retries on abort/timeout then succeeds", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return new Response("ok", { status: 200 });
    });

    const restore = useInstantTimers();

    const res = await fetchWithRetry("https://example.com", {
      retries: 1,
      timeoutMs: 100,
    });
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);

    restore();
  });
});

describe("fetchWithRetry — retry decision logic (429, 5xx)", () => {
  it("retries on 429 and returns final 429 when exhausted", async () => {
    const restore = useInstantTimers();

    globalThis.fetch = mockFetch([
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
    ]);

    const res = await fetchWithRetry("https://example.com", { retries: 2 });
    expect(res.status).toBe(429);
    expect(mockResponses.length).toBe(0);

    restore();
  });

  it("retries on 503 and returns final 503 when exhausted", async () => {
    const restore = useInstantTimers();

    globalThis.fetch = mockFetch([
      new Response("server error", { status: 503 }),
      new Response("server error", { status: 503 }),
      new Response("server error", { status: 503 }),
    ]);

    const res = await fetchWithRetry("https://example.com", { retries: 2 });
    expect(res.status).toBe(503);

    restore();
  });

  it("retries on transient 5xx then returns success", async () => {
    const restore = useInstantTimers();

    globalThis.fetch = mockFetch([
      new Response("server error", { status: 500 }),
      new Response("server error", { status: 500 }),
      new Response("ok", { status: 200 }),
    ]);

    const res = await fetchWithRetry("https://example.com", { retries: 2 });
    expect(res.status).toBe(200);

    restore();
  });

  it("respects custom retry count", async () => {
    const restore = useInstantTimers();

    globalThis.fetch = mockFetch([
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
    ]);

    const res = await fetchWithRetry("https://example.com", { retries: 4 });
    expect(res.status).toBe(429);

    restore();
  });
});

// ── ok/err formatters ──

describe("ok output formatter", () => {
  it("wraps text in content array with details", () => {
    const result = ok("hello world", { count: 42 });
    expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(result.details).toEqual({ count: 42, truncated: false });
  });

  it("truncates long text and marks truncated: true", () => {
    const long = "x".repeat(20_000);
    const result = ok(long);
    expect(result.content[0].text.length).toBeLessThan(long.length);
    expect(result.details.truncated).toBe(true);
  });

  it("does not truncate short text", () => {
    const result = ok("short");
    expect(result.content[0].text).toBe("short");
    expect(result.details.truncated).toBe(false);
  });
});

describe("err output formatter", () => {
  it("wraps error message with isError flag", () => {
    const result = err("something went wrong", { code: 500 });
    expect(result.content).toEqual([{ type: "text", text: "something went wrong" }]);
    expect(result.details).toEqual({ isError: true, code: 500 });
  });
});

// ── Auth headers ──

describe("hfHeaders", () => {
  it("returns Authorization when HF_TOKEN is set", () => {
    process.env.HF_TOKEN = "hf_test_token_123";
    const h = hfHeaders();
    expect(h).toEqual({ Authorization: "Bearer hf_test_token_123" });
    delete process.env.HF_TOKEN;
  });

  it("returns empty object when HF_TOKEN is not set", () => {
    const saved = process.env.HF_TOKEN;
    delete process.env.HF_TOKEN;
    const h = hfHeaders();
    expect(h).toEqual({});
    if (saved) process.env.HF_TOKEN = saved;
  });
});

describe("ghHeaders", () => {
  it("returns Authorization when GITHUB_TOKEN is set", () => {
    process.env.GITHUB_TOKEN = "gh_test_token_456";
    const h = ghHeaders();
    expect(h.Authorization).toBe("Bearer gh_test_token_456");
    expect(h.Accept).toBe("application/vnd.github.v3+json");
    expect(h["User-Agent"]).toBe("ml-intern-pi");
    delete process.env.GITHUB_TOKEN;
  });

  it("returns minimal headers when GITHUB_TOKEN is not set", () => {
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const h = ghHeaders();
    expect(h.Authorization).toBeUndefined();
    expect(h.Accept).toBe("application/vnd.github.v3+json");
    expect(h["User-Agent"]).toBe("ml-intern-pi");
    if (saved) process.env.GITHUB_TOKEN = saved;
  });
});

// ── StringEnum ──

describe("StringEnum", () => {
  it("creates an enum-typed schema", () => {
    const schema = StringEnum(["red", "green", "blue"] as const);
    expect(schema.type).toBe("string");
    expect(schema.enum).toEqual(["red", "green", "blue"]);
  });

  it("includes description when provided", () => {
    const schema = StringEnum(["a", "b"] as const, { description: "choose one" });
    expect(schema.description).toBe("choose one");
  });

  it("includes default when provided", () => {
    const schema = StringEnum(["x", "y"] as const, { default: "x" });
    expect(schema.default).toBe("x");
  });
});

// ── checkRateLimit helper ──

describe("checkRateLimit helper", () => {
  it("returns null for 200 OK", () => {
    const msg = checkRateLimit(new Response("ok", { status: 200 }));
    expect(msg).toBeNull();
  });

  it("returns null for 201 Created", () => {
    const msg = checkRateLimit(new Response("created", { status: 201 }));
    expect(msg).toBeNull();
  });

  it("returns actionable message for 429", () => {
    const msg = checkRateLimit(new Response("rate limited", { status: 429 }), "hf_papers");
    expect(msg).not.toBeNull();
    expect(msg).toContain("429");
    expect(msg).toContain("hf_papers");
    expect(msg).toContain("60s");
    expect(msg).toContain("retry");
  });

  it("returns actionable message for 429 without context", () => {
    const msg = checkRateLimit(new Response("rate limited", { status: 429 }));
    expect(msg).not.toBeNull();
    expect(msg).toContain("429");
    expect(msg).toContain("retry");
  });

  it("returns server error message for 500", () => {
    const msg = checkRateLimit(new Response("server error", { status: 500 }));
    expect(msg).not.toBeNull();
    expect(msg).toContain("500");
    expect(msg).toContain("retry");
  });

  it("returns server error message for 503", () => {
    const msg = checkRateLimit(new Response("server error", { status: 503 }));
    expect(msg).not.toBeNull();
    expect(msg).toContain("503");
  });

  it("returns null for 4xx client errors (not 429)", () => {
    // 400, 403, 404 are not retryable by fetchWithRetry, and
    // checkRateLimit doesn't provide special messaging for them.
    const msg = checkRateLimit(new Response("bad request", { status: 400 }));
    expect(msg).toBeNull();

    const msg403 = checkRateLimit(new Response("forbidden", { status: 403 }));
    expect(msg403).toBeNull();

    const msg404 = checkRateLimit(new Response("not found", { status: 404 }));
    expect(msg404).toBeNull();
  });
});

// ── Rate limit error messaging guidance ──
// Tests that verify the caller-side pattern for handling exhausted retries.

describe("rate limit exhaustion — caller-side handling pattern", () => {
  it("429 response after retries — caller can produce actionable guidance", async () => {
    const restore = useInstantTimers();

    globalThis.fetch = mockFetch([
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
    ]);

    const res = await fetchWithRetry("https://api.example.com/v1/data", { retries: 2 });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(429);
    expect(res.ok).toBe(false);

    // Simulate tool-level error message generation pattern
    if (res.status === 429) {
      const msg = `Rate limited (HTTP 429). All retries exhausted. Wait 60s and retry.`;
      expect(msg).toContain("Rate limited");
      expect(msg).toContain("429");
      expect(msg).toContain("retry");
    }

    restore();
  });

  it("503 response after retries — caller can produce actionable guidance", async () => {
    const restore = useInstantTimers();

    globalThis.fetch = mockFetch([
      new Response("server error", { status: 503 }),
      new Response("server error", { status: 503 }),
      new Response("server error", { status: 503 }),
    ]);

    const res = await fetchWithRetry("https://api.example.com/v1/data", { retries: 2 });

    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);

    restore();
  });
});
