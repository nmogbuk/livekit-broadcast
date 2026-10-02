/**
 * Environment configuration.
 *
 * Every value is read once, at import time, and missing required values throw
 * immediately. A control plane that boots with a missing LIVEKIT_SECRET would
 * mint tokens the SFU rejects, and the failure would surface as "users can't
 * join" — far from its cause. Failing at boot keeps the error next to the bug.
 */

import { readFileSync } from 'node:fs';
import { parseKeyRing, type KeyRing } from './auth/keys.js';
import { parseOperators, type OperatorCredential } from './auth/operators.js';

/**
 * Read NAME, or NAME_FILE if it names a file.
 *
 * Docker Swarm mounts secrets as files under /run/secrets rather than injecting
 * them into the environment, which is the point: an env var is visible in
 * `docker inspect`, in a crash dump, and to any child process. The _FILE suffix
 * is the conventional bridge, and it is what lets the same image run under
 * swarm (secrets) and plain compose (env) with no code change.
 */
function read(name: string): string | undefined {
  const fromFile = process.env[`${name}_FILE`];
  if (fromFile) {
    try {
      // Trailing newline is near-universal in secret files and would silently
      // corrupt an API key comparison.
      return readFileSync(fromFile, 'utf8').trim();
    } catch (error) {
      throw new Error(
        `${name}_FILE is set to ${fromFile} but it could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return process.env[name];
}

function required(name: string): string {
  const value = read(name);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name} (or ${name}_FILE). ` +
        `See platform/deployment/.env.example; run deployment/bin/bootstrap.sh to generate secrets.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return read(name) || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = read(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = read(name);
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const config = {
  /** Port the HTTP API listens on. Traefik fronts it. */
  port: optionalInt('PORT', 3000),
  host: optional('HOST', '0.0.0.0'),
  logLevel: optional('LOG_LEVEL', 'info'),

  /** Public origin of this app, used to build shareable room links. */
  publicUrl: optional('PUBLIC_URL', 'http://localhost:3000'),

  redisUrl: optional('REDIS_URL', 'redis://127.0.0.1:6379'),

  livekit: {
    /**
     * Server-to-server URL, reached from inside the deployment. Usually plain
     * http on loopback — it never leaves the host, so TLS buys nothing here.
     */
    url: optional('LIVEKIT_URL', 'http://127.0.0.1:7880'),
    /**
     * URL handed to browsers. Must be wss:// in production — a secure page
     * cannot open an insecure WebSocket, so http:// here breaks every client
     * with a mixed-content error rather than an obvious failure.
     */
    publicUrl: required('LIVEKIT_PUBLIC_URL'),
    key: required('LIVEKIT_KEY'),
    secret: required('LIVEKIT_SECRET'),
  },

  recording: {
    /** 'local' writes into the egress container's mounted volume; 's3' uploads. */
    backend: optional('RECORDING_BACKEND', 'local') as 'local' | 's3',
    /** Path prefix inside the egress output volume (local backend). */
    localPathPrefix: optional('RECORDING_LOCAL_PREFIX', '/out/recordings'),
    s3: {
      bucket: optional('RECORDING_S3_BUCKET', ''),
      region: optional('RECORDING_S3_REGION', ''),
      accessKey: optional('RECORDING_S3_ACCESS_KEY', ''),
      secret: optional('RECORDING_S3_SECRET', ''),
      /**
       * S3 endpoint, resolved BY THE EGRESS CONTAINER, not by this process.
       * The control plane only forwards it in the egress request. With MinIO on
       * the media node that makes `http://127.0.0.1:9000` correct here even
       * though this server is on a different machine — it is egress's loopback,
       * not ours. Plain http and loopback are fine: the bytes never leave the
       * media host, so TLS would cost CPU we need for encoding.
       */
      endpoint: optional('RECORDING_S3_ENDPOINT', ''),
      /**
       * MinIO addresses buckets path-style (`host/bucket/key`); AWS defaults to
       * virtual-host style (`bucket.host/key`). Without this every upload to
       * MinIO fails to resolve. Defaults on whenever a custom endpoint is set,
       * since that is nearly always a MinIO/R2/B2-style store.
       */
      forcePathStyle: optionalBool('RECORDING_S3_FORCE_PATH_STYLE', Boolean(read('RECORDING_S3_ENDPOINT'))),
      /** Public base URL for the HLS playlist, i.e. your CDN in front of the bucket. */
      publicBaseUrl: optional('RECORDING_S3_PUBLIC_BASE_URL', ''),
    },
  },

  /**
   * Encoding presets, per orientation.
   *
   * Configurable because they are the single biggest lever on CPU, and the
   * media host is CPU-bound (4 cores / 8 threads). Portrait defaults to 720p:
   * TikTok is viewed on phones, where 720x1280 is indistinguishable from 1080p
   * at arm's length, and it costs roughly 40% less to encode than the 1080p
   * preset. Raise it only if you have measured the headroom.
   */
  encoding: {
    landscape: optional('ENCODING_LANDSCAPE', 'H264_1080P_30'),
    portrait: optional('ENCODING_PORTRAIT', 'PORTRAIT_H264_720P_30'),
  },

  /**
   * Token lifetime. Short tokens limit the blast radius of a leaked JWT, but a
   * token that expires mid-show forces a reconnect. Six hours covers a long
   * show; LiveKit refreshes the token on an active connection.
   */
  tokenTtlSeconds: optionalInt('TOKEN_TTL_SECONDS', 6 * 60 * 60),

  /**
   * Hide audience participants from each other's participant lists.
   * See livekit/grants.ts for why this matters above a few hundred listeners.
   */
  hideAudience: optionalBool('HIDE_AUDIENCE', true),

  /**
   * Operator credentials — `name:secret` pairs, comma separated.
   *
   * Named rather than shared so actions are attributable and one person's
   * access can be removed without rotating everyone's. Falls back to
   * ADMIN_API_KEY (as an unnamed `default`) so an existing deployment keeps
   * working through the rollout.
   */
  operators: parseOperators(optional('OPERATOR_KEYS', '') || required('ADMIN_API_KEY')) as
    readonly OperatorCredential[],

  /**
   * The signing key ring — `kid:secret` pairs, comma separated, FIRST ACTIVE.
   *
   * A ring rather than one secret so keys can be rotated without logging
   * everyone out: add a key at the front, and old tokens keep verifying against
   * the key their header names until they expire. Each root key is split by
   * HKDF into unrelated per-purpose subkeys, so a session token and an invite
   * token are not merely labelled differently — they are signed with different
   * keys. See auth/keys.ts.
   *
   * Deliberately NOT the LiveKit secret: that one is shared with the SFU and
   * every egress worker, so reusing it would mean a leak there also hands over
   * every user session.
   */
  keyRing: parseKeyRing(optional('SESSION_KEYS', '') || required('SESSION_SECRET')) as KeyRing,

  /**
   * Session lifetime. Long, because this is an anonymous identity rather than
   * an authenticated one: expiring it early does not protect an account, it
   * just loses someone their name and their place in a show.
   */
  /**
   * Real accounts, via GoTrue.
   *
   * Optional on purpose. With no JWT secret configured the whole account layer
   * is inert and the anonymous session path is unchanged, so a deployment that
   * has not run the waves-auth stack still works exactly as before.
   */
  auth: {
    get enabled(): boolean {
      return Boolean(read('GOTRUE_JWT_SECRET'));
    },
    /**
     * The SAME secret GoTrue signs with. That shared value is the entire trust
     * relationship between the two services: whoever holds it can mint a token
     * this server will believe.
     */
    jwtSecret: optional('GOTRUE_JWT_SECRET', ''),
    /** Where the browser reaches GoTrue. Same origin, so a path, not a host. */
    publicPath: optional('GOTRUE_PUBLIC_PATH', '/auth/v1'),
    /**
     * Who gets the stage. Account ids or email addresses, comma separated.
     * Emails are convenient before anyone has signed in; ids are what survives
     * Apple's private relay addresses.
     */
    hostAccounts: optional('HOST_ACCOUNTS', '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  },

  /**
   * The hosts' private messenger: Matrix logins, push-token registration and
   * the push gateway. Inert until MATRIX_JWT_SECRET is set, so this image still
   * deploys without the messenger stack.
   */
  messenger: {
    get enabled(): boolean {
      return Boolean(read('MATRIX_JWT_SECRET'));
    },
    /** Shared with tuwunel's [global.jwt] key; whoever holds it can log in as any host. */
    matrixJwtSecret: optional('MATRIX_JWT_SECRET', ''),
    matrixServerName: optional('MATRIX_SERVER_NAME', ''),
    matrixHomeserverUrl: optional('MATRIX_HOMESERVER_URL', ''),
    apns: {
      teamId: optional('APNS_TEAM_ID', ''),
      keyId: optional('APNS_KEY_ID', ''),
      /** PEM of the .p8 push key, normally via APNS_PRIVATE_KEY_FILE. */
      privateKey: optional('APNS_PRIVATE_KEY', ''),
      topic: optional('APNS_TOPIC', 'app.waves.messenger'),
      /** TestFlight and App Store builds register with the production service. */
      production: optionalBool('APNS_PRODUCTION', true),
    },
  },

  sessionTtlSeconds: optionalInt('SESSION_TTL_SECONDS', 30 * 24 * 60 * 60),

  /**
   * How long a host invite link stays valid. A show is set up in advance and
   * the host clicks the link on the night, so this is days, not minutes.
   */
  inviteTtlSeconds: optionalInt('INVITE_TTL_SECONDS', 14 * 24 * 60 * 60),

  /**
   * How long a HOST's device stays enrolled.
   *
   * A year, against 30 days for an audience session. A host's phone is a
   * personal device used daily; making them re-enroll monthly to run their own
   * show is the friction that sends people back to Instagram Live. Revocation
   * is what handles a lost phone, not expiry — see revokeAllSessions.
   */
  hostSessionTtlSeconds: optionalInt('HOST_SESSION_TTL_SECONDS', 365 * 24 * 60 * 60),

  /**
   * How long an enrollment LINK is good for. Short by design: it is sent once,
   * redeemed once, and a link that lingers in a chat history is a standing
   * grant to create rooms as that host.
   */
  enrollTtlSeconds: optionalInt('ENROLL_TTL_SECONDS', 7 * 24 * 60 * 60),

  /**
   * Which day it is, for the daily show.
   *
   * ONE zone decides the room id for everyone, wherever they are. It is not a
   * display preference — `show-YYYY-MM-DD` is the room two hosts have to land in
   * together, so the only thing that matters is that they agree.
   *
   * The zone must therefore be the one whose midnight is LATEST among the hosts,
   * or a show running past midnight for the person further east splits into two
   * rooms and neither sees the other. The hosts are in Lisbon and Stockholm, so
   * Europe/Lisbon is correct: at 00:10 Stockholm it is still 23:10 in Lisbon and
   * both resolve to the same room. Stockholm as the default would break exactly
   * that hour.
   *
   * Was Africa/Lagos, which is ahead of both and rolled over first — the worst of
   * the three. Nobody set it; it was a default from an earlier assumption about
   * where this show was made.
   */
  showTimeZone: optional('SHOW_TIMEZONE', 'Europe/Lisbon'),
} as const;

export type Config = typeof config;
