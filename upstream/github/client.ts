// Hugging Face Chat UI, Apache-2.0. 1c9c9bcbd92da1c4bdcc7d4a20354191c747709e
// Modified: local configuration import / reviewable NUL spelling.
import { config } from "./config";

/**
 * The GitHub REST layer the grounding tools share.
 *
 * Two properties matter to everything built on top:
 *
 * - **Failures are values, not exceptions.** A model recovers from
 *   `"File not found: examples/scripts/sft.py in huggingface/trl"` far better
 *   than from a rejected promise, so every path here returns a result the caller
 *   can turn into readable text.
 * - **Repeated reads are cheap.** A repo tree is stable for hours and every
 *   `github_find_examples` call wants the same one, so responses are cached with
 *   a short TTL and revalidated with `If-None-Match` when it lapses. A 304 does
 *   not count against the GitHub rate limit, so a lapsed entry costs a round
 *   trip but not budget.
 */

const API_ROOT = "https://api.github.com";

/** Repo metadata is small and on the critical path; everything else can take longer. */
export const METADATA_TIMEOUT_MS = 10_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

const TTL_MS = 5 * 60_000;
/** Trees run to several MB, so the cache is bounded by bytes rather than entries. */
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

export const MISSING_TOKEN_MESSAGE =
	"GitHub grounding is not configured: set GITHUB_TOKEN to a personal access token. " +
	"It needs no scopes — these are public reads, and the token is only for the rate limit.";

type CacheEntry = { fetchedAt: number; etag?: string; body: string; bytes: number };

// Insertion-ordered, so the oldest key is the first one Map iteration yields.
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;
let cacheToken = "";

function cacheSet(key: string, entry: CacheEntry) {
	const existing = cache.get(key);
	if (existing) cacheBytes -= existing.bytes;
	cache.delete(key);
	cache.set(key, entry);
	cacheBytes += entry.bytes;
	for (const [oldest, value] of cache) {
		if (cacheBytes <= MAX_CACHE_BYTES) break;
		cache.delete(oldest);
		cacheBytes -= value.bytes;
	}
}

export function resetGithubCache() {
	cache.clear();
	cacheBytes = 0;
	cacheToken = "";
}

export type GithubSuccess = { ok: true; body: string; status: number };
export type GithubFailure = { ok: false; status: number; message: string };
export type GithubResult = GithubSuccess | GithubFailure;

/** `true` when the tools cannot run at all, which every handler reports the same way. */
export function githubToken(): string {
	return (config.GITHUB_TOKEN || "").trim();
}

function describeRateLimit(headers: Headers): string {
	const reset = Number(headers.get("x-ratelimit-reset"));
	const retryAfter = Number(headers.get("retry-after"));
	const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
	const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
	// The agent can plan around a wait it can see; it cannot plan around "403".
	if (at) {
		const minutes = Math.max(1, Math.ceil((at.getTime() - Date.now()) / 60_000));
		return `GitHub rate limit exceeded. It resets at ${at.toISOString()} (about ${minutes} minute${minutes === 1 ? "" : "s"} from now). Work with what you already have rather than retrying immediately.`;
	}
	if (seconds) {
		return `GitHub rate limit exceeded. Retry in about ${seconds} seconds rather than immediately.`;
	}
	return "GitHub rate limit exceeded. Retry later rather than immediately.";
}

async function describeError(response: Response): Promise<string> {
	if (response.status === 401) {
		return "GitHub rejected the configured token (401). It may be expired or revoked.";
	}
	if (
		(response.status === 403 || response.status === 429) &&
		response.headers.get("x-ratelimit-remaining") !== null &&
		Number(response.headers.get("x-ratelimit-remaining")) <= 0
	) {
		return describeRateLimit(response.headers);
	}
	let detail = "";
	try {
		const parsed: unknown = JSON.parse(await response.text());
		const message = (parsed as { message?: unknown } | null)?.message;
		if (typeof message === "string" && message.trim()) detail = `: ${message.trim()}`;
	} catch {
		// A non-JSON body tells the agent nothing useful; the status already does.
	}
	return `GitHub API error (status ${response.status})${detail}`;
}

export interface GithubRequestOptions {
	/** Defaults to the JSON media type; `application/vnd.github.raw` for file bodies. */
	accept?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Off for one-shot searches, where a stale "did you mean" is worse than a request. */
	cache?: boolean;
}

/**
 * One GitHub request. `path` is API-root-relative and must already be encoded.
 *
 * Request headers are deliberately never logged: they carry the PAT, and a token
 * in a log line outlives the request that leaked it.
 */
export async function githubRequest(
	path: string,
	options: GithubRequestOptions = {}
): Promise<GithubResult> {
	const token = githubToken();
	if (!token) return { ok: false, status: 0, message: MISSING_TOKEN_MESSAGE };

	// A rotated token invalidates everything: the old responses were scoped to it.
	if (token !== cacheToken) {
		cache.clear();
		cacheBytes = 0;
		cacheToken = token;
	}

	const accept = options.accept ?? "application/vnd.github+json";
	const useCache = options.cache !== false;
	const key = `${accept}\0${path}`;
	const cached = useCache ? cache.get(key) : undefined;
	if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
		return { ok: true, body: cached.body, status: 200 };
	}

	const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(`${API_ROOT}${path}`, {
			headers: {
				Accept: accept,
				"X-GitHub-Api-Version": "2022-11-28",
				Authorization: `Bearer ${token}`,
				...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
			},
			signal,
		});
	} catch (err) {
		if (options.signal?.aborted) return { ok: false, status: 0, message: "Aborted by user" };
		const reason = timeout.aborted
			? `the request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
			: err instanceof Error
				? err.message
				: String(err);
		return { ok: false, status: 0, message: `Could not reach the GitHub API: ${reason}.` };
	}

	if (response.status === 304 && cached) {
		cacheSet(key, { ...cached, fetchedAt: Date.now() });
		return { ok: true, body: cached.body, status: 200 };
	}

	if (!response.ok) {
		return { ok: false, status: response.status, message: await describeError(response) };
	}

	const body = await response.text();
	if (useCache) {
		const etag = response.headers.get("etag") ?? undefined;
		cacheSet(key, { fetchedAt: Date.now(), body, bytes: body.length, ...(etag ? { etag } : {}) });
	}
	return { ok: true, body, status: response.status };
}

/** `githubRequest` plus a JSON parse, with a decode failure reported like any other error. */
export async function githubJson<T>(
	path: string,
	options: GithubRequestOptions = {}
): Promise<{ ok: true; data: T } | GithubFailure> {
	const result = await githubRequest(path, options);
	if (!result.ok) return result;
	try {
		return { ok: true, data: JSON.parse(result.body) as T };
	} catch {
		return { ok: false, status: result.status, message: "GitHub returned a malformed response." };
	}
}

/** `owner/repo` path segments, each encoded so a stray slash cannot escape the route. */
export function encodeSegments(...segments: string[]): string {
	return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

/** A file path keeps its slashes but encodes everything else. */
export function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
