/**
 * dsh-input-history — host half (no-op mount stub).
 *
 * Exists only so the package becomes a host Loader entry (via the profile
 * bundle list), which is what makes the client-modules roster generator scan
 * this package's `dsh.client` declaration and serve lib/client.js to the
 * browser. All behaviour lives in the browser half; no services, no RPC.
 */
export const name = "dsh-input-history";
export const inject = [];

export function apply(ctx, options) {
	// Intentionally empty.
}
