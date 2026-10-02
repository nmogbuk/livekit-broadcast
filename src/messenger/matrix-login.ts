/**
 * Matrix logins for the hosts' messenger.
 *
 * tuwunel accepts a login JWT signed with a key it shares only with this
 * control plane. Minting one here, after the GoTrue account has passed the
 * HOST_ACCOUNTS check, keeps that allowlist as the only gate: tuwunel never
 * trusts GoTrue directly, so an arbitrary Apple ID cannot reach it.
 */

import { SignJWT } from 'jose';

export const MATRIX_JWT_ISSUER = 'waves-control';
export const MATRIX_JWT_AUDIENCE = 'waves-matrix';
export const MATRIX_LOGIN_TYPE = 'org.matrix.login.jwt';

/** Long enough for one login round trip, too short to be worth intercepting. */
export const MATRIX_LOGIN_TTL_SECONDS = 60;

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GoTrue account ids are UUIDs, which are valid Matrix localparts once
 * lowercased. HOST_ACCOUNTS may also hold emails, which cannot be mapped to a
 * Matrix user, so callers filter with this.
 */
export const isAccountId = (value: string): boolean => ACCOUNT_ID.test(value);

export function matrixUserId(accountId: string, serverName: string): string {
  return `@${accountId.toLowerCase()}:${serverName}`;
}

/** The account id behind a Matrix user id on this server, or null. */
export function accountIdFromMatrixUserId(userId: string, serverName: string): string | null {
  const match = /^@([^:]+):(.+)$/.exec(userId);
  if (!match || match[2] !== serverName) return null;
  const localpart = match[1] ?? '';
  return isAccountId(localpart) ? localpart.toLowerCase() : null;
}

export async function signMatrixLogin(accountId: string, secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    // tuwunel lowercases `sub` into the localpart; doing it here keeps the
    // token and the resulting user id identical.
    .setSubject(accountId.toLowerCase())
    .setIssuer(MATRIX_JWT_ISSUER)
    .setAudience(MATRIX_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MATRIX_LOGIN_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}
