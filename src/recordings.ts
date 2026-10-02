import { createHash, createHmac } from 'node:crypto';
import { config } from './config.js';

/**
 * Reading the recording bucket back out.
 *
 * The bucket is written by LiveKit's egress service and never read by this
 * process — until now. Rather than pull in @aws-sdk/client-s3 (several megabytes
 * for two calls) this signs the two requests it needs by hand. SigV4 is a hash
 * chain, not a protocol: the whole implementation is the forty lines below.
 */

const S3 = config.recording.s3;

/**
 * Where THIS process reaches the store.
 *
 * Deliberately not `S3.endpoint` — that value is `127.0.0.1:9000`, which is
 * correct for the egress container and meaningless here, since the control
 * plane runs on a different machine. The public base URL is the one address
 * both this process and a browser can resolve, so it is also the only one a
 * presigned URL can be signed for.
 */
function origin(): string {
  const base = S3.publicBaseUrl.replace(/\/+$/, '');
  const suffix = `/${S3.bucket}`;
  return base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

export const recordingsConfigured = (): boolean =>
  Boolean(S3.bucket && S3.accessKey && S3.secret && S3.publicBaseUrl);

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac('sha256', key).update(value).digest();

/** RFC 3986. encodeURIComponent leaves !'()* alone, and S3 does not forgive it. */
const uriEncode = (value: string, keepSlash: boolean): string => {
  const escaped = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? escaped.replace(/%2F/g, '/') : escaped;
};

function signingKey(dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${S3.secret}`, dateStamp);
  const kRegion = hmac(kDate, S3.region || 'us-east-1');
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

/** `20260828T175009Z` and `20260828`, the two clock formats SigV4 wants. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function canonicalRequest(
  method: string,
  path: string,
  query: string,
  host: string,
  amzDate: string,
  payloadHash: string,
  signedHeaders: string,
  headerBlock: string,
): string {
  return [method, path, query, headerBlock, signedHeaders, payloadHash].join('\n');
}

function stringToSign(amzDate: string, dateStamp: string, canonical: string): string {
  return [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/${S3.region || 'us-east-1'}/s3/aws4_request`,
    sha256(canonical),
  ].join('\n');
}

export interface RecordingObject {
  key: string;
  size: number;
  lastModified: string;
}

/**
 * One page of ListObjectsV2 under a prefix.
 *
 * Listing is denied to anonymous callers (objects are readable, the index is
 * not), so this is the one operation that genuinely needs credentials — which is
 * also why the browser cannot do it directly and this endpoint exists at all.
 */
export async function listObjects(prefix: string): Promise<RecordingObject[]> {
  if (!recordingsConfigured()) return [];

  const host = new URL(origin()).host;
  const path = S3.forcePathStyle ? `/${S3.bucket}` : '/';
  const { amzDate, dateStamp } = stamps(new Date());
  const payloadHash = sha256('');

  const found: RecordingObject[] = [];
  let token: string | undefined;

  /*
   * Paginated because a busy month exceeds the 1000-key default and a truncated
   * list would silently hide the oldest shows — the failure mode being "my
   * recording is gone", which is the worst thing this feature could say.
   */
  do {
    const params: [string, string][] = [
      ['list-type', '2'],
      ['max-keys', '1000'],
      ['prefix', prefix],
    ];
    if (token) params.push(['continuation-token', token]);
    const query = params
      .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const canonical = canonicalRequest(
      'GET',
      path,
      query,
      host,
      amzDate,
      payloadHash,
      'host;x-amz-content-sha256;x-amz-date',
      `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    );
    const signature = hmac(signingKey(dateStamp), stringToSign(amzDate, dateStamp, canonical))
      .toString('hex');

    const response = await fetch(`${origin()}${path}?${query}`, {
      headers: {
        host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${S3.accessKey}/${dateStamp}/` +
          `${S3.region || 'us-east-1'}/s3/aws4_request, ` +
          'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
          `Signature=${signature}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Listing recordings failed (${response.status})`);
    }
    const xml = await response.text();

    for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
      const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      if (!key) continue;
      found.push({
        key,
        size: Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
        lastModified: block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] ?? '',
      });
    }

    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
      : undefined;
  } while (token);

  return found;
}

/**
 * A time-limited URL the browser can play or download directly.
 *
 * The bytes go straight from the media host to the browser. Proxying them
 * through this process would put 25GB of archive across the control plane's
 * uplink to save nothing — the store is already the thing serving the audience.
 */
export function presignGet(key: string, ttlSeconds: number, downloadAs?: string): string {
  const host = new URL(origin()).host;
  const path = S3.forcePathStyle
    ? `/${S3.bucket}/${uriEncode(key, true)}`
    : `/${uriEncode(key, true)}`;
  const { amzDate, dateStamp } = stamps(new Date());

  const params: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    [
      'X-Amz-Credential',
      `${S3.accessKey}/${dateStamp}/${S3.region || 'us-east-1'}/s3/aws4_request`,
    ],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(ttlSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  /*
   * Turns the same URL into a download instead of a tab that starts playing.
   * Signed as part of the query, so it cannot be tampered with after the fact.
   */
  if (downloadAs) {
    params.push(['response-content-disposition', `attachment; filename="${downloadAs}"`]);
  }

  const query = params
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonical = canonicalRequest(
    'GET',
    path,
    query,
    host,
    amzDate,
    'UNSIGNED-PAYLOAD',
    'host',
    `host:${host}\n`,
  );
  const signature = hmac(signingKey(dateStamp), stringToSign(amzDate, dateStamp, canonical))
    .toString('hex');

  return `${origin()}${path}?${query}&X-Amz-Signature=${signature}`;
}
