/**
 * The hosts' private messenger: Matrix login, push-token registration, and
 * the Matrix push gateway.
 *
 * Deliberately independent of principalFor: every caller here holds a bearer
 * token (GoTrue for login, Matrix for push), and the cookie fallbacks that
 * serve the Waves web app would only add ways in.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { isHostAccount, verifyAccessToken } from '../auth/accounts.js';
import type { ApnsSender } from '../messenger/apns.js';
import {
  MATRIX_LOGIN_TTL_SECONDS,
  MATRIX_LOGIN_TYPE,
  accountIdFromMatrixUserId,
  isAccountId,
  matrixUserId,
  signMatrixLogin,
} from '../messenger/matrix-login.js';
import { isApnsToken, type PushTokenStore } from '../messenger/push-tokens.js';

export type MessengerDeps = {
  tokens: PushTokenStore;
  apns: ApnsSender | null;
  matrixUserIdForAccessToken: (accessToken: string) => Promise<string | null>;
  /** The name a host chose for Waves, or null. */
  stageNameFor: (accountId: string) => Promise<string | null>;
};

// The gateway API sets no limit; ten is far above the two Macs this serves.
const MAX_DEVICES_PER_NOTIFICATION = 10;

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !/^bearer\s+/i.test(raw)) return null;
  const token = raw.replace(/^bearer\s+/i, '').trim();
  return token || null;
}

const fail = (reply: FastifyReply, status: number, error: string) =>
  reply.code(status).send({ error });

const isHostAccountId = (accountId: string): boolean =>
  config.auth.hostAccounts.some((entry) => entry.toLowerCase() === accountId);

export async function messengerRoutes(app: FastifyInstance, deps: MessengerDeps): Promise<void> {
  /** The other hosts, with the names they chose, for one host. */
  const contactsFor = (self: string, serverName: string) => {
    const otherIds = config.auth.hostAccounts
      .filter(isAccountId)
      .map((id) => id.toLowerCase())
      .filter((id) => id !== self);
    // Names come with the ids: a host who has not opened the Mac app yet has no
    // Matrix profile, and the other host's contact list still needs a name.
    return Promise.all(
      otherIds.map(async (id) => ({
        userId: matrixUserId(id, serverName),
        name: await deps.stageNameFor(id),
      })),
    );
  };

  app.post('/api/messenger/login', async (request, reply) => {
    const serverName = config.messenger.matrixServerName;
    if (!config.messenger.enabled || !serverName) {
      return fail(reply, 503, 'The messenger is not configured.');
    }
    const token = bearerToken(request);
    const account = token ? await verifyAccessToken(token) : null;
    if (!account) return fail(reply, 401, 'Sign in first.');
    if (!isHostAccount(account) || !isAccountId(account.id)) {
      return fail(reply, 403, 'This account is not a Waves host.');
    }

    const self = account.id.toLowerCase();
    const loginToken = await signMatrixLogin(self, config.messenger.matrixJwtSecret);
    const contacts = await contactsFor(self, serverName);
    const otherHosts = contacts.map((contact) => contact.userId);

    request.log.info({ account: self }, 'messenger login issued');
    return reply.send({
      homeserver: config.messenger.matrixHomeserverUrl,
      userId: matrixUserId(self, serverName),
      loginType: MATRIX_LOGIN_TYPE,
      loginToken,
      expiresInSeconds: MATRIX_LOGIN_TTL_SECONDS,
      name: await deps.stageNameFor(self),
      otherHosts,
      contacts,
    });
  });

  /**
   * Contacts for a host who is already signed in, so names picked up after
   * sign-in (or changed since) reach the app. Proven with the Matrix session,
   * as for push tokens.
   */
  app.get('/api/messenger/contacts', async (request, reply) => {
    const serverName = config.messenger.matrixServerName;
    if (!config.messenger.enabled || !serverName) {
      return fail(reply, 503, 'The messenger is not configured.');
    }
    const token = bearerToken(request);
    const userId = token ? await deps.matrixUserIdForAccessToken(token) : null;
    const accountId = userId ? accountIdFromMatrixUserId(userId, serverName) : null;
    if (!accountId) return fail(reply, 401, 'Sign in to the messenger first.');
    if (!isHostAccountId(accountId)) return fail(reply, 403, 'This account is not a Waves host.');
    return reply.send({
      name: await deps.stageNameFor(accountId),
      contacts: await contactsFor(accountId, serverName),
    });
  });

  app.post('/api/messenger/push-token', async (request, reply) => {
    if (!config.messenger.enabled) return fail(reply, 503, 'The messenger is not configured.');
    const token = bearerToken(request);
    const userId = token ? await deps.matrixUserIdForAccessToken(token) : null;
    const accountId = userId
      ? accountIdFromMatrixUserId(userId, config.messenger.matrixServerName)
      : null;
    if (!accountId) return fail(reply, 401, 'Sign in to the messenger first.');
    if (!isHostAccountId(accountId)) return fail(reply, 403, 'This account is not a Waves host.');

    const pushToken = (request.body as { token?: unknown } | undefined)?.token;
    if (typeof pushToken !== 'string' || !isApnsToken(pushToken)) {
      return fail(reply, 400, 'token must be an APNs device token.');
    }
    await deps.tokens.register(accountId, pushToken);
    return reply.code(204).send();
  });

  /**
   * The Matrix push gateway (`/_matrix/push/v1/notify`), mounted under /api.
   *
   * tuwunel strips that standard suffix from a pusher URL and appends it again,
   * so the pusher is registered as .../api/push/_matrix/push/v1/notify.
   */
  app.post('/api/push/_matrix/push/v1/notify', async (request, reply) => {
    const notification = (
      request.body as { notification?: { event_id?: unknown; devices?: unknown } } | undefined
    )?.notification;
    if (!notification || !Array.isArray(notification.devices)) {
      return fail(reply, 400, 'notification.devices is required');
    }

    const rejected: string[] = [];
    // No event means a badge refresh after a read elsewhere: nothing to announce.
    if (!notification.event_id) return reply.send({ rejected });
    if (!deps.apns) return fail(reply, 503, 'Push is not configured.');

    const devices = notification.devices.slice(0, MAX_DEVICES_PER_NOTIFICATION) as Array<
      { app_id?: unknown; pushkey?: unknown } | null
    >;
    for (const device of devices) {
      const pushkey = device?.pushkey;
      if (typeof pushkey !== 'string') continue;
      if (device?.app_id !== config.messenger.apns.topic || !isApnsToken(pushkey)) {
        rejected.push(pushkey);
        continue;
      }
      if (!(await deps.tokens.accountFor(pushkey))) {
        rejected.push(pushkey);
        continue;
      }
      const outcome = await deps.apns.send(pushkey);
      if (outcome.delivered) continue;
      // Token prefix only: a full device token is an identifier worth keeping out of logs.
      request.log.warn(
        { pushkey: pushkey.slice(0, 8), status: outcome.status, reason: outcome.reason },
        'APNs refused a notification',
      );
      if (outcome.tokenInvalid) {
        rejected.push(pushkey);
        await deps.tokens.remove(pushkey);
      }
    }
    return reply.send({ rejected });
  });
}
