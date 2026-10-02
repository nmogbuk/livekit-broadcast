/**
 * The key ring.
 *
 * Replaces a single shared secret, which was weak in four distinct ways:
 *
 *   1. NO ROTATION PATH. Changing the secret invalidated every live session and
 *      every outstanding invite at once. A key you cannot rotate without an
 *      outage is a key you never rotate.
 *   2. ONE KEY, TWO PURPOSES. Sessions and invites were signed with the same
 *      bytes and kept apart only by a `typ` claim the verifier had to remember
 *      to check. A missed check anywhere = an invite redeemable as a session.
 *   3. NO PER-SESSION REVOCATION. The only lever was rotating the secret, which
 *      logs out everyone to remove one person.
 *   4. VERIFY IMPLIES SIGN. Symmetric keys mean anything that can check a token
 *      can also mint one.
 *
 * What this fixes:
 *
 *   - N keys, each with a `kid` carried in the JWT header. One SIGNS, all of
 *     them VERIFY. Rotation is: add a key, make it active, keep the old one
 *     verifying until existing tokens age out, then drop it. No logouts.
 *   - Every root key is split by HKDF into per-purpose subkeys, so the session
 *     key and the invite key are cryptographically unrelated. Cross-purpose
 *     replay stops being a check we must not forget and becomes impossible.
 *   - Sessions carry a `sid`, so one session can be revoked without touching
 *     anyone else. See sessions.ts.
 *
 * (4) is unaddressed on purpose: this process is the only issuer and the only
 * verifier, so asymmetric keys would add operational weight — key distribution,
 * a JWKS endpoint — to buy a property nothing currently needs. If another
 * service ever needs to verify a Waves token, switch to EdDSA; the `kid`
 * indirection is already here, which is what makes that a swap rather than a
 * migration.
 */

import { hkdfSync, timingSafeEqual } from 'node:crypto';

/** Purpose labels. Adding one gives it its own derived key automatically. */
/**
 * `enroll` is the third purpose: a one-time link that turns a device into a
 * host's device. Separate from `invite` because an invite grants a role in ONE
 * room and expires in days, while an enrollment grants the standing right to
 * CREATE rooms and is meant to be redeemed once per phone, forever.
 */
export type KeyPurpose = 'session' | 'invite' | 'enroll';

/** HKDF salt. Versioned so the derivation itself can change deliberately. */
const SALT = Buffer.from('waves.keyring.v1');

export interface RingKey {
  kid: string;
  /** Root material. Never used to sign directly — only to derive. */
  root: Buffer;
}

export class KeyRing {
  private readonly keys: RingKey[];
  private readonly derived = new Map<string, Uint8Array>();

  constructor(keys: RingKey[]) {
    if (keys.length === 0) throw new Error('KeyRing needs at least one key');
    this.keys = keys;
  }

  /** The key new tokens are signed with — always the first. */
  get active(): RingKey {
    return this.keys[0]!;
  }

  get kids(): string[] {
    return this.keys.map((k) => k.kid);
  }

  /**
   * The signing/verifying key for one purpose under one root key.
   *
   * Derivation is deterministic, so this is a pure cache — restarting the
   * process yields the same subkeys and existing tokens keep verifying.
   */
  keyFor(kid: string, purpose: KeyPurpose): Uint8Array | null {
    const cacheKey = `${kid}:${purpose}`;
    const cached = this.derived.get(cacheKey);
    if (cached) return cached;

    const key = this.keys.find((k) => k.kid === kid);
    if (!key) return null;

    const subkey = new Uint8Array(
      hkdfSync('sha256', key.root, SALT, Buffer.from(`waves.${purpose}`), 32),
    );
    this.derived.set(cacheKey, subkey);
    return subkey;
  }

  signingKeyFor(purpose: KeyPurpose): { kid: string; key: Uint8Array } {
    const kid = this.active.kid;
    const key = this.keyFor(kid, purpose);
    if (!key) throw new Error(`no derived key for ${kid}/${purpose}`);
    return { kid, key };
  }
}

/**
 * Parse the configured keys.
 *
 * Format: `kid:secret` entries separated by commas, FIRST IS ACTIVE.
 *
 *   SESSION_KEYS=2026-08b:xLq…,2026-08a:9fK…
 *
 * A bare secret with no `kid:` is accepted and labelled `k1`, so an existing
 * single-secret deployment BOOTS unchanged.
 *
 * It does not, however, keep existing sessions alive: tokens minted by the
 * previous release carry no `kid` and were signed with the raw secret rather
 * than an HKDF subkey, so they no longer verify. Verified, not assumed.
 *
 * The cost of that one-time break: everyone is anonymous, so a listener just
 * re-enters a display name — but anyone who had redeemed an invite gets a NEW
 * subject and therefore LOSES their room role, and needs a fresh invite link.
 * Acceptable here only because the deployment is days old and its rooms are
 * test data. Rotation from this point forward is seamless, which is the whole
 * point: this is the last upgrade that costs a logout.
 */
export function parseKeyRing(raw: string): KeyRing {
  const keys: RingKey[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const hasKid = separator > 0;
    const kid = hasKid ? entry.slice(0, separator) : 'k1';
    const secret = hasKid ? entry.slice(separator + 1) : entry;

    if (secret.length < 32) {
      throw new Error(
        `Key ${kid} is ${secret.length} chars; at least 32 required. ` +
          `Generate with: openssl rand -base64 32`,
      );
    }
    if (seen.has(kid)) throw new Error(`Duplicate key id ${kid}`);
    seen.add(kid);
    keys.push({ kid, root: Buffer.from(secret, 'utf8') });
  }

  if (keys.length === 0) throw new Error('No signing keys configured');
  return new KeyRing(keys);
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Lengths are compared first and non-secretly — that leaks only the length,
 * which is not the secret, and `timingSafeEqual` throws on a mismatch.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
