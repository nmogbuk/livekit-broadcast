/**
 * Apple Push Notification service, over HTTP/2 with a token-based (.p8) key.
 *
 * A .p8 key does not expire, unlike the per-app certificates the other estate
 * apps use, and one key serves every app on the team.
 */

import {
  connect,
  type ClientHttp2Session,
  type ClientHttp2Stream,
} from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import { config } from '../config.js';

export type ApnsOutcome =
  | { delivered: true }
  | { delivered: false; status: number; reason: string; tokenInvalid: boolean };

export interface ApnsSender {
  send(deviceToken: string): Promise<ApnsOutcome>;
  close(): void;
}

export interface ApnsOptions {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  topic: string;
  production: boolean;
}

/**
 * What a quit app shows. Nothing about the event reaches Apple: tuwunel sends
 * this gateway event IDs only, and even those stay out of the payload.
 */
export const GENERIC_ALERT = JSON.stringify({
  aps: {
    alert: { title: 'Waves', body: 'New activity in Waves' },
    sound: 'default',
    'thread-id': 'waves',
  },
});

const INVALID_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

// Apple rejects provider tokens older than an hour and throttles refreshes
// more frequent than every twenty minutes.
const PROVIDER_TOKEN_REFRESH_MS = 40 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 10_000;

export function createApnsSender(options: ApnsOptions): ApnsSender {
  const origin = options.production
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
  let session: ClientHttp2Session | null = null;
  let signingKey: ReturnType<typeof importPKCS8> | null = null;
  let providerToken: { value: string; mintedAt: number } | null = null;

  const openSession = (): ClientHttp2Session => {
    if (session && !session.closed && !session.destroyed) return session;
    const next = connect(origin);
    next.on('error', () => next.destroy());
    next.on('goaway', () => next.close());
    next.on('close', () => {
      if (session === next) session = null;
    });
    // An idle push connection must not keep the process alive on shutdown.
    next.unref();
    session = next;
    return next;
  };

  const currentProviderToken = async (): Promise<string> => {
    const now = Date.now();
    if (providerToken && now - providerToken.mintedAt < PROVIDER_TOKEN_REFRESH_MS) {
      return providerToken.value;
    }
    signingKey ??= importPKCS8(options.privateKeyPem, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: options.keyId })
      .setIssuer(options.teamId)
      .setIssuedAt(Math.floor(now / 1000))
      .sign(await signingKey);
    providerToken = { value, mintedAt: now };
    return value;
  };

  return {
    async send(deviceToken) {
      const authorization = `bearer ${await currentProviderToken()}`;
      return new Promise<ApnsOutcome>((resolve) => {
        let settled = false;
        const finish = (outcome: ApnsOutcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };

        let request: ClientHttp2Stream;
        try {
          request = openSession().request({
            ':method': 'POST',
            ':path': `/3/device/${deviceToken}`,
            authorization,
            'apns-topic': options.topic,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
            // One alert stands in for a burst; the app shows the detail once opened.
            'apns-collapse-id': 'waves-activity',
            'content-type': 'application/json',
          });
        } catch (error) {
          finish({
            delivered: false,
            status: 0,
            reason: error instanceof Error ? error.message : 'connect failed',
            tokenInvalid: false,
          });
          return;
        }

        let status = 0;
        let body = '';
        request.setEncoding('utf8');
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
          request.close();
          finish({ delivered: false, status: 0, reason: 'Timeout', tokenInvalid: false });
        });
        request.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          if (status === 200) {
            finish({ delivered: true });
            return;
          }
          let reason = '';
          try {
            reason = String((JSON.parse(body) as { reason?: unknown }).reason ?? '');
          } catch {
            // Apple always answers errors in JSON; anything else is a transport fault.
          }
          finish({
            delivered: false,
            status,
            reason,
            tokenInvalid: status === 410 || INVALID_TOKEN_REASONS.has(reason),
          });
        });
        request.on('error', (error) =>
          finish({ delivered: false, status: 0, reason: error.message, tokenInvalid: false }),
        );
        request.end(GENERIC_ALERT);
      });
    },
    close() {
      session?.close();
      session = null;
    },
  };
}

export function apnsSenderFromConfig(): ApnsSender | null {
  const { teamId, keyId, privateKey, topic, production } = config.messenger.apns;
  if (!teamId || !keyId || !privateKey) return null;
  return createApnsSender({ teamId, keyId, privateKeyPem: privateKey, topic, production });
}
