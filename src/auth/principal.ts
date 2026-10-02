/**
 * Turning an HTTP request into a Principal.
 *
 * This is the seam the whole security model hangs on. Before, it read a
 * client-supplied `x-waves-identity` header and believed it. Now the identity
 * comes from a cookie the server signed, so a caller can choose their display
 * name but never their subject — and permissions key only on the subject.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Room } from '../types.js';
import { can, type Capability, type Principal } from './policy.js';
import { identifyOperator } from './operators.js';
import { isHostAccount, verifyAccessToken, type Account } from './accounts.js';
import { getStageName } from '../accounts-profile.js';
import { isRevoked, revokeSession } from './sessions.js';
import { newSessionId, newSubject, signSession, verifySession } from './tokens.js';

export const SESSION_COOKIE = 'waves_session';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Which operator, if any, is presenting a credential on this request?
 *
 * Returns the operator's NAME rather than a boolean, so every privileged action
 * can be attributed to a person in the logs instead of to "someone with the
 * admin key".
 */
function operatorFor(request: FastifyRequest): string | null {
  const header = request.headers['x-waves-operator-key'] ?? request.headers['x-waves-admin-key'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return null;
  return identifyOperator(provided, config.operators);
}

/**
 * The principal for this request, minting a session if there isn't one.
 *
 * Anonymous by default and on purpose: this product is a comedy show, and
 * making someone create an account before they can hear a joke would cost far
 * more than it protects. What matters is that the identity is UNFORGEABLE, not
 * that it is verified — a listener may call themselves anything, but they
 * cannot inherit anyone's permissions by doing so.
 */
export async function principalFor(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Principal> {
  /*
   * A signed-in account wins over everything else.
   *
   * Checked FIRST, and it does not touch the session cookie: the account IS the
   * identity, on every device, on every day. The anonymous path below still
   * exists and is still the default — an audience should never need an account
   * to hear a show — but a host who has signed in is themselves everywhere.
   */
  const account = await accountFor(request);
  if (account) {
    const host = isHostAccount(account);
    /*
     * A stage name the host chose beats the one Apple supplied. Apple's is only
     * a starting value — the audience knows these two by their stage names, and
     * signing in should not rename them everywhere.
     */
    const stageName = await getStageName(`user_${account.id}`);
    return {
      // Namespaced so an account subject can never collide with an `anon_` one,
      // and so the origin of any subject is legible in a room's role list.
      sub: `user_${account.id}`,
      // The account id doubles as the session id. Revoking a device means
      // revoking it in GoTrue, which is where the refresh token lives.
      sid: account.id,
      name: stageName || account.name,
      operator: host,
      ...(host ? { operatorId: account.email || account.id } : {}),
      account,
    };
  }

  const cookie = request.cookies[SESSION_COOKIE];
  const claims = cookie ? await verifySession(cookie) : null;
  const operatorId = operatorFor(request);

  if (claims) {
    // A validly signed token can still have been revoked — a lost phone, an
    // ejected troll, or a "log out everywhere". Signature alone is not enough.
    if (await isRevoked(claims.sid, claims.sub, claims.issuedAt)) {
      const principal = freshPrincipal(operatorId);
      await issueSession(reply, principal);
      return principal;
    }

    // The operator credential elevates the CURRENT session rather than creating
    // a parallel identity, so an operator's actions stay attributable to one
    // subject across their whole request history.
    return {
      sub: claims.sub,
      sid: claims.sid,
      name: claims.name,
      operator: Boolean(operatorId) || claims.operator,
      ...(operatorId ?? claims.operatorId ? { operatorId: operatorId ?? claims.operatorId } : {}),
    };
  }

  const principal = freshPrincipal(operatorId);
  await issueSession(reply, principal);
  return principal;
}

/** The bearer token on this request, if it verifies. */
async function accountFor(request: FastifyRequest): Promise<Account | null> {
  const header = request.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !raw.toLowerCase().startsWith('bearer ')) return null;
  return verifyAccessToken(raw.slice(7).trim());
}

function freshPrincipal(operatorId: string | null): Principal {
  return {
    sub: newSubject(),
    sid: newSessionId(),
    name: '',
    operator: Boolean(operatorId),
    ...(operatorId ? { operatorId } : {}),
  };
}

/** End this session. The token keeps verifying but stops being accepted. */
export async function endSession(reply: FastifyReply, principal: Principal): Promise<void> {
  await revokeSession(principal.sid);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Write (or refresh) the session cookie.
 *
 * `ttlSeconds` overrides the default for HOST devices. An audience session is
 * 30 days because it is anonymous and disposable; a host's phone is a personal
 * device they use daily, and making them re-enroll every month to run their own
 * show would be the kind of friction that sends people back to Instagram Live.
 */
export async function issueSession(
  reply: FastifyReply,
  principal: Principal,
  ttlSeconds: number = config.sessionTtlSeconds,
): Promise<void> {
  const token = await signSession(
    {
      sub: principal.sub,
      sid: principal.sid,
      name: principal.name,
      operator: principal.operator,
      ...(principal.operatorId ? { operatorId: principal.operatorId } : {}),
    },
    ttlSeconds,
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    // httpOnly: script cannot read it, so an XSS bug cannot exfiltrate the
    // session — which matters here because display names are user-supplied.
    httpOnly: true,
    // Secure everywhere except plain-http local development.
    secure: config.publicUrl.startsWith('https://'),
    // Lax, not Strict: a show link arrives from WhatsApp or a tweet, and Strict
    // would drop the cookie on exactly that navigation.
    sameSite: 'lax',
    maxAge: ttlSeconds,
  });
}

export function requireCapability(
  principal: Principal,
  capability: Capability,
  room?: Room,
): void {
  if (can(principal, capability, room)) return;
  throw new HttpError(403, `Not allowed: ${capability}`);
}

export function requireOperator(principal: Principal): void {
  if (!principal.operator) throw new HttpError(401, 'Operator credential required');
}

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  if (error instanceof Error && error.name === 'RoomNotFoundError') {
    return reply.code(404).send({ error: error.message });
  }
  // 503, not 500: the request was valid and retrying once the infrastructure is
  // back will succeed.
  if (
    error instanceof Error &&
    (error.name === 'EgressUnavailableError' || error.name === 'SfuUnreachableError')
  ) {
    return reply.code(503).send({ error: error.message });
  }
  reply.log.error({ err: error }, 'unhandled request error');
  return reply.code(500).send({ error: 'Internal server error' });
}
