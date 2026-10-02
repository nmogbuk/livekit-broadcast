import { EgressClient, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { config } from '../config.js';

/**
 * Server-to-server clients. These use the internal LiveKit URL — they talk to
 * the SFU over loopback, never across the internet, so they are unaffected by
 * the public wss:// hostname the browsers use.
 */
export const roomService = new RoomServiceClient(
  config.livekit.url,
  config.livekit.key,
  config.livekit.secret,
);

export const egressClient = new EgressClient(
  config.livekit.url,
  config.livekit.key,
  config.livekit.secret,
);

/** Verifies the Authorization header LiveKit signs its webhooks with. */
export const webhookReceiver = new WebhookReceiver(config.livekit.key, config.livekit.secret);

/**
 * Raised when the SFU cannot be reached at all.
 *
 * This matters more in a split deployment (control plane on the swarm, media on
 * its own host) than it would on one box: there is a network between the two,
 * so "the SFU is unreachable" goes from near-impossible to a thing that
 * genuinely happens. Surfacing it as a generic 500 tells an operator nothing.
 */
export class SfuUnreachableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(
      `Could not reach the LiveKit SFU at ${config.livekit.url} while attempting to ${operation}. ` +
        `Check that the media host is up and that LIVEKIT_URL is correct.`,
    );
    this.name = 'SfuUnreachableError';
    this.cause = cause;
  }
}

/** Translate transport-level failures into something an operator can act on. */
export async function withSfu<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(message)) {
      throw new SfuUnreachableError(operation, error);
    }
    throw error;
  }
}
