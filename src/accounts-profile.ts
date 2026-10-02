/**
 * A stage name that belongs to the account, not to the provider.
 *
 * Apple hands back the name on the Apple ID — "Frank Mogbuk" — and that is what
 * every room then recorded, because joining writes `principal.name` into the
 * room profile. But the audience knows this host as Super Nero, and a past
 * show's credits should not be rewritten by which identity provider was used to
 * sign in.
 *
 * Stored beside the room state in Redis rather than in GoTrue's user_metadata:
 * that table is the auth service's, and the control plane should not be writing
 * to another service's schema to remember something only it cares about.
 */

import { redis } from './store.js';

const key = (sub: string) => `waves:stage-name:${sub}`;

/** Long-lived: a stage name is not session state. */
const TTL_SECONDS = 365 * 24 * 60 * 60;

export async function getStageName(sub: string): Promise<string | null> {
  return redis.get(key(sub));
}

export async function setStageName(sub: string, name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) {
    await redis.del(key(sub));
    return;
  }
  await redis.set(key(sub), trimmed, 'EX', TTL_SECONDS);
}
