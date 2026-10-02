# livekit-broadcast

A room, stage and broadcast control plane for a self-hosted LiveKit deployment.
A small cast on stage, a large listening audience, recorded to MP4, streamed
live to YouTube and TikTok, and fanned out to an HLS tier a CDN serves.

Node and TypeScript, built on `livekit-server-sdk`.

## The one thing worth stealing from this repo

**One egress, many outputs.**

LiveKit's `EncodedOutputs` accepts `file`, `segments` and `stream` in a single
RoomComposite request and encodes **once** for all of them. A show that records
to MP4, serves an HLS tier and streams to YouTube is therefore one egress job
at about 3.0 CPU, not three jobs at 9.0.

On a dedicated media box that is not a tuning detail. Egress refuses jobs once
its CPU budget is spent, so on a four-core machine the difference is whether
the show runs at all.

The cost is coupled lifecycles: stopping the archive stops the stream, because
they are the same job. RTMP destinations escape that with `updateStream`, which
adds and removes URLs on a **running** egress, so going live and off air
mid-show costs nothing extra.

Orientation is the one thing that genuinely forces a second egress. An encode
has one resolution, so 9:16 for TikTok cannot ride along with 16:9 for YouTube.

## Permissions live on the server

Grants are derived from role lists on the room, not from a role field on the
participant and never from anything the client sends. Someone who patches the
client JavaScript still cannot publish audio, because the token they were
issued does not permit it. Everything that decides who is allowed to be heard
is in `src/livekit/grants.ts` and nowhere else.

The model is role lists on the room rather than per-participant records because
a show has a small cast and a huge audience, and you do not want a row per
listener to decide that a listener may not speak.

## Layout

```
src/livekit/     egress, grants, participants, call recording, client
src/routes/      rooms, host, broadcast, recordings, session, webhooks
src/rooms.ts     room lifecycle
src/recordings.ts
src/store.ts     Redis-backed state
src/auth/        sessions, tokens, keys, policy, principal
src/messenger/   Matrix identity and APNs push (optional, see below)
```

`src/messenger/` and `src/routes/messenger.ts` are a separate concern that
happened to live in the same service: Matrix-backed identity and Apple push for
a companion app. They are wired in `src/index.ts` in four imports and one route
registration, and can be removed without touching the broadcast layer.

## Provenance

This is an independent implementation written against LiveKit's documented API.
It shares no code with any AGPL-licensed alternative, and the source comments
say so where the question would naturally arise.

## Run

```
npm install
npm run build
npm start
```

Requires a reachable LiveKit server, an Egress worker, Redis, and S3-compatible
object storage for recordings and HLS segments. Configuration is environment
driven; see `src/config.ts`.

## Tests

```
npm test
```

## Licence

MIT.
