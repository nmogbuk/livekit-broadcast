/**
 * The host app.
 *
 * Two people run this show from their phones. Everything here exists so that
 * running it costs one tap and no credential: no operator key typed into a
 * phone, no console, nobody else in the loop.
 *
 * The model is device enrollment. A host opens a one-time link once, on the
 * phone they will use; that link elevates THAT device's session to their named
 * host identity for a year. After that, opening the app is the whole login. The
 * operator secret never leaves the server, which matters because a secret typed
 * into a phone ends up in a screenshot, a chat, or a shared password note.
 *
 * Revocation, not expiry, is what handles a lost phone —
 * `POST /api/host/signout-everywhere`.
 */

import type { FastifyInstance } from 'fastify';
import {
  HttpError,
  capabilitiesFor,
  issueSession,
  principalFor,
  requireCapability,
  requireOperator,
  revokeAllSessions,
  sendError,
  signEnrollment,
  verifyEnrollment,
} from '../auth/index.js';
import { config } from '../config.js';
import { upsert } from '../store.js';
import { setStageName } from '../accounts-profile.js';
import { ensureLivekitRoom, issueToken, newRoom } from '../rooms.js';
import { toPublicRoom } from '../types.js';

/**
 * Which day it is where the show happens.
 *
 * `en-CA` because it formats as YYYY-MM-DD, which sorts correctly and reads the
 * same everywhere. The zone is configurable and defaults to Africa/Lagos: a set
 * that starts at 00:30 in Lagos is tonight's show, and under UTC it would be
 * filed as yesterday's.
 */
export function showDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.showTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The room id for a given day. Stable, so both hosts tapping "go live" meet. */
export const showRoomId = (day: string): string => `show-${day}`;

function prettyDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(year!, month! - 1, date!)));
}

export async function hostRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Redeem an enrollment link.
   *
   * Elevates the CURRENT session rather than creating a parallel identity, the
   * same way the operator header does — so a host's actions stay attributable
   * to one subject across their whole history, before and after enrolling.
   */
  app.post('/api/host/enroll', async (request, reply) => {
    try {
      const token = (request.body as { token?: string } | undefined)?.token;
      if (!token) throw new HttpError(400, 'token is required');

      const claims = await verifyEnrollment(token);
      if (!claims) throw new HttpError(401, 'That enrollment link is not valid or has expired.');

      // The name must match a configured operator. Without this check a token
      // signed for a host who has since been removed would still work.
      const known = config.operators.some((operator) => operator.id === claims.host);
      if (!known) throw new HttpError(401, 'That host is no longer configured.');

      const principal = await principalFor(request, reply);
      const enrolled = {
        ...principal,
        name: principal.name || claims.name,
        operator: true,
        operatorId: claims.host,
      };
      await issueSession(reply, enrolled, config.hostSessionTtlSeconds);

      request.log.info({ host: claims.host, sub: enrolled.sub }, 'host device enrolled');
      return reply.send({ host: claims.host, name: enrolled.name });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Who am I? The app calls this on every launch to choose what to render. */
  /**
   * Set the name the audience sees.
   *
   * Needed because an account's name comes from Apple, and joining a room writes
   * principal.name into that room's profile — so signing in renamed a host
   * everywhere, including on shows that had already aired under a different
   * name. This stores a stage name against the account, which principalFor
   * prefers over the provider's.
   */
  app.post('/api/host/name', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      // Accounts only: an anonymous session's name already lives in its cookie
      // and is set through POST /api/session.
      if (!principal.account) {
        throw new HttpError(400, 'Sign in to set a stage name.');
      }
      const name = (request.body as { name?: unknown } | undefined)?.name;
      if (typeof name !== 'string') throw new HttpError(400, 'name is required');

      await setStageName(principal.sub, name);
      request.log.info({ sub: principal.sub }, 'stage name set');
      return reply.send({ name: name.trim().slice(0, 40) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/host/me', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      return reply.send({
        host: principal.operator,
        hostId: principal.operatorId ?? null,
        name: principal.name,
        sub: principal.sub,
        /*
         * Is this identity backed by an ACCOUNT, or by the legacy enrolled-device
         * cookie? Both report host: true, and that cookie is valid for a year, so
         * without this the client cannot tell that a signed-in host has quietly
         * become their old anonymous self again.
         */
        account: Boolean(principal.account),
        day: showDay(),
        roomId: showRoomId(showDay()),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Go live: today's room, created if it does not exist, joined either way.
   *
   * ONE endpoint rather than create-then-join, because the two hosts will tap
   * this within seconds of each other and a client-side "does it exist?" check
   * would race — both would try to create, and one would get a 409 in the face
   * on the way to their own show. Here the race is resolved server-side and
   * both callers get the same room.
   */
  app.post('/api/host/show', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      if (!principal.operator) throw new HttpError(403, 'Only hosts can start a show.');

      const body = (request.body as { name?: string } | undefined) ?? {};
      const day = showDay();
      const id = showRoomId(day);

      /*
       * Create-or-join in ONE locked step.
       *
       * The obvious shape — getRoom, then createRoom if absent, then add
       * myself — has a lost-update race that this product hits every single
       * day: both hosts tap "Go live" within seconds, both read "no room", both
       * write a fresh one, and the second write erases the first. The loser is
       * then not a moderator of the show they just started, with no error to
       * explain it. Measured, not hypothetical: it happened on the first test.
       */
      const { room, created } = await upsert(
        id,
        () =>
          newRoom({
            id,
            title: `Waves — ${prettyDay(day)}`,
            createdBy: principal.sub,
            ...(body.name ? { creatorName: body.name } : {}),
            // Video by default: this is the format these two run, and an audio
            // room would silently refuse their cameras.
            videoEnabled: true,
          }),
        (r) => {
          const add = (list: string[]) =>
            list.includes(principal.sub) ? list : [...list, principal.sub];
          return {
            ...r,
            // Every host is a moderator of the daily show, not just whoever
            // tapped first — otherwise the second to arrive is an audience
            // member in their own show, with no camera.
            moderators: add(r.moderators),
            speakers: add(r.speakers),
            presenters: add(r.presenters),
            ...(body.name
              ? { profiles: { ...r.profiles, [principal.sub]: { name: body.name } } }
              : {}),
          };
        },
      );

      // Outside the lock: idempotent, and a network round trip to the SFU has
      // no business holding a lock the other host is waiting on.
      await ensureLivekitRoom(room);
      const updated = room;


      const named = body.name ? { ...principal, name: body.name } : principal;
      const token = await issueToken(updated, named);

      request.log.info(
        { room: id, host: principal.operatorId, created },
        'host started show',
      );

      return reply.send({
        room: toPublicRoom(updated),
        url: config.livekit.publicUrl,
        token,
        capabilities: capabilitiesFor(named, updated),
        day,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Mint an enrollment link for a host. Operator-only, done once per phone.
   *
   * Returns the link and nothing else — deliberately not stored, so there is no
   * list of live enrollment links to leak. Re-minting is free.
   */
  app.post('/api/host/enrollment', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      requireOperator(principal);

      const body = (request.body as { host?: string; name?: string } | undefined) ?? {};
      const host = (body.host ?? '').trim();
      if (!host) throw new HttpError(400, 'host is required');
      if (!config.operators.some((operator) => operator.id === host)) {
        const known = config.operators.map((operator) => operator.id).join(', ');
        throw new HttpError(400, `Unknown host ${host}. Configured: ${known}`);
      }

      const token = await signEnrollment(
        { host, name: body.name ?? host },
        config.enrollTtlSeconds,
      );

      request.log.info({ host, by: principal.operatorId }, 'enrollment link minted');
      return reply.send({
        url: `${config.publicUrl}/host?enroll=${token}`,
        host,
        expiresInSeconds: config.enrollTtlSeconds,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Sign every one of this host's devices out.
   *
   * The answer to a lost phone. Enrollment is deliberately long-lived, so this
   * — not expiry — is what ends access; without it the only remedy would be
   * rotating the operator credential and re-enrolling everyone.
   */
  app.post('/api/host/signout-everywhere', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:create');
      await revokeAllSessions(principal.sub);
      request.log.info({ host: principal.operatorId }, 'host revoked all sessions');
      return reply.send({ ok: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
