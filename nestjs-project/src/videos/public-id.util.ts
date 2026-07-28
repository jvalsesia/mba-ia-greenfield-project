import { randomBytes } from 'node:crypto';

/**
 * Bytes of entropy behind a public id. 8 bytes → 64 bits, encoded as 11
 * URL-safe characters by base64url (no padding at this length).
 */
const PUBLIC_ID_BYTES = 8;

/**
 * Generates the short public identifier that appears in a video's URL
 * (`phase-03-videos/TD-07`).
 *
 * `node:crypto` rather than a library: `nanoid` v6 is ESM-only and this is a
 * CommonJS codebase, and the standard library already provides exactly this.
 *
 * Uniqueness is enforced by the `UNIQUE` constraint on `videos.public_id`, not
 * by this function — callers retry on a unique violation. Randomness here only
 * makes ids unguessable and collisions vanishingly rare.
 */
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}
