import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// Importing lib/index.js pulls node:fs/promises etc. — fine under node. The
// host half registers no browser surfaces at import time.
const host = await import("../lib/index.js");

/* ------------------------------- store path ------------------------------- */

test("resolveStorePath honors DSH_HOME and falls back to ~/.dsh", () => {
	const dshHome = join(tmpdir(), "dsh-home-test");
	assert.equal(host.resolveStorePath({ DSH_HOME: dshHome }, "/home/u"), join(dshHome, "input-history.json"));
	// blank override treated as unset
	assert.equal(host.resolveStorePath({ DSH_HOME: "   " }, "/home/u"), join("/home/u", ".dsh", "input-history.json"));
	assert.equal(host.resolveStorePath({}, "/home/u"), join("/home/u", ".dsh", "input-history.json"));
});

/* ------------------------------ normalization ----------------------------- */

test("normalizeRing keeps strings, drops blanks, caps, and clamps the limit", () => {
	assert.deepEqual(host.normalizeRing(["a", "b", "a"]), { entries: ["a", "b", "a"], limit: 100 });
	assert.deepEqual(host.normalizeRing(["a", "", "  ", 42, null, "b"]), { entries: ["a", "b"], limit: 100 });
	// consecutive duplicates collapse; non-consecutive ones are kept
	assert.deepEqual(host.normalizeRing(["a", "a", "b", "a"]), { entries: ["a", "b", "a"], limit: 100 });
	// cap keeps the newest
	const many = [];
	for (let i = 0; i < 150; i++) many.push(`m${i}`);
	const capped = host.normalizeRing(many, 50);
	assert.equal(capped.entries.length, 50);
	assert.equal(capped.entries[0], "m100");
	assert.equal(capped.entries[49], "m149");
	// limit clamping: sub-1 clamps to the 1-entry floor, oversize to the ceiling
	assert.equal(host.normalizeRing(["a"], 0).limit, 1);
	assert.equal(host.normalizeRing(["a"], 999_999).limit, 10_000);
	assert.equal(host.normalizeRing(["a"], "x").limit, 100);
	// over-long entries are truncated, never rejected
	const long = "x".repeat(70_000);
	const out = host.normalizeRing([long]);
	assert.equal(out.entries[0].length, 64 * 1024);
	// non-array payloads read as empty
	assert.deepEqual(host.normalizeRing({ a: 1 }), { entries: [], limit: 100 });
});

/* ---------------------------- file persistence ---------------------------- */

test("writeRing persists and readRing round-trips, tolerating bare-array and corruption", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dsh-input-history-"));
	try {
		const path = join(dir, "input-history.json");
		// write + read round-trip through the API envelope
		const ring = { entries: ["a", "b"], limit: 100 };
		await host.__test.writeRing(path, ring);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), ring);
		// readRing returns the persisted envelope
		const api = host.buildApi(() => path);
		assert.deepEqual(await api["history.read"]({}), ring);
		// a bare JSON array is tolerated
		await host.__test.writeRing(path, { entries: ["x"], limit: 100 });
		await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(["bare", "array"])));
		assert.deepEqual(await api["history.read"]({}), { entries: ["bare", "array"], limit: 100 });
		// corruption reads as empty
		await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "not json {"));
		assert.deepEqual(await api["history.read"]({}), { entries: [], limit: 100 });
		// missing file reads as empty
		await rm(path, { force: true });
		assert.deepEqual(await api["history.read"]({}), { entries: [], limit: 100 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("buildApi.history.write validates, caps, persists, and returns the stored ring", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dsh-input-history-"));
	try {
		const path = join(dir, "input-history.json");
		const api = host.buildApi(() => path);
		await assert.rejects(api["history.write"]({}), /entries/);
		await assert.rejects(api["history.write"]({ entries: "nope" }), /entries/);
		const stored = await api["history.write"]({ entries: ["a", "", "b", "c"], limit: 2 });
		assert.deepEqual(stored, { entries: ["b", "c"], limit: 2 });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { entries: ["b", "c"], limit: 2 });
		// concurrent writes serialize without losing data (last wins)
		const p1 = api["history.write"]({ entries: ["1"], limit: 100 });
		const p2 = api["history.write"]({ entries: ["2"], limit: 100 });
		await Promise.all([p1, p2]);
		const final = JSON.parse(await readFile(path, "utf8"));
		assert.deepEqual(final.entries, ["2"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/* ------------------------------ route + fence ----------------------------- */

/** Minimal node:http-like request object with headers + a JSON body stream. */
function fakeRequest({ headers, body }) {
	const req = new PassThrough();
	req.headers = headers;
	req.method = "POST";
	req.url = "/input-history/api/history.read";
	if (body !== undefined) req.write(JSON.stringify(body));
	req.end();
	return req;
}

/** Minimal response double collecting status/body. */
function fakeResponse() {
	let body = "";
	const res = {
		status: 0,
		headers: {},
		writeHead(status, headers) {
			res.status = status;
			res.headers = headers;
		},
		end(chunk) {
			body += chunk;
		},
		get json() {
			return body === "" ? undefined : JSON.parse(body);
		},
	};
	return res;
}

test("routeHandler honors the fence and dispatches methods", async () => {
	const calls = [];
	const api = {
		"history.read": async () => ({ entries: ["a"], limit: 100 }),
		"history.write": async (payload) => {
			calls.push(payload);
			return { entries: ["x"], limit: 100 };
		},
	};
	const trusted = ["127.0.0.1:64414"];
	const fence = (req) => host.isTrustedApiRequest(req, trusted);

	// loopback host + same origin -> allowed
	const okReq = fakeRequest({
		headers: { host: "127.0.0.1:64414", origin: "http://127.0.0.1:64414", "sec-fetch-site": "same-origin" },
	});
	const okRes = fakeResponse();
	await host.routeHandler(fence, api)(okReq, okRes);
	assert.equal(okRes.status, 200);
	assert.deepEqual(okRes.json, { ok: true, value: { entries: ["a"], limit: 100 } });

	// cross-site marker -> forbidden
	const crossReq = fakeRequest({
		headers: { host: "127.0.0.1:64414", origin: "http://evil.example", "sec-fetch-site": "cross-site" },
	});
	const crossRes = fakeResponse();
	await host.routeHandler(fence, api)(crossReq, crossRes);
	assert.equal(crossRes.status, 403);

	// untrusted host -> forbidden
	const untrustedReq = fakeRequest({ headers: { host: "evil.example" } });
	const untrustedRes = fakeResponse();
	await host.routeHandler(fence, api)(untrustedReq, untrustedRes);
	assert.equal(untrustedRes.status, 403);

	// unknown method -> 404
	const missingReq = fakeRequest({ headers: { host: "127.0.0.1:64414", origin: "http://127.0.0.1:64414" } });
	missingReq.url = "/input-history/api/nope";
	const missingRes = fakeResponse();
	await host.routeHandler(fence, api)(missingReq, missingRes);
	assert.equal(missingRes.status, 404);

	// write dispatches the payload through
	const writeReq = fakeRequest({
		headers: { host: "127.0.0.1:64414", origin: "http://127.0.0.1:64414" },
		body: { entries: ["z"], limit: 5 },
	});
	writeReq.url = "/input-history/api/history.write";
	const writeRes = fakeResponse();
	await host.routeHandler(fence, api)(writeReq, writeRes);
	assert.equal(writeRes.status, 200);
	assert.deepEqual(calls, [{ entries: ["z"], limit: 5 }]);
	assert.deepEqual(writeRes.json, { ok: true, value: { entries: ["x"], limit: 100 } });
});

test("isTrustedApiRequest: loopback, trusted host, and origin rules", () => {
	const trusted = ["localhost:64414", "dsh.example"];
	const base = (over) => ({ headers: { host: "localhost:64414", origin: "http://localhost:64414", "sec-fetch-site": "same-origin", ...over } });
	assert.equal(host.isTrustedApiRequest(base({}), trusted), true);
	// matching origin is required once present
	assert.equal(host.isTrustedApiRequest(base({ origin: "http://localhost:9999" }), trusted), false);
	// hostname-only trusted entry matches any port
	assert.equal(host.isTrustedApiRequest(base({ host: "dsh.example:1234", origin: "http://dsh.example:1234" }), trusted), true);
	// no origin header is accepted on a trusted host
	assert.equal(host.isTrustedApiRequest({ headers: { host: "dsh.example", "sec-fetch-site": "same-origin" } }, trusted), true);
	// missing host is never trusted
	assert.equal(host.isTrustedApiRequest({ headers: {} }, trusted), false);
});

test("host half exports the cordis shape", () => {
	assert.equal(typeof host.apply, "function");
	assert.deepEqual(host.inject, ["webServer", "webRuntime"]);
});
