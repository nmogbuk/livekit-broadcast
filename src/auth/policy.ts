/**
 * Authorization policy — the single place that decides who may do what.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: permissions key on a server-assigned
 * subject, never on a display name.
 *
 * The previous model stored `moderators: ['host-ada']`, where `host-ada` was a
 * name the client typed into a header. Anyone who typed it became a moderator
 * of that room — able to eject the actual host mid-show and start broadcasts to
 * their YouTube channel. Names are now labels only; every array below holds
 * subjects.
 */

import type { Room } from '../types.js';

export interface Principal {
  /** Server-assigned identity. The only thing authorization reads. */
  sub: string;
  /** This login, so it can be revoked on its own. Never an authorization input. */
  sid: string;
  /** For display. Deliberately absent from every decision in this file. */
  name: string;
  /** Holds a valid operator credential. */
  operator: boolean;
  /** WHICH operator, for attribution in logs. Not an authorization input. */
  operatorId?: string;
  /**
   * The signed-in account, when there is one. Present for display and logging;
   * authorization still reads `sub` and `operator` only, so an account changes
   * WHO you are rather than what the rules are.
   */
  account?: {
    id: string;
    email: string;
    emailVerified: boolean;
    provider: string;
    name: string;
  };
}

export type Capability =
  | 'room:create'
  | 'room:view'
  | 'room:join'
  | 'room:speak'
  | 'room:present'
  | 'room:moderate'
  | 'room:broadcast'
  | 'room:invite';

export type RoomRole = 'moderator' | 'presenter' | 'speaker' | 'audience';

export function roleOf(room: Room, sub: string): RoomRole {
  if (room.moderators.includes(sub)) return 'moderator';
  if (room.presenters.includes(sub)) return 'presenter';
  if (room.speakers.includes(sub)) return 'speaker';
  return 'audience';
}

/**
 * Can this principal do this, in this room?
 *
 * Operators pass everything by design — they are the platform's break-glass and
 * their credential is held server-side, not typed by a visitor. Every operator
 * action is attributed to their subject in the logs.
 */
export function can(principal: Principal, capability: Capability, room?: Room): boolean {
  if (capability === 'room:create') return principal.operator;

  if (!room) return false;

  const role = roleOf(room, principal.sub);

  /*
   * The operator bypass covers CONTROL, not STAGE.
   *
   * An operator can moderate, broadcast and invite anywhere — that is the job.
   * But being *heard* is not a control action, and letting the operator flag
   * silently confer a microphone would be both surprising and inconsistent:
   * grants are recomputed for connected participants on every role change, and
   * that recomputation cannot see who holds the operator credential. The
   * operator would gain a microphone at join and lose it at the next promotion.
   *
   * So an operator who wants to speak promotes themselves, which is one click
   * and leaves a trace in the room's role list.
   */
  const controlCapability =
    capability === 'room:moderate' ||
    capability === 'room:broadcast' ||
    capability === 'room:invite' ||
    capability === 'room:view' ||
    capability === 'room:join';
  if (principal.operator && controlCapability) return true;

  switch (capability) {
    case 'room:view':
      return true;

    case 'room:join':
      // A closed room still admits its own moderators, so a host can reopen or
      // wrap up a show they closed.
      return !room.closed || role === 'moderator';

    case 'room:speak':
      // stageOnly rooms have no audience tier — a rehearsal, not a show.
      return role !== 'audience' || room.stageOnly;

    case 'room:present':
      return role === 'presenter' || role === 'moderator';

    case 'room:moderate':
    case 'room:broadcast':
    case 'room:invite':
      return role === 'moderator';

    default:
      return false;
  }
}

/** The capability set a client may render from. Never trusted for enforcement. */
export function capabilitiesFor(principal: Principal, room: Room): Capability[] {
  const all: Capability[] = [
    'room:view', 'room:join', 'room:speak', 'room:present',
    'room:moderate', 'room:broadcast', 'room:invite',
  ];
  return all.filter((capability) => can(principal, capability, room));
}
