/**
 * Merge one subject into another, across every room.
 *
 *   node dist/tools/merge-identity.js --from anon_xY… --to user_3ac6… [--apply]
 *
 * WHY THIS EXISTS
 *
 * Before accounts, a host was an anonymous subject minted per device. Signing in
 * with Apple creates a NEW subject (`user_<account id>`), so the history built up
 * under the old one — moderator of every past show, the display name the audience
 * knows — belongs to someone who no longer exists. This moves it.
 *
 * Both hosts need it exactly once, which is why it is a committed tool rather
 * than a one-off pasted into a shell: the second run should not be a fresh
 * improvisation against production data.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply.
 */

import { redis, getRoom, update } from '../store.js';
import type { Room } from '../types.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

const from = arg('from');
const to = arg('to');
const apply = process.argv.includes('--apply');

if (!from || !to) {
  console.error('usage: merge-identity --from <subject> --to <subject> [--apply]');
  process.exit(2);
}
if (from === to) {
  console.error('--from and --to are the same subject; nothing to merge.');
  process.exit(2);
}

/**
 * Every room, read from the keyspace rather than the room index.
 *
 * The index is maintained by the app and could in principle have drifted; a
 * merge that silently skips a room leaves an identity half-migrated, which is
 * worse than one that takes a second longer.
 */
async function allRoomIds(): Promise<string[]> {
  const ids: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'waves:room:*', 'COUNT', 200);
    cursor = next;
    for (const key of keys) ids.push(key.replace(/^waves:room:/, ''));
  } while (cursor !== '0');
  return ids.sort();
}

/** Replace `from` with `to` in a list, keeping order and never duplicating. */
function rewriteList(list: string[], oldSub: string, newSub: string): string[] {
  if (!list.includes(oldSub)) return list;
  const out: string[] = [];
  for (const entry of list) {
    const mapped = entry === oldSub ? newSub : entry;
    // The two subjects can BOTH already be present — the account signed in and
    // was promoted while the anonymous one was still listed. Appending blindly
    // would leave a duplicate in a role list.
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

interface Change {
  room: string;
  fields: string[];
  name?: string;
}

const changes: Change[] = [];

for (const id of await allRoomIds()) {
  const room = await getRoom(id);
  if (!room) continue;

  const touched: string[] = [];
  const listFields = ['moderators', 'speakers', 'presenters', 'raisedHands'] as const;
  for (const field of listFields) {
    if (room[field]?.includes(from)) touched.push(field);
  }
  if (room.createdBy === from) touched.push('createdBy');
  if (room.profiles?.[from]) touched.push('profiles');
  if (touched.length === 0) continue;

  /*
   * The display name follows the identity.
   *
   * Whatever the old subject was called in THIS room is the name the audience
   * saw in it, so it is the honest thing to keep — a past show should not
   * retroactively be hosted by a name nobody used at the time. Only fills a gap;
   * a name already set on the new subject wins.
   */
  const carriedName = room.profiles?.[from]?.name;
  changes.push({ room: id, fields: touched, ...(carriedName ? { name: carriedName } : {}) });

  if (!apply) continue;

  await update(id, (r: Room): Room => {
    const profiles = { ...r.profiles };
    const inherited = profiles[from];
    delete profiles[from];
    if (inherited && !profiles[to]) profiles[to] = inherited;

    return {
      ...r,
      createdBy: r.createdBy === from ? to : r.createdBy,
      moderators: rewriteList(r.moderators, from, to),
      speakers: rewriteList(r.speakers, from, to),
      presenters: rewriteList(r.presenters, from, to),
      raisedHands: rewriteList(r.raisedHands, from, to),
      profiles,
    };
  });
}

console.log(apply ? 'MERGED' : 'DRY RUN — nothing written');
console.log(`  from: ${from}`);
console.log(`  to:   ${to}`);
if (changes.length === 0) {
  console.log('  no rooms reference that subject');
} else {
  for (const change of changes) {
    console.log(
      `  ${change.room}: ${change.fields.join(', ')}` +
        (change.name ? `  (name "${change.name}")` : ''),
    );
  }
  console.log(`  ${changes.length} room(s)`);
}
if (!apply) console.log('  re-run with --apply to write');

await redis.quit();
