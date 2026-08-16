/**
 * dsh-input-history — host half.
 *
 * This plugin is purely client-side: the composer's ↑/↓ input history lives
 * in the browser (a global localStorage ring written at send time and read
 * synchronously on every arrow key). The host half exists only so the bundle
 * mounts through the standard dsh bundle channel; it performs no work.
 */

/** Plugin identity for cordis.yml rows. */
const name = "dsh-input-history";

/** Services required before mounting: none (the client half resolves sessions/connection itself). */
const inject = [];

/** Host plugin body: intentionally a no-op — all logic lives in lib/client.js. */
export function apply(_ctx) {
	/* nothing to do */
}

export { name, inject };
