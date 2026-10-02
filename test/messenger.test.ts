/**
 * The messenger's control-plane surface: who may log in to Matrix, whose push
 * tokens count, and what reaches Apple.
 *
 * config.ts reads the environment when it is first imported, so the
 * environment is set before the routes are imported, dynamically.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';

const GOTRUE_SECRET = 'gotrue-test-secret-0123456789abcdefghij';
const MATRIX_SECRET = 'matrix-test-secret-0123456789abcdefghij';
const HOST = '3ac6b9d3-354a-41e4-b878-990f9d23e79f';
const OTHER_HOST = '0b7c2c1e-8a8e-4c1f-9a53-6c0d2e7f9a10';
const STRANGER = '9f1d4a2b-1111-4222-8333-444455556666';
const SERVER_NAME = 'waves.test';
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

Object.assign(process.env, {
  LIVEKIT_PUBLIC_URL: 'wss://sfu.waves.test',
  LIVEKIT_KEY: 'APItest',
  LIVEKIT_SECRET: 'livekit-test-secret-0123456789abcdefghij',
  ADMIN_API_KEY: 'admin-test-key-0123456789abcdef',
  SESSION_SECRET: 'session-test-secret-0123456789abcdefghij',
  GOTRUE_JWT_SECRET: GOTRUE_SECRET,
  // An email entry is allowed on the stage but has no Matrix id.
  HOST_ACCOUNTS: `${HOST},${OTHER_HOST},kuro@example.com`,
  MATRIX_JWT_SECRET: MATRIX_SECRET,
  MATRIX_SERVER_NAME: SERVER_NAME,
  MATRIX_HOMESERVER_URL: `https://${SERVER_NAME}`,
  APNS_TOPIC: 'app.waves.messenger',
});

const { messengerRoutes } = await import('../src/routes/messenger.js');
const { GENERIC_ALERT } = await import('../src/messenger/apns.js');
type ApnsOutcome = Awaited<ReturnType<import('../src/messenger/apns.js').ApnsSender['send']>>;

const goTrueToken = (sub: string, appMetadata: Record<string, unknown> = { provider: 'apple' }) =>
  new SignJWT({ app_metadata: appMetadata, email: 'relay@privaterelay.appleid.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(GOTRUE_SECRET));

class MemoryTokens {
  readonly byToken = new Map<string, string>();
  async register(accountId: string, token: string) {
    this.byToken.set(token.toLowerCase(), accountId);
  }
  async accountFor(token: string) {
    return this.byToken.get(token.toLowerCase()) ?? null;
  }
  async remove(token: string) {
    this.byToken.delete(token.toLowerCase());
  }
}

class FakeApns {
  readonly sent: string[] = [];
  outcome: ApnsOutcome = { delivered: true };
  async send(token: string) {
    this.sent.push(token);
    return this.outcome;
  }
  close() {}
}

describe('messenger routes', () => {
  let app: FastifyInstance;
  let tokens: MemoryTokens;
  let apns: FakeApns;
  const whoami = new Map<string, string>([
    ['matrix-token-host', `@${HOST}:${SERVER_NAME}`],
    ['matrix-token-stranger', `@${STRANGER}:${SERVER_NAME}`],
    ['matrix-token-foreign', `@${HOST}:elsewhere.example`],
  ]);
  const stageNames = new Map<string, string>([
    [HOST, 'Super Nero'],
    [OTHER_HOST, 'Kuro'],
  ]);

  before(async () => {
    tokens = new MemoryTokens();
    apns = new FakeApns();
    app = Fastify();
    await app.register(messengerRoutes, {
      tokens,
      apns,
      matrixUserIdForAccessToken: async (token: string) => whoami.get(token) ?? null,
      stageNameFor: async (accountId: string) => stageNames.get(accountId) ?? null,
    });
    await app.ready();
  });

  after(() => app.close());

  describe('POST /api/messenger/login', () => {
    const login = (authorization?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/messenger/login',
        headers: authorization ? { authorization } : {},
      });

    it('refuses a request without a token', async () => {
      assert.equal((await login()).statusCode, 401);
    });

    it('refuses a token GoTrue did not sign', async () => {
      const forged = await new SignJWT({ app_metadata: { provider: 'apple' } })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(HOST)
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('not-the-gotrue-secret-0123456789abcdef'));
      assert.equal((await login(`Bearer ${forged}`)).statusCode, 401);
    });

    it('refuses an account that is not a host', async () => {
      const response = await login(`Bearer ${await goTrueToken(STRANGER)}`);
      assert.equal(response.statusCode, 403);
    });

    it('refuses a host id reached without a sign-in provider', async () => {
      const response = await login(`Bearer ${await goTrueToken(HOST, {})}`);
      assert.equal(response.statusCode, 403);
    });

    it('issues a host a 60-second Matrix login for their own user', async () => {
      const response = await login(`Bearer ${await goTrueToken(HOST)}`);
      assert.equal(response.statusCode, 200);
      const body = response.json();

      assert.equal(body.userId, `@${HOST}:${SERVER_NAME}`);
      assert.equal(body.loginType, 'org.matrix.login.jwt');
      assert.equal(body.homeserver, `https://${SERVER_NAME}`);
      // The email entry has no Matrix id, and a host is not their own contact.
      assert.deepEqual(body.otherHosts, [`@${OTHER_HOST}:${SERVER_NAME}`]);
      assert.deepEqual(body.contacts, [{ userId: `@${OTHER_HOST}:${SERVER_NAME}`, name: 'Kuro' }]);
      assert.equal(body.name, 'Super Nero');

      const { payload, protectedHeader } = await jwtVerify(
        body.loginToken,
        new TextEncoder().encode(MATRIX_SECRET),
        { issuer: 'waves-control', audience: 'waves-matrix', algorithms: ['HS256'] },
      );
      assert.equal(protectedHeader.alg, 'HS256');
      assert.equal(payload.sub, HOST);
      assert.equal((payload.exp ?? 0) - (payload.iat ?? 0), 60);
    });
  });

  describe('GET /api/messenger/contacts', () => {
    const contacts = (authorization?: string) =>
      app.inject({
        method: 'GET',
        url: '/api/messenger/contacts',
        headers: authorization ? { authorization } : {},
      });

    it('refuses a Matrix token the homeserver does not recognise', async () => {
      assert.equal((await contacts('Bearer matrix-token-unknown')).statusCode, 401);
    });

    it('refuses a Matrix user who is not a host', async () => {
      assert.equal((await contacts('Bearer matrix-token-stranger')).statusCode, 403);
    });

    it("gives a host the other hosts' names and their own", async () => {
      const response = await contacts('Bearer matrix-token-host');
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        name: 'Super Nero',
        contacts: [{ userId: `@${OTHER_HOST}:${SERVER_NAME}`, name: 'Kuro' }],
      });
    });
  });

  describe('POST /api/messenger/push-token', () => {
    const register = (authorization: string | undefined, token: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/messenger/push-token',
        headers: authorization ? { authorization } : {},
        payload: { token },
      });

    it('refuses a Matrix token the homeserver does not recognise', async () => {
      assert.equal((await register('Bearer matrix-token-unknown', TOKEN_A)).statusCode, 401);
    });

    it('refuses a user from another server', async () => {
      assert.equal((await register('Bearer matrix-token-foreign', TOKEN_A)).statusCode, 401);
    });

    it('refuses a Matrix user who is not a host', async () => {
      assert.equal((await register('Bearer matrix-token-stranger', TOKEN_A)).statusCode, 403);
    });

    it('refuses something that is not an APNs token', async () => {
      assert.equal((await register('Bearer matrix-token-host', 'not hex')).statusCode, 400);
    });

    it("records a host's token", async () => {
      assert.equal((await register('Bearer matrix-token-host', TOKEN_A)).statusCode, 204);
      assert.equal(await tokens.accountFor(TOKEN_A), HOST);
    });
  });

  describe('POST /api/push/_matrix/push/v1/notify', () => {
    const notify = (notification: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/push/_matrix/push/v1/notify',
        payload: { notification },
      });
    const device = (pushkey: string, appId = 'app.waves.messenger') => ({
      app_id: appId,
      pushkey,
    });

    it('rejects a malformed notification', async () => {
      assert.equal((await notify({})).statusCode, 400);
    });

    it('sends nothing for a badge-only update', async () => {
      apns.sent.length = 0;
      const response = await notify({ devices: [device(TOKEN_A)] });
      assert.deepEqual(response.json(), { rejected: [] });
      assert.equal(apns.sent.length, 0);
    });

    it('rejects a token no host registered, without contacting Apple', async () => {
      apns.sent.length = 0;
      const response = await notify({ event_id: '$e', devices: [device(TOKEN_B)] });
      assert.deepEqual(response.json(), { rejected: [TOKEN_B] });
      assert.equal(apns.sent.length, 0);
    });

    it('rejects a device registered for another app', async () => {
      await tokens.register(HOST, TOKEN_A);
      const response = await notify({ event_id: '$e', devices: [device(TOKEN_A, 'im.other')] });
      assert.deepEqual(response.json(), { rejected: [TOKEN_A] });
    });

    it('delivers to a registered token', async () => {
      await tokens.register(HOST, TOKEN_A);
      apns.sent.length = 0;
      apns.outcome = { delivered: true };
      const response = await notify({
        event_id: '$e',
        room_id: '!r:waves.test',
        sender: `@${OTHER_HOST}:${SERVER_NAME}`,
        devices: [device(TOKEN_A)],
      });
      assert.deepEqual(response.json(), { rejected: [] });
      assert.deepEqual(apns.sent, [TOKEN_A]);
    });

    it('turns an Apple rejection into a rejected token and forgets it', async () => {
      await tokens.register(HOST, TOKEN_A);
      apns.outcome = { delivered: false, status: 410, reason: 'Unregistered', tokenInvalid: true };
      const response = await notify({ event_id: '$e', devices: [device(TOKEN_A)] });
      assert.deepEqual(response.json(), { rejected: [TOKEN_A] });
      assert.equal(await tokens.accountFor(TOKEN_A), null);
    });

    it('keeps a token through a transient Apple failure', async () => {
      await tokens.register(HOST, TOKEN_A);
      apns.outcome = { delivered: false, status: 503, reason: 'ServiceUnavailable', tokenInvalid: false };
      const response = await notify({ event_id: '$e', devices: [device(TOKEN_A)] });
      assert.deepEqual(response.json(), { rejected: [] });
      assert.equal(await tokens.accountFor(TOKEN_A), HOST);
      apns.outcome = { delivered: true };
    });
  });
});

describe('the alert Apple receives', () => {
  it('carries no event, room, sender or message data', () => {
    const payload = JSON.parse(GENERIC_ALERT);
    assert.deepEqual(Object.keys(payload), ['aps']);
    assert.equal(payload.aps.alert.body, 'New activity in Waves');
    for (const leak of ['event_id', 'room_id', 'sender', 'content', '$', '@', '!']) {
      assert.ok(!GENERIC_ALERT.includes(leak), `alert payload contains ${leak}`);
    }
  });
});
