/**
 * Telling people apart from machinery.
 *
 * `listParticipants` returns everything connected to a room, and a recording
 * show has an egress worker sitting in it: LiveKit's RoomComposite recorder
 * joins as a real participant. It is hidden and publishes nothing, which makes
 * it indistinguishable from an audience member by permissions alone — the
 * audience is hidden and publishes nothing too, by design.
 *
 * So the count of "who is listening" silently gained one the moment a host hit
 * record, and two on a dual-orientation show. A host reading the room off that
 * number is reading the recorder back to themselves.
 */

import { ParticipantInfo_Kind } from '@livekit/protocol';

/** Anything with an `identity` and a `kind`, which is every participant shape. */
interface KindedParticipant {
  kind?: ParticipantInfo_Kind;
}

/**
 * True for a human participant.
 *
 * Everything else — egress recorders, SIP callers, ingress feeds, agents — is
 * infrastructure that happens to hold a connection. Written as "is STANDARD"
 * rather than "is not EGRESS" deliberately: a new machine kind added upstream
 * should default to being excluded from the audience, not silently counted.
 */
export const isHuman = (participant: KindedParticipant): boolean =>
  (participant.kind ?? ParticipantInfo_Kind.STANDARD) === ParticipantInfo_Kind.STANDARD;

export const humansAmong = <T extends KindedParticipant>(participants: T[]): T[] =>
  participants.filter(isHuman);
