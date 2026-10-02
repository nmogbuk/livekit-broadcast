/**
 * Real accounts, from GoTrue.
 *
 * Identity used to be a property of a DEVICE: a host proved who they were with
 * an enrollment token baked into one phone's cookie. That made a second device a
 * stranger, made "this device isn't set up yet" a dead end for anyone who opened
 * the installed app, and left the daily rooms re-granting roles every night.
 *
 * An account is a property of a PERSON, so all three stop being possible.
 *
 * This module does one thing: turn a bearer token into a verified identity, or
 * nothing. It deliberately holds no session state — GoTrue owns the refresh
 * cycle, and duplicating it here would create two clocks to disagree.
 */

import { jwtVerify } from 'jose';
import { config } from '../config.js';

export interface Account {
  /** GoTrue's user id. Stable for the life of the account, across every device. */
  id: string;
  email: string;
  emailVerified: boolean;
  /** Which provider vouched for them — 'apple' in production. */
  provider: string;
  name: string;
}

const secretKey = (): Uint8Array => new TextEncoder().encode(config.auth.jwtSecret);

/** Trim a display name out of whatever the provider chose to give us. */
function displayNameFrom(claims: Record<string, unknown>, email: string): string {
  const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of ['name', 'full_name', 'preferred_username']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 40);
  }
  /*
   * Apple gives a name ONCE, on the very first authorization, and never again —
   * so for anyone who signed in before we asked for it, there is nothing to read
   * and the local part of the address is the only human-ish string available.
   * The host sets their own stage name anyway; this is just a sane default.
   */
  const local = email.split('@')[0] ?? '';
  return local.slice(0, 40);
}

/**
 * Verify a GoTrue access token.
 *
 * Returns null rather than throwing: an unverifiable token is not an error, it
 * is an anonymous request, and the caller falls back to the audience path.
 */
export async function verifyAccessToken(token: string): Promise<Account | null> {
  if (!config.auth.enabled) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      // Pinned, not inferred. Accepting whatever the header names is how a token
      // signed with `alg: none` — or with a public key as an HMAC secret — gets
      // treated as valid.
      algorithms: ['HS256'],
      audience: 'authenticated',
    });

    const sub = payload.sub;
    if (typeof sub !== 'string' || !sub) return null;

    const appMeta = (payload.app_metadata ?? {}) as Record<string, unknown>;
    const email = typeof payload.email === 'string' ? payload.email : '';

    return {
      id: sub,
      email,
      /*
       * GoTrue omits this claim for provider sign-ins where the address is
       * verified by construction. Absent therefore means "not stated", not
       * "unverified" — but `provider` is checked at the host gate regardless,
       * so a bare true here cannot itself grant anything.
       */
      emailVerified: payload.email_verified !== false,
      provider: typeof appMeta.provider === 'string' ? appMeta.provider : '',
      name: displayNameFrom(payload as Record<string, unknown>, email),
    };
  } catch {
    // Expired, wrong signature, wrong audience — all the same answer here.
    return null;
  }
}

/**
 * Is this account one of the show's hosts?
 *
 * An allowlist rather than a flag on the account, because the alternative is a
 * privilege that can be granted by whoever can write to the auth database, and
 * this list lives in a deployment secret instead.
 *
 * Matched on the account id OR the email, because Apple's "Hide My Email" hands
 * back a per-app relay address that cannot be predicted in advance: the host
 * signs in once, and their stable id goes in the list afterwards.
 */
export function isHostAccount(account: Account): boolean {
  const allow = config.auth.hostAccounts;
  if (allow.length === 0) return false;

  /*
   * Provider sign-in only.
   *
   * The allowlist matches on email, so any path to an account with a CHOSEN
   * email address would be a path to the stage. Email/password signup is off in
   * GoTrue for that reason; this is the second lock, in case it is ever turned
   * back on by someone who did not know why it was off.
   */
  if (!account.provider) return false;
  if (!account.emailVerified) return false;

  const email = account.email.toLowerCase();
  return allow.some((entry) => entry === account.id || entry.toLowerCase() === email);
}
