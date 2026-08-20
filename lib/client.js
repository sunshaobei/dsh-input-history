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
	 *    persisted to ONE global ring (default 100 entries; the
	 *    "dsh-input-history:history-limit" key overrides the cap). The ring
	 *    is not bound to any session or workspace.
	 * 2. Durability: localStorage is only the synchronous cache — it dies
	 *    with the ephemeral per-launch origin, so the durable copy lives in
	 *    $DSH_HOME/input-history.json (~/.dsh by default) behind the host
	 *    half's fenced /input-history/api. Every local change is mirrored
	 *    to the host (debounced), and startup fetches the host ring once,
	 *    union-merges it with the local cache (host order first, local-only
	 *    entries appended), and pushes the union back when the host was
	 *    behind — history survives app restarts, origin changes, and
	 *    localStorage wipes.
	 * 3. Empty-draft ArrowUp recalls the last sent prompt, ArrowUp/ArrowDown
	 *    walk the ring, ArrowDown past the newest restores the original
	 *    draft. The ring is read synchronously on every keystroke, so the
	 *    recall is instant and complete — no async history RPC, no
	 *    invalidation. The platform's trigger menus stay in command of the
	 *    arrows while they are open.
	 * 4. One-time warm-start: the current session's past prompts (pure-text
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
	/** Host half's fenced JSON route prefix (the durable ring store). */
	var HOST_API_PREFIX = "/input-history/api/";
	/** Debounce for mirroring the ring to the host after a local change. */
	var HOST_WRITE_DEBOUNCE_MS = 300;

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
	 * Render one image attachment as a plain-text marker for the history entry.
	 * Images are runtime-only in the composer's draft (never plain text), so a
	 * marker is the only faithful record of an image send; the file name (when
	 * known) is kept so the recalled entry shows what was attached.
	 * @param {{file?: {name?: string}}} attachment - a draft image descriptor.
	 * @returns a marker string like "[图片: cat.png]" (or "[图片]" when unnamed).
	 */
	function imageMarker(attachment) {
		if (!attachment || typeof attachment !== "object") return "[图片]";
		var name = attachment.file && typeof attachment.file.name === "string" ? attachment.file.name : "";
		name = name.trim();
		return name === "" ? "[图片]" : "[图片: " + name + "]";
	}

	/** Render an ordered list of image names/attachments to marker text. */
	function imageMarkers(attachments) {
		var out = [];
		for (var i = 0; i < attachments.length; i++) {
			var attachment = attachments[i];
			if (!attachment || typeof attachment !== "object") continue;
			var marker = imageMarker(attachment);
			if (marker !== "") out.push(marker);
		}
		return out;
	}

	/**
	 * Compose the full "what was sent" text for one history entry: the draft
	 * text plus its non-text attachments (pending file references and image
	 * markers), each on its own line. Pure and deterministic — every part is
	 * optional, ordering is text-then-files-then-images, and blank inputs
	 * produce an empty string (callers decide whether that is worth persisting).
	 * @param {string} text - the plain draft text.
	 * @param {string[]} pendingTokens - file reference tokens to keep (already in `@token` form).
	 * @param {string[]} imageMarkers - rendered image markers.
	 * @returns the composed entry text, or "" when nothing is present.
	 */
	function composeSendText(text, pendingTokens, imageMarkers) {
		var parts = [];
		var trimmed = String(text ?? "").trim();
		if (trimmed !== "") parts.push(trimmed);
		var fileTokens = (pendingTokens || []).filter(function (t) {
			return typeof t === "string" && String(t).trim() !== "";
		});
		if (fileTokens.length > 0) parts.push(fileTokens.join(" "));
		var markers = (imageMarkers || []).filter(function (m) {
			return typeof m === "string" && String(m).trim() !== "";
		});
		if (markers.length > 0) parts.push(markers.join("\n"));
		return parts.join("\n");
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

	/**
	 * Union-merge two rings (oldest→newest): every `primary` entry in order,
	 * then every `extras` entry not already present. Non-strings and blanks
	 * are dropped (the ring never stores them — recordSent/extractPrompts
	 * fold+trim before persisting). Exact-string dedupe.
	 */
	function mergeRings(primary, extras) {
		var merged = [];
		var seen = new Set();
		var i;
		for (i = 0; i < primary.length; i++) {
			if (typeof primary[i] !== "string" || String(primary[i]).trim() === "" || seen.has(primary[i])) continue;
			seen.add(primary[i]);
			merged.push(primary[i]);
		}
		for (i = 0; i < extras.length; i++) {
			if (typeof extras[i] !== "string" || String(extras[i]).trim() === "" || seen.has(extras[i])) continue;
			seen.add(extras[i]);
			merged.push(extras[i]);
		}
		return merged;
	}

	/** Shallow ring equality (order-sensitive). */
	function sameRing(a, b) {
		if (a.length !== b.length) return false;
		for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
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

	/* ---------------------------- host durability ---------------------------- */

	/**
	 * Call one host API method over the fenced JSON route.
	 * @returns the unwrapped value, or null on any failure (host unreachable,
	 * older host half, fenced away) — the localStorage cache carries on.
	 */
	function callHostApi(method, payload, keepalive) {
		if (typeof fetch !== "function") return Promise.resolve(null);
		var request = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload ?? {}),
		};
		if (keepalive === true) request.keepalive = true;
		return fetch(HOST_API_PREFIX + method, request)
			.then(function (response) {
				return response.json().catch(function () {
					return null;
				}).then(function (parsed) {
					if (!response.ok || parsed === null || parsed.ok !== true) return null;
					return parsed.value;
				});
			})
			.catch(function () {
				return null;
			});
	}

	/** Pending debounce handle for the host mirror write (null = idle). */
	var hostWriteTimer = null;

	/** Write the current local ring to the host right now (fire-and-forget in prod; awaited by tests). */
	function flushHostWrite(keepalive) {
		if (hostWriteTimer !== null) {
			clearTimeout(hostWriteTimer);
			hostWriteTimer = null;
		}
		return callHostApi("history.write", { entries: loadHistory(), limit: historyLimit() }, keepalive === true);
	}

	/** Mirror the ring to the host after a local change (debounced, coalesced). */
	function scheduleHostWrite() {
		if (typeof fetch !== "function") return;
		if (hostWriteTimer !== null) clearTimeout(hostWriteTimer);
		hostWriteTimer = setTimeout(function () {
			hostWriteTimer = null;
			flushHostWrite(false);
		}, HOST_WRITE_DEBOUNCE_MS);
		// node test env: never hold the event loop open for the debounce
		if (hostWriteTimer !== null && typeof hostWriteTimer.unref === "function") hostWriteTimer.unref();
	}

	/**
	 * Adopt the host-persisted cap when the user has no local override: the
	 * override lives in origin-scoped localStorage and would otherwise reset
	 * to the default on every app restart (truncating the ring on the next
	 * write). Best effort — a bad value is ignored.
	 */
	function adoptHostLimit(limit) {
		if (!Number.isInteger(limit) || limit <= 0) return;
		var store = historyStore();
		if (store === null) return;
		try {
			if (store.getItem(HISTORY_LIMIT_KEY) === null) store.setItem(HISTORY_LIMIT_KEY, String(limit));
		} catch {
			/* best effort */
		}
	}

	/**
	 * Startup reconciliation: fetch the durable host ring, union-merge it
	 * with the local cache (host order first, local-only entries appended —
	 * they are the sends recorded since the host's last write), adopt the
	 * host-persisted cap, and push the union back when the host was behind.
	 * Never gates anything: any failure leaves the localStorage ring as-is.
	 */
	function syncFromHost() {
		return callHostApi("history.read", {}).then(function (value) {
			if (value === null || value === undefined) return;
			var serverEntries = Array.isArray(value.entries)
				? value.entries.filter(function (entry) { return typeof entry === "string"; })
				: [];
			adoptHostLimit(value.limit);
			var localEntries = loadHistory();
			var merged = mergeRings(serverEntries, localEntries);
			if (!sameRing(merged, localEntries)) saveHistory(merged);
			if (!sameRing(merged, serverEntries)) scheduleHostWrite();
		});
	}

	/**
	 * Record one sent prompt: legacy file blocks fold back to `@path`,
	 * blanks are dropped, consecutive duplicates collapse, and the ring is
	 * capped at the configured size. Synchronous and persistent — the ↑/↓
	 * nav reads it back instantly, so every send is always recallable. The
	 * host mirror is updated on a debounce, so the durable file follows
	 * within a few hundred milliseconds.
	 */
	function recordSent(text) {
		var folded = foldFileBlocks(String(text ?? "")).trim();
		if (folded === "") return;
		var entries = loadHistory();
		if (entries.length > 0 && entries[entries.length - 1] === folded) return;
		entries.push(folded);
		saveHistory(entries);
		scheduleHostWrite();
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
			var imageNames = [];
			for (var b = 0; b < blocks.length; b++) {
				var block = blocks[b];
				if (!block) continue;
				if (block.type === "text") {
					text += block.text ?? "";
				} else if (block.type === "image") {
					// image blocks carry an optional name (the original file name);
					// the base64 data is never stored — only the marker/text form.
					imageNames.push(String(block.name ?? "").trim());
				}
			}
			var folded = composeSendText(
				foldFileBlocks(text),
				[],
				imageNames.map(function (name) { return name === "" ? "[图片]" : "[图片: " + name + "]"; })
			).trim();
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
		 * Read the current pending dsh-file-upload file chips for a session
		 * (full `{token, path, name, size}` info) via the coordinated hook that
		 * plugin mounts on window. Absent (plugin not installed / not mounted
		 * yet) or failing reads degrade to an empty list.
		 * @returns {Array<{token,path,name,size}>} pending file chips.
		 */
		var pendingFileChips = function (sessionId) {
			try {
				if (typeof window === "undefined" || window === null) return [];
				var hook = window.__dsh_file_upload_pending__;
				if (hook === undefined || hook === null) return [];
				if (typeof hook.chipsOf === "function") {
					var chips = hook.chipsOf(sessionId);
					return Array.isArray(chips)
						? chips.filter(function (c) { return c && typeof c === "object" && typeof c.token === "string" && typeof c.path === "string"; })
						: [];
				}
				// legacy hook: tokens only (no path) — cannot rebuild a capsule, so
				// treat as no restorable chips (the @token text is still recorded).
				return [];
			} catch {
				return [];
			}
		};

		/** `@token` strings derived from a chip list (for the persisted entry text). */
		var fileTokensOf = function (chips) {
			return (chips || []).map(function (c) { return typeof c.token === "string" && c.token !== "" ? "@" + c.token : null; }).filter(function (t) { return t !== null; });
		};

		/**
		 * Resolve ordered draft image ids to their browser File objects (for
		 * in-memory recall re-attach) AND their rendered markers (for the
		 * persisted entry text). Missing conversation service / unresolvable ids
		 * degrade to empty lists; a generic marker is still produced per id so an
		 * image-only send is never dropped from the ring.
		 * @param {string[]} imageIds - the draft image ids (from InputState).
		 * @returns {{files: File[], markers: string[]}}
		 */
		var imageCaptureOf = function (sessionId, imageIds) {
			var files = [];
			var markers = [];
			if (!Array.isArray(imageIds) || imageIds.length === 0) return { files: files, markers: markers };
			try {
				var conversation = ctx.get("conversation");
				var attachments = conversation && typeof conversation.draftImages === "function"
					? conversation.draftImages(imageIds)
					: [];
				for (var i = 0; i < attachments.length; i++) {
					var attachment = attachments[i];
					if (!attachment || typeof attachment !== "object") continue;
					if (attachment.file) files.push(attachment.file);
					markers.push(imageMarker(attachment));
				}
			} catch {
				/* best effort */
			}
			// guarantee one marker per id even when nothing resolved
			while (markers.length < imageIds.length) markers.push("[图片]");
			return { files: files, markers: markers };
		};

		/**
		 * In-memory map from a persisted entry text to the attachments needed to
		 * recall it natively (raw text + file chips + image File objects). Lives
		 * only for this page session — it is the source of "within-session native
		 * recall"; after a restart it is empty and recall degrades to the text
		 * entry. Not persisted (image bytes / chips are runtime-only).
		 */
		var entryAttachments = new Map();
		/** Cap the attachment map roughly at the ring size (oldest-first eviction). */
		var pruneAttachments = function () {
			var cap = Math.max(historyLimit(), 1);
			while (entryAttachments.size > cap) {
				var oldest = entryAttachments.keys().next();
				if (oldest.done) break;
				entryAttachments.delete(oldest.value);
			}
		};

		/**
		 * Persist one send from already-captured parts: the draft text, its file
		 * chips, and its image capture (`{files, markers}`). Writes the composed
		 * entry to the ring and, when there is something restorable, the
		 * attachment map. No-op when the composed entry is empty.
		 */
		var recordCaptured = function (text, chips, imageCapture) {
			var rawText = String(text ?? "");
			// Skip a file token that is already present in the text as a `@token`
			// (e.g. a recalled entry that kept its `@token` text AND restored the
			// capsule is re-sent) so the ring never records the reference twice.
			var fileTokens = fileTokensOf(chips).filter(function (token) {
				return token !== "" && rawText.indexOf(token) === -1;
			});
			var markers = imageCapture && Array.isArray(imageCapture.markers) ? imageCapture.markers : [];
			var imageFiles = imageCapture && Array.isArray(imageCapture.files) ? imageCapture.files : [];
			var composed = composeSendText(rawText, fileTokens, markers);
			if (composed === "") return;
			recordSent(composed);
			// only map entries that actually carry something restorable
			if ((Array.isArray(chips) && chips.length > 0) || imageFiles.length > 0) {
				entryAttachments.set(composed, {
					text: String(text ?? "").trim(),
					files: Array.isArray(chips) ? chips : [],
					imageFiles: imageFiles,
				});
				pruneAttachments();
			}
		};

		/**
		 * Capture everything about a send into the history ring AND the
		 * attachment map: the persisted entry text (draft text + `@token` file
		 * refs + image markers), plus the raw text / file chips / image Files
		 * needed to recall the same send natively. No-op when nothing to record.
		 * Use this when capture and record happen at the same instant (Enter).
		 */
		var recordFullSend = function (sessionId, text, imageIds) {
			recordCaptured(String(text ?? ""), pendingFileChips(sessionId), imageCaptureOf(sessionId, imageIds));
		};

		/* --------------------------- native recall restore --------------------------- */

		/**
		 * Attachments currently restored into the composer by a recall: the image
		 * ids added via addImages and whether file chips were written to the
		 * upload rail. Cleared before every recall / browse-exit so navigation
		 * never leaks attachments from one entry into another.
		 */
		var restored = { imageIds: [], filesActive: false };

		/**
		 * Remove whatever a previous recall attached (images from the input
		 * facade; upload chips from the rail). Safe to call repeatedly.
		 */
		var clearRestored = function (input, sessionId) {
			if (restored.imageIds.length > 0 && input !== null && typeof input.removeImage === "function") {
				for (var i = 0; i < restored.imageIds.length; i++) {
					try {
						input.removeImage(restored.imageIds[i]);
					} catch {
						/* already gone */
					}
				}
			}
			restored.imageIds = [];
			if (restored.filesActive) {
				restored.filesActive = false;
				try {
					if (typeof window !== "undefined" && window !== null) {
						var hook = window.__dsh_file_upload_pending__;
						if (hook !== undefined && hook !== null && typeof hook.setChips === "function") hook.setChips(sessionId, []);
					}
				} catch {
					/* best effort */
				}
			}
		};

		/**
		 * Re-attach image Files into the composer as real draft images, tracking
		 * the new ids so a later recall can clear them. Best effort — a File
		 * whose media type the composer rejects (or a busy phase) just skips.
		 */
		var restoreImages = function (input, imageFiles) {
			if (!Array.isArray(imageFiles) || imageFiles.length === 0) return;
			if (input === null || typeof input.addImages !== "function") return;
			var conversation;
			try {
				conversation = ctx.get("conversation");
			} catch {
				conversation = undefined;
			}
			if (conversation === undefined || conversation === null || typeof conversation.createDraftImages !== "function") return;
			var created;
			try {
				created = conversation.createDraftImages(imageFiles);
			} catch {
				return; // unsupported media type / intake failure — degrade to text
			}
			if (!Array.isArray(created) || created.length === 0) return;
			var ids = created.map(function (a) { return a && a.id; }).filter(function (id) { return typeof id === "string" && id !== ""; });
			if (ids.length === 0) return;
			var accepted = false;
			try {
				accepted = input.addImages(ids) === true;
			} catch {
				accepted = false;
			}
			if (accepted) {
				restored.imageIds = ids;
			} else if (typeof conversation.releaseDraftImages === "function") {
				try {
					conversation.releaseDraftImages(created);
				} catch {
					/* best effort */
				}
			}
		};

		/**
		 * Restore file-upload chips into the session's pending rail so the
		 * recalled file references render as native capsules again. The `@token`
		 * text also stays in the recalled draft (host dedupes on send).
		 */
		var restoreFiles = function (sessionId, chips) {
			if (!Array.isArray(chips) || chips.length === 0) return;
			try {
				if (typeof window === "undefined" || window === null) return;
				var hook = window.__dsh_file_upload_pending__;
				if (hook === undefined || hook === null || typeof hook.setChips !== "function") return;
				hook.setChips(sessionId, chips);
				restored.filesActive = true;
			} catch {
				/* best effort */
			}
		};

		/**
		 * Apply one recalled entry to the composer. When the entry was recorded
		 * with restorable attachments (same page session), restore them natively
		 * — raw text into the draft, image Files as real thumbnails, file chips
		 * as capsules — instead of dumping the `[图片]/ @token` marker text.
		 * Otherwise (older entry / after restart) fall back to the persisted
		 * text entry as-is. Always clears the previously-restored attachments
		 * first so entries never bleed into one another.
		 */
		var applyRecall = function (text, input, sessionId) {
			clearRestored(input, sessionId);
			var attachments = entryAttachments.get(text);
			if (attachments === undefined || attachments === null) {
				input.setDraft(text);
				return;
			}
			// Recall restores the composer EXACTLY as it was composed: the raw
			// text into the textarea, the file chips back as native capsules, and
			// the images back as real thumbnails. The `@token` and `[图片]`
			// markers stay only in the persisted history text (the record and the
			// degraded post-restart fallback) — they are NOT dumped into the
			// textarea, so a re-send re-serializes the capsule cleanly (the host
			// would otherwise inject the reference once but render the chip twice).
			input.setDraft(attachments.text);
			restoreImages(input, attachments.imageFiles);
			restoreFiles(sessionId, attachments.files);
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
					// the migration may have added entries — mirror them to the host
					scheduleHostWrite();
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
					scheduleHostWrite();
				} catch {
					/* best effort: the ring simply starts empty */
				}
			})();
		};

		/**
		 * Capture-phase key routing: send-time history recording +
		 * history arrows over the persistent ring.
		 */
		var onKeyDown = function (event) {
			var composing = event.isComposing === true || event.keyCode === 229;
			if (composing) return;
			var target = event.target;
			if (!(target instanceof HTMLTextAreaElement)) return;
			var card = typeof target.closest === "function" ? target.closest("[data-composer-card]") : null;
			if (!card) return;
			var menuOpen = card.querySelector('[role="listbox"]') !== null;
			var sessionId = sessions.list.getSnapshot().current;
			if (sessionId === undefined) return;
			if (event.key === "Enter" && !event.shiftKey && !menuOpen) {
				// The platform submits on this Enter (it ignores repeats and
				// locked inputs, and never submits while a command claim is
				// in flight) — record the draft exactly as sent. Any other
				// send path (the send button) is captured by onComposerClick.
				if (!event.repeat && !target.disabled) {
					var busy = false;
					var recorderInput = resolveInput(sessionId);
					var imageIds = [];
					if (recorderInput !== null) {
						var phase = recorderInput.snapshot && recorderInput.snapshot.phase;
						busy = phase === "adjudicating" || phase === "submitting";
						if (Array.isArray(recorderInput.snapshot.imageIds)) imageIds = recorderInput.snapshot.imageIds;
					}
					if (!busy) recordFullSend(sessionId, String(target.value), imageIds);
				}
				return;
			}
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			if (menuOpen) return;
			// The ring is read synchronously on every keystroke: no async
			// load, no invalidation, no per-session state — every recorded
			// send is instantly recallable.
			var entries = loadHistory();
			if (entries.length === 0) return;
			var input = resolveInput(sessionId);
			if (input === null) return;
			var state = { entries: entries, cursor: navState.cursor, original: navState.original };
			var next = historyNav(state, event.key === "ArrowUp" ? "up" : "down", target.value);
			if (next === null) return;
			event.preventDefault();
			navState.cursor = next.cursor;
			navState.original = next.original;
			try {
				applyRecall(next.text, input, sessionId);
			} catch (error) {
				console.error("[dsh-input-history] history recall failed:", error);
				clearRestored(input, sessionId);
				navState.cursor = null;
			}
		};

		/**
		 * Capture-phase click routing for the send button: a click on any
		 * enabled button inside the composer card snapshots the current
		 * draft; when the click cleared the draft, the platform's
		 * commitSend ran synchronously in the bubble phase — the draft was
		 * sent — so it is recorded. Every other card button (attachment,
		 * commands, model, stop) leaves the draft untouched, so the
		 * verify-by-clear never misfires.
		 */
		var onComposerClick = function (event) {
			if (event.button !== 0) return;
			var target = event.target;
			if (typeof Element === "undefined" || !(target instanceof Element)) return;
			if (typeof target.closest !== "function") return;
			var card = target.closest("[data-composer-card]");
			if (card === null || card === undefined) return;
			var button = target.closest("button");
			if (button === null || button === undefined) return;
			var sessionId = sessions.list.getSnapshot().current;
			if (sessionId === undefined) return;
			var input = resolveInput(sessionId);
			if (input === null) return;
			var draft = String((input.snapshot && input.snapshot.draft) ?? "");
			var imageIds = Array.isArray(input.snapshot && input.snapshot.imageIds) ? input.snapshot.imageIds : [];
			if (draft.trim() === "" && imageIds.length === 0) return;
			// Snapshot the pending file chips AND image Files NOW: the click may
			// be a send, and the submit that follows serializes/clears the upload
			// chips and releases the draft images — reading them later would see
			// empty pending lists and lost attachments.
			var chips = pendingFileChips(sessionId);
			var imageCapture = imageCaptureOf(sessionId, imageIds);
			setTimeout(function () {
				if (input.snapshot && input.snapshot.draft === "") {
					recordCaptured(draft, chips, imageCapture);
				}
			}, 0);
		};

		/** Warm-start the ring once a session id is known (first current wins). */
		var warmOnce = (function () {
			var done = false;
			return function (sessionId) {
				if (done) return;
				done = true;
				seedHistoryOnce(sessionId);
			};
		})();

		// Startup reconciliation with the durable host ring — runs immediately
		// (no session gate); any failure leaves the localStorage cache as-is.
		syncFromHost();

		ctx.effect(function () {
			// keydown goes on window capture (before any document-capture listener,
			// incl. dsh-file-upload's Enter interception) so send recording always
			// sees the still-pending file refs and draft images; the ↑/↓ nav is
			// unaffected (window capture still precedes the composer's handling).
			window.addEventListener("keydown", onKeyDown, true);
			document.addEventListener("click", onComposerClick, true);
			// Last-chance flush: a debounced write pending at tab close would
			// otherwise die with the page (keepalive lets the POST outlive it).
			var onPageHide = function () {
				flushHostWrite(true);
			};
			if (typeof window !== "undefined" && window !== null && typeof window.addEventListener === "function") {
				window.addEventListener("pagehide", onPageHide);
			}
			var offList = undefined;
			var seeded = false;
			var trySeed = function () {
				if (seeded) return;
				var current = sessions.list.getSnapshot().current;
				if (current === undefined) return;
				seeded = true;
				if (offList !== undefined) {
					try {
						offList();
					} catch {
						/* already disposed */
					}
					offList = undefined;
				}
				warmOnce(current);
			};
			try {
				offList = sessions.list.subscribe(trySeed);
			} catch {
				offList = undefined;
			}
			trySeed();
			return function () {
				window.removeEventListener("keydown", onKeyDown, true);
				document.removeEventListener("click", onComposerClick, true);
				if (typeof window !== "undefined" && window !== null && typeof window.removeEventListener === "function") {
					window.removeEventListener("pagehide", onPageHide);
				}
				if (offList !== undefined) {
					try {
						offList();
					} catch {
						/* already disposed */
					}
				}
			};
		}, "dsh-input-history: ↑/↓ input history");
	}

	exports.apply = apply;
	exports.inject = inject;
	exports.__test = {
		foldFileBlocks: foldFileBlocks,
		imageMarker: imageMarker,
		imageMarkers: imageMarkers,
		composeSendText: composeSendText,
		historyNav: historyNav,
		recordSent: recordSent,
		loadHistory: loadHistory,
		saveHistory: saveHistory,
		historyLimit: historyLimit,
		extractPrompts: extractPrompts,
		foldIntoRing: foldIntoRing,
		migrateLegacyRing: migrateLegacyRing,
		mergeRings: mergeRings,
		sameRing: sameRing,
		callHostApi: callHostApi,
		syncFromHost: syncFromHost,
		scheduleHostWrite: scheduleHostWrite,
		flushHostWrite: flushHostWrite,
		adoptHostLimit: adoptHostLimit,
		HISTORY_KEY: HISTORY_KEY,
		HISTORY_LIMIT_KEY: HISTORY_LIMIT_KEY,
		HISTORY_LIMIT: HISTORY_LIMIT,
		LEGACY_HISTORY_KEY: LEGACY_HISTORY_KEY,
		LEGACY_HISTORY_LIMIT_KEY: LEGACY_HISTORY_LIMIT_KEY,
		HOST_API_PREFIX: HOST_API_PREFIX,
	};
	return module.exports;
	},
});
