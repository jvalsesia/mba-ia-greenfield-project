---
libs:
  - name: bullmq
    version: "^5.81.2"
    resolved: "5.81.2"
    source: npm-registry
  - name: "@nestjs/bullmq"
    version: "^11.0.4"
    resolved: "11.0.4"
    source: npm-registry
  - name: "@aws-sdk/client-s3"
    version: "^3.1096.0"
    resolved: "3.1096.0"
    source: npm-registry
  - name: "@aws-sdk/s3-request-presigner"
    version: "^3.1096.0"
    resolved: "3.1096.0"
    source: npm-registry
  - name: ffmpeg
    version: "distro build (Debian bookworm, node:25.6.0-slim base)"
    resolved: "n/a — OS package, not npm"
    source: os-package
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T15:12:00-03:00"
  nestjs-project/package.json: "2026-07-28T14:15:36-03:00"
---

# phase-03-videos — Library References

## Provenance and the `context7` gap

The root `CLAUDE.md` requires library APIs to be confirmed via the **context7** MCP server before implementation. **`context7` is not available in this repository** — `.mcp.json` registers only `postgres`, and `.mcp.json.example` adds only `figma`. This was raised as `IC-1` in `validation.md` and resolved by accepting substitute primary sources for this phase.

Substitutes actually used, in order of authority:

1. **npm registry metadata** (`https://registry.npmjs.org/<pkg>/latest`, read 2026-07-28) — authoritative for version, license, `engines`, `type` (ESM/CJS), `main`/`exports`, `peerDependencies` and `dependencies`. These are the facts that decide compatibility with the installed stack, and they are read from the registry rather than recalled.
2. **Official vendor documentation** — AWS S3 user guide for the multipart limits cited in `TD-02`.

**Obligation carried into implementation:** every version below is a registry `latest` at research time, not yet an installed version. `SI-03.1` installs them and must re-confirm the resolved versions against `nestjs-project/package-lock.json`; any divergence is recorded here as a revision before dependent SIs proceed.

---

## Installed-stack constraints these libraries must satisfy

Read from `nestjs-project/package.json` and `tsconfig.json`:

| Constraint | Value | Consequence |
|---|---|---|
| NestJS | `@nestjs/common` / `@nestjs/core` `^11.0.1` | Any Nest integration package must declare `^11` in its peers. |
| Module system | CommonJS (`ts-jest` transform, `nodenext` resolution) | **ESM-only packages are disqualified** — they cannot be `require`d from the compiled output or from the Jest sandbox. |
| Node (container) | `v25.6.0` (`node:25.6.0-slim`) | Packages with an `engines.node` floor above 25 are unusable. |
| TypeORM | `^0.3.28`, `synchronize: false` | New entities ship with a hand-versioned migration. |

---

## `bullmq@^5.81.2` — queue primitives (`TD-01`)

**Compatibility check.** `main: ./dist/cjs/index.js` and no `"type": "module"` → **CommonJS build present**, so it loads under `ts-jest` and the compiled CJS output. `engines.node: >=12.22.0` → satisfied. Bundles `ioredis@5.11.1` as a direct dependency, so no separate Redis client is installed. `peerDependencies: { redis: ">=5.0.0" }` refers to the **Redis server** version — the Compose image must be Redis 5 or newer (`redis:8-alpine` in this phase, comfortably above).

**Surface used in this phase:**

- `Queue` — the producer handle. Obtained via DI (see `@nestjs/bullmq` below) rather than constructed directly.
- Job options relevant to `TD-09`: `attempts`, `backoff: { type: 'exponential', delay }`, `removeOnComplete`, `removeOnFail`.
- Worker options relevant to the `OQ-1` revision on `TD-09`: `stalledInterval`, `maxStalledCount`, `concurrency`.

**Operational note.** BullMQ stores jobs in Redis, so job durability is Redis durability. The Compose service must enable persistence (`--appendonly yes`) or a broker restart drops queued work — called out in `TD-01`'s Cons.

## `@nestjs/bullmq@^11.0.4` — NestJS integration (`TD-01`)

**Compatibility check.** `peerDependencies: { "@nestjs/core": "^10.0.0 || ^11.0.0", "@nestjs/common": "^10.0.0 || ^11.0.0", "bullmq": "^3.0.0 || ^4.0.0 || ^5.0.0" }` → the installed NestJS `^11.0.1` and the `bullmq@^5` above both fall inside the declared ranges. `main: dist/index.js`, no `"type": "module"` → CommonJS. This is the compatibility claim `TD-01` rests on, and it holds as declared by the package.

**Surface used in this phase:**

- `BullModule.forRoot({ connection })` — registered once, in both the API module graph (producer) and the worker module graph (consumer).
- `BullModule.registerQueue({ name })` — declares the `video-processing` queue in the module that produces to it.
- `@InjectQueue(name)` — injects the `Queue` into the producing service.
- `@Processor(name)` on a class extending `WorkerHost`, implementing `process(job)` — the consumer, registered only in the worker's module graph per `TD-04`.

**Wiring note for `TD-04`.** The worker entrypoint bootstraps with `NestFactory.createApplicationContext`, which starts providers without an HTTP listener. The `@Processor` class must therefore live in a module imported by the worker's root module and **not** by the API's, or the API would also consume jobs — defeating the process separation the TD decides.

## `@aws-sdk/client-s3@^3.1096.0` — object storage (`TD-02`, `TD-03`, `TD-06`, `TD-08`, `TD-12`)

**Compatibility check.** Apache-2.0, CommonJS-compatible dual build, no `engines` floor above the container's Node 25. Modular v3 client — only the S3 client package is installed, not a monolithic SDK.

**Surface used in this phase:**

| Command | Used for | TD |
|---|---|---|
| `CreateMultipartUploadCommand` | Opening the upload session, returns `UploadId` | TD-02 |
| `UploadPartCommand` | Presigned per-part `PUT` target (signed, never executed server-side) | TD-02 |
| `CompleteMultipartUploadCommand` | Assembling parts from the client-supplied `{ PartNumber, ETag }` list | TD-02 |
| `AbortMultipartUploadCommand` | The cancel path | TD-12 |
| `GetObjectCommand` | Presigned read target for streaming, download and the worker's FFmpeg input | TD-06, TD-08 |
| `PutObjectCommand` | Worker writes the generated thumbnail | TD-03 |
| `HeadObjectCommand` | Confirming the assembled object's size after completion | TD-02 |
| `CreateBucketCommand`, `PutBucketPolicyCommand` | Bootstrap of the two buckets and the thumbnail bucket's public-read policy | TD-03 |

**MinIO-specific client configuration.** MinIO is S3-API-compatible but is addressed by endpoint rather than by AWS region host, so the client must be constructed with:

- `endpoint` — the Compose service URL (`http://minio:9000`), never `localhost`, per the Docker networking rule in the root `CLAUDE.md`.
- `forcePathStyle: true` — **required.** The v3 default is virtual-hosted-style addressing (`https://<bucket>.<host>/<key>`), which does not resolve against a MinIO container hostname. Without this flag every request fails DNS resolution.
- `region` — arbitrary but mandatory; the SigV4 signer requires a value even when the backend ignores it.
- `credentials` — the MinIO root user/password from the environment.

**Signing note relevant to `TD-08`.** The signature covers the request the URL was signed for, so `response-content-disposition` must be passed as a parameter to `GetObjectCommand` **before** signing, not appended to the finished URL — appending it after signing invalidates the signature.

## `@aws-sdk/s3-request-presigner@^3.1096.0` — presigned URLs (`TD-02`, `TD-06`, `TD-08`)

**Compatibility check.** Versioned and released in lockstep with `@aws-sdk/client-s3`; both must be pinned to the same minor to avoid signer/client drift.

**Surface used:** `getSignedUrl(client, command, { expiresIn })`, where `expiresIn` is **seconds**.

TTLs decided by the TDs, collected here because they are the values the implementation must use:

| Purpose | TTL | TD |
|---|---|---|
| Multipart part upload (`UploadPartCommand`) | 3600 s (1 h) | TD-02 |
| Worker FFmpeg input (`GetObjectCommand`) | 7200 s (2 h) | TD-06 |
| Streaming / download redirect (`GetObjectCommand`) | 300 s (5 min) | TD-08 |

**Constraint.** SigV4 presigned URLs cap at 7 days; every TTL above is far below the ceiling, so no clamping applies.

## `ffmpeg` / `ffprobe` — OS package, not npm (`TD-05`, `TD-06`)

`TD-05` deliberately adds **no npm dependency** — the binaries are the API. Installed via `apt install -y ffmpeg` in both `Dockerfile.worker` (runtime, per `TD-04`) and `Dockerfile.dev` (so integration tests can run in the sanctioned container, per the `IC-2` revision on `TD-10`).

**Command contracts the implementation depends on:**

- **Metadata** — `ffprobe -v error -print_format json -show_format -show_streams <input>` writes a JSON document to stdout with `format.duration` (seconds, as a string) and a `streams` array carrying `codec_type`, `width`, `height` and `codec_name`. Exit code `0` on success; diagnostics go to stderr.
- **Thumbnail** — `ffmpeg -ss <seconds> -i <input> -frames:v 1 -q:v 2 -f image2 -y <output.jpg>`. Placing `-ss` **before** `-i` selects input seeking, which jumps to the timestamp instead of decoding from the start — the property that makes `TD-06`'s HTTP-input strategy fast on a 10GB file.
- **Test fixture** — `ffmpeg -f lavfi -i testsrc=duration=<n>:size=<WxH>:rate=<fps> -f lavfi -i sine -shortest -y <out.mp4>` synthesises a clip with both a video and an audio stream, so no binary asset is committed (`TD-10`).

**Network input requirement (`TD-06`).** Passing a presigned HTTPS URL as `<input>` requires an FFmpeg build with protocol support compiled in; Debian's packaged build includes the `http`/`https` protocols. The implementation must treat a non-zero exit with a protocol error as a hard failure rather than retrying, since retries cannot fix a missing protocol.

**Security note.** Both commands are invoked via `spawn(cmd, argsArray)` with no shell, so storage keys and signed URLs cannot be interpreted as shell syntax — this is part of why `TD-05` chose direct `spawn`.

## Not adopted, and why

| Package | Version checked | Reason rejected |
|---|---|---|
| `nanoid` | 6.0.0 | `"type": "module"` with `engines.node: ^22 \|\| ^24 \|\| >=26` — **ESM-only**, incompatible with this CommonJS/`ts-jest` codebase. `TD-07` uses `node:crypto` instead. |
| `fluent-ffmpeg` | 2.1.3 (+ `@types/fluent-ffmpeg` 2.1.28) | Two packages for two command lines; wraps the FFmpeg stderr that is the only useful failure signal. Rejected by `TD-05`. |
| `pg-boss` | 12.26.3 | No first-party NestJS integration; would place a second schema owner inside the project's own database. Rejected by `TD-01`. |
| `amqplib` / `@golevelup/nestjs-rabbitmq` | 2.0.1 / 9.0.2 | Broker weight unjustified at one producer and one consumer; retry-with-backoff needs manual DLX/TTL plumbing. Rejected by `TD-01`. |
| `@aws-sdk/lib-storage` | 3.1096.0 | Its `Upload` helper performs multipart **server-side**, which is precisely the data path `TD-02` removes. Not installed. |
