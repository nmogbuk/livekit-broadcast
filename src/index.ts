import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { roomRoutes } from './routes/rooms.js';
import { sessionRoutes } from './routes/session.js';
import { hostRoutes } from './routes/host.js';
import { broadcastRoutes } from './routes/broadcast.js';
import { webhookRoutes } from './routes/webhooks.js';
import { recordingRoutes } from './routes/recordings.js';
import { messengerRoutes } from './routes/messenger.js';
import { apnsSenderFromConfig } from './messenger/apns.js';
import { matrixUserIdForAccessToken } from './messenger/matrix-identity.js';
import { redisPushTokenStore } from './messenger/push-tokens.js';
import { getStageName } from './accounts-profile.js';
import { redis } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Query-string parameters that carry a credential.
 *
 * The egress recorder is handed a room token IN THE URL — that is LiveKit's
 * design, not ours, and it is not negotiable from this side. Fastify logs
 * `req.url` verbatim on every request, so without this the JWT that grants
 * subscribe access to a live show is written to the service log, shipped
 * wherever those go, and kept for as long as they are.
 *
 * `redact` in the logger options cannot reach it: that operates on serialized
 * object paths, and this is a substring of one string.
 */
const SECRET_QUERY_PARAMS = ['token', 'access_token', 'jwt', 'invite', 'key', 'secret'];

/** A loggable URL: same shape, credentials replaced. */
function redactUrl(url: string): string {
  const split = url.indexOf('?');
  if (split === -1) return url;
  const query = new URLSearchParams(url.slice(split + 1));
  let touched = false;
  for (const name of SECRET_QUERY_PARAMS) {
    if (query.has(name)) {
      query.set(name, '[redacted]');
      touched = true;
    }
  }
  if (!touched) return url;
  // decodeURIComponent-free: URLSearchParams re-encodes, which is fine for a
  // log line and safer than hand-splicing the original string.
  return `${url.slice(0, split)}?${query.toString()}`;
}

const app = Fastify({
  logger: {
    level: config.logLevel,
    /**
     * Strip credentials from logs. An RTMP URL's last path segment is a stream
     * key, and Fastify logs request bodies on error — without this, a failed
     * destination registration would write a live YouTube key to disk.
     */
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-waves-admin-key"]',
        'req.headers["x-waves-operator-key"]',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.body.url',
        'body.url',
      ],
      censor: '[redacted]',
    },
    serializers: {
      /*
       * Overrides Fastify's default, which logs the raw URL. Same fields it
       * emits, with the query string cleaned — see redactUrl. Applies to every
       * route, so an invite link in a query string is covered too, not just the
       * egress token that prompted this.
       */
      req(request) {
        return {
          method: request.method,
          url: redactUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  },
  trustProxy: true,
  bodyLimit: 1024 * 512,
});

await app.register(cors, { origin: true, credentials: true });

/**
 * Sessions ride in a cookie, so the parser has to be registered before any
 * route reads one. Signing is done by us with jose (auth/tokens.ts) rather than
 * by the cookie plugin — the same token shape is then verifiable anywhere,
 * including from the app's own JS if it ever needs to.
 */
await app.register(cookie);

/**
 * Compress responses.
 *
 * The app bundle is ~545 KB raw and ~121 KB brotli — the LiveKit SDK is most of
 * it and cannot be shrunk away. This product's audience is on African mobile
 * networks where that 4x is paid for in both time and money, so compression is
 * a feature here, not a micro-optimisation.
 */
await app.register(compress, {
  global: true,
  encodings: ['br', 'gzip', 'deflate'],
  threshold: 1024,
});

await app.register(sessionRoutes);
await app.register(hostRoutes);
await app.register(roomRoutes);
await app.register(recordingRoutes);
await app.register(broadcastRoutes);
await app.register(webhookRoutes);
await app.register(messengerRoutes, {
  tokens: redisPushTokenStore(redis),
  apns: apnsSenderFromConfig(),
  matrixUserIdForAccessToken: (token) =>
    matrixUserIdForAccessToken(token, config.messenger.matrixHomeserverUrl),
  stageNameFor: (accountId) => getStageName(`user_${accountId}`),
});

app.get('/healthz', async () => {
  await redis.ping();
  return { ok: true };
});

const publicDir = join(here, '..', 'public');

await app.register(fastifyStatic, {
  root: publicDir,
  prefix: '/',
  /*
   * Serve dotfiles, for /.well-known/ only.
   *
   * @fastify/static ignores paths with a dot-prefixed segment by default, which
   * is the right instinct — it stops .git and .env from being fetched. But
   * /.well-known is the one place the web genuinely expects a dotted path, and
   * Apple will not verify a Sign in with Apple domain without reading
   * /.well-known/apple-developer-domain-association.txt from it.
   *
   * 'allow' rather than a bespoke route because the directory is a public
   * namespace by design and will hold more than one file over time. Nothing
   * sensitive is under public/ — it is the built client bundle.
   */
  dotfiles: 'allow',
  // The build fingerprints its filenames, so those are safe to cache hard.
  // Everything else stays revalidated: an operator should never be looking at
  // a stale console during a show.
  setHeaders(response, path) {
    if (/-[A-Z0-9]{8}\.(js|css)$/.test(path)) {
      response.setHeader('cache-control', 'public, max-age=31536000, immutable');
    } else {
      response.setHeader('cache-control', 'no-cache');
    }
  },
});

/**
 * The recorder's page.
 *
 * Egress requests customBaseUrl DIRECTLY with the layout as a query parameter —
 * `/egress?layout=waves&token=…&url=…` — not, as its docs imply, by appending
 * `/{layout}` to the path. Verified by reading the request it actually made.
 * Both shapes are served anyway, since that detail has moved between versions
 * and getting it wrong costs a whole show: Chrome records the 404 page, so the
 * result is a valid MP4 of nothing and you find out afterwards.
 *
 * THE SFU URL IS INJECTED HERE, and that is the load-bearing part.
 *
 * Egress passes `url=ws://127.0.0.1:7880` — correct from inside its own
 * container, but this page is served over HTTPS and a secure page may not open
 * an insecure WebSocket. Chrome blocks it, the room never connects, and egress
 * aborts with "Start signal not received". So the page is told the public wss://
 * address and prefers it whenever the loopback one cannot be used.
 */
async function serveRecorderPage(request: FastifyRequest, reply: FastifyReply) {
  /*
   * The layout only. NOT the whole query — it carries the room token, and a log
   * line is exactly the wrong place for a live credential. Kept at all because
   * the parameter names egress sends have moved between versions and this is
   * the only place their real shape is observable.
   */
  const { layout } = request.query as { layout?: string };
  request.log.info({ layout: layout ?? '(none)' }, 'egress template requested');
  const html = await readFile(join(publicDir, 'egress', 'waves.html'), 'utf8');
  return reply
    .type('text/html')
    .header('cache-control', 'no-cache')
    .send(
      html.replace(
        '</head>',
        `  <meta name="waves-sfu" content="${config.livekit.publicUrl}" />\n  </head>`,
      ),
    );
}

app.get('/egress', serveRecorderPage);
// Constrained to extensionless names: `callNotFound()` ends a request rather
// than handing back to static serving, so a check inside the handler would turn
// /egress/layout.js into a 404 and load the page with no script.
app.get('/egress/:layout(^[a-z0-9-]+$)', serveRecorderPage);

/**
 * Routes.
 *
 *   /            the product — the audience and stage app
 *   /r/<roomId>  a specific show; the shareable link people actually receive
 *   /operator    back-office show control (web sub-profile)
 *   /join.html   the minimal test client, served as a plain file
 *
 * `/r/*` is a client-rendered route, so every one of them returns the same
 * document and the app reads the id from the path. Without this a shared link
 * would 404 on first load and only work after an in-app navigation.
 */
const sendApp = (reply: import('fastify').FastifyReply) =>
  reply.type('text/html').sendFile('index.html', join(publicDir, 'app'));

app.get('/', async (_request, reply) => sendApp(reply));
app.get('/r/:roomId', async (_request, reply) => sendApp(reply));
/*
 * `/host` is the installed app's start_url — the two hosts' home screen. It is
 * a client route like /r/*, so it must return the app document rather than 404,
 * or the home-screen icon would open onto an error on every cold launch.
 */
app.get('/host', async (_request, reply) => sendApp(reply));

/*
 * `/join` — where a standing invite lands.
 *
 * It cannot be `/r/<room>` like a dated invite, because the whole point of a
 * rolling link is that it does not know its room until the moment it is
 * redeemed. The client redeems first and then rewrites the address to the room
 * the server resolved.
 */
app.get('/join', async (_request, reply) => sendApp(reply));
app.get('/operator', async (_request, reply) =>
  reply.type('text/html').sendFile('operator.html', publicDir));

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
