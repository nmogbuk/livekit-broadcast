/**
 * Which Apple push tokens belong to a Waves host.
 *
 * The Matrix push gateway API has no caller authentication, so the gateway
 * only notifies tokens a signed-in host registered here. Otherwise anyone who
 * learned the gateway URL and a token could make the hosts' Macs chime.
 */

import type { Redis } from 'ioredis';

export interface PushTokenStore {
  register(accountId: string, token: string): Promise<void>;
  accountFor(token: string): Promise<string | null>;
  remove(token: string): Promise<void>;
}

// APNs device tokens are hex; Apple documents their length as variable.
const APNS_TOKEN = /^[0-9a-f]{64,200}$/i;

export const isApnsToken = (value: string): boolean => APNS_TOKEN.test(value);

/**
 * The app re-registers on every launch, so a record that expired or was
 * evicted from the shared, LRU-evicting Redis returns on the next start.
 */
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

const keyFor = (token: string) => `waves:messenger:push-token:${token.toLowerCase()}`;

export function redisPushTokenStore(redis: Redis): PushTokenStore {
  return {
    async register(accountId, token) {
      await redis.set(keyFor(token), accountId, 'EX', TOKEN_TTL_SECONDS);
    },
    async accountFor(token) {
      return redis.get(keyFor(token));
    },
    async remove(token) {
      await redis.del(keyFor(token));
    },
  };
}
