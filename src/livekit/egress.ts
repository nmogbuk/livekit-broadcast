/**
 * Recording, live RTMP broadcast, and the HLS audience tier.
 *
 * Built directly on LiveKit Egress.
 *
 * THE CENTRAL DESIGN DECISION — one egress, many outputs.
 *
 * LiveKit's `EncodedOutputs` accepts `file` + `segments` + `stream` in a single
 * RoomComposite request and encodes ONCE for all of them. A show that records to
 * MP4, serves an HLS tier, and streams to YouTube is therefore ONE egress at
 * 3.0 CPU, not three at 9.0.
 *
 * That is not a micro-optimisation on the media host (i7-7700, 4 cores / 8
 * threads): egress refuses jobs once its CPU budget is spent, so the difference
 * is whether the show runs at all.
 *
 * The cost is coupled lifecycles — stopping the archive stops the stream, since
 * they are one job. RTMP destinations escape that coupling via `updateStream`,
 * which adds and removes URLs on a *running* egress, so going live and off air
 * mid-show costs nothing extra. Orientation is the one thing that genuinely
 * forces a second egress: an encode has one resolution, so 9:16 TikTok cannot
 * ride along with 16:9 YouTube.
 */

import {
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptionsPreset,
  S3Upload,
  SegmentedFileOutput,
  SegmentedFileProtocol,
  StreamOutput,
  StreamProtocol,
  type EgressInfo,
  type EncodedOutputs,
} from 'livekit-server-sdk';
import { egressClient } from './client.js';
import { callRecordingKey } from './call-recording.js';
import { config } from '../config.js';
import type { Orientation, Room, ShowEgress, StreamDestination } from '../types.js';

/**
 * Layout of the composited output.
 *
 * LiveKit's built-in templates (grid / speaker / single-speaker) all assume
 * 16:9 sources. Given a phone in portrait, `speaker` letterboxed the feed into
 * a 16:9 box — a black bar down one side, the performer shrunk — and pushed
 * everyone else into a corner thumbnail. On a product whose performers are
 * mostly on phones, that renders the normal case as though it were a fault.
 *
 * So the composite is ours: web/src/egress/layout.ts, served from the control
 * plane. Every source keeps its own shape, and the space a portrait feed leaves
 * in a landscape frame is filled with a blurred copy of itself rather than
 * black — the convention every vertical-video platform arrived at.
 */
const SHOW_LAYOUT = 'waves';

/**
 * Where egress fetches that page.
 *
 * Egress appends `/{layout}` and the room's connection parameters, then
 * screen-captures the result. It must be reachable FROM THE MEDIA NODE over the
 * public internet — this is not a server-to-server API call the control plane
 * makes, it is a browser on another host loading a URL.
 */
function templateBaseUrl(): string {
  return `${config.publicUrl.replace(/\/$/, '')}/egress`;
}

/**
 * Vertical platforms need a 9:16 encode. A single egress produces a single
 * resolution, so a landscape and a portrait destination cannot share one.
 *
 * Resolved from config by name rather than hardcoded, because the preset is the
 * single biggest lever on CPU and the media host is CPU-bound at 4 cores. An
 * unknown name fails loudly at request time with the valid list, instead of
 * silently falling back to a preset nobody chose.
 */
function presetFor(orientation: Orientation): EncodingOptionsPreset {
  const name = config.encoding[orientation];
  const table = EncodingOptionsPreset as unknown as Record<string, number | undefined>;
  const preset = table[name];
  if (preset === undefined) {
    const valid = Object.keys(EncodingOptionsPreset).filter((k) => Number.isNaN(Number(k)));
    throw new Error(
      `Unknown encoding preset ${JSON.stringify(name)} for ${orientation}. Valid: ${valid.join(', ')}`,
    );
  }
  return preset as EncodingOptionsPreset;
}

/**
 * Raised when no egress worker picks up a job.
 *
 * Egress requests are dispatched over Redis to whichever worker is free. If
 * none is running — or all are saturated, which on a 4-core host happens at
 * roughly two concurrent video shows — LiveKit does not fail fast; it waits for
 * the RPC deadline and then times out. Surfacing that as a generic 500 tells a
 * host mid-show nothing.
 */
export class EgressUnavailableError extends Error {
  constructor(operation: string) {
    super(
      `No egress worker accepted the ${operation} request. ` +
        `Check that the egress container is running (docker service ps waves-media_egress) ` +
        `and that it shares the same Redis as the SFU. ` +
        `If another show is already recording, the host may be out of CPU budget.`,
    );
    this.name = 'EgressUnavailableError';
  }
}

async function withEgressErrors<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|aborted|deadline|no response|unavailable|resource|cpu/i.test(message)) {
      throw new EgressUnavailableError(operation);
    }
    throw error;
  }
}

/** Platform defaults. TikTok ingests vertical; YouTube is landscape by convention. */
export function defaultOrientation(platform: StreamDestination['platform']): Orientation {
  return platform === 'tiktok' ? 'portrait' : 'landscape';
}

function s3Upload(): S3Upload {
  const { s3 } = config.recording;
  return new S3Upload({
    accessKey: s3.accessKey,
    secret: s3.secret,
    region: s3.region,
    bucket: s3.bucket,
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    // MinIO and most S3-compatible stores address buckets path-style. Omitting
    // this against MinIO makes every upload fail to resolve the host.
    forcePathStyle: s3.forcePathStyle,
  });
}

/** Only the s3 backend carries an upload target; local writes to the mounted volume. */
function uploadTarget() {
  return config.recording.backend === 's3'
    ? { output: { case: 's3' as const, value: s3Upload() } }
    : {};
}

/**
 * `{room_name}` and `{time}` are substituted by the egress service, not here —
 * doing it locally would race, since the egress may not start at the instant
 * the request is made.
 */
function pathFor(kind: 'recordings' | 'hls', room: Room, suffix: string): string {
  const base = `${kind}/${room.id}/{room_name}-{time}${suffix}`;
  return config.recording.backend === 's3' ? base : `${config.recording.localPathPrefix}/${base}`;
}

/**
 * What LiveKit actually named the outputs.
 *
 * `pathFor` returns a TEMPLATE — `{room_name}` and `{time}` are placeholders
 * that LiveKit expands on its side. Storing the template as if it were a path
 * produced a playback URL with literal braces in it, which 404s: the object is
 * really at `.../vidtest-2026-08-22T224229/index.m3u8`.
 *
 * LiveKit resolves them when it accepts the request and reports the result on
 * the returned EgressInfo, so the real names are available immediately. Falls
 * back to the template rather than to nothing, so a future LiveKit that stops
 * populating these degrades to today's behaviour instead of losing the path.
 */
function resolvedPaths(info: EgressInfo, fallbackFile: string, fallbackPlaylist: string) {
  return {
    file: info.fileResults?.[0]?.filename || fallbackFile,
    playlist: info.segmentResults?.[0]?.playlistName || fallbackPlaylist,
  };
}

export interface ShowOutputs {
  /** Write an MP4 archive. */
  record?: boolean;
  /** Write HLS segments for the CDN-served audience tier. */
  hls?: boolean;
  /** RTMP destinations to go live on immediately. */
  destinations?: StreamDestination[];
}

/**
 * Start a show: one egress per orientation, carrying every requested output.
 *
 * Returns one ShowEgress per orientation actually needed — normally one, or two
 * when portrait destinations are involved. Recording and HLS ride on the
 * landscape encode only; there is no reason to archive the same show twice.
 */
export async function startShow(room: Room, outputs: ShowOutputs): Promise<ShowEgress[]> {
  const destinations = outputs.destinations ?? [];

  const byOrientation = new Map<Orientation, StreamDestination[]>();
  for (const destination of destinations) {
    const group = byOrientation.get(destination.orientation) ?? [];
    group.push(destination);
    byOrientation.set(destination.orientation, group);
  }

  // Recording and HLS always ride the landscape encode. If the show is
  // portrait-only, that encode still has to exist to carry them.
  const wantsCapture = Boolean(outputs.record || outputs.hls);
  if (wantsCapture && !byOrientation.has('landscape')) {
    byOrientation.set('landscape', []);
  }
  if (byOrientation.size === 0) {
    throw new Error('startShow called with no outputs and no destinations');
  }

  const started: ShowEgress[] = [];
  try {
    for (const [orientation, group] of byOrientation) {
      const isPrimary = orientation === 'landscape';
      const encoded: EncodedOutputs = {};
      const result: ShowEgress = {
        egressId: '',
        orientation,
        startedAt: new Date().toISOString(),
        destinationIds: group.map((d) => d.id),
      };

      // Templates. The real names come back on the EgressInfo below.
      let fileTemplate = '';
      let playlistTemplate = '';

      if (outputs.record && isPrimary) {
        fileTemplate = pathFor('recordings', room, '.mp4');
        encoded.file = new EncodedFileOutput({
          fileType: EncodedFileType.MP4,
          filepath: fileTemplate,
          ...uploadTarget(),
        });
      }

      if (outputs.hls && isPrimary) {
        const prefix = pathFor('hls', room, '/index');
        playlistTemplate = `${prefix}.m3u8`;
        encoded.segments = new SegmentedFileOutput({
          protocol: SegmentedFileProtocol.HLS_PROTOCOL,
          filenamePrefix: prefix,
          playlistName: playlistTemplate,
          segmentDuration: 4,
          ...uploadTarget(),
        });
      }

      if (group.length > 0) {
        encoded.stream = new StreamOutput({
          protocol: StreamProtocol.RTMP,
          urls: group.map((d) => d.url),
        });
      }

      if (Object.keys(encoded).length === 0) continue;

      const info = await withEgressErrors(`${orientation} show`, () =>
        egressClient.startRoomCompositeEgress(room.id, encoded, {
          // Layout is Chrome's job — it is what composites tiles into a frame.
          // Sending one for an audio-only room forces egress down the Chrome
          // path anyway, at 4.0 CPU. Omitting it lets egress take the SDK audio
          // path instead (1.0, no browser at all), which on a 4-core box is the
          // difference between one concurrent show and several.
          ...(room.videoEnabled
            ? { layout: SHOW_LAYOUT, customBaseUrl: templateBaseUrl() }
            : {}),
          encodingOptions: presetFor(orientation),
          audioOnly: !room.videoEnabled,
        }),
      );

      result.egressId = info.egressId;

      // Now that LiveKit has expanded {room_name}/{time}, record where the
      // outputs REALLY are — a playback URL with literal braces in it 404s.
      const paths = resolvedPaths(info, fileTemplate, playlistTemplate);
      if (outputs.record && isPrimary) result.recordingPath = paths.file;
      if (outputs.hls && isPrimary) {
        result.hlsPath = paths.playlist.replace(/\.m3u8$/, '');
        const base = config.recording.s3.publicBaseUrl;
        if (base) result.playbackUrl = `${base.replace(/\/$/, '')}/${paths.playlist}`;
      }

      started.push(result);
    }
  } catch (error) {
    /**
     * Roll back partial starts. If the portrait egress fails after the
     * landscape one is live, the show would already be pushing to YouTube while
     * the caller sees an error and stores nothing — an untracked, unstoppable
     * egress. Tearing down first keeps "start failed" meaning nothing runs.
     */
    await Promise.allSettled(started.map((e) => stopEgress(e.egressId)));
    throw error;
  }

  return started;
}

/**
 * Record a messenger call: one MP4 of both hosts, in the show layout.
 *
 * 720p rather than the show preset: a two-person call is watched back on a
 * laptop, and the lower encode leaves CPU for a show recording at the same time.
 * Returns the egress id.
 */
export async function startCallRecording(roomName: string): Promise<string> {
  const key = callRecordingKey(roomName);
  const filepath =
    config.recording.backend === 's3' ? key : `${config.recording.localPathPrefix}/${key}`;
  const info = await withEgressErrors('call recording', () =>
    egressClient.startRoomCompositeEgress(
      roomName,
      {
        file: new EncodedFileOutput({
          fileType: EncodedFileType.MP4,
          filepath,
          ...uploadTarget(),
        }),
      },
      {
        layout: SHOW_LAYOUT,
        customBaseUrl: templateBaseUrl(),
        encodingOptions: EncodingOptionsPreset.H264_720P_30,
      },
    ),
  );
  return info.egressId;
}

/**
 * Attach a destination to a running egress without interrupting it.
 *
 * Only possible on an egress that was started WITH a stream output — LiveKit
 * cannot add a stream to a file-only job. Returns null when there is no
 * compatible running egress, which is the caller's signal to start one.
 */
export async function addDestination(
  room: Room,
  destination: StreamDestination,
): Promise<ShowEgress | null> {
  const target = room.egresses.find(
    (e) => e.orientation === destination.orientation && e.destinationIds.length > 0,
  );
  if (!target) return null;

  await withEgressErrors('add destination', () =>
    egressClient.updateStream(target.egressId, [destination.url]),
  );
  return { ...target, destinationIds: [...target.destinationIds, destination.id] };
}

/** Drop a destination without stopping the rest of the fan-out. */
export async function removeDestination(
  room: Room,
  destination: StreamDestination,
): Promise<ShowEgress | null> {
  const target = room.egresses.find((e) => e.destinationIds.includes(destination.id));
  if (!target) return null;

  await withEgressErrors('remove destination', () =>
    egressClient.updateStream(target.egressId, undefined, [destination.url]),
  );
  return {
    ...target,
    destinationIds: target.destinationIds.filter((id) => id !== destination.id),
  };
}

/**
 * Stop an egress.
 *
 * Treats "already gone" as success: a stop racing with a crashed or
 * auto-terminated egress is the normal case at the end of a show, and throwing
 * would leave stored state pointing at an egress that no longer exists —
 * permanently un-stoppable.
 */
export async function stopEgress(egressId: string): Promise<void> {
  try {
    await egressClient.stopEgress(egressId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|does not exist|already/i.test(message)) return;
    throw error;
  }
}

/** Egresses LiveKit currently reports as active for a room. */
export async function listActiveEgress(roomId: string): Promise<EgressInfo[]> {
  return egressClient.listEgress({ roomName: roomId, active: true });
}
