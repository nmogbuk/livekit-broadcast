/**
 * Domain model for a Waves show.
 *
 * Written against LiveKit's documented API directly. This is an independent
 * implementation and shares no code with any AGPL-licensed alternative.
 *
 * The model is deliberately *role lists on the room* rather than a role field on
 * the participant. A show's cast is small and its audience is huge, so storing
 * "who is a speaker" (tens) is cheap while storing "who is audience" (tens of
 * thousands) is not. Anyone not named in a list is audience by default.
 */

export type Orientation = 'landscape' | 'portrait';

export type Platform = 'youtube' | 'tiktok' | 'custom';

export interface StreamDestination {
  id: string;
  platform: Platform;
  label: string;
  /**
   * Full RTMP ingest URL including the stream key.
   * SECRET — never returned by the API and never logged. See redactRtmpUrl().
   */
  url: string;
  /**
   * Vertical platforms need a 9:16 encode. One egress produces one resolution,
   * so destinations of differing orientation are split across separate egresses.
   */
  orientation: Orientation;
}

/**
 * One running egress, carrying every output that shares its encode.
 *
 * This models what LiveKit actually does. A single RoomComposite egress accepts
 * `file` + `segments` + `stream` outputs together (EncodedOutputs) and encodes
 * ONCE for all of them. Modelling recording, HLS and RTMP as three separate
 * egresses — as an earlier revision did — triples the cost of a show for no
 * benefit: LiveKit prices a video RoomComposite at 3.0 CPU each, so a show
 * recording + serving HLS + streaming to YouTube burned 9.0 CPU instead of 3.0.
 *
 * On the 4-core/8-thread media host that difference decides whether a show can
 * run at all, since egress refuses jobs once its CPU budget is exhausted.
 *
 * Orientation is still the one thing that genuinely forces a second egress: an
 * encode has a single resolution, so a 9:16 TikTok output cannot ride along
 * with a 16:9 YouTube one.
 */
export interface ShowEgress {
  egressId: string;
  orientation: Orientation;
  startedAt: string;
  /** MP4 archive path, when recording is part of this egress. */
  recordingPath?: string;
  /** HLS playlist prefix, when the audience tier is part of this egress. */
  hlsPath?: string;
  /** Public playlist URL, when a CDN base is configured. */
  playbackUrl?: string;
  /** RTMP destinations currently attached. May change live via updateStream. */
  destinationIds: string[];
}

export interface Room {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  /** Subject of the operator who created it. */
  createdBy: string;

  /*
   * ROLE LISTS HOLD SUBJECTS, NOT NAMES.
   *
   * These were display names until 2026-08-18, which meant anyone who typed
   * "host-ada" into a header became a moderator — able to eject the real host
   * and broadcast to their own channel. Subjects are server-assigned and
   * unforgeable; see auth/policy.ts.
   */

  /** Full control: promote/demote, start and stop broadcasts, close the room. */
  moderators: string[];
  /** On stage — may publish microphone. The comedians. */
  speakers: string[];
  /** May additionally publish camera and screen share. */
  presenters: string[];

  /**
   * Display names, keyed by subject. Purely for showing a human something
   * readable — a moderator's queue full of `anon_x7K…` is unusable. Never read
   * by any authorization decision.
   */
  profiles: Record<string, { name: string }>;

  /**
   * Bumped to revoke every outstanding invite link at once. The only
   * revocation that works for a capability URL that may have been forwarded.
   */
  inviteEpoch: number;

  /**
   * When true there is no audience tier: everyone who joins may speak.
   * Suitable for a writers' room or rehearsal, not for a show.
   */
  stageOnly: boolean;
  /** Allow camera publishing at all. An audio-only show leaves this false. */
  videoEnabled: boolean;
  /** Closed rooms reject new joins but do not evict those already inside. */
  closed: boolean;

  /** Subjects that asked to come on stage, in request order. */
  raisedHands: string[];

  /** Running egresses. Empty when the show is not being captured or streamed. */
  egresses: ShowEgress[];
  /** Destinations configured for this room, including secret URLs. */
  destinations: StreamDestination[];
}

/** True when any running egress is pushing to at least one RTMP destination. */
export function isOnAir(room: Room): boolean {
  return room.egresses.some((e) => e.destinationIds.length > 0);
}

/** True when any running egress is writing an MP4 archive. */
export function isRecording(room: Room): boolean {
  return room.egresses.some((e) => e.recordingPath !== undefined);
}

export interface Identity {
  id: string;
  name?: string;
  avatarUrl?: string;
}

/** Room as returned to clients — secrets stripped. */
export type PublicRoom = Omit<Room, 'destinations'> & {
  destinations: Array<Omit<StreamDestination, 'url'> & { urlPreview: string }>;
};

/** A display name for a subject, or a short stub if we have never seen one. */
export const displayName = (room: Room, sub: string): string =>
  room.profiles[sub]?.name || `guest-${sub.slice(-4)}`;

/**
 * An RTMP URL's final path segment is the stream key — a bearer credential that
 * lets anyone broadcast to the channel. Show only enough to tell destinations
 * apart in a UI.
 */
export function redactRtmpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const key = segments.at(-1) ?? '';
    const shown = key.length > 4 ? `${key.slice(0, 2)}…${key.slice(-2)}` : '…';
    return `${parsed.protocol}//${parsed.host}/…/${shown}`;
  } catch {
    return '(malformed url)';
  }
}

export function toPublicRoom(room: Room): PublicRoom {
  return {
    ...room,
    destinations: room.destinations.map(({ url, ...rest }) => ({
      ...rest,
      urlPreview: redactRtmpUrl(url),
    })),
  };
}
