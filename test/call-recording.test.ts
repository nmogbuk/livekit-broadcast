/**
 * When a messenger call is recorded. config.ts reads the environment on first
 * import, so it is set before the module is imported.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NERO = '3ac6b9d3-354a-41e4-b878-990f9d23e79f';
const KURO = '68a04728-148c-446a-9f72-e2f28671e902';
const STRANGER = '9f1d4a2b-1111-4222-8333-444455556666';
const SERVER = 'waves.test';

Object.assign(process.env, {
  LIVEKIT_PUBLIC_URL: 'wss://sfu.waves.test',
  LIVEKIT_KEY: 'APItest',
  LIVEKIT_SECRET: 'livekit-test-secret-0123456789abcdefghij',
  ADMIN_API_KEY: 'admin-test-key-0123456789abcdef',
  SESSION_SECRET: 'session-test-secret-0123456789abcdefghij',
  HOST_ACCOUNTS: `${NERO},${KURO}`,
  MATRIX_SERVER_NAME: SERVER,
});

const { callRecordingKey, hostAccountFromIdentity, syncCallRecording } = await import(
  '../src/livekit/call-recording.js'
);

const caller = (account: string, device = 'MACBOOK') => `@${account}:${SERVER}:${device}`;

function fakeRoom(identities: string[], active: string[] = [], claimed = false) {
  const calls: string[] = [];
  let held = claimed;
  const deps = {
    participantIdentities: async () => identities,
    activeEgressIds: async () => active,
    claimStart: async () => (held ? false : (held = true)),
    releaseStart: async () => {
      held = false;
      calls.push('release');
    },
    start: async () => {
      calls.push('start');
      return 'EG_new';
    },
    stop: async (id: string) => {
      calls.push(`stop ${id}`);
    },
  };
  return { deps, calls };
}

describe('which LiveKit identities are hosts', () => {
  it('a host calling from their Mac', () => {
    assert.equal(hostAccountFromIdentity(caller(NERO)), NERO);
  });

  it('not a Matrix account outside the host list', () => {
    assert.equal(hostAccountFromIdentity(caller(STRANGER)), null);
  });

  it('not a host on another Matrix server', () => {
    assert.equal(hostAccountFromIdentity(`@${NERO}:elsewhere.example:MACBOOK`), null);
  });

  it('not show participants or the egress recorder', () => {
    assert.equal(hostAccountFromIdentity(`user_${NERO}`), null);
    assert.equal(hostAccountFromIdentity('anon_x9'), null);
    assert.equal(hostAccountFromIdentity('EG_4sPa8uZ'), null);
  });
});

describe('recording a call', () => {
  it('starts once both hosts are in the call', async () => {
    const { deps, calls } = fakeRoom([caller(NERO), caller(KURO)]);
    assert.equal(await syncCallRecording('room', deps), 'started');
    assert.deepEqual(calls, ['start']);
  });

  it('does not start with one host waiting for the other', async () => {
    const { deps, calls } = fakeRoom([caller(NERO)]);
    assert.equal(await syncCallRecording('room', deps), 'unchanged');
    assert.deepEqual(calls, []);
  });

  it('does not count the same host twice, or a stranger', async () => {
    const { deps, calls } = fakeRoom([caller(NERO, 'A'), caller(NERO, 'B'), caller(STRANGER)]);
    assert.equal(await syncCallRecording('room', deps), 'unchanged');
    assert.deepEqual(calls, []);
  });

  it('does not start a second recording', async () => {
    const { deps, calls } = fakeRoom([caller(NERO), caller(KURO)], ['EG_running']);
    assert.equal(await syncCallRecording('room', deps), 'unchanged');
    assert.deepEqual(calls, []);
  });

  it('does not start while another webhook is already starting one', async () => {
    const { deps, calls } = fakeRoom([caller(NERO), caller(KURO)], [], true);
    assert.equal(await syncCallRecording('room', deps), 'unchanged');
    assert.deepEqual(calls, []);
  });

  it('releases its claim when the recording fails to start, so the next event retries', async () => {
    const { deps, calls } = fakeRoom([caller(NERO), caller(KURO)]);
    deps.start = async () => {
      throw new Error('no egress worker');
    };
    await assert.rejects(syncCallRecording('room', deps));
    assert.deepEqual(calls, ['release']);
  });

  it('keeps recording while one host drops out', async () => {
    const { deps, calls } = fakeRoom([caller(KURO)], ['EG_running']);
    assert.equal(await syncCallRecording('room', deps), 'unchanged');
    assert.deepEqual(calls, []);
  });

  it('stops when the last host leaves', async () => {
    const { deps, calls } = fakeRoom(['EG_recorder'], ['EG_running']);
    assert.equal(await syncCallRecording('room', deps), 'stopped');
    assert.deepEqual(calls, ['stop EG_running', 'release']);
  });

  it('records a call redialled straight after the last one ended', async () => {
    let identities = [caller(NERO), caller(KURO)];
    let active: string[] = [];
    const { deps } = fakeRoom([]);
    deps.participantIdentities = async () => identities;
    deps.activeEgressIds = async () => active;

    assert.equal(await syncCallRecording('room', deps), 'started');
    [identities, active] = [['EG_recorder'], ['EG_new']];
    assert.equal(await syncCallRecording('room', deps), 'stopped');
    [identities, active] = [[caller(NERO), caller(KURO)], []];
    assert.equal(await syncCallRecording('room', deps), 'started');
  });
});

describe('where a call recording is stored', () => {
  it('under calls/, with the room hash made path-safe', () => {
    assert.equal(
      callRecordingKey('9WKqK0EZk/tZrIV7+ipzBQ15G'),
      'calls/9WKqK0EZk_tZrIV7_ipzBQ15G/call-{time}.mp4',
    );
  });
});
