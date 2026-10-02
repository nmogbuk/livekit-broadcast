/**
 * Room lifecycle and stage control.
 *
 * The invariant this module exists to hold: LiveKit is the enforcement point,
 * so any change to a room's role lists must be pushed to LiveKit for
 * participants who are *already connected*. Storing "alice is now a speaker" in
 * Redis without calling updateParticipant leaves alice holding a token that
 * still says audience — she would have to leave and rejoin to get a microphone,
 * which on stage is a visible failure.
 */

import { AccessToken } from 'livekit-server-sdk';
import { HttpError } from './auth/principal.js';
import type { Principal } from './auth/policy.js';
import { roomService, withSfu } from './livekit/client.js';
import { humansAmong } from './livekit/participants.js';
import { grantsDiffer, grantsFor } from './livekit/grants.js';
import { getRoom, putRoom, update } from './store.js';
import { config } from './config.js';
import { displayName, type Room } from './types.js';

export interface CreateRoomInput {
  id: string;
  title: string;
  description?: string;
  /** Subject of the creating operator — they become its first moderator. */
  createdBy: string;
  creatorName?: string;
  stageOnly?: boolean;
  videoEnabled?: boolean;
}

/**
 * Make sure the room exists in LiveKit, idempotently.
 *
 * LiveKit reaps an empty room after `empty_timeout` (10 minutes) and the SFU is
 * configured with `auto_create: false`, so a room created ahead of time is GONE
 * by the time the audience arrives — the signal connection 404s with "requested
 * room does not exist" and nobody can join.
 *
 * That is precisely the shape of this product: a show is created in advance and
 * the doors open later. So the room is (re)asserted every time a token is
 * minted, not only when it is first created. `auto_create` stays off, which is
 * what keeps a stranger with a token from conjuring a room the control plane
 * has never heard of.
 */
export async function ensureLivekitRoom(room: Room): Promise<void> {
  await withSfu('prepare the room', () =>
    roomService.createRoom({
      name: room.id,
      metadata: JSON.stringify({ title: room.title }),
      emptyTimeout: 60 * 10,
      departureTimeout: 60,
    }),
  );
}

/**
 * The shape of a new room, with nothing persisted and nothing called.
 *
 * Split out of createRoom so a caller that needs create-or-join ATOMICALLY (the
 * daily show: two hosts tapping "Go live" at once) can build the room inside
 * the store's lock instead of racing a read against a write.
 */
export function newRoom(input: CreateRoomInput): Room {
  return {
    id: input.id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
    moderators: [input.createdBy],
    speakers: [],
    presenters: [],
    profiles: input.creatorName ? { [input.createdBy]: { name: input.creatorName } } : {},
    inviteEpoch: 1,
    stageOnly: input.stageOnly ?? false,
    videoEnabled: input.videoEnabled ?? false,
    closed: false,
    raisedHands: [],
    egresses: [],
    destinations: [],
  };
}

export async function createRoom(input: CreateRoomInput): Promise<Room> {
  const room = newRoom(input);

  /**
   * LiveKit first, Redis second — the order is load-bearing.
   *
   * Persisting to Redis first means an unreachable SFU leaves a room that
   * exists in our store but not in LiveKit. The caller sees a 500, retries, and
   * gets 409 "already exists": the room id is permanently poisoned, neither
   * usable nor re-creatable. Reversing it makes the failure clean — nothing is
   * stored, so a retry simply works.
   *
   * The opposite orphan (a LiveKit room with no Redis entry, if putRoom fails)
   * is benign: empty_timeout reaps it within ten minutes.
   *
   * Created eagerly rather than relying on auto-create so metadata and timeouts
   * are in place before the first participant arrives. livekit.yaml also sets
   * auto_create:false, so a room that skipped this path would not exist at all.
   */
  await ensureLivekitRoom(room);

  await putRoom(room);

  return room;
}

export async function issueToken(room: Room, principal: Principal): Promise<string> {
  // Re-assert the room before handing out a key to it — see ensureLivekitRoom.
  await ensureLivekitRoom(room);

  const token = new AccessToken(config.livekit.key, config.livekit.secret, {
    /*
     * The LiveKit identity IS our subject, not the display name. That is what
     * makes the SFU's own participant list authoritative: two people can call
     * themselves "Ada" and remain distinct participants, and a promotion lands
     * on exactly one of them.
     */
    identity: principal.sub,
    name: displayName(room, principal.sub),
    ttl: config.tokenTtlSeconds,
  });
  token.addGrant(grantsFor(room, principal));
  return token.toJwt();
}

/** Remember a display name for a subject, so moderators see something human. */
export function rememberName(roomId: string, sub: string, name: string): Promise<Room> {
  return update(roomId, (room) => ({
    ...room,
    profiles: { ...room.profiles, [sub]: { name } },
  }));
}

/**
 * Push role changes to everyone already connected.
 *
 * Only participants whose effective grants actually changed are updated —
 * updateParticipant forces a renegotiation, so blanket-updating a room with a
 * large audience on every promotion would be self-inflicted load.
 */
async function reconcileParticipants(before: Room, after: Room): Promise<void> {
  /*
   * Humans only. An egress recorder is a participant too, and pushing a
   * permission update to it forces a renegotiation on the job that is recording
   * the show — a risk taken for nothing, since a recorder has no grants to
   * reconcile.
   */
  const participants = humansAmong(await roomService.listParticipants(after.id));

  await Promise.all(
    participants.map(async (participant) => {
      // Rebuilt from the subject alone. `operator: false` is correct and
      // deliberate — the operator bypass covers control, never the stage, so a
      // reconcile can never quietly hand someone a microphone.
      const principal: Principal = {
        sub: participant.identity,
        // No session behind this one — it is reconstructed from the SFU's view
        // to recompute grants, not to authorize a request.
        sid: '',
        name: '',
        operator: false,
      };
      const oldGrants = grantsFor(before, principal);
      const newGrants = grantsFor(after, principal);
      if (!grantsDiffer(oldGrants, newGrants)) return;

      await roomService.updateParticipant(
        after.id,
        participant.identity,
        undefined,
        newGrants,
      );
    }),
  );
}

/** Apply a role-list mutation and reconcile connected participants. */
async function mutateRoles(roomId: string, mutate: (room: Room) => Room): Promise<Room> {
  const before = await getRoom(roomId);
  const after = await update(roomId, mutate);
  if (before) await reconcileParticipants(before, after);
  return after;
}

const without = (list: string[], id: string) => list.filter((entry) => entry !== id);
const withUnique = (list: string[], id: string) => (list.includes(id) ? list : [...list, id]);

export function promoteToSpeaker(roomId: string, identityId: string): Promise<Room> {
  return mutateRoles(roomId, (room) => ({
    ...room,
    speakers: withUnique(room.speakers, identityId),
    raisedHands: without(room.raisedHands, identityId),
  }));
}

export function promoteToPresenter(roomId: string, identityId: string): Promise<Room> {
  return mutateRoles(roomId, (room) => ({
    ...room,
    speakers: withUnique(room.speakers, identityId),
    presenters: withUnique(room.presenters, identityId),
    raisedHands: without(room.raisedHands, identityId),
  }));
}

export function demoteToAudience(roomId: string, identityId: string): Promise<Room> {
  return mutateRoles(roomId, (room) => ({
    ...room,
    speakers: without(room.speakers, identityId),
    presenters: without(room.presenters, identityId),
  }));
}

export function addModerator(roomId: string, identityId: string): Promise<Room> {
  return mutateRoles(roomId, (room) => ({
    ...room,
    moderators: withUnique(room.moderators, identityId),
  }));
}

/**
 * Remove a moderator, refusing to remove the last one.
 *
 * A room with no moderators cannot be moderated back into a good state by
 * anyone — the promotion endpoints all require moderator rights — so it would
 * be permanently stuck. Cheaper to reject the call than to build a recovery path.
 */
export function removeModerator(roomId: string, identityId: string): Promise<Room> {
  return mutateRoles(roomId, (room) => {
    const remaining = without(room.moderators, identityId);
    if (remaining.length === 0) {
      // 409, not 500: the request is well-formed and the caller is authorized,
      // but it conflicts with the room's state. Returning 500 here would also
      // hide the reason behind a generic "Internal server error".
      throw new HttpError(409, 'Cannot remove the last moderator from a room');
    }
    return { ...room, moderators: remaining };
  });
}

export function raiseHand(roomId: string, identityId: string): Promise<Room> {
  return update(roomId, (room) => ({
    ...room,
    raisedHands: withUnique(room.raisedHands, identityId),
  }));
}

export function lowerHand(roomId: string, identityId: string): Promise<Room> {
  return update(roomId, (room) => ({
    ...room,
    raisedHands: without(room.raisedHands, identityId),
  }));
}

/** Forcibly disconnect a participant. The token stays valid, so also demote. */
export async function removeParticipant(roomId: string, identityId: string): Promise<void> {
  await roomService.removeParticipant(roomId, identityId);
}
