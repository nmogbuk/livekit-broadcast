import type { FastifyInstance } from 'fastify';
import { principalFor, requireOperator, sendError } from '../auth/index.js';
import { listObjects, presignGet, recordingsConfigured } from '../recordings.js';

/**
 * How long a playback link stays good.
 *
 * Long enough to watch a two-hour show without the URL dying mid-scrub, short
 * enough that a link pasted into a chat is useless by tomorrow.
 */
const LINK_TTL_SECONDS = 6 * 60 * 60;

/**
 * The archive, as the two hosts see it.
 *
 * There is no record of past shows in Redis — `show/stop` sets `egresses: []`,
 * so the moment a show ends the control plane forgets it was ever recorded. The
 * bucket is the only history that exists, which is why this reads the store
 * directly instead of a table.
 */
export interface Take {
  key: string;
  /** Play in the browser. */
  url: string;
  /** Same object, but the browser saves it instead of playing it. */
  downloadUrl: string;
  startedAt: string;
  sizeBytes: number;
}

export interface RecordingDay {
  day: string;
  roomId: string;
  takes: Take[];
}

interface StoredObject {
  key: string;
  lastModified: string;
  size: number;
}

/**
 * `recordings/show-2026-08-28/show-2026-08-28-2026-08-28T175009.mp4`
 *          ^ room                                 ^ when egress started
 *
 * The timestamp in the NAME is when recording began; `lastModified` is when it
 * finished uploading. For a show that is the difference between "8pm" and
 * "10:15pm", so the name is the honest answer to "when was this".
 */
function startedAtFrom(key: string, fallback: string): string {
  const stamp = key.match(/(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})\.mp4$/);
  if (!stamp) return fallback;
  const [, date, hh, mm, ss] = stamp;
  return `${date}T${hh}:${mm}:${ss}Z`;
}

const dayOf = (isoOrKey: string): string => isoOrKey.slice(0, 10);

/**
 * Recordings grouped by the day they started, newest day and take first.
 *
 * Grouped first, signed second: the download filename depends on the take's
 * position within its day, which is not known until the whole day has been
 * collected and sorted. Signing during the walk numbered them in bucket order
 * and then re-sorted the list underneath the names.
 */
function groupByDay(objects: StoredObject[], fileStem: string): RecordingDay[] {
  const byDay = new Map<string, { day: string; roomId: string; raw: StoredObject[] }>();
  for (const object of objects) {
    const day = dayOf(startedAtFrom(object.key, object.lastModified));
    const entry = byDay.get(day) ?? { day, roomId: object.key.split('/')[1] ?? '', raw: [] };
    entry.raw.push(object);
    byDay.set(day, entry);
  }

  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .map(({ day, roomId, raw }) => {
      const ordered = [...raw].sort((a, b) =>
        startedAtFrom(a.key, a.lastModified) < startedAtFrom(b.key, b.lastModified) ? 1 : -1,
      );
      return {
        day,
        roomId,
        takes: ordered.map((object, index): Take => {
          // Newest first on screen, so part numbers count back down the list.
          const part = ordered.length - index;
          const name =
            ordered.length > 1 ? `${fileStem}-${day}-part-${part}.mp4` : `${fileStem}-${day}.mp4`;
          return {
            key: object.key,
            url: presignGet(object.key, LINK_TTL_SECONDS),
            downloadUrl: presignGet(object.key, LINK_TTL_SECONDS, name),
            startedAt: startedAtFrom(object.key, object.lastModified),
            sizeBytes: object.size,
          };
        }),
      };
    });
}

const mp4sUnder = async (prefix: string) =>
  (await listObjects(prefix)).filter((o) => o.key.endsWith('.mp4'));

export async function recordingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every recording, newest first.
   *
   * Host-only: `principal.operator` is the same gate that decides who may start
   * a show, so the people who made the recordings are exactly the people who can
   * list them. Audience sessions get a 401 here even though they can watch the
   * live HLS tier.
   */
  app.get('/api/recordings', async (request, reply) => {
    try {
      const principal = await principalFor(request, reply);
      requireOperator(principal);

      if (!recordingsConfigured()) {
        return reply.send({ days: [], calls: [], configured: false });
      }

      const [shows, calls] = await Promise.all([mp4sUnder('recordings/'), mp4sUnder('calls/')]);
      return reply.send({
        days: groupByDay(shows, 'waves'),
        // The hosts' messenger calls, recorded on the server (see livekit/call-recording.ts).
        calls: groupByDay(calls, 'waves-call'),
        configured: true,
        linkTtlSeconds: LINK_TTL_SECONDS,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
