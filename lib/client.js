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

