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

/* ------------------------------ attachment markers -------------------------- */

test("imageMarker renders a name when present, generic marker when unnamed", () => {
	assert.equal(t.imageMarker({ file: { name: "cat.png" } }), "[图片: cat.png]");
	assert.equal(t.imageMarker({ file: { name: "  " } }), "[图片]");
	assert.equal(t.imageMarker({ file: {} }), "[图片]");
	assert.equal(t.imageMarker({}), "[图片]");
	assert.equal(t.imageMarker(null), "[图片]");
	assert.equal(t.imageMarker(undefined), "[图片]");
	assert.deepEqual(t.imageMarkers([
		{ file: { name: "a.png" } },
		{ file: { name: "b.jpg" } },
		{ file: {} },
		null,
	]), ["[图片: a.png]", "[图片: b.jpg]", "[图片]"]);
	assert.deepEqual(t.imageMarkers([]), []);
});

test("composeSendText joins text, file tokens, and image markers; skips empty parts", () => {
	assert.equal(t.composeSendText("hello", [], []), "hello");
	assert.equal(t.composeSendText("看图", ["@a.ts", "@b.md"], ["[图片: cat.png]"]), "看图\n@a.ts @b.md\n[图片: cat.png]");
	// file tokens and image markers combined on one line each
	assert.equal(t.composeSendText("", ["@a.ts", "  ", "@b.ts"], []), "@a.ts @b.ts");
	assert.equal(t.composeSendText("", [], ["[图片]", "[图片: x.png]"]), "[图片]\n[图片: x.png]");
	// image-only send still yields an entry
	assert.equal(t.composeSendText("", [], ["[图片]"]), "[图片]");
	// nothing present -> empty
	assert.equal(t.composeSendText("", [], []), "");
	assert.equal(t.composeSendText("   ", [], []), "");
	// non-string / malformed tokens and markers are dropped
	assert.equal(t.composeSendText("x", [42, null, ""], ["  ", ""]), "x");
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

test("historyNav: whitespace-only draft still recalls", () => {
	const state = { entries: ["only"], cursor: null, original: "" };
	const next = t.historyNav(state, "up", "  \n ");
	assert.deepEqual(next, { cursor: 0, original: "  \n ", text: "only" });
});

/* ------------------------- persistent history ring ------------------------- */

/** Minimal in-memory localStorage double for the ring tests. */
function memoryStorage() {
	const data = new Map();
	return {
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => { data.set(key, String(value)); },
		removeItem: (key) => { data.delete(key); },
	};
}

test("recordSent folds blocks, skips blanks, dedupes consecutively, caps at the limit", () => {
	const store = memoryStorage();
	globalThis.localStorage = store;
	try {
		assert.deepEqual(t.loadHistory(), []);
		t.recordSent("  hello  ");
		t.recordSent("hello"); // consecutive duplicate of the trimmed form
		t.recordSent("");
		t.recordSent("  \n ");
		t.recordSent('check @a.ts\n<file path="a.ts">\nbody\n</file>\n');
		assert.deepEqual(t.loadHistory(), ["hello", "check @a.ts"]);
		// cap: default 100, newest wins
		for (let i = 0; i < 110; i++) t.recordSent(`m${i}`);
		let ring = t.loadHistory();
		assert.equal(ring.length, 100);
		assert.equal(ring[0], "m10");
		assert.equal(ring[99], "m109");
		// a later send evicts the oldest
		t.recordSent("last");
		ring = t.loadHistory();
		assert.equal(ring.length, 100);
		assert.equal(ring[0], "m11");
		assert.equal(ring[99], "last");
	} finally {
		delete globalThis.localStorage;
	}
});

test("historyLimit honors the localStorage override and rejects bad values", () => {
	const store = memoryStorage();
	globalThis.localStorage = store;
	try {
		assert.equal(t.historyLimit(), 100);
		store.setItem(t.HISTORY_LIMIT_KEY, "20");
		assert.equal(t.historyLimit(), 20);
		store.setItem(t.HISTORY_LIMIT_KEY, "0");
		assert.equal(t.historyLimit(), 100);
		store.setItem(t.HISTORY_LIMIT_KEY, "-5");
		assert.equal(t.historyLimit(), 100);
		store.setItem(t.HISTORY_LIMIT_KEY, "abc");
		assert.equal(t.historyLimit(), 100);
		// an overridden cap is enforced at save time
		store.setItem(t.HISTORY_LIMIT_KEY, "20");
		t.recordSent("x");
		for (let i = 0; i < 30; i++) t.recordSent(`k${i}`);
		assert.equal(t.loadHistory().length, 20);
		assert.equal(t.loadHistory()[19], "k29");
	} finally {
		delete globalThis.localStorage;
	}
});

test("loadHistory tolerates corruption, non-array payloads, and absent storage", () => {
	const store = memoryStorage();
	globalThis.localStorage = store;
	try {
		assert.deepEqual(t.loadHistory(), []);
		store.setItem(t.HISTORY_KEY, "not json {");
		assert.deepEqual(t.loadHistory(), []);
		store.setItem(t.HISTORY_KEY, JSON.stringify({ a: 1 }));
		assert.deepEqual(t.loadHistory(), []);
		store.setItem(t.HISTORY_KEY, JSON.stringify(["ok", 42, null, "two"]));
		assert.deepEqual(t.loadHistory(), ["ok", "two"]);
	} finally {
		delete globalThis.localStorage;
	}
	// no localStorage at all: everything degrades to an empty no-op ring
	assert.deepEqual(t.loadHistory(), []);
	t.recordSent("ignored");
	assert.deepEqual(t.loadHistory(), []);
});

/* ----------------------------- legacy migration ---------------------------- */

test("migrateLegacyRing folds the old dsh-file-mention ring into the new namespace once", () => {
	const store = memoryStorage();
	globalThis.localStorage = store;
	try {
		store.setItem("dsh-file-mention:input-history", JSON.stringify(["old a", "old a", "old b"]));
		store.setItem("dsh-file-mention:history-limit", "40");
		t.migrateLegacyRing();
		// cap override migrated, ring folded + deduped, legacy keys removed
		assert.equal(t.historyLimit(), 40);
		assert.deepEqual(t.loadHistory(), ["old a", "old b"]);
		assert.equal(store.getItem("dsh-file-mention:input-history"), null);
		// idempotent: a second call imports nothing
		t.migrateLegacyRing();
		assert.deepEqual(t.loadHistory(), ["old a", "old b"]);
		// a fresh legacy ring (e.g. from a reinstall) still imports once more
		store.setItem("dsh-file-mention:input-history", JSON.stringify(["old a", "new c"]));
		t.migrateLegacyRing();
		assert.deepEqual(t.loadHistory(), ["old a", "old b", "new c"]);
	} finally {
		delete globalThis.localStorage;
	}
});

test("foldIntoRing merges, folds blocks, and leaves the source untouched", () => {
	const store = memoryStorage();
	globalThis.localStorage = store;
	try {
		t.recordSent("fresh");
		store.setItem("some:ring", JSON.stringify(['legacy @a.ts\n<file path="a.ts">\nbody\n</file>\n', "fresh", 42, ""]));
		assert.equal(t.foldIntoRing("some:ring"), true);
		// folded + non-string/blank rows dropped; already-present rows skipped
		assert.deepEqual(t.loadHistory(), ["fresh", "legacy @a.ts"]);
		assert.equal(store.getItem("some:ring"), JSON.stringify(['legacy @a.ts\n<file path="a.ts">\nbody\n</file>\n', "fresh", 42, ""]));
		assert.equal(t.foldIntoRing("some:ring"), false, "nothing new to merge");
	} finally {
		delete globalThis.localStorage;
	}
});

/* ----------------------------- prompt extraction ---------------------------- */

test("extractPrompts keeps human prompts (text + images), folds blocks, dedupes consecutively", () => {
	const events = [
		{ event: { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] } } },
		{ event: { type: "user/message", seq: 2, data: { source: { kind: "plugin", plugin: "x" }, content: [{ type: "text", text: "injected" }] } } },
		{ event: { type: "assistant/message", seq: 3, data: {} } },
		{ event: { type: "user/message", seq: 4, data: { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] } } },
		{
			event: {
				type: "user/message",
				seq: 5,
				data: {
					source: { kind: "user" },
					content: [
						{ type: "text", text: 'check @a.ts\n<file path="a.ts">\nbody\n</file>\n' },
					],
				},
			},
		},
		// unnamed image-only send -> generic image marker
		{ event: { type: "user/message", seq: 6, data: { source: { kind: "user" }, content: [{ type: "image", url: "x" }] } } },
	];
	assert.deepEqual(t.extractPrompts(events), ["hello", "check @a.ts", "[图片]"]);
	assert.deepEqual(t.extractPrompts([]), []);
});

test("extractPrompts records text + image blocks of one send, with image file names", () => {
	const events = [
		{
			event: {
				type: "user/message",
				seq: 1,
				data: {
					source: { kind: "user" },
					content: [
						{ type: "text", text: "看图" },
						{ type: "image", url: "x", name: "cat.png" },
						{ type: "image", url: "y" }, // unnamed
					],
				},
			},
		},
	];
	assert.deepEqual(t.extractPrompts(events), ["看图\n[图片: cat.png]\n[图片]"]);
});

/* ---------------------------- host durability ---------------------------- */

test("mergeRings unions primary-first and drops exact duplicates", () => {
	assert.deepEqual(t.mergeRings(["a", "b"], ["c", "a", "d"]), ["a", "b", "c", "d"]);
	assert.deepEqual(t.mergeRings([], ["a", "a", "b"]), ["a", "b"]);
	assert.deepEqual(t.mergeRings(["a", "b"], []), ["a", "b"]);
	assert.deepEqual(t.mergeRings([], []), []);
	// non-strings and blanks are skipped
	assert.deepEqual(t.mergeRings(["a", 42, null], ["b", "", "  "]), ["a", "b"]);
});

test("sameRing compares order-sensitively", () => {
	assert.equal(t.sameRing([], []), true);
	assert.equal(t.sameRing(["a", "b"], ["a", "b"]), true);
	assert.equal(t.sameRing(["a", "b"], ["b", "a"]), false);
	assert.equal(t.sameRing(["a"], ["a", "a"]), false);
});

test("callHostApi unwraps the value and fails soft to null", async () => {
	const calls = [];
	globalThis.fetch = (url, options) => {
		calls.push({ url, options });
		return Promise.resolve({
			ok: true,
			json: () => Promise.resolve({ ok: true, value: { entries: ["a"] } }),
		});
	};
	try {
		assert.deepEqual(await t.callHostApi("history.read", {}), { entries: ["a"] });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "/input-history/api/history.read");
		assert.equal(calls[0].options.method, "POST");
		assert.deepEqual(JSON.parse(calls[0].options.body), {});
	} finally {
		delete globalThis.fetch;
	}
	// transport failure -> null, never throws
	globalThis.fetch = () => Promise.reject(new Error("boom"));
	try {
		assert.equal(await t.callHostApi("history.read", {}), null);
	} finally {
		delete globalThis.fetch;
	}
	// absent fetch -> null
	assert.equal(await t.callHostApi("history.read", {}), null);
	// keepalive is plumbed through
	globalThis.fetch = (url, options) => {
		calls.push(options);
		return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
	};
	try {
		await t.callHostApi("history.write", { entries: ["x"] }, true);
		assert.equal(calls[calls.length - 1].keepalive, true);
	} finally {
		delete globalThis.fetch;
	}
});

test("adoptHostLimit applies only when no local override exists", () => {
	const store = memoryStorage();
	globalThis.localStorage = store;
	try {
		t.adoptHostLimit(42);
		assert.equal(t.historyLimit(), 42);
		store.setItem(t.HISTORY_LIMIT_KEY, "7");
		t.adoptHostLimit(99);
		assert.equal(t.historyLimit(), 7, "local override wins");
		t.adoptHostLimit(0);
		assert.equal(t.historyLimit(), 7, "bad limit ignored");
	} finally {
		delete globalThis.localStorage;
	}
});

test("syncFromHost merges the host ring with local and pushes the union back", async () => {
	const store = memoryStorage();
	globalThis.localStorage = store;
	const writes = [];
	globalThis.fetch = (url, options) => {
		const payload = JSON.parse(options.body);
		if (url.endsWith("/history.read")) {
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ ok: true, value: { entries: ["server a", "server b"], limit: 100 } }),
			});
		}
		if (url.endsWith("/history.write")) {
			writes.push(payload);
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: { entries: payload.entries, limit: payload.limit } }) });
		}
		return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
	};
	try {
		// local-only entries survive and are appended after the host's
		store.setItem(t.HISTORY_KEY, JSON.stringify(["local x", "server b"]));
		await t.syncFromHost();
		assert.deepEqual(t.loadHistory(), ["server a", "server b", "local x"]);
		// syncFromHost schedules the debounced push; flushing it performs
		// exactly one write with the union (host was behind)
		await t.flushHostWrite();
		assert.equal(writes.length, 1);
		assert.deepEqual(writes[0].entries, ["server a", "server b", "local x"]);
		// adopted cap: no local override was present
		assert.equal(t.historyLimit(), 100);
	} finally {
		delete globalThis.localStorage;
		delete globalThis.fetch;
	}
	// host failure leaves the local ring untouched and writes nothing
	const store2 = memoryStorage();
	globalThis.localStorage = store2;
	store2.setItem(t.HISTORY_KEY, JSON.stringify(["only local"]));
	globalThis.fetch = () => Promise.reject(new Error("offline"));
	try {
		await t.syncFromHost();
		assert.deepEqual(t.loadHistory(), ["only local"]);
	} finally {
		delete globalThis.localStorage;
		delete globalThis.fetch;
	}
});

test("syncFromHost idempotent when host and local already agree", async () => {
	const store = memoryStorage();
	globalThis.localStorage = store;
	let writeCalls = 0;
	globalThis.fetch = (url, options) => {
		if (url.endsWith("/history.read")) {
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ ok: true, value: { entries: ["a", "b"], limit: 100 } }),
			});
		}
		writeCalls++;
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: {} }) });
	};
	try {
		store.setItem(t.HISTORY_KEY, JSON.stringify(["a", "b"]));
		await t.syncFromHost();
		assert.equal(writeCalls, 0, "no push when already in sync");
		assert.deepEqual(t.loadHistory(), ["a", "b"]);
	} finally {
		delete globalThis.localStorage;
		delete globalThis.fetch;
	}
});
