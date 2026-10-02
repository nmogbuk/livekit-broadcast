/**
 * Room persistence.
 *
 * Redis is already required by LiveKit and Egress (it is their coordination
 * bus), so reusing it here avoids introducing a second datastore for what is a
 * small amount of state. Rooms are stored as whole JSON documents because every
 * read wants the entire room and shows are low-write.
 *
 * Mutations go through `update()`, which holds a short lock. Two moderators
 * promoting different guests at the same moment would otherwise read the same
 * room, each append one speaker, and the second write would silently discard
 * the first.
 */

import { Redis } from 'ioredis';
import { config } from './config.js';
import type { Room } from './types.js';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

const roomKey = (id: string) => `waves:room:${id}`;
const lockKey = (id: string) => `waves:lock:room:${id}`;
const ROOM_INDEX = 'waves:rooms';

/**
 * Bring a stored room up to the current shape.
 *
 * Rooms written before 2026-08-18 key their role lists on DISPLAY NAMES, which
 * is exactly the vulnerability the auth layer removed: anyone who typed
 * `host-ada` inherited that room's moderator rights.
 *
 * Those entries are DROPPED rather than migrated, because there is no honest
 * mapping from a name nobody proved to a subject. The room is left with no
 * moderator, which is safe and recoverable — an operator can still moderate it
 * and issue a fresh host link. Silently keeping them would carry the hole
 * forward into a release whose entire purpose is closing it.
 *
 * `user_` is a subject too.
 *
 * This test was written when `anon_` was the only kind there was, so when
 * accounts arrived it silently deleted every account subject on read: a signed-in
 * host could be written into a moderator list, and the very next read would drop
 * them and report them as audience. The filter is a guard against LEGACY DISPLAY
 * NAMES, not an allowlist of one prefix — so it names the prefixes a subject may
 * have, and any future one has to be added here.
 */
const SUBJECT_PREFIXES = ['anon_', 'user_'] as const;

function normalize(room: Room): Room {
  const isSubject = (value: string) =>
    SUBJECT_PREFIXES.some((prefix) => value.startsWith(prefix));
  const legacy =
    [...room.moderators, ...room.speakers, ...room.presenters].some((v) => !isSubject(v));

  return {
    ...room,
    moderators: room.moderators.filter(isSubject),
    speakers: room.speakers.filter(isSubject),
    presenters: room.presenters.filter(isSubject),
    raisedHands: (room.raisedHands ?? []).filter(isSubject),
    profiles: room.profiles ?? {},
    // Bump past any epoch a pre-migration invite could have carried.
    inviteEpoch: room.inviteEpoch ?? (legacy ? 2 : 1),
  };
}

export async function getRoom(id: string): Promise<Room | null> {
  const raw = await redis.get(roomKey(id));
  return raw ? normalize(JSON.parse(raw) as Room) : null;
}

export async function putRoom(room: Room): Promise<void> {
  await redis
    .multi()
    .set(roomKey(room.id), JSON.stringify(room))
    .sadd(ROOM_INDEX, room.id)
    .exec();
}

export async function deleteRoom(id: string): Promise<void> {
  await redis.multi().del(roomKey(id)).srem(ROOM_INDEX, id).exec();
}

export async function listRooms(): Promise<Room[]> {
  const ids = await redis.smembers(ROOM_INDEX);
  if (ids.length === 0) return [];
  const raws = await redis.mget(ids.map(roomKey));
  return raws.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as Room);
}

export class RoomNotFoundError extends Error {
  constructor(id: string) {
    super(`Room ${id} not found`);
    this.name = 'RoomNotFoundError';
  }
}

const LOCK_TTL_MS = 5000;
const LOCK_RETRY_MS = 40;
const LOCK_MAX_WAIT_MS = 3000;

/**
 * Read-modify-write under a lock.
 *
 * The lock carries a random token and is released with a compare-and-delete, so
 * a slow request whose lock has already expired cannot delete the lock a
 * *different* request now holds. The TTL guarantees a crashed holder frees it.
 */
/**
 * Create-or-join, atomically.
 *
 * `update` locks a room that already exists; this locks the DECISION of whether
 * it exists. Without that the daily-show flow had a lost-update race: two hosts
 * tapping "Go live" together both read "no room", both built a fresh one, and
 * the second `putRoom` overwrote the first — so whoever lost was silently not a
 * moderator of the show they had just started.
 *
 * `create` runs only when the room is genuinely absent, and `mutate` runs
 * either way, so the caller can add themselves to the role lists in the same
 * critical section that decided the room's existence.
 */
export async function upsert(
  id: string,
  create: () => Room,
  mutate: (room: Room) => Room,
): Promise<{ room: Room; created: boolean }> {
  return withRoomLock(id, async () => {
    const current = await getRoom(id);
    const base = current ?? create();
    const next = mutate(structuredClone(base));
    await putRoom(next);
    return { room: next, created: !current };
  });
}

/** Hold the per-room lock for the duration of `work`. */
async function withRoomLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  while (true) {
    const acquired = await redis.set(lockKey(id), token, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired) break;
    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring lock for room ${id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }

  try {
    return await work();
  } finally {
    // Compare-and-delete: only release the lock if we still hold it.
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      lockKey(id),
      token,
    );
  }
}

export async function update(id: string, mutate: (room: Room) => Room | Promise<Room>): Promise<Room> {
  return withRoomLock(id, async () => {
    const current = await getRoom(id);
    if (!current) throw new RoomNotFoundError(id);
    const next = await mutate(structuredClone(current));
    await putRoom(next);
    return next;
  });
}


/**
 * Revocation for links that outlive their room.
 *
 * A per-room `inviteEpoch` cannot revoke a rolling invite: the room it opens
 * does not exist yet, and tomorrow it will be a different one. So rolling
 * invites carry this standing counter instead, and bumping it invalidates every
 * outstanding rolling link at once — the same guarantee, one level up.
 */
const STANDING_EPOCH = 'waves:invite-epoch:standing';

export async function standingEpoch(): Promise<number> {
  const value = await redis.get(STANDING_EPOCH);
  // Absent means nothing has ever been revoked, which is epoch 1 — not 0, so a
  // token minted before this key existed still matches.
  return value ? Number(value) : 1;
}

/** Invalidates every rolling invite ever issued. Returns the new epoch. */
export async function bumpStandingEpoch(): Promise<number> {
  const next = await redis.incr(STANDING_EPOCH);
  // INCR on a missing key yields 1, which is the epoch already in use. Step once
  // more so a revoke always actually revokes.
  return next === 1 ? await redis.incr(STANDING_EPOCH) : next;
}
