/**
 * The stage seam: Waves roles -> LiveKit grants.
 *
 * This is the security boundary of the whole product. A role here is not a UI
 * hint — LiveKit enforces `canPublishSources` at the SFU, so an audience member
 * who patches the client JavaScript still cannot publish audio. Everything that
 * decides "who is allowed to be heard" must live in this file and nowhere else.
 *
 * Independent implementation written against LiveKit's documented VideoGrant /
 * TrackSource API. No AGPL-licensed code is used here.
 */

import { TrackSource, type VideoGrant } from 'livekit-server-sdk';
import type { Room } from '../types.js';
import { can, roleOf, type Principal } from '../auth/policy.js';
import { config } from '../config.js';

/**
 * Which track sources each role may publish.
 *
 * Note the asymmetry between speaker and presenter: a comedian needs a
 * microphone, a host running a clip needs a screen. Granting screen share to
 * every speaker means any guest can put anything on the stream mid-show, which
 * is a moderation problem rather than a feature.
 */
export function publishableSources(room: Room, principal: Principal): TrackSource[] {
  const sources: TrackSource[] = [];

  // Derived from the same policy the HTTP API uses, so the SFU's enforcement and
  // the API's cannot drift apart. One definition of "may speak", two consumers.
  if (can(principal, 'room:speak', room)) sources.push(TrackSource.MICROPHONE);

  const mayPresent = can(principal, 'room:present', room);
  if (mayPresent && room.videoEnabled) sources.push(TrackSource.CAMERA);
  if (mayPresent) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);

  return sources;
}

export function grantsFor(room: Room, principal: Principal): VideoGrant {
  const role = roleOf(room, principal.sub);
  const sources = publishableSources(room, principal);
  const onStage = sources.length > 0;

  return {
    roomJoin: true,
    room: room.id,
    roomAdmin: can(principal, 'room:moderate', room),

    canSubscribe: true,
    canPublish: onStage,
    // Supersedes canPublish. An empty list would mean "publish nothing", so it
    // is only sent when the participant actually has something to publish.
    ...(onStage ? { canPublishSources: sources } : {}),

    // Data messages carry reactions and hand-raises, so the audience keeps this
    // even with no media rights. It is the one channel a listener can use.
    canPublishData: true,
    canUpdateOwnMetadata: true,

    /**
     * Hide the audience from other participants.
     *
     * Without this, every join broadcasts a participant_joined to everyone
     * already in the room: 10,000 listeners means ~10^8 signalling messages
     * over the course of a show, and each client holds 10,000 participant
     * objects. Hidden participants still receive media and still publish data
     * messages, so reactions keep working — they simply do not appear in anyone
     * else's roster. Moderators track real attendance via the server API, which
     * still sees hidden participants.
     */
    hidden: config.hideAudience && !onStage && role === 'audience',
  };
}

/**
 * Compare two grants on the fields that require LiveKit to be told about a
 * change. Metadata edits (a display-name change) do not affect permissions, so
 * they must not trigger a permission update — LiveKit renegotiates on
 * updateParticipant, and doing that on every keystroke would churn the room.
 */
export function grantsDiffer(a: VideoGrant, b: VideoGrant): boolean {
  const key = (g: VideoGrant) =>
    JSON.stringify([
      g.roomJoin ?? false,
      g.roomAdmin ?? false,
      g.canPublish ?? false,
      g.hidden ?? false,
      [...(g.canPublishSources ?? [])].sort(),
    ]);
  return key(a) !== key(b);
}
