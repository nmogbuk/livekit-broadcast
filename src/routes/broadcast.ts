/**
 * Show control: recording, HLS and live RTMP broadcast.
 *
 * The API is organised around a "show" rather than around individual egress
 * jobs, because that is what the underlying LiveKit call actually is — one
 * encode carrying several outputs. See livekit/egress.ts for why that matters
 * on a 4-core media host.
 *
 * Destination secrets: an RTMP URL contains the stream key, which is a bearer
 * credential for the channel. They go in on write and never come back out —
 * responses carry only a redacted preview.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { HttpError, principalFor, requireCapability, sendError } from '../auth/index.js';
import { getRoom, update } from '../store.js';
import {
  addDestination,
  defaultOrientation,
  listActiveEgress,
  removeDestination,
  startShow,
  stopEgress,
} from '../livekit/egress.js';
import { toPublicRoom, type Orientation, type Platform, type StreamDestination } from '../types.js';

const PLATFORMS: Platform[] = ['youtube', 'tiktok', 'custom'];

async function loadRoom(id: string) {
  const room = await getRoom(id);
  if (!room) throw new HttpError(404, `Room ${id} not found`);
  return room;
}

export async function broadcastRoutes(app: FastifyInstance): Promise<void> {
  /** Register an RTMP destination. */
  app.post('/api/rooms/:id/destinations', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:broadcast', room);

      const body = request.body as Record<string, unknown>;
      const platform = String(body.platform ?? 'custom') as Platform;
      if (!PLATFORMS.includes(platform)) {
        throw new HttpError(400, `platform must be one of ${PLATFORMS.join(', ')}`);
      }

      const url = String(body.url ?? '');
      if (!/^rtmps?:\/\/.+\/.+/.test(url)) {
        throw new HttpError(
          400,
          'url must be a full rtmp:// or rtmps:// ingest URL including the stream key',
        );
      }

      const destination: StreamDestination = {
        id: randomUUID(),
        platform,
        label: String(body.label ?? platform),
        url,
        orientation: (body.orientation as Orientation) ?? defaultOrientation(platform),
      };

      await update(id, (r) => ({ ...r, destinations: [...r.destinations, destination] }));

      // If a compatible egress is already streaming, attach live rather than
      // making the operator restart the show to pick up a new destination.
      const current = await loadRoom(id);
      const attached = await addDestination(current, destination);
      if (attached) {
        await update(id, (r) => ({
          ...r,
          egresses: r.egresses.map((e) => (e.egressId === attached.egressId ? attached : e)),
        }));
      }

      return reply.code(201).send({
        room: toPublicRoom(await loadRoom(id)),
        destinationId: destination.id,
        attachedToLiveShow: Boolean(attached),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Remove a destination.
   *
   * NOTE — send an empty JSON body (`{}`), not a body-less DELETE. Behind the
   * estate's Traefik, a body-less DELETE reaches Fastify framed as though it
   * carries a body but without a `Content-Type`, and is rejected 415
   * (FST_ERR_CTP_INVALID_MEDIA_TYPE) before this handler runs. Verified: the
   * same request succeeds when sent directly to the container, and succeeds
   * through Traefik with `content-type: application/json` and `{}`.
   */
  app.delete('/api/rooms/:id/destinations/:destinationId', async (request, reply) => {
    try {
      const { id, destinationId } = request.params as { id: string; destinationId: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:broadcast', room);

      const destination = room.destinations.find((d) => d.id === destinationId);
      if (!destination) throw new HttpError(404, 'Destination not found');

      const changed = await removeDestination(room, destination);
      const updated = await update(id, (r) => ({
        ...r,
        destinations: r.destinations.filter((d) => d.id !== destinationId),
        egresses: changed
          ? r.egresses.map((e) => (e.egressId === changed.egressId ? changed : e))
          : r.egresses,
      }));
      return reply.send({ room: toPublicRoom(updated) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Start the show.
   *
   * Body: { record?: boolean, hls?: boolean, destinationIds?: string[] }
   * Defaults to recording + HLS with every registered destination live.
   *
   * Rejects when a show is already running: starting a second egress to the
   * same RTMP URL makes both streams glitch, because the platform sees two
   * publishers on one key.
   */
  app.post('/api/rooms/:id/show/start', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:broadcast', room);

      if (room.egresses.length > 0) {
        throw new HttpError(409, 'A show is already running for this room');
      }

      const body = (request.body ?? {}) as {
        record?: boolean;
        hls?: boolean;
        destinationIds?: string[];
      };

      const destinations = body.destinationIds
        ? room.destinations.filter((d) => body.destinationIds!.includes(d.id))
        : room.destinations;

      const record = body.record ?? true;
      const hls = body.hls ?? true;

      if (!record && !hls && destinations.length === 0) {
        throw new HttpError(400, 'Nothing to do: enable record or hls, or register a destination');
      }

      const egresses = await startShow(room, { record, hls, destinations });
      const updated = await update(id, (r) => ({ ...r, egresses }));
      return reply.send({ room: toPublicRoom(updated), egresses });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Stop everything: archive, HLS and all RTMP output. */
  app.post('/api/rooms/:id/show/stop', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:broadcast', room);

      await Promise.all(room.egresses.map((e) => stopEgress(e.egressId)));
      const updated = await update(id, (r) => ({ ...r, egresses: [] }));
      return reply.send({ room: toPublicRoom(updated), stopped: room.egresses });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Go off air without ending the recording.
   *
   * Removes every RTMP URL from the running egresses via updateStream, so the
   * archive and HLS tier continue uninterrupted. This is the reason RTMP
   * destinations are not coupled to the egress lifecycle the way file outputs
   * are — a host can drop off YouTube mid-show and keep recording.
   */
  app.post('/api/rooms/:id/show/offair', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:broadcast', room);

      const live = room.destinations.filter((d) =>
        room.egresses.some((e) => e.destinationIds.includes(d.id)),
      );
      if (live.length === 0) throw new HttpError(409, 'This room is not on air');

      for (const destination of live) {
        const changed = await removeDestination(await loadRoom(id), destination);
        if (changed) {
          await update(id, (r) => ({
            ...r,
            egresses: r.egresses.map((e) => (e.egressId === changed.egressId ? changed : e)),
          }));
        }
      }
      return reply.send({ room: toPublicRoom(await loadRoom(id)) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Ground truth from LiveKit, not from stored state.
   *
   * Useful when the two disagree — an egress that died on its own leaves stale
   * entries in Redis, and this is how an operator sees that during a show.
   */
  app.get('/api/rooms/:id/egress', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const room = await loadRoom(id);
      const principal = await principalFor(request, reply);
      requireCapability(principal, 'room:broadcast', room);

      const active = await listActiveEgress(id);
      return reply.send({
        stored: room.egresses,
        live: active.map((e) => ({ egressId: e.egressId, status: e.status, error: e.error })),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
