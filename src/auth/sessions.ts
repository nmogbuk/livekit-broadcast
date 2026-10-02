/**
 * Session revocation.
 *
 * A signed token is valid until it expires — that is what makes it cheap, and
 * it is also why "log this person out" needs somewhere to write. Sessions are
 * long-lived here (30 days, because an anonymous identity expiring early just
 * loses someone their name), so the ability to end one individually matters.
 *
 * Two levers, both keyed in Redis so they survive a restart and are shared
 * across replicas:
 *
 *   revoke(sid)          kill ONE session — a lost phone, an ejected troll.
 *   revokeAllFor(sub)    kill every session for a subject, by recording a
 *                        cutoff: tokens issued before it stop verifying.
 *
 * Entries expire with the tokens they invalidate, so the denylist stays
 * proportional to recent revocations rather than growing forever.
 */

import { redis } from '../store.js';
import { config } from '../config.js';

const sidKey = (sid: string) => `waves:revoked:sid:${sid}`;
const subKey = (sub: string) => `waves:revoked:sub:${sub}`;

/** Revoke a single session. */
export async function revokeSession(sid: string): Promise<void> {
  // TTL matches the session lifetime: once the token would have expired anyway,
  // the denylist entry is dead weight.
  await redis.set(sidKey(sid), '1', 'EX', config.sessionTtlSeconds);
}

/** Revoke every session a subject currently holds ("log out everywhere"). */
export async function revokeAllSessions(sub: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await redis.set(subKey(sub), String(now), 'EX', config.sessionTtlSeconds);
}

/**
 * Has this token been revoked?
 *
 * Two Redis reads on every authenticated request, pipelined into one round
 * trip. Worth it: the alternative is a session that cannot be ended.
 */
export async function isRevoked(sid: string, sub: string, issuedAt: number): Promise<boolean> {
  const [sidHit, cutoff] = await redis.mget(sidKey(sid), subKey(sub));
  if (sidHit) return true;
  if (cutoff && issuedAt < Number(cutoff)) return true;
  return false;
}
