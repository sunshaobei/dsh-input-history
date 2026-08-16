import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The client bundle registers through window.__ModuleLoader__ and never
 * imports a module; the shim captures the registration and executes the
 * factory with a require that must never be called.
 */
const registrations = [];
globalThis.window = { __ModuleLoader__: { load(spec) { registrations.push(spec); } } };
// browser-only surfaces the client half touches at activation (no-ops under node)
globalThis.document = { addEventListener() {}, removeEventListener() {} };
await import("../lib/client.js");

assert.equal(registrations.length, 1, "bundle registers exactly once");
assert.equal(registrations[0].id, "dsh-input-history");
const client = registrations[0].factory(() => {
	throw new Error("client bundle must not require any module");
});
const t = client.__test;

/* ------------------------------- plugin shape ------------------------------- */

test("plugin exports the cordis client shape and needs only sessions", () => {
	assert.equal(typeof client.apply, "function");
	assert.deepEqual(client.inject, ["sessions"]);
});

/* ------------------------------- block folding ------------------------------ */

test("foldFileBlocks collapses text and binary blocks back to mentions", () => {
	const prompt =
		'look at @src/a.ts\n<file path="src/a.ts">\nlet x = 1;\n</file>\nand @logo.png\n<file path="logo.png" binary size="123"/>\nplease review';
	assert.equal(t.foldFileBlocks(prompt), "look at @src/a.ts and @logo.png please review");
	const truncated =
		'@big.log\n<file path="big.log">\ndata\n[truncated at 524288 bytes]\n</file>\n';
	assert.equal(t.foldFileBlocks(truncated), "@big.log ");
	assert.equal(t.foldFileBlocks("no blocks here"), "no blocks here");
});

/* ----------------------------- history reducer ----------------------------- */

test("historyNav: up recalls on empty draft only, walks back, down restores", () => {
	const state = { entries: ["first", "second", "third"], cursor: null, original: "" };
	assert.equal(t.historyNav(state, "up", "not empty"), null);
	assert.equal(t.historyNav(state, "down", ""), null);
	const up1 = t.historyNav(state, "up", "");
	assert.deepEqual(up1, { cursor: 2, original: "", text: "third" });
	const browsing = { ...state, cursor: 2, original: "" };
	const up2 = t.historyNav(browsing, "up", "third");
	assert.deepEqual(up2, { cursor: 1, original: "", text: "second" });
	const oldest = { ...state, cursor: 0, original: "" };
	assert.equal(t.historyNav(oldest, "up", "first"), null);
	const down = t.historyNav(browsing, "down", "third");
	assert.deepEqual(down, { cursor: null, original: "", text: "" });
	const mid = { ...state, cursor: 1, original: "typed before" };
	const downMid = t.historyNav(mid, "down", "second");
	assert.deepEqual(downMid, { cursor: 2, original: "typed before", text: "third" });
	// a manual edit silently exits browsing: the next up re-recalls from empty
	assert.equal(t.historyNav(mid, "up", "edited text"), null);
});

