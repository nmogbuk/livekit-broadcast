/**
 * Recording the hosts' messenger calls.
 *
 * Calls are LiveKit rooms that lk-jwt-service creates for a Matrix
 * conversation, not shows, so nobody presses record: a call is recorded from
 * the moment both hosts are in it until the last one leaves. The owner chose
 * server-side recording for these calls (.maestro/handoffs/_blockers.md); the
 * Mac app joins them without end-to-end encryption because egress cannot
 * decrypt encrypted media.
 */

import { config } from '../config.js';

/**
 * The host account behind a LiveKit identity, or null.
 *
 * lk-jwt-service names a caller `<matrix user id>:<device id>`, and a host's
 * Matrix user is `@<account id>:<server name>`. Show participants (`user_…`,
 * `anon_…`) and the egress recorder never match, and neither does a Matrix
 * account that is not on the host list.
 */
export function hostAccountFromIdentity(identity: string): string | null {
  const serverName = config.messenger.matrixServerName;
  if (!serverName) return null;
  const match = /^@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+):[^:]+$/i.exec(
    identity,
  );
  if (!match || match[2] !== serverName) return null;
  const accountId = match[1]!.toLowerCase();
  return config.auth.hostAccounts.some((entry) => entry.toLowerCase() === accountId)
    ? accountId
    : null;
}

/**
 * Object key for a call recording. `{time}` is expanded by egress.
 *
 * The room name is lk-jwt-service's base64 hash of the Matrix room, whose `/`
 * and `+` would otherwise split or garble the path.
 */
export const callRecordingKey = (roomName: string): string =>
  `calls/${roomName.replace(/[^A-Za-z0-9_-]/g, '_')}/call-{time}.mp4`;

export interface CallRecordingDeps {
  participantIdentities(roomName: string): Promise<string[]>;
  /**
   * Recordings starting or running. One already ending does not count, so a
   * call redialled while the last one's file is still being written is
   * recorded too.
   */
  activeEgressIds(roomName: string): Promise<string[]>;
  /** Claims the right to start a recording for a while; false if already claimed. */
  claimStart(roomName: string): Promise<boolean>;
  releaseStart(roomName: string): Promise<void>;
  start(roomName: string): Promise<string>;
  stop(egressId: string): Promise<void>;
}

export type CallRecordingOutcome = 'started' | 'stopped' | 'unchanged';

/**
 * Brings a call room's recording in line with who is in it.
 *
 * Called on every host joining or leaving. Two hosts present and nothing
 * recording starts one; no hosts left stops it. One host present changes
 * nothing, so a host dropping out for a moment does not split the recording.
 * The claim stops two webhooks arriving together from starting two egresses
 * before either shows up as active.
 */
export async function syncCallRecording(
  roomName: string,
  deps: CallRecordingDeps,
): Promise<CallRecordingOutcome> {
  const identities = await deps.participantIdentities(roomName);
  const hosts = new Set(identities.map(hostAccountFromIdentity).filter(Boolean));
  const active = await deps.activeEgressIds(roomName);

  if (hosts.size >= 2 && active.length === 0) {
    if (!(await deps.claimStart(roomName))) return 'unchanged';
    try {
      await deps.start(roomName);
      return 'started';
    } catch (error) {
      await deps.releaseStart(roomName);
      throw error;
    }
  }
  if (hosts.size === 0 && active.length > 0) {
    await Promise.all(active.map((egressId) => deps.stop(egressId)));
    await deps.releaseStart(roomName);
    return 'stopped';
  }
  return 'unchanged';
}
