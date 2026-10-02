/**
 * Signed tokens: sessions and invites.
 *
 * Both are JWTs, but they are signed with DIFFERENT KEYS, derived per purpose
 * from the active root key (see keys.ts). An invite is not merely *labelled*
 * as an invite — it is signed with a key the session verifier does not possess,
 * so replaying one as the other fails at the signature, not at a check someone
 * has to remember to write.
 *
 * The `typ` claim is still asserted. Defence in depth is the point: the
 * cryptographic separation is what makes it safe, the claim check is what makes
 * it obvious.
 */

import { SignJWT, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import type { KeyPurpose } from './keys.js';

const ISSUER = 'waves';
const ALG = 'HS256';

/** Roles an invite can confer. Excludes `audience`, which is the absence of one. */
export type InviteRole = 'moderator' | 'presenter' | 'speaker';

export interface SessionClaims {
  /** Server-assigned. Never derived from anything the client sent. */
  sub: string;
  /** This session's own id, so it can be revoked without touching others. */
  sid: string;
  /** Display name. A label, never a permission — see policy.ts. */
  name: string;
  /** True only for a session created by presenting an operator credential. */
  operator: boolean;
  /** Which operator credential, for attribution. */
  operatorId?: string;
  /** Issued-at, needed to evaluate a "log out everywhere" cutoff. */
  issuedAt: number;
}

export interface InviteClaims {
  /**
   * The room this link opens. Empty for a rolling invite, which has no room
   * until the day it is redeemed.
   */
  room: string;
  role: InviteRole;
  /**
   * The room's invite epoch when this link was minted. Bumping the room's epoch
   * invalidates every outstanding invite at once — the only revocation that
   * works for a capability URL someone may have forwarded.
   *
   * For a rolling invite this is the STANDING epoch instead, since there is no
   * one room whose epoch could carry it.
   */
  epoch: number;

  /**
   * Resolves to whichever daily show is running when it is redeemed.
   *
   * A normal invite names a room, and room ids are per-day — so yesterday's link
   * silently opens yesterday's empty room rather than tonight's show. A rolling
   * link carries no room at all and is resolved at redeem time, which is the
   * only way a link can outlive the day it was sent.
   */
  rolling?: boolean;
}

/**
 * A new anonymous subject.
 *
 * 24 random bytes, base64url. The `anon_` prefix makes it obvious in logs and
 * in a room's role list that this identity was never verified — an operator
 * reading `moderators: ["anon_x7K…"]` should not mistake it for an account.
 */
export const newSubject = (): string => `anon_${randomBytes(24).toString('base64url')}`;

/** A session id. Shorter than a subject: it identifies a login, not a person. */
export const newSessionId = (): string => randomBytes(12).toString('base64url');

function signer(purpose: KeyPurpose) {
  return config.keyRing.signingKeyFor(purpose);
}

/**
 * Verify against the key named in the token's own header.
 *
 * The `kid` selects which key to try, so an old token stays valid after a
 * rotation without every request having to try each key in turn. An unknown or
 * absent `kid` is a rejection, never a fallback — trusting a token whose key we
 * cannot name is exactly the hole rotation is supposed to avoid.
 */
async function verifyWithRing(token: string, purpose: KeyPurpose): Promise<JWTPayload | null> {
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    return null;
  }
  if (!kid) return null;

  const key = config.keyRing.keyFor(kid, purpose);
  if (!key) return null;

  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: [ALG] });
    return payload;
  } catch {
    // Expired, tampered, wrong key — all the same answer to a caller. Telling
    // them which would help an attacker narrow it down.
    return null;
  }
}

export async function signSession(
  claims: Omit<SessionClaims, 'issuedAt'>,
  ttlSeconds: number,
): Promise<string> {
  const { kid, key } = signer('session');
  return new SignJWT({
    typ: 'session',
    sid: claims.sid,
    name: claims.name,
    operator: claims.operator,
    ...(claims.operatorId ? { oid: claims.operatorId } : {}),
  })
    .setProtectedHeader({ alg: ALG, kid })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  const payload = await verifyWithRing(token, 'session');
  if (!payload) return null;
  if (payload.typ !== 'session') return null;
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;

  return {
    sub: payload.sub,
    sid: payload.sid,
    name: typeof payload.name === 'string' ? payload.name : '',
    operator: payload.operator === true,
    ...(typeof payload.oid === 'string' ? { operatorId: payload.oid } : {}),
    issuedAt: typeof payload.iat === 'number' ? payload.iat : 0,
  };
}

/**
 * Enrollment: the link that makes a phone a host's phone.
 *
 * Carries the host's NAME, not a secret. Redeeming it elevates the session that
 * presents it, so the operator credential itself never has to be typed into a
 * phone or live in a password manager on a device that gets left on tables.
 *
 * Deliberately single-purpose: an enrollment cannot be replayed as a session or
 * an invite, because each purpose derives an unrelated HKDF subkey.
 */
export interface EnrollmentClaims {
  /** Which host — matches an id in OPERATOR_KEYS. */
  host: string;
  /** Display name to seed the session with. */
  name: string;
}

export async function signEnrollment(
  claims: EnrollmentClaims,
  ttlSeconds: number,
): Promise<string> {
  const { kid, key } = signer('enroll');
  return new SignJWT({ typ: 'enroll', host: claims.host, name: claims.name })
    .setProtectedHeader({ alg: ALG, kid })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyEnrollment(token: string): Promise<EnrollmentClaims | null> {
  const payload = await verifyWithRing(token, 'enroll');
  if (!payload) return null;
  if (payload.typ !== 'enroll') return null;
  if (typeof payload.host !== 'string' || !payload.host) return null;
  return {
    host: payload.host,
    name: typeof payload.name === 'string' ? payload.name : payload.host,
  };
}

export async function signInvite(claims: InviteClaims, ttlSeconds: number): Promise<string> {
  const { kid, key } = signer('invite');
  return new SignJWT({
    typ: 'invite',
    room: claims.room,
    role: claims.role,
    epoch: claims.epoch,
    ...(claims.rolling ? { rolling: true } : {}),
  })
    .setProtectedHeader({ alg: ALG, kid })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyInvite(token: string): Promise<InviteClaims | null> {
  const payload = await verifyWithRing(token, 'invite');
  if (!payload) return null;
  if (payload.typ !== 'invite') return null;

  const { room, role, epoch, rolling } = payload;
  if (typeof room !== 'string' || typeof epoch !== 'number') return null;
  if (role !== 'moderator' && role !== 'presenter' && role !== 'speaker') return null;
  // A non-rolling invite with no room names nothing and must not be honoured;
  // a rolling one is expected to have none.
  if (!room && rolling !== true) return null;
  return { room, role, epoch, ...(rolling === true ? { rolling: true as const } : {}) };
}
