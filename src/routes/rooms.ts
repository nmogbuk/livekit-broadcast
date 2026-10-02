/**
 * Room, token and stage endpoints.
 *
 * Every handler resolves a Principal first and then asks the policy module what
 * that principal may do. No handler reads a name to make a decision — see
 * auth/policy.ts for why that distinction is the whole security model.
 */

import type { FastifyInstance } from 'fastify';
import {
  HttpError,
  capabilitiesFor,
  principalFor,
  requireCapability,
  requireOperator,
  roleOf,
  sendError,
} from '../auth/index.js';
import { getRoom, listRooms, update } from '../store.js';
import { roomService } from '../livekit/client.js';
import { humansAmong } from '../livekit/participants.js';
import {
  addModerator,
  createRoom,
  demoteToAudience,
  issueToken,
  lowerHand,
  promoteToPresenter,
  promoteToSpeaker,
  raiseHand,
  rememberName,
  removeModerator,
  removeParticipant,
} from '../rooms.js';
import { config } from '../config.js';
import { showDay, showRoomId } from './host.js';
import { displayName, toPublicRoom } from '../types.js';

/** Room ids appear in URLs and become LiveKit room names — keep them boring. */
const ROOM_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

/**
 * Is this a daily show room from a previous day?
 *
 * Returned to the client so a stale link says so. A guest who bookmarks a room
 * URL — or who was sent a dated invite — otherwise lands in a real, empty room
 * from a past night and reads it as "nobody came", with nothing on screen to
 * suggest they are simply in the wrong place.
 */
function endedShowFor(id: string): string | null {
  const dated = /^show-(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (!dated) return null;
  const today = showDay();
  return dated[1] !== today ? showRoomId(today) : null;
}

async function loadRoom(id: string) {
  const room = await getRoom(id);
  if (!room) throw new HttpError(404, `Room ${id} not found`);
  return room;
}

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rooms', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      requireOperator(principal);
      const rooms = await listRooms();
      return reply.send({ rooms: rooms.map(toPublicRoom) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/rooms', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:create');

      const body = request.body as Record<string, unknown>;
      const id = String(body.id ?? '').toLowerCase();
      if (!ROOM_ID.test(id)) {
        throw new HttpError(
          400,
          'id must be 3-64 chars, lowercase letters, digits and hyphens, starting alphanumeric',
        );
      }
      if (await getRoom(id)) throw new HttpError(409, `Room ${id} already exists`);

      const room = await createRoom({
        id,
        title: String(body.title ?? id),
        ...(body.description ? { description: String(body.description) } : {}),
        // The creating operator becomes the first moderator, keyed on their
        // subject — so control of a show is bound to a session, not a name.
        createdBy: principal.sub,
        ...(principal.name ? { creatorName: principal.name } : {}),
        stageOnly: Boolean(body.stageOnly),
        videoEnabled: Boolean(body.videoEnabled),
      });
      request.log.info({ room: id, by: principal.sub }, 'room created');
      return reply.code(201).send({ room: toPublicRoom(room) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/rooms/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      const movedTo = endedShowFor(room.id);
      return reply.send({
        room: toPublicRoom(room),
        // What the CLIENT may render. Never what the server enforces — every
        // endpoint re-derives its own answer from the policy.
        capabilities: capabilitiesFor(principal, room),
        me: { sub: principal.sub, name: principal.name, role: roleOf(room, principal.sub) },
        ...(movedTo ? { endedShow: true, todayRoomId: movedTo } : {}),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Mint a join token.
   *
   * Anyone may ask — that is what makes a show joinable by an audience. The
   * GRANTS are what differ, and they come from the room role lists keyed by the
   * caller's subject, so asking under someone else's name changes nothing.
   */
  app.post('/api/rooms/:id/token', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      let room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:join', room);

      // Record the display name so moderators see something human in the queue.
      if (principal.name && room.profiles[principal.sub]?.name !== principal.name) {
        room = await rememberName(id, principal.sub, principal.name);
      }

      const token = await issueToken(room, principal);
      return reply.send({
        token,
        url: config.livekit.publicUrl,
        room: toPublicRoom(room),
        capabilities: capabilitiesFor(principal, room),
        me: { sub: principal.sub, name: principal.name, role: roleOf(room, principal.sub) },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Live presence: who is on stage, and how many are listening.
   *
   * The count cannot come from the client. Audience members hold `hidden: true`,
   * and the SFU deliberately excludes hidden participants from
   * `room.numParticipants` and never broadcasts their join — that is what keeps
   * a large room cheap. The server API still sees them, so this is the only
   * place a true audience number can be produced.
   */
  app.get('/api/rooms/:id/presence', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);

      let participants: Awaited<ReturnType<typeof roomService.listParticipants>> = [];
      try {
        // Humans only. A recording show has an egress worker connected as a
        // participant — hidden and publishing nothing, exactly like an audience
        // member — so without this the listener count goes up by one the moment
        // a host hits record, and the host reads the recorder as a viewer.
        participants = humansAmong(await roomService.listParticipants(id));
      } catch {
        // Room not yet created in LiveKit, or the SFU is briefly unreachable.
        // An empty stage is the honest answer; do not fail the page for it.
      }

      const onStage = participants
        .filter((p) => (p.permission?.canPublishSources?.length ?? 0) > 0)
        .map((p) => ({ sub: p.identity, name: p.name || displayName(room, p.identity) }));

      // Raised hands are subjects; a moderator needs names to act on them.
      const hands = room.raisedHands.map((sub) => ({ sub, name: displayName(room, sub) }));

      return reply.send({
        onStage,
        listening: Math.max(0, participants.length - onStage.length),
        total: participants.length,
        raisedHands: hands,
        live: room.egresses.some((e) => e.destinationIds.length > 0),
        recording: room.egresses.length > 0,
        capabilities: capabilitiesFor(principal, room),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/rooms/:id/hand', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:join', room);

      const raised = (request.body as { raised?: boolean } | undefined)?.raised ?? true;
      // Always your OWN hand: the subject comes from the session, never the body.
      const updated = raised
        ? await raiseHand(id, principal.sub)
        : await lowerHand(id, principal.sub);
      return reply.send({ room: toPublicRoom(updated) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Stage control. Every one of these needs room:moderate. */
  const stageActions = {
    'promote-speaker': promoteToSpeaker,
    'promote-presenter': promoteToPresenter,
    demote: demoteToAudience,
    'add-moderator': addModerator,
    'remove-moderator': removeModerator,
  } as const;

  app.post('/api/rooms/:id/stage/:action', async (request, reply) => {
    try {
      const { id, action } = request.params as { id: string; action: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:moderate', room);

      const handler = stageActions[action as keyof typeof stageActions];
      if (!handler) throw new HttpError(404, `Unknown stage action ${action}`);

      // The target is a SUBJECT. Accepting a display name here would reopen the
      // hole this whole layer exists to close, since names are not unique.
      const target = (request.body as { sub?: string } | undefined)?.sub;
      if (!target) throw new HttpError(400, 'sub is required');

      const updated = await handler(id, target);
      request.log.info({ room: id, action, target, by: principal.sub }, 'stage change');
      return reply.send({ room: toPublicRoom(updated) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Eject a participant.
   *
   * Demote first, then disconnect. The other order leaves a window in which the
   * ejected participant still holds a token granting publish rights and can
   * simply reconnect with a live microphone.
   */
  app.post('/api/rooms/:id/eject', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:moderate', room);

      const target = (request.body as { sub?: string } | undefined)?.sub;
      if (!target) throw new HttpError(400, 'sub is required');

      const updated = await demoteToAudience(id, target);
      await removeParticipant(id, target);
      request.log.warn({ room: id, target, by: principal.sub }, 'participant ejected');
      return reply.send({ room: toPublicRoom(updated) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/rooms/:id/close', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:moderate', room);

      const closed = (request.body as { closed?: boolean } | undefined)?.closed ?? true;
      const updated = await update(id, (r) => ({ ...r, closed }));
      return reply.send({ room: toPublicRoom(updated) });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
