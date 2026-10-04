/**
 * dsh-input-history — browser half.
 *
 * Persists every submitted composer prompt locally (text + attachment bytes)
 * and re-fills the EMPTY composer with a previous entry on ArrowUp/ArrowDown.
 *
 * ── Capture ─────────────────────────────────────────────────────────────
 * Every composer submission funnels through the root `conversation` service's
 * `sendSession(session, text, attachmentIds, mode, signal)` (the shell's
 * defaultSink calls it). We wrap the prototype method: before the original
 * runs, the ordered draft attachments are resolved to their live File
 * objects, so attachment bytes are captured exactly as submitted — no
 * guessing from message refs afterwards. Capture is fully async and every
 * failure is swallowed: a storage problem must never break sending.
 *
 * ── Persistence ─────────────────────────────────────────────────────────
 * Entry metadata (text + attachment descriptors) lives in localStorage
 * (`dsh-input-history:entries:v1`, newest first, capped at 50 — beyond that
 * the oldest entry is dropped together with its blobs). Attachment bytes go
 * to IndexedDB (`dsh-input-history` / `blobs`, key `<entryId>:<index>`), so
 * multi-MB images/files never fight the localStorage budget and can be
 * re-echoed verbatim later.
 *
 * ── Restore ─────────────────────────────────────────────────────────────
 * The active session is tracked through a `conversation.composer.dock` slot
 * whose `inject(sessionId)` runs exactly for the mounted composer. Restore
 * uses the product's own draft pipeline: `conversation.createDrafts(
 * sessionId, files)` re-registers each stored File (images get a fresh
 * object-URL preview, files restart the background upload), then the
 * session input shell's `actions.setDraft(text)` + `actions.addAttachments(
 * ids)` fill the composer — so file chips and image thumbnails render
 * exactly like a hand-picked attachment. Entries whose blobs are gone
 * restore text-only.
 *
 * ── Switch policy ───────────────────────────────────────────────────────
 * Switching is allowed ONLY while the composer holds no user content
 * (draft text empty AND no attachment ids, editable phase). Any manual edit
 * or attachment change while cycling ends the cycle. ArrowDown past the
 * newest position clears the composer and ends the cycle.
 *
 * No React require; slots and sessions are declared Cordis dependencies.
 * Conversation capture is reached lazily through `ctx.inject`.
 */
window.__ModuleLoader__.load({
	id: "dsh-input-history",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region constants
		var STORE_KEY = "dsh-input-history:entries:v1";
		var MAX_ENTRIES = 50;
		var TOAST_MS = 1500;
		//#endregion

		//#region state
		var entries = loadEntries(); // newest first: [{id, ts, text, at: [{kind,name,mediaType,size}]}]
		var cycle = { index: null, text: null, att: 0 }; // ArrowUp/Down position (index null = idle) + restored projection for the continue-switching check
		var restoring = false; // one async restore in flight at a time
		var active = null; // { sessionId, resolve() } set by the dock probe
		var unwatch = null; // manual-edit watcher while cycling
		var detachCapture = null; // restores the wrapped sendSession on dispose
		//#endregion

		//#region localStorage entry list
		function loadEntries() {
			try {
				var raw = localStorage.getItem(STORE_KEY);
				var list = raw ? JSON.parse(raw) : [];
				return Array.isArray(list) ? list : [];
			} catch (_) {
				return [];
			}
		}
		function saveEntries() {
			try {
				localStorage.setItem(STORE_KEY, JSON.stringify(entries));
			} catch (_) { /* quota — keep the in-memory copy */ }
		}
		//#endregion

		//#region IndexedDB blob store
		function idb() {
			return new Promise(function (resolve, reject) {
				var req = indexedDB.open("dsh-input-history", 1);
				req.onupgradeneeded = function () {
					req.result.createObjectStore("blobs");
				};
				req.onsuccess = function () { resolve(req.result); };
				req.onerror = function () { reject(req.error); };
			});
		}
		function idbPut(key, blob) {
			return idb().then(function (db) {
				return new Promise(function (resolve, reject) {
					var tx = db.transaction("blobs", "readwrite");
					tx.objectStore("blobs").put(blob, key);
					tx.oncomplete = function () { resolve(); };
					tx.onerror = function () { reject(tx.error); };
				});
			});
		}
		function idbGet(key) {
			return idb().then(function (db) {
				return new Promise(function (resolve, reject) {
					var req = db.transaction("blobs").objectStore("blobs").get(key);
					req.onsuccess = function () { resolve(req.result || null); };
					req.onerror = function () { reject(req.error); };
				});
			});
		}
		function dropBlobs(entryId) {
			return idb().then(function (db) {
				return new Promise(function (resolve) {
					var tx = db.transaction("blobs", "readwrite");
					var store = tx.objectStore("blobs");
					var req = store.openCursor();
					req.onsuccess = function () {
						var cursor = req.result;
						if (!cursor) return;
						if (String(cursor.key).indexOf(entryId + ":") === 0) store.delete(cursor.key);
						cursor.continue();
					};
					tx.oncomplete = function () { resolve(); };
					tx.onerror = function () { resolve(); };
				});
			});
		}
		//#endregion


		//#region capture
		/** Dedupe key for one submission: exact text + attachment names/sizes. */
		function signatureOf(text, drafts) {
			return text + "\u0000" + (drafts || []).map(function (a) {
				return a.kind + ":" + (a.file && a.file.name) + ":" + (a.file && a.file.size);
			}).join("|");
		}
		/**
		 * Record one submission: push {id, ts, text, at[]} to the front, persist
		 * bytes to IndexedDB, trim to MAX_ENTRIES (dropping the oldest entries
		 * and their blobs with them). Never rejects.
		 */
		function capture(text, drafts) {
			if (!text && drafts.length === 0) return;
			var sig = signatureOf(text, drafts);
			if (entries.length > 0 && signatureOf(entries[0].text, []) === sig) {
				// identical consecutive resend — refresh timestamp, keep blobs
				entries[0].ts = Date.now();
				saveEntries();
				return;
			}
			var id = "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
			var meta = drafts.map(function (a) {
				return {
					kind: a.kind,
					name: (a.file && a.file.name) || (a.kind === "image" ? "image" : "file"),
					mediaType: (a.file && a.file.type) || "",
					size: (a.file && a.file.size) || 0
				};
			});
			var entry = { id: id, ts: Date.now(), text: text, at: meta };
			// Drop an older same-signature occurrence (same content re-sent later).
			entries = entries.filter(function (e) { return signatureOf(e.text, e.at.map(function (a) { return { kind: a.kind, file: { name: a.name, size: a.size } }; })) !== sig; });
			entries.unshift(entry);
			var puts = drafts.map(function (a, i) {
				if (!(a.file instanceof Blob)) return Promise.resolve();
				return idbPut(id + ":" + i, a.file).catch(function () { /* entry keeps text-only */ });
			});
			Promise.all(puts).then(function () {
				var dropped = entries.slice(MAX_ENTRIES);
				entries = entries.slice(0, MAX_ENTRIES);
				saveEntries();
				dropped.forEach(function (e) { dropBlobs(e.id); });
			}).catch(function () { saveEntries(); });
		}
		/**
		 * Wrap ConversationController.prototype.sendSession so every composer
		 * submission is captured before the original send consumes the drafts.
		 */
		function installCapture(ctx) {
			ctx.inject(["conversation"], function (scope) {
				var conversation = scope.conversation;
				if (!conversation) return;
				var proto = Object.getPrototypeOf(conversation);
				if (!proto || proto.__dshInputHistoryWrapped || typeof proto.sendSession !== "function") return;
				proto.__dshInputHistoryWrapped = true;
				var original = proto.sendSession;
				proto.sendSession = function (session, text, attachmentIds, mode, signal) {
					try {
						var drafts = [];
						try { drafts = this.resolveDraftAttachments(attachmentIds || []); } catch (_) { /* empty drafts */ }
						capture(String(text || ""), drafts);
					} catch (_) { /* capture must never break sending */ }
					return original.call(this, session, text, attachmentIds, mode, signal);
				};
				detachCapture = function () {
					proto.sendSession = original;
					delete proto.__dshInputHistoryWrapped;
				};
			});
		}
		//#endregion

		//#region active session probe
		/**
		 * The dock slot's inject(sessionId) runs exactly for the mounted composer,
		 * so recording it gives the session the ArrowUp/Down keys apply to.
		 */
		function installProbe(ctx) {
			ctx.slots.inject("conversation.composer.dock", function () {
				return ctx.slots.register({
					name: "conversation.composer.dock",
					id: "dsh-input-history",
					order: 90,
					label: function () { return "输入历史"; },
					inject: function (sessionId) {
						active = { sessionId: sessionId };
						return {};
					}
				}, function Probe() { return null; });
			});
		}
		/** Resolve one session id into conversation + input shell, or null. */
		function sessionById(ctx, sessionId) {
			try {
				var actx = ctx.sessions.scope(sessionId);
				if (!actx) return null;
				var conversation = actx.get("conversation");
				if (!conversation) return null;
				return { sessionId: sessionId, conversation: conversation, input: conversation.input.for(actx) };
			} catch (_) {
				return null;
			}
		}
		/**
		 * Resolve the active session's conversation + input shell. Primary: the
		 * composer dock probe. Fallback: the most recently updated session (the
		 * same heuristic the quota panel uses) so a probe miss still resolves.
		 */
		function resolveSession(ctx) {
			if (active) {
				var via = sessionById(ctx, active.sessionId);
				if (via) return via;
			}
			try {
				var list = ctx.sessions.list();
				if (list && list.length) {
					var ordered = list.slice().sort(function (a, b) {
						return Number(b.updatedAt || b.touchedAt || b.seq || 0) - Number(a.updatedAt || a.touchedAt || a.seq || 0);
					});
					return sessionById(ctx, ordered[0].id);
				}
			} catch (_) {}
			return null;
		}
		//#endregion



		//#region switch logic
		function endCycle() {
			if (unwatch) { unwatch(); unwatch = null; }
			cycle.index = null;
			cycle.text = null;
			cycle.att = 0;
		}
		/**
		 * End the cycle only on a REAL user edit: the draft diverges from the
		 * restored projection (recorded post-restore, so editor normalization of
		 * chips/@references does not falsely end the cycle) and is non-empty.
		 */
		function watchDraft(shell) {
			if (unwatch) unwatch();
			unwatch = shell.state.subscribe(function () {
				if (cycle.index === null) return;
				var snap = shell.state.getSnapshot();
				var draft = snap.draft || "";
				var textMismatch = draft !== "" && draft !== cycle.text;
				var attMismatch = (snap.attachmentIds || []).length !== cycle.att;
				if (textMismatch || attMismatch) endCycle();
			});
		}
		/**
		 * Fill the empty composer with entries[index]: text via setDraft, then
		 * stored File bytes re-registered through conversation.createDrafts so
		 * image previews and file uploads behave exactly like a hand-picked
		 * attachment. Resolves {restored, missing}.
		 */
		/**
		 * Clear the composer completely: every draft attachment removed from the
		 * input AND released in the browser registry (revokes image object URLs,
		 * drops upload state), then the draft text emptied. Without the
		 * attachment half, ↓-exit over an image entry cleared the text but left
		 * the thumbnails behind.
		 */
		function clearComposer(session) {
			try {
				var previous = (session.input.state.getSnapshot().attachmentIds || []).slice();
				for (var p = 0; p < previous.length; p++) {
					try { session.input.actions.removeAttachment(previous[p]); } catch (_) {}
					try { session.conversation.releaseDraftAttachment(previous[p]); } catch (_) {}
				}
				session.input.actions.setDraft("");
			} catch (_) {}
		}
		function applyEntry(session, index) {
			var entry = entries[index];
			if (!entry) return Promise.resolve({ restored: 0, missing: 0 });
			var conversation = session.conversation;
			var shell = session.input;
			// Swap out attachments left by the previously restored entry FIRST —
			// otherwise images/files accumulate across ArrowUp/Down presses.
			clearComposer(session);
			// Text next — setDraft replaces the whole draft.
			shell.actions.setDraft(entry.text);
			var reads = entry.at.map(function (a, i) {
				return idbGet(entry.id + ":" + i).catch(function () { return null; });
			});
			return Promise.all(reads).then(function (blobs) {
				var files = [];
				for (var i = 0; i < blobs.length; i++) {
					if (blobs[i]) {
						files.push(new File([blobs[i]], entry.at[i].name, {
							type: entry.at[i].mediaType || ""
						}));
					}
				}
				if (files.length === 0) return { restored: 0, missing: entry.at.length };
				var drafts = conversation.createDrafts(session.sessionId, files);
				shell.actions.addAttachments(drafts.map(function (d) { return d.id; }));
				return { restored: drafts.length, missing: entry.at.length - drafts.length };
			}).then(function (r) {
				cycle.index = index;
				// Record the ACTUAL post-restore projection (the editor may have
				// normalized the text, e.g. @references into chips) — the cycle
				// watch and the continue-switching check compare against this.
				try {
					var after = shell.state.getSnapshot();
					cycle.text = after.draft || entry.text;
					cycle.att = (after.attachmentIds || []).length;
				} catch (_) {
					cycle.text = entry.text;
					cycle.att = r.restored;
				}
				watchDraft(shell);
				return r;
			}).catch(function () {
				return { restored: 0, missing: entry.at.length };
			});
		}
		/** True when the event target sits inside the composer editor. */
		function inComposer(target) {
			if (!target || !target.closest) return false;
			if (target.closest("[data-lexical-editor]")) return true;
			var editable = target.closest('textarea, [contenteditable="true"]');
			return Boolean(editable && editable.closest('[class*="composer"], form'));
		}
		function onKeyDown(e) {
			if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
			if (!inComposer(e.target)) return;
			if (restoring) { e.preventDefault(); return; }
			var session = resolveSession(keyCtx);
			if (!session) return;
			var snap;
			try { snap = session.input.state.getSnapshot(); } catch (_) { return; }
			if (snap.phase !== "plain") { endCycle(); return; }
			// Switch policy: allowed with an EMPTY composer, or while the composer
			// holds exactly the entry this cycle restored (cycling continues over
			// restored content — restored history is not user-authored input).
			// Any other non-empty content blocks switching.
			var isEmpty = (snap.draft || "") === "" && (snap.attachmentIds || []).length === 0;
			var cycling = cycle.index !== null
				&& (snap.draft || "") === (cycle.text || "")
				&& (snap.attachmentIds || []).length === cycle.att;
			if (!isEmpty && !cycling) {
				endCycle();
				return;
			}
			if (entries.length === 0) {
				if (e.key === "ArrowUp") e.preventDefault();
				return;
			}
			e.preventDefault();
			if (e.key === "ArrowDown") {
				if (cycle.index === null) return; // nothing cycled yet — leave the caret alone
				var down = cycle.index - 1;
				if (down < 0) {
					endCycle();
					clearComposer(session);
						return;
				}
				restoring = true;
				applyEntry(session, down).then(function (r) {
					restoring = false;
					});
				return;
			}
			// ArrowUp
			var up = cycle.index === null ? 0 : cycle.index + 1;
			if (up >= entries.length) {
				return;
			}
			restoring = true;
			applyEntry(session, up).then(function (r) {
				restoring = false;
			});
		}
		//#endregion

		//#region apply
		var keyCtx = null; // root ctx the keydown handler resolves services against
		// Cordis requires explicit dependencies for direct ctx service access.
		// slots is used during activation; sessions is used by resolveSession.
		exports.inject = ["slots", "sessions"];
		exports.apply = function apply(ctx) {
			keyCtx = ctx;
			ctx.effect(function () {
				var style = document.createElement("style");
				style.dataset.plugin = "dsh-input-history";
				style.textContent = CSS;
				document.head.append(style);
				document.addEventListener("keydown", onKeyDown, true);
				return function () {
					document.removeEventListener("keydown", onKeyDown, true);
					style.remove();
						if (detachCapture) { detachCapture(); detachCapture = null; }
					endCycle();
					keyCtx = null;
				};
			}, "dsh-input-history: styles + key listener");
			installCapture(ctx);
			installProbe(ctx);
		};
		//#endregion

		return module.exports;
	}
});
