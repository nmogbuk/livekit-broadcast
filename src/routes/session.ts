/**
 * Session and invite endpoints.
 *
 * The audience never signs up. A visitor gets a server-signed session on first
 * contact, picks a display name, and that is the whole of "authentication" for
 * someone who only wants to listen to a comedy show — asking for an account
 * first would cost far more than it protects.
 *
 * Power is handled separately, by capability links: a producer creates a show
 * and sends the host a URL that upgrades whoever opens it to moderator OF THAT
 * ROOM ONLY. Nobody needs an inbox, and the grant binds to the redeemer's
 * subject the moment it is used.
 */

import type { FastifyInstance } from 'fastify';
import {
  HttpError,
  capabilitiesFor,
  endSession,
  issueSession,
  principalFor,
  requireCapability,
  requireOperator,
  revokeAllSessions,
  sendError,
  signInvite,
  verifyInvite,
} from '../auth/index.js';
import { getRoom, update, standingEpoch, bumpStandingEpoch } from '../store.js';
import { showDay, showRoomId } from './host.js';
import { rememberName } from '../rooms.js';
import { config } from '../config.js';
import { toPublicRoom } from '../types.js';

/** Display names are shown to other people, so bound them and strip control chars. */
function cleanName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, 40);
  if (name.length < 2) throw new HttpError(400, 'Name must be at least 2 characters');
  return name;
}

async function loadRoom(id: string) {
  const room = await getRoom(id);
  if (!room) throw new HttpError(404, `Room ${id} not found`);
  return room;
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /** Who am I? Mints a session on first call, so the cookie is set by arrival. */
  app.get('/api/session', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      return reply.send({
        sub: principal.sub,
        name: principal.name,
        operator: principal.operator,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Choose a display name.
   *
   * Only the name changes — the subject is re-signed as-is. A caller cannot
   * pick, guess or reuse a subject, which is the whole point: naming yourself
   * "Ada Host" gets you the label and none of Ada's permissions.
   */
  app.post('/api/session', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      const name = cleanName((request.body as { name?: unknown } | undefined)?.name);
      const updated = { ...principal, name };
      await issueSession(reply, updated);
      return reply.send({ sub: updated.sub, name: updated.name, operator: updated.operator });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * End this session.
   *
   * Revokes the session id rather than only clearing the cookie: a cleared
   * cookie is a client-side courtesy, and a copy of the token taken beforehand
   * would still work. `?everywhere=1` revokes every session for the subject,
   * which is what someone reaching for "log out" after losing a phone means.
   */
  app.post('/api/session/logout', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      const everywhere = (request.query as { everywhere?: string })?.everywhere === '1';
      if (everywhere) await revokeAllSessions(principal.sub);
      await endSession(reply, principal);
      request.log.info({ sub: principal.sub, everywhere }, 'session ended');
      return reply.send({ ok: true, everywhere });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Mint an invite link for a room.
   *
   * A capability URL, with the properties that implies: anyone holding it can
   * redeem it until it expires. That is the right trade for "producer texts the
   * comedian a host link" — an inbox is one more thing to fail on show night —
   * but it is why invites are time-boxed and why the revoke endpoint exists.
   */
  app.post('/api/rooms/:id/invite', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:invite', room);

      const requested = (request.body as { role?: string } | undefined)?.role ?? 'speaker';
      if (requested !== 'moderator' && requested !== 'presenter' && requested !== 'speaker') {
        throw new HttpError(400, 'role must be moderator, presenter or speaker');
      }

      const token = await signInvite(
        { room: room.id, role: requested, epoch: room.inviteEpoch },
        config.inviteTtlSeconds,
      );

      request.log.info({ room: room.id, role: requested, by: principal.sub }, 'invite minted');

      return reply.send({
        url: `${config.publicUrl}/r/${room.id}?invite=${token}`,
        role: requested,
        expiresInSeconds: config.inviteTtlSeconds,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Invalidate every outstanding invite for a room at once. */
  app.post('/api/rooms/:id/invite/revoke', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:invite', room);

      const updated = await update(id, (r) => ({ ...r, inviteEpoch: r.inviteEpoch + 1 }));
      request.log.warn({ room: id, by: principal.sub }, 'invites revoked');
      return reply.send({ room: toPublicRoom(updated) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Redeem an invite: bind its role to the caller's session.
   *
   * After this the role lives in the room's list keyed by subject, so the link
   * is no longer what carries the permission — revoking invites afterwards does
   * not un-host someone who already redeemed, which is the behaviour a producer
   * expects.
   */
  /**
   * Mint a STANDING invite — one link that opens whichever show is running on
   * the day it is used.
   *
   * Host-only, and deliberately not room-scoped: there is no room to scope it
   * to. That is also the trade it makes. A dated invite stops working when its
   * show ends, which bounds the damage if it is forwarded; this one keeps
   * working, so it is a key to every future show until its TTL runs out or
   * someone revokes it. That is why the revoke endpoint below ships in the same
   * change rather than as a follow-up.
   */
  app.post('/api/invites/standing', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      requireOperator(principal);

      const requested = (request.body as { role?: string } | undefined)?.role ?? 'speaker';
      if (requested !== 'moderator' && requested !== 'presenter' && requested !== 'speaker') {
        throw new HttpError(400, 'role must be moderator, presenter or speaker');
      }

      const token = await signInvite(
        { room: '', role: requested, epoch: await standingEpoch(), rolling: true },
        config.inviteTtlSeconds,
      );

      request.log.info({ role: requested, by: principal.sub }, 'standing invite minted');

      return reply.send({
        url: `${config.publicUrl}/join?invite=${token}`,
        role: requested,
        expiresInSeconds: config.inviteTtlSeconds,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Revoke every standing invite ever issued.
   *
   * Anyone already admitted keeps their role — once redeemed it lives on the
   * room keyed by subject, exactly like a dated invite. This stops the LINKS.
   */
  app.post('/api/invites/standing/revoke', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      requireOperator(principal);
      const epoch = await bumpStandingEpoch();
      request.log.warn({ by: principal.sub, epoch }, 'standing invites revoked');
      return reply.send({ revoked: true, epoch });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/invite/redeem', async (request, reply) => {
    try {
      const token = (request.body as { token?: string } | undefined)?.token;
      if (!token) throw new HttpError(400, 'token is required');

      const claims = await verifyInvite(token);
      if (!claims) throw new HttpError(401, 'That invite link is not valid.');

      /*
       * A rolling invite names no room — it means "whichever show is running
       * today". Resolving here, at redeem time, is the whole point: one link
       * sent once keeps working every night, instead of pointing at a room id
       * that went stale at midnight.
       */
      const targetId = claims.rolling ? showRoomId(showDay()) : claims.room;

      const existing = await getRoom(targetId);
      if (!existing && claims.rolling) {
        // The link is fine; the show simply has not been opened yet. Say that,
        // rather than the 404 a guest reads as a broken link.
        throw new HttpError(409, "Tonight's show has not started yet. Try again shortly.");
      }
      const room = existing ?? (await loadRoom(targetId));

      if (claims.rolling) {
        const standing = await standingEpoch();
        if (claims.epoch !== standing) {
          throw new HttpError(401, 'That invite link has been revoked.');
        }
      } else if (claims.epoch !== room.inviteEpoch) {
        throw new HttpError(401, 'That invite link has been revoked.');
      }

      /*
       * A link to a PAST day's show.
       *
       * This used to succeed and drop the guest into an empty room from a
       * previous night: the app looked like it worked and nobody was there,
       * which is the hardest kind of failure for them to report. Only dated
       * daily rooms can hit this, so the check is narrow by construction.
       */
      const dated = /^show-(\d{4}-\d{2}-\d{2})$/.exec(room.id);
      if (!claims.rolling && dated && dated[1] !== showDay()) {
        throw new HttpError(
          410,
          `That link was for the show on ${dated[1]}, which has ended. ` +
            'Ask for a new link to tonight.',
        );
      }

      const principal = await principalFor(request, reply);

      const updated = await update(room.id, (r) => {
        const add = (list: string[]) =>
          list.includes(principal.sub) ? list : [...list, principal.sub];
        return {
          ...r,
          speakers: add(r.speakers),
          presenters:
            claims.role === 'presenter' || claims.role === 'moderator'
              ? add(r.presenters)
              : r.presenters,
          moderators: claims.role === 'moderator' ? add(r.moderators) : r.moderators,
        };
      });

      if (principal.name) await rememberName(room.id, principal.sub, principal.name);

      request.log.info({ room: room.id, role: claims.role, sub: principal.sub }, 'invite redeemed');

      return reply.send({
        room: toPublicRoom(updated),
        role: claims.role,
        capabilities: capabilitiesFor(principal, updated),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
