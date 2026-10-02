/**
 * Who a Matrix access token belongs to, asked of tuwunel itself.
 *
 * The Mac app already holds a Matrix session, so it proves who it is with
 * that instead of keeping a second, GoTrue credential alive just to register
 * its push token.
 */

const WHOAMI_TIMEOUT_MS = 10_000;

export async function matrixUserIdForAccessToken(
  accessToken: string,
  homeserverUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!homeserverUrl) return null;
  try {
    const response = await fetchImpl(
      new URL('/_matrix/client/v3/account/whoami', homeserverUrl),
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { user_id?: unknown };
    return typeof body.user_id === 'string' ? body.user_id : null;
  } catch {
    return null;
  }
}
