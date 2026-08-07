/**
 * Node version guard.
 *
 * Public API: nodeGuardMessage(version) returns the one-line refusal
 * message when `version`'s major is below the minimum this CLI supports,
 * or `undefined` when the version is fine (or unparseable — fail open).
 */
export { nodeGuardMessage } from './guard.ts';
