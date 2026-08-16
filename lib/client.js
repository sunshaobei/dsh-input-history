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
