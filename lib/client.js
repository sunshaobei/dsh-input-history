window.__ModuleLoader__.load({
	id: "dsh-input-history",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/* eslint-disable no-var */

	/**
	 * dsh-input-history — client half.
	 *
	 * Arrow-key input history for the DSH web composer, as a standalone
	 * plugin (split out of dsh-file-mention so the two features can evolve
	 * and mount independently):
	 *
	 * 1. Every composer send — Enter or the send button, in any session or
	 *    workspace — is folded (legacy file blocks back to `@path`) and
	 *    persisted to ONE global ring in localStorage (default 100 entries;
	 *    the "dsh-input-history:history-limit" key overrides the cap). The
	 *    ring is not bound to any session or workspace.
	 * 2. Empty-draft ArrowUp recalls the last sent prompt, ArrowUp/ArrowDown
	 *    walk the ring, ArrowDown past the newest restores the original
	 *    draft. The ring is read synchronously on every keystroke, so the
	 *    recall is instant and complete — no async history RPC, no
	 *    invalidation. The platform's trigger menus stay in command of the
	 *    arrows while they are open.
	 * 3. One-time warm-start: the current session's past prompts (pure-text
	 *    user/message events) are folded into the ring, and a ring left by
	 *    the old dsh-file-mention keys is migrated into this plugin's
	 *    namespace — best effort only, never blocking or gating the nav.
	 */

	/** localStorage key of the global sent-prompt ring (oldest→newest). */
	var HISTORY_KEY = "dsh-input-history:input-history";
	/** Optional localStorage integer override for the ring cap. */
	var HISTORY_LIMIT_KEY = "dsh-input-history:history-limit";
	/** Ring cap: how many sent prompts the ↑/↓ history keeps (override via HISTORY_LIMIT_KEY). */
	var HISTORY_LIMIT = 100;
	/** Legacy dsh-file-mention keys, migrated into this namespace on first seed. */
	var LEGACY_HISTORY_KEY = "dsh-file-mention:input-history";
	var LEGACY_HISTORY_LIMIT_KEY = "dsh-file-mention:history-limit";
	/** Seed pages pulled lazily by the one-time warm-start seed (200 messages each). */
	var HISTORY_PAGES = 3;
	var HISTORY_PAGE_MESSAGES = 200;

	/* ------------------------------- pure core ------------------------------- */

	/**
	 * Fold serialized file blocks back to their `@path` mention form so a
	 * recalled prompt shows what the user typed, not the attached content.
	 * @param {string} text - prompt text possibly containing file blocks.
	 * @returns the text with every block replaced by `@path `.
	 */
	function foldFileBlocks(text) {
		return String(text).replace(/@([^\n<]+)\n<file\b[^>]*(?:\/>|>[\s\S]*?<\/file>)\n?/g, function (_all, label) {
			return "@" + label + " ";
		});
	}

	/**
	 * One input-history navigation step.
	 * @param state - {entries, cursor, original}; cursor null = live editing.
	 * @param key - "up" | "down".
	 * @param draft - the live textarea value.
	 * @returns {cursor, original, text} to apply, or null when the key
	 * should fall through. Browsing mode requires the draft to still equal
	 * the recalled entry (any manual edit silently exits browsing).
	 */
	function historyNav(state, key, draft) {
		var entries = state.entries;
		var browsing = state.cursor !== null && entries[state.cursor] === draft;
		if (key === "up") {
			if (entries.length === 0) return null;
			if (!browsing) {
				if (String(draft).trim() !== "") return null;
				return { cursor: entries.length - 1, original: draft, text: entries[entries.length - 1] };
			}
			if (state.cursor > 0) return { cursor: state.cursor - 1, original: state.original, text: entries[state.cursor - 1] };
			return null;
		}
		if (!browsing) return null;
		if (state.cursor < entries.length - 1) {
			return { cursor: state.cursor + 1, original: state.original, text: entries[state.cursor + 1] };
		}
		return { cursor: null, original: state.original, text: state.original };
	}

	/* ----------------------- persistent history ring ----------------------- */

	/** localStorage handle or null (private mode / SSR / test env). */
	function historyStore() {
		try {
			if (typeof localStorage !== "undefined" && localStorage !== null) return localStorage;
		} catch {
			/* access denied */
		}
		return null;
	}

	/** Effective ring cap: the HISTORY_LIMIT_KEY override when it is a positive int. */
	function historyLimit() {
		var store = historyStore();
		if (store !== null) {
			try {
				var raw = store.getItem(HISTORY_LIMIT_KEY);
				if (raw !== null) {
					var parsed = Number.parseInt(raw, 10);
					if (Number.isFinite(parsed) && parsed > 0) return parsed;
				}
			} catch {
				/* fall back to the default */
			}
		}
		return HISTORY_LIMIT;
	}

	/**
	 * Read the persisted ring (oldest→newest). Absence, corruption, and
	 * non-array payloads all read as empty — the ↑/↓ nav never depends on
	 * async state, so it can never be "not loaded yet".
	 */
	function loadHistory() {
		var store = historyStore();
		if (store === null) return [];
		try {
			var raw = store.getItem(HISTORY_KEY);
			if (raw === null) return [];
			var parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(function (entry) {
				return typeof entry === "string";
			});
		} catch {
			return [];
		}
	}

	/** Persist the ring (oldest→newest), keeping only the newest historyLimit() entries. */
	function saveHistory(entries) {
		var store = historyStore();
		if (store === null) return;
		try {
			store.setItem(HISTORY_KEY, JSON.stringify(entries.slice(-historyLimit())));
		} catch {
			/* quota / private mode: best effort */
		}
	}

	/**
	 * Record one sent prompt: legacy file blocks fold back to `@path`,
	 * blanks are dropped, consecutive duplicates collapse, and the ring is
	 * capped at the configured size. Synchronous and persistent — the ↑/↓
	 * nav reads it back instantly, so every send is always recallable.
	 */
	function recordSent(text) {
		var folded = foldFileBlocks(String(text ?? "")).trim();
		if (folded === "") return;
		var entries = loadHistory();
		if (entries.length > 0 && entries[entries.length - 1] === folded) return;
		entries.push(folded);
		saveHistory(entries);
	}

	/** Extract human prompts (oldest→newest) from one history page's entries. */
	function extractPrompts(events) {
		var out = [];
		for (var i = 0; i < events.length; i++) {
			var event = events[i] && events[i].event;
			if (!event || event.type !== "user/message") continue;
			var message = event.data;
			if (!message || !message.source || message.source.kind !== "user") continue;
			var blocks = Array.isArray(message.content) ? message.content : [];
			var text = "";
			var pureText = true;
			for (var b = 0; b < blocks.length; b++) {
				if (!blocks[b] || blocks[b].type !== "text") {
					pureText = false;
					break;
				}
				text += blocks[b].text ?? "";
			}
			if (!pureText) continue;
			var folded = foldFileBlocks(text).trim();
			if (folded === "") continue;
			if (out.length > 0 && out[out.length - 1] === folded) continue;
			out.push(folded);
		}
		return out;
	}

	/** Fold a ring stored under one localStorage key into the persisted ring (fully deduped against the whole ring, capped). */
	function foldIntoRing(key) {
		var store = historyStore();
		if (store === null) return false;
		var raw;
		try {
			raw = store.getItem(key);
		} catch {
			return false;
		}
		if (raw === null) return false;
		var legacy;
		try {
			legacy = JSON.parse(raw);
		} catch {
			return false;
		}
		if (!Array.isArray(legacy)) return false;
		var merged = loadHistory().slice();
		var seen = new Set(merged);
		var before = merged.length;
		for (var i = 0; i < legacy.length; i++) {
			if (typeof legacy[i] !== "string") continue;
			var folded = foldFileBlocks(legacy[i]).trim();
			if (folded === "" || seen.has(folded)) continue;
			seen.add(folded);
			merged.push(folded);
		}
		if (merged.length === before) return false;
		saveHistory(merged);
		return true;
	}

	/** One-time migration of the old dsh-file-mention ring/limit keys into this plugin's namespace. */
	function migrateLegacyRing() {
		var store = historyStore();
		if (store === null) return;
		try {
			// the legacy cap override, when set, becomes this plugin's cap
			if (store.getItem(HISTORY_LIMIT_KEY) === null) {
				var legacyLimit = store.getItem(LEGACY_HISTORY_LIMIT_KEY);
				if (legacyLimit !== null) store.setItem(HISTORY_LIMIT_KEY, legacyLimit);
			}
			// the legacy ring folds in once; afterwards the key is removed so
			// a reinstall of dsh-file-mention never re-imports stale rows
			if (foldIntoRing(LEGACY_HISTORY_KEY)) store.removeItem(LEGACY_HISTORY_KEY);
		} catch {
			/* best effort */
		}
	}

	/* --------------------------------- shell --------------------------------- */

	/** Required services: the session list/scope registry (connection is best-effort for the seed). */
	var inject = ["sessions"];

	/**
	 * Client plugin body.
	 * @param ctx - client root context.
	 */
	function apply(ctx) {
		var sessions = ctx.sessions;

		/** Global ↑/↓ navigation cursor over the persistent ring (shared across sessions and workspaces). */
		var navState = { cursor: null, original: "" };
		/** One-time warm-start: session-history seed + legacy-key migration. */
		var seedStarted = false;

		/** Resolve the session input facade (official draft write path); null when the scope is unavailable. */
		var resolveInput = function (sessionId) {
			try {
				var scoped = sessions.scope(sessionId);
				if (scoped === undefined) return null;
				var conversation = ctx.get("conversation");
				if (conversation === undefined || conversation === null) return null;
				return conversation.input.for(scoped);
			} catch {
				return null;
			}
		};

		/**
		 * One-time warm-start: migrate a ring left by the old dsh-file-mention
		 * keys into this plugin's namespace, then fold the current session's
		 * past prompts into the ring so the ↑/↓ history is populated from day
		 * one. Best effort and additive only — the ring itself is written by
		 * recordSent at send time, so this never gates or invalidates the
		 * navigation; any failure just leaves the ring starting empty.
		 */
		var seedHistoryOnce = function (sessionId) {
			if (seedStarted) return;
			seedStarted = true;
			(async function () {
				try {
					migrateLegacyRing();
				} catch {
					/* best effort */
				}
				try {
					if (loadHistory().length > 0) return;
					if (typeof sessionId !== "string" || sessionId === "") return;
					var connection = undefined;
					try {
						connection = ctx.get("connection");
					} catch {
						connection = undefined;
					}
					var historyApi = connection && connection.api;
					if (historyApi === undefined || historyApi.sessions === undefined) return;
					var entries = [];
					var beforeSeq;
					for (var page = 0; page < HISTORY_PAGES; page++) {
						var request = { sessionId: sessionId, maxMessages: HISTORY_PAGE_MESSAGES };
						if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
						var response = await historyApi.sessions.history(request);
						var result = response && response.result;
						if (!result || !result.ok) return;
						var events = result.value.events ?? [];
						entries = extractPrompts(events).concat(entries);
						var hasMore = result.value.hasMore === true;
						var minSeq = events.length > 0 && events[0].event ? events[0].event.seq : undefined;
						if (!hasMore || minSeq === undefined || minSeq <= 1) break;
						beforeSeq = minSeq;
					}
					var ring = loadHistory();
					var merged = ring.slice();
					for (var i = 0; i < entries.length; i++) {
						if (merged.length > 0 && merged[merged.length - 1] === entries[i]) continue;
						merged.push(entries[i]);
					}
					saveHistory(merged);
				} catch {
					/* best effort: the ring simply starts empty */
				}
			})();
		};

		/**
		 * Capture-phase key routing: send-time history recording +
		 * history arrows over the persistent ring.
