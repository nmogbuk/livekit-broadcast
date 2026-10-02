/**
 * LiveKit webhook receiver.
 *
 * This exists because stored state can silently drift from reality. An egress
 * can end without us asking: YouTube rejects the stream key, the egress
 * container is OOM-killed, a session limit is reached. When that happens our
 * Redis copy still lists a running broadcast, so the UI shows "LIVE" over a
 * dead stream and `broadcast/start` refuses with 409 — during a show, that
 * combination is the worst possible failure.
 *
 * The webhook is the correction: LiveKit tells us the egress ended, and we drop
 * it from the room. Treat it as the authority on egress lifecycle.
 */

import type { FastifyInstance } from 'fastify';
import { EgressStatus } from 'livekit-server-sdk';
import { roomService, webhookReceiver } from '../livekit/client.js';
import { hostAccountFromIdentity, syncCallRecording } from '../livekit/call-recording.js';
import { listActiveEgress, startCallRecording, stopEgress } from '../livekit/egress.js';
import { getRoom, redis, update } from '../store.js';

/** A call's recording is claimed for this long while it starts. */
const CALL_START_CLAIM_SECONDS = 60;

const callRecordingDeps = {
  participantIdentities: async (roomName: string) =>
    (await roomService.listParticipants(roomName)).map((p) => p.identity),
  activeEgressIds: async (roomName: string) =>
    (await listActiveEgress(roomName))
      .filter((e) => e.status !== EgressStatus.EGRESS_ENDING)
      .map((e) => e.egressId),
  claimStart: async (roomName: string) =>
    (await redis.set(
      `waves:call-recording:${roomName}`,
      '1',
      'EX',
      CALL_START_CLAIM_SECONDS,
      'NX',
    )) === 'OK',
  releaseStart: async (roomName: string) => {
    await redis.del(`waves:call-recording:${roomName}`);
  },
  start: startCallRecording,
  stop: stopEgress,
};

/** Statuses that mean "this egress is over" — successfully or otherwise. */
const TERMINAL = new Set<EgressStatus>([
  EgressStatus.EGRESS_COMPLETE,
  EgressStatus.EGRESS_FAILED,
  EgressStatus.EGRESS_ABORTED,
  EgressStatus.EGRESS_LIMIT_REACHED,
]);

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The signature covers the raw bytes, so this route opts out of JSON parsing.
   * Verifying a re-serialized body would fail on any key-order or whitespace
   * difference.
   */
  app.addContentTypeParser(
    'application/webhook+json',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  app.post('/api/livekit/webhook', async (request, reply) => {
    let event;
    try {
      const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      event = await webhookReceiver.receive(raw, request.headers.authorization);
    } catch (error) {
      // A failed signature check is either misconfiguration or someone probing.
      request.log.warn({ err: error }, 'rejected unverified LiveKit webhook');
      return reply.code(401).send({ error: 'Invalid webhook signature' });
    }

    try {
      if (event.event === 'egress_ended' || event.event === 'egress_updated') {
        const info = event.egressInfo;
        if (info && TERMINAL.has(info.status)) {
          const roomId = info.roomName;
          const room = roomId ? await getRoom(roomId) : null;

          if (room) {
            const wasTracked = room.egresses.some((e) => e.egressId === info.egressId);

            if (wasTracked) {
              if (info.status !== EgressStatus.EGRESS_COMPLETE) {
                // Surface it loudly — this is a show going off the air.
                request.log.error(
                  {
                    roomId,
                    egressId: info.egressId,
                    status: EgressStatus[info.status],
                    egressError: info.error,
                  },
                  'egress terminated unexpectedly',
                );
              }

              await update(roomId, (r) => ({
                ...r,
                egresses: r.egresses.filter((e) => e.egressId !== info.egressId),
              }));
            }
          }
        }
      }

      /**
       * Messenger calls record themselves. Only a host joining or leaving can
       * change what should be recording, so show traffic never gets this far.
       */
      if (
        (event.event === 'participant_joined' || event.event === 'participant_left') &&
        event.room?.name &&
        hostAccountFromIdentity(event.participant?.identity ?? '')
      ) {
        const outcome = await syncCallRecording(event.room.name, callRecordingDeps);
        if (outcome !== 'unchanged') {
          request.log.info({ room: event.room.name, outcome }, 'call recording');
        }
      }

      /**
       * A finished room cannot have running egresses. Clearing here stops a
       * room that ended abnormally from being un-startable next time.
       */
      if (event.event === 'room_finished' && event.room?.name) {
        const room = await getRoom(event.room.name);
        if (room && room.egresses.length > 0) {
          await update(event.room.name, (r) => ({ ...r, egresses: [] }));
        }
      }
    } catch (error) {
      // Never fail the webhook back to LiveKit — it retries, and a persistent
      // error here would turn one bad event into a retry storm.
      request.log.error({ err: error, event: event.event }, 'error handling webhook');
    }

    return reply.send({ ok: true });
  });
}
