/**
 * dsh-input-history — host half.
 *
 * The composer ↑/↓ history used to live only in localStorage — but the DSH
 * web UI is served from an ephemeral loopback port, so every app restart is
 * a new origin and the ring was gone. The durable copy now lives in ONE
 * JSON file under the DSH home (`$DSH_HOME/input-history.json`, default
 * `~/.dsh/input-history.json`), exposed to the client through one fenced
 * JSON API:
 *
 *   history.read  {}                    -> {entries, limit}
 *   history.write {entries, limit?}     -> {entries, limit}   (as persisted)
 *
 * The route applies the same browser-trust fence as the /api gateway (Host
 * loopback or the web runtime's trustedHosts, plus same-origin browser
 * markers). The client remains the ring's logic owner (fold/dedupe/cap);
 * the host validates, caps, and atomically rewrites the file (tmp+rename).
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Plugin identity for cordis.yml rows. */
const name = "dsh-input-history";

/** Services required before mounting: webserver routes + trusted hosts for the fence. */
const inject = ["webServer", "webRuntime"];

/** Default ring cap when the client does not send one (mirrors the client default). */
const DEFAULT_LIMIT = 100;
/** Ring cap bounds — a hostile/buggy payload can never grow the file unboundedly. */
const MIN_LIMIT = 1;
const MAX_LIMIT = 10_000;
/** Per-entry size bound (chars); longer entries are truncated, never rejected. */
const MAX_ENTRY_CHARS = 64 * 1024;
/** Request JSON body bound. */
const BODY_LIMIT = 1 << 20;

/** One API failure with its wire code and HTTP status. */
class InputHistoryError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

/** Message text of an unknown thrown value. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/* ------------------------------ store path ------------------------------- */

/**
 * Resolve the history file: `$DSH_HOME/input-history.json` when DSH_HOME is
 * set (non-blank), else `~/.dsh/input-history.json`. Resolved per call so
 * tests and late env changes never see a stale root.
 */
export function resolveStorePath(env = process.env, home = homedir()) {
	const override = env.DSH_HOME;
	const root = typeof override === "string" && override.trim() !== "" ? override.trim() : join(home, ".dsh");
	return join(root, "input-history.json");
}

/* ------------------------------ ring file -------------------------------- */

/** Validate/cap one ring payload: strings only, per-entry truncation, newest `limit` kept. */
export function normalizeRing(entries, limit = DEFAULT_LIMIT) {
	const cap = Number.isInteger(limit) ? Math.min(Math.max(limit, MIN_LIMIT), MAX_LIMIT) : DEFAULT_LIMIT;
	if (!Array.isArray(entries)) return { entries: [], limit: cap };
	const clean = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const text = entry.length > MAX_ENTRY_CHARS ? entry.slice(0, MAX_ENTRY_CHARS) : entry;
		if (text.trim() === "") continue;
		// exact consecutive duplicates collapse; full dedupe stays the client's job
		if (clean.length > 0 && clean[clean.length - 1] === text) continue;
		clean.push(text);
	}
	return { entries: clean.slice(-cap), limit: cap };
}

/** Read the persisted ring; absence and corruption both read as empty. */
async function readRing(path) {
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return { entries: [], limit: DEFAULT_LIMIT };
	}
	try {
		const parsed = JSON.parse(raw);
		// tolerate both the current {entries, limit} envelope and a bare array
		if (Array.isArray(parsed)) return normalizeRing(parsed);
		if (parsed !== null && typeof parsed === "object") {
			return normalizeRing(parsed.entries, Number.isInteger(parsed.limit) ? parsed.limit : DEFAULT_LIMIT);
		}
		return { entries: [], limit: DEFAULT_LIMIT };
	} catch {
		return { entries: [], limit: DEFAULT_LIMIT };
	}
}

/** Atomically rewrite the ring file (unique tmp sibling + rename, tmp reaped on failure). */
async function writeRing(path, ring) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify(ring), "utf8");
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

/* ---------------------------------- fence ---------------------------------- */

/** First value of a header entry (node gives string | string[] | undefined). */
const header = (headers, key) => {
	const raw = headers?.[key];
	if (raw === undefined) return undefined;
	return Array.isArray(raw) ? raw[0] : String(raw);
};

/** Parse a Host header value into a URL (hostname/port split); undefined when malformed. */
function parseAuthority(value) {
	if (value === undefined) return undefined;
	try {
		return new URL(`http://${value}`);
	} catch {
		return undefined;
	}
}

/** Loopback hostname test (IPv4 127/8, IPv6 ::1 — Node keeps the brackets — localhost). */
function isLoopbackHostname(hostname) {
	return (
		hostname === "localhost" ||
		hostname === "::1" ||
		hostname === "[::1]" ||
		/^127\.\d+\.\d+\.\d+$/.test(hostname)
	);
}

/** Whether the request authority matches a trustedHosts entry (hostname, plus port when the entry carries one). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		if (typeof entry !== "string" || entry === "") return false;
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		if (entryUrl.port === "") return entryUrl.hostname === hostUrl.hostname;
		return entryUrl.host === hostUrl.host;
	});
}

/** Decide whether one plugin request may reach the API: trusted Host + same-origin browser markers. */
export function isTrustedApiRequest(request, trustedHosts) {
	const host = header(request.headers, "host");
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/* --------------------------------- routing --------------------------------- */

/** Read and parse one JSON request body (size-capped). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const part = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		size += part.length;
		if (size > BODY_LIMIT) throw new InputHistoryError("bad-request", "request body too large");
		chunks.push(part);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") return {};
		return parsed;
	} catch {
		throw new InputHistoryError("bad-request", "request body is not valid JSON");
	}
}

/** Write one JSON response. */
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

const writeOk = (res, value) => writeJson(res, 200, { ok: true, value });
const writeError = (res, error) => {
	const ih = error instanceof InputHistoryError;
	const status = ih ? error.status : 500;
	const code = ih ? error.code : "internal";
	writeJson(res, status, { ok: false, error: { code, message: messageOf(error) } });
};

/**
 * Serialize writes: concurrent clients (two windows/tabs) chain onto one
 * promise so a tmp+rename never races another rename of the same file.
 */
let writeChain = Promise.resolve();

/** Build the API table bound to the store path resolver. */
export function buildApi(storePath = resolveStorePath) {
	return {
		"history.read": async () => readRing(storePath()),
		"history.write": async (payload) => {
			if (!Array.isArray(payload?.entries)) {
				throw new InputHistoryError("bad-request", 'missing or invalid "entries"');
			}
			const ring = normalizeRing(payload.entries, payload.limit);
			const path = storePath();
			const run = writeChain.then(() => writeRing(path, ring));
			writeChain = run.catch(() => {});
			await run;
			return ring;
		},
	};
}

/** Build the fenced POST-dispatch route handler bound to the API table. */
export function routeHandler(fence, api) {
	return async (req, res) => {
		if (!fence(req)) {
			writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
			return;
		}
		if (req.method !== "POST") {
			writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
			return;
		}
		const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
		const prefix = "/input-history/api/";
		const method = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : undefined;
		if (method === undefined || method.includes("/")) {
			writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown input-history API method" } });
			return;
		}
		try {
			const payload = await readJsonBody(req);
			const handler = api[method];
			if (handler === undefined) {
				throw new InputHistoryError("not-found", `unknown input-history API method "${method}"`, 404);
			}
			writeOk(res, await handler(payload ?? {}));
		} catch (error) {
			writeError(res, error);
		}
	};
}

/**
 * Host plugin body: mount the fenced /input-history/api routes; the file
 * store under the DSH home is the ring's durable copy.
 * @param ctx - host plugin context (webServer, webRuntime).
 */
export function apply(ctx) {
	const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);
	ctx.effect(
		() => ctx.webServer.register({ kind: "prefix", path: "/input-history/api", handler: routeHandler(fence, buildApi()) }),
		"dsh-input-history: /input-history/api routes",
	);
}

/** Pure-helper test surface (not a plugin contract). */
export const __test = { resolveStorePath, normalizeRing, readRing, writeRing, isTrustedApiRequest, readJsonBody, buildApi, routeHandler, InputHistoryError };

export { name, inject };
