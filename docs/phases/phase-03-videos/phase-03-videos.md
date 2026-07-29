---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-28T15:12:27-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-28T15:11:55-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T15:10:45-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video ingestion pipeline end to end: a 10GB-capable upload that never routes bytes through the API, automatic background processing that extracts duration and metadata and cuts a thumbnail, a short unique public URL per video, and range-capable streaming plus download — together with the three new infrastructure services (object storage, queue broker, video worker) that the architecture has modelled since Phase 01 but never had.

The organising principle inherited from `phase-03-videos/TD-02`, `TD-06` and `TD-08`: **large media never transits the API process** — not on upload, not on the worker's read, not on playback.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Storage/Queue Infrastructure

**Description:** Install the phase's production dependencies, add the `storage` and `queue` config namespaces following the `registerAs` pattern inherited from Phase 01, extend the Joi env schema, and bring up the two new infrastructure services (MinIO and Redis) in Docker Compose. Also install `ffmpeg` in the dev image so the suite can exercise the real binary per the `IC-2` revision on `TD-10`.

**Technical actions:**

- Install production dependencies in `nestjs-project`: `bullmq@^5.81.2`, `@nestjs/bullmq@^11.0.4`, `@aws-sdk/client-s3@^3.1096.0`, `@aws-sdk/s3-request-presigner@^3.1096.0`. Immediately re-confirm the resolved versions against `package-lock.json` and record any divergence in `library-refs.md` — this is the obligation `IC-1` carried forward.
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (internal, default `'http://minio:9000'`), `S3_PUBLIC_ENDPOINT` (the endpoint baked into URLs handed to clients), `S3_REGION` (default `'us-east-1'`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (boolean, default `true`), `S3_VIDEOS_BUCKET` (default `'streamtube-videos'`), `S3_THUMBNAILS_BUCKET` (default `'streamtube-thumbnails'`), `UPLOAD_PART_SIZE_BYTES` (default `67108864` = 64 MiB), `UPLOAD_MAX_SIZE_BYTES` (default `10737418240` = 10 GiB), `UPLOAD_URL_TTL_SECONDS` (default `3600`), `DELIVERY_URL_TTL_SECONDS` (default `300`), `WORKER_URL_TTL_SECONDS` (default `7200`).
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`), `VIDEO_QUEUE_NAME` (default `'video-processing'`), `VIDEO_JOB_ATTEMPTS` (default `3`), `VIDEO_JOB_BACKOFF_MS` (default `5000`), `VIDEO_WORKER_CONCURRENCY` (default `2`), `VIDEO_STALLED_INTERVAL_MS` (default `60000`), `VIDEO_MAX_STALLED_COUNT` (default `2`).
- Update `src/config/env.validation.ts` — add every variable above to the Joi schema; `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are `required()`, the rest carry the defaults above. Update `.env.example` with Compose-compatible values.
- Register both namespaces in `AppModule`'s `ConfigModule.forRoot({ load: [...] })`.
- Add the `minio` service to `nestjs-project/compose.yaml` — image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` and `9001:9001`, env `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, a named volume `minio_data:/data`, and a healthcheck on `mc ready local` (or `curl -f http://localhost:9000/minio/health/live`).
- Add the `redis` service — image `redis:8-alpine`, command `redis-server --appendonly yes` (persistence is required, per `library-refs.md` § bullmq operational note), a named volume `redis_data:/data`, and a healthcheck on `redis-cli ping`.
- Make `nestjs-api` depend on both with `condition: service_healthy`.
- Update `Dockerfile.dev` — add `ffmpeg` to the `apt install` line so integration specs can invoke the real binary in the container the project's conventions sanction.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Integration | The extended Joi schema accepts a complete env, applies every documented default, and rejects an env missing `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` |

**Dependencies:** _none_

**Acceptance criteria:**

- `docker compose up -d` brings `minio` and `redis` to a healthy state alongside `db`, `mailpit` and `nestjs-api`
- `docker compose exec nestjs-api ffprobe -version` and `ffmpeg -version` both exit 0
- The app boots with the two new config namespaces loaded and no Joi validation error
- Removing `S3_ACCESS_KEY_ID` from the env fails startup with an explicit validation message

---

### SI-03.2 — Channel Lookup by User (DG-1 prerequisite)

**Description:** Give `ChannelsModule` the ability to answer "which channel does this authenticated user own?" — the lookup every upload initiation needs, and which `ChannelsService` does not currently expose. Recorded in `context.md` § Prerequisites Established During Validation.

**Technical actions:**

- Add `findByUserId(userId: string): Promise<Channel | null>` to `src/channels/channels.service.ts`, querying `Repository<Channel>` by `user_id`.
- Confirm `ChannelsModule` already exports `ChannelsService` (it does) so `VideosModule` can import it. **`VideosService` must never query the `channels` table directly** — the Single Responsibility rule in the root `CLAUDE.md` places that lookup in `ChannelsModule`.
- Add a `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404) to `src/common/exceptions/domain.exception.ts`, extending `DomainException` per the Phase 02 convention.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/channels.service.spec.ts` | Unit | `findByUserId` delegates to the repository with the expected criteria and returns `null` when absent |
| `src/channels/channels.service.integration-spec.ts` | Integration | `findByUserId` returns the channel created by `createChannel` for that user, and `null` for an unknown user id |

**Dependencies:** _none_

**Acceptance criteria:**

- `findByUserId` returns the channel of a user who has one, and `null` otherwise
- `ChannelsService` remains the only owner of `channels` queries

---

### SI-03.3 — Video Entity, Public ID Generator, and Migration

**Description:** Create the `Video` entity tied to `Channel`, the short unique public identifier generator decided in `TD-07`, and the versioned migration that creates the table and its status enum.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` following the Phase 02 entity conventions (`@PrimaryGeneratedColumn('uuid')`, snake_case columns, `@CreateDateColumn` / `@UpdateDateColumn`). Columns per the Data Model below. Declare `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`.
- Create `src/videos/video-status.enum.ts` — `export const VIDEO_STATUS = { DRAFT: 'draft', PROCESSING: 'processing', READY: 'ready', FAILED: 'failed' } as const` plus the derived union type, following the `as const` constants convention.
- Create `src/videos/public-id.util.ts` — `generatePublicId(): string` returning `randomBytes(8).toString('base64url')` from `node:crypto` (11 URL-safe characters). No dependency, per `TD-07`.
- Create the migration `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate`. It must create the `videos_status_enum` type, the `videos` table, the FK to `channels`, and the indexes listed in the Data Model. **The `down()` must drop the enum type as well as the table** — and the paired `up()` should guard the enum with `IF NOT EXISTS` semantics, since the repository's existing migration test suite has already been bitten by an orphan enum surviving a table drop.
- Store `size_bytes` as `bigint`. TypeORM returns Postgres `bigint` as a **string** in JS; the entity property is typed `string` and converted at the service boundary, never assumed to be a `number`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/public-id.util.spec.ts` | Unit | Generated ids are 11 chars, URL-safe (`[A-Za-z0-9_-]`), and 1000 consecutive generations are distinct |
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Persisting a video with a channel round-trips every column; the unique constraint on `public_id` rejects a duplicate; the FK rejects an unknown `channel_id`; `status` defaults to `draft` |
| `src/database/migrations.integration-spec.ts` | Integration | Extended to include `CreateVideos` — apply creates the table and enum, revert removes both |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with the enum, FK and indexes
- `npm run migration:revert` removes the table **and** the enum type, leaving no orphan objects
- A video row cannot be inserted with a `public_id` that already exists

---

### SI-03.4 — Storage Module (S3 Client, Presigning, Bucket Bootstrap)

**Description:** Encapsulate every object-storage concern behind a single module: the two S3 clients (`TD-03` layout, internal vs client-facing endpoint), the multipart primitives `TD-02` and `TD-12` depend on, the presigners `TD-06` and `TD-08` depend on, and the idempotent bucket bootstrap.

**Technical actions:**

- Create `src/storage/storage.module.ts` exporting `StorageService`.
- Create `src/storage/s3-client.provider.ts` — two providers built from `storageConfig`:
  - `S3_INTERNAL_CLIENT` with `endpoint: S3_ENDPOINT` — used for every server-side call (create/complete/abort multipart, put thumbnail, head object, bucket bootstrap) **and** for the worker's presigned read.
  - `S3_PUBLIC_CLIENT` with `endpoint: S3_PUBLIC_ENDPOINT` — used **only** to presign URLs handed to external clients.
  Both with `forcePathStyle: true`, `region`, and credentials. **`forcePathStyle` is mandatory** — the v3 default is virtual-hosted addressing, which cannot resolve against a MinIO container hostname.
  > **Why two clients:** SigV4 signs the `Host` header, so the endpoint cannot be swapped after signing. A URL signed against `http://minio:9000` is unusable outside the Compose network, and one signed against a browser-facing host is unusable by the worker. Signing each URL with the client whose endpoint matches its consumer is the only correct resolution. In dev both variables point at `http://minio:9000` so integration and e2e specs — which run inside the network — exercise the real path; production points `S3_PUBLIC_ENDPOINT` at the public host or CDN.
- Create `src/storage/storage.service.ts` with: `ensureBuckets()`, `createMultipartUpload(key, contentType)`, `presignUploadParts(key, uploadId, partCount)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `headObject(bucket, key)`, `putThumbnail(key, body)`, `presignGet(bucket, key, ttl, opts?)` where `opts` may carry `responseContentDisposition`. **`responseContentDisposition` is passed to `GetObjectCommand` before signing** — appending it to a finished URL invalidates the signature.
- `ensureBuckets()` creates both buckets if absent and applies a public-read bucket policy to the thumbnails bucket (`TD-03`). It is idempotent and invoked from an `OnApplicationBootstrap` hook so a fresh Compose stack self-provisions.
- Key builders in `src/storage/storage.keys.ts`: `videoSourceKey(videoId, ext)` → `videos/{videoId}/source{ext}`; `thumbnailKey(videoId)` → `thumbnails/{videoId}/thumb.jpg`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.keys.spec.ts` | Unit | Key builders produce the documented shapes and preserve/normalise the extension |
| `src/storage/storage.service.integration-spec.ts` | Integration | Against **real MinIO**: `ensureBuckets` is idempotent across two calls; a full multipart round-trip (create → presigned part `PUT` → complete → `headObject`) reproduces the uploaded bytes; `abortMultipartUpload` removes the upload from `ListMultipartUploads`; a presigned GET honours a `Range` header with `206` + `Content-Range`; a presigned GET carrying `responseContentDisposition` returns `Content-Disposition: attachment`; the thumbnails bucket is anonymously readable and the videos bucket is not |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A cold `docker compose up` results in both buckets existing without manual `mc` commands
- A multipart upload of a multi-part payload completes and the reassembled object matches the source bytes
- A presigned GET returns `206 Partial Content` for a ranged request — the property `TD-08` relies on
- An anonymous GET succeeds against the thumbnails bucket and fails against the videos bucket

---

### SI-03.5 — Queue Module and Job Producer

**Description:** Register the BullMQ connection and the `video-processing` queue, and expose a narrow producer service. Both the API and the worker import this module; only the worker registers a consumer (`TD-04`).

**Technical actions:**

- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` injecting `queueConfig` for `connection: { host, port }`, plus `BullModule.registerQueue({ name: VIDEO_QUEUE_NAME })`. Export `BullModule`.
- Create `src/videos/video-queue.service.ts` — injects the queue via `@InjectQueue(VIDEO_QUEUE_NAME)` and exposes `enqueueProcessing(videoId: string): Promise<void>`, adding a `process-video` job with `{ videoId }` and the options fixed in `TD-09`: `attempts`, `backoff: { type: 'exponential', delay }`, `removeOnComplete: { count: 100 }`, `removeOnFail: false`.
- The job payload carries **only** `videoId` — the worker re-reads the row, so a job that waits in the queue can never act on stale metadata.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-queue.service.spec.ts` | Unit | `enqueueProcessing` adds a `process-video` job with the documented name, payload and options |
| `src/videos/video-queue.service.integration-spec.ts` | Integration | Against **real Redis**: an enqueued job is retrievable from the queue with the expected payload and `attempts`/`backoff` options |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A job enqueued by the API is visible in Redis under the `video-processing` queue
- Job options carry the retry policy decided in `TD-09`, not BullMQ defaults

---

### SI-03.6 — Upload Initiation (Draft Pre-registration + Presigned Parts)

**Description:** The first leg of the `TD-02` handshake: create the video row as `draft`, open the S3 multipart upload, and return the presigned part URLs the client uploads to directly. This is the capability *"Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"*.

**Technical actions:**

- Create `src/videos/dto/create-upload.dto.ts` — `CreateUploadDto` with `@IsString() @IsNotEmpty() @MaxLength(255)` title, `@IsString() @IsNotEmpty() @MaxLength(255)` filename, `@IsString() @IsIn(SUPPORTED_VIDEO_MIME_TYPES)` mimeType, `@IsInt() @IsPositive()` sizeBytes.
- Create `src/videos/videos.constants.ts` — `SUPPORTED_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm'] as const` and the extension map used to build the storage key.
- Add domain exceptions to `src/common/exceptions/domain.exception.ts`: `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 400), `UnsupportedVideoTypeException` (`UNSUPPORTED_VIDEO_TYPE`, 415).
- Create `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: resolve the channel via `ChannelsService.findByUserId` (throw `ChannelNotFoundException` if absent); validate `sizeBytes` against `UPLOAD_MAX_SIZE_BYTES`; generate `public_id` with a **bounded retry on unique-violation** (`TD-07` — the DB constraint is the authority, not the entropy); insert the row as `draft`; call `createMultipartUpload`; compute `partCount = ceil(sizeBytes / partSize)`; presign that many `UploadPart` URLs; persist `storage_key` and `upload_id`; return the payload.
- Create `src/videos/videos.controller.ts` — `@ApiTags('videos')`, `@Controller('videos')`, `@Post('uploads')` reading the principal via `@CurrentUser()`. Full Swagger decoration per the inherited convention, with `ApiErrorEnvelope` referenced via `getSchemaPath` for error shapes.
- Create `src/videos/videos.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `QueueModule`; registered in `AppModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Part count derives correctly from size and part size (including a non-exact final part); over-limit size throws `VideoTooLargeException`; a user without a channel throws `ChannelNotFoundException`; a `public_id` unique violation is retried |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against **real DB + MinIO**: initiation persists a `draft` row with `public_id`, `storage_key` and `upload_id`, and the multipart upload is listed in MinIO |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/uploads` returns 201 with `publicId`, `uploadId` and a presigned URL per part; 401 without a token; 400 on `sizeBytes` above 10 GiB; 415 on an unsupported mime type; 400 on a malformed body |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos/uploads` creates a `draft` video and returns one presigned URL per part
- No video bytes are sent to the API in this request — the body is metadata only
- A 10 GiB declared size yields 160 parts at the 64 MiB default, within S3's 10,000-part cap
- A declared size above the configured maximum is rejected before any storage call

---

### SI-03.7 — Upload Completion and Automatic Processing Trigger

**Description:** The second leg of the handshake: assemble the parts, confirm the stored object, flip the video to `processing`, and enqueue the job. This is what makes processing *automatic* after upload.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with a `@ValidateNested({ each: true }) @Type(() => UploadPartDto) @ArrayNotEmpty()` parts array; `UploadPartDto` carries `@IsInt() @Min(1)` partNumber and `@IsString() @IsNotEmpty()` etag.
- Add `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoNotInDraftException` (`VIDEO_NOT_IN_DRAFT`, 409) and `UploadCompletionFailedException` (`UPLOAD_COMPLETION_FAILED`, 400).
- Implement `completeUpload(userId, videoId, dto)` in `VideosService`: load the video scoped to the caller's channel (a video belonging to another channel raises `VideoNotFoundException`, **not** a 403 — ownership must not be probeable); require `status = draft` and a non-null `upload_id`; sort parts by `partNumber` and call `completeMultipartUpload` (a storage-side failure maps to `UploadCompletionFailedException`); `headObject` the assembled key and persist the **actual** `size_bytes` rather than trusting the declared value; set `status = processing`, clear `upload_id`; enqueue via `VideoQueueService`.
- The status write and the enqueue are ordered **status first, enqueue second** — a job that arrives before the row is `processing` would read a `draft` row and fail spuriously.
- Add `@Post(':videoId/uploads/complete')` to the controller with full Swagger decoration.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Completion rejects a non-`draft` video; a video of another channel raises `VideoNotFoundException`; parts are sorted before the storage call; the queue is called exactly once, after the status write |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against **real DB + MinIO + Redis**: a full multipart round-trip completes, `size_bytes` is corrected from `headObject`, status becomes `processing`, `upload_id` is cleared and a job lands in the queue |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:id/uploads/complete` returns 200 with `status: 'processing'`; 409 when already completed; 404 for another user's video; 400 on bogus ETags |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Completing an upload transitions the video `draft → processing` and enqueues exactly one job
- The persisted `size_bytes` reflects the object actually stored, not the client's declaration
- A second completion of the same video returns 409 and does not enqueue a duplicate job
- Another user's video is indistinguishable from a non-existent one (404 both ways)

---

### SI-03.8 — Upload Abort

**Description:** The cancel path decided in `TD-12`: release the multipart parts and remove the draft row when a client abandons an upload.

**Technical actions:**

- Implement `abortUpload(userId, videoId)` in `VideosService` — load the video scoped to the caller's channel (`VideoNotFoundException` otherwise); require `status = draft` (`VideoNotInDraftException` otherwise); call `abortMultipartUpload`; delete the row.
- Add `@Delete(':videoId/upload')` returning `@HttpCode(HttpStatus.NO_CONTENT)`, with Swagger decoration.
- Record in the plan's Deliverables that the complementary bucket lifecycle rule (`AbortIncompleteMultipartUpload`) is a documented follow-up, not part of this phase — per `TD-12`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Abort rejects a non-`draft` video and another channel's video |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against **real DB + MinIO**: after abort the row is gone and the upload no longer appears in `ListMultipartUploads` |
| `test/videos.e2e-spec.ts` | E2E | `DELETE /videos/:id/upload` returns 204; 404 for another user's video; 409 for an already-completed video |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Aborting a draft upload removes both the database row and the multipart parts in storage
- A completed video cannot be aborted through this endpoint

---

### SI-03.9 — FFmpeg Runner and Video Processing Service

**Description:** The processing logic itself, decoupled from the queue: probe the source for duration and metadata, and cut one frame into a JPEG thumbnail — both by invoking the real binaries over a presigned HTTP input (`TD-05`, `TD-06`).

**Technical actions:**

- Create `src/videos/processing/ffmpeg-runner.ts` — an injectable `FfmpegRunner` with `run(command: 'ffmpeg' | 'ffprobe', args: string[]): Promise<{ stdout, stderr }>`, implemented with `child_process.spawn` and an **argument array, never a shell string**, so signed URLs cannot be interpreted as shell syntax. A non-zero exit rejects with the captured `stderr` — the only useful diagnostic when a file fails to decode.
- Create `src/videos/processing/video-metadata.ts` — `parseFfprobeOutput(json)` mapping the `ffprobe` document to `{ durationSeconds, width, height, videoCodec, audioCodec }`, tolerating an audio-less file and a missing `format.duration`.
- Create `src/videos/processing/video-processing.service.ts` — `process(videoId)`:
  1. presign a GET on the source key with `WORKER_URL_TTL_SECONDS` (2 h, `TD-06`);
  2. `ffprobe -v error -print_format json -show_format -show_streams <url>` and parse;
  3. choose the thumbnail timestamp as `min(durationSeconds * 0.1, 10)` seconds, clamped to `0` for very short clips — a deterministic rule, so the same input always yields the same frame;
  4. `ffmpeg -ss <t> -i <url> -frames:v 1 -q:v 2 -f image2 -y <tmpfile>` (`-ss` **before** `-i` for input seeking, which is what makes this fast on a 10GB object);
  5. `putThumbnail` the result and delete the temp JPEG in a `finally`;
  6. return the metadata for the caller to persist.
- The service depends on the `FfmpegRunner` **interface**, so unit tests inject a stub while integration tests drive the real binary.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-metadata.spec.ts` | Unit | Parses a representative `ffprobe` document; handles a video-only file; handles missing duration |
| `src/videos/processing/video-processing.service.spec.ts` | Unit | Builds the documented argument arrays; computes the thumbnail timestamp rule including the short-clip clamp; deletes the temp file even when the upload throws |
| `src/videos/processing/video-processing.service.integration-spec.ts` | Integration | Against **real FFmpeg + MinIO**: a fixture generated with `ffmpeg -f lavfi -i testsrc` is uploaded, probed over a presigned URL, and yields the expected duration and dimensions; a real JPEG lands in the thumbnails bucket; a non-video payload rejects with FFmpeg's stderr surfaced |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- Duration, resolution and codecs are extracted from a real file over a presigned HTTP URL, with no full download
- A real JPEG thumbnail is produced and stored
- A corrupt or non-video object fails with FFmpeg's own error text, not a generic wrapper message

---

### SI-03.10 — Worker Process, Image, and Compose Service

**Description:** Package the processing service as the separate worker container the architecture models (`TD-04`), consume the queue, and drive the status lifecycle to its terminal states (`TD-09`).

**Technical actions:**

- Create `src/videos/processing/video.processor.ts` — `@Processor(VIDEO_QUEUE_NAME)` class extending `WorkerHost`, with worker options from `queueConfig`: `concurrency`, `stalledInterval: 60_000`, `maxStalledCount: 2` (the `OQ-1` revision on `TD-09`). `process(job)` loads the video, delegates to `VideoProcessingService`, and on success persists the metadata, `thumbnail_key` and `status = ready`.
- Handle terminal failure with `@OnWorkerEvent('failed')`: when `job.attemptsMade >= attempts`, set `status = failed` and persist `processing_error` with the captured message, truncated to a sane length. A non-final attempt leaves the row in `processing` so the retry can still succeed.
- Create `src/worker.module.ts` — the worker's root module: `ConfigModule` (global, same namespaces), `TypeOrmModule.forRootAsync` (same factory as `AppModule`), `QueueModule`, `StorageModule`, and a videos-processing module that provides `VideoProcessor`, `VideoProcessingService` and `FfmpegRunner`. **It must not import `VideosController`** — the worker has no HTTP surface.
- Create `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` plus `enableShutdownHooks()` so SIGTERM drains in-flight jobs.
- Add a `worker:dev` npm script (`nest start --watch --entryFile worker`) and a `worker:prod` script (`node dist/worker`).
- Create `nestjs-project/Dockerfile.worker` — same `node:25.6.0-slim` base, `apt install -y ffmpeg`, working dir `/home/node/app`.
- Add the `video-worker` service to `compose.yaml` — built from `Dockerfile.worker`, same `.env`, same bind mount, `depends_on` `db` (healthy), `redis` (healthy) and `minio` (healthy), command running the worker entrypoint.
- **Registration boundary check:** `@Processor` is provided only in the worker's graph. Verify `AppModule` does not transitively import the processor, or the API would consume jobs too — defeating `TD-04`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video.processor.spec.ts` | Unit | Success persists metadata, `thumbnail_key` and `status = ready`; a final-attempt failure sets `status = failed` with `processing_error`; a non-final failure leaves `processing` untouched |
| `src/worker.module.spec.ts` | Unit | The worker module compiles and resolves `VideoProcessor`, `VideoProcessingService` and `FfmpegRunner` |
| `src/app.module.spec.ts` | Unit | Extended: `AppModule` compiles and **does not** provide `VideoProcessor` — the API must not consume the queue |
| `src/videos/processing/video.processor.integration-spec.ts` | Integration | Against **real DB + Redis + MinIO + FFmpeg**: a job enqueued for an uploaded fixture drives the video to `ready` with duration, dimensions and a stored thumbnail; a job for an object that is not a video drives it to `failed` with a non-empty `processing_error` |

**Dependencies:** SI-03.5, SI-03.9, SI-03.7

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker` alongside the API, and it connects to Redis, Postgres and MinIO
- A completed upload reaches `status = ready` with duration, dimensions and a thumbnail, with no manual step
- A file that cannot be decoded reaches `status = failed` with a persisted reason after the configured attempts
- The API process does not consume jobs

---

### SI-03.11 — Video Delivery: Metadata, Streaming, and Download

**Description:** The read surface — the unique public URL resolving to video metadata, range-capable playback, and download — under the authorization model decided in `TD-11`.

**Technical actions:**

- Add `VideoNotReadyException` (`VIDEO_NOT_READY`, 409).
- Implement `findByPublicId(publicId, viewerUserId?)` in `VideosService` — resolve by `public_id`; if `status !== ready`, return it only when the viewer owns the channel, otherwise raise `VideoNotFoundException`. **`404`, never `403`** — an unprocessed upload's existence must not be disclosed.
- Implement `getStreamUrl(publicId, viewerUserId?)` and `getDownloadUrl(publicId, viewerUserId?)` — reuse the resolver, then presign a GET on the videos bucket with `DELIVERY_URL_TTL_SECONDS` (5 min, `TD-08`), the download variant adding `responseContentDisposition: attachment; filename="<original_filename>"`. A non-`ready` video visible to its owner raises `VideoNotReadyException`.
- Add three `@Public()` endpoints to `VideosController`: `@Get(':publicId')` returning the metadata DTO; `@Get(':publicId/stream')` and `@Get(':publicId/download')` returning `@Redirect()` / an explicit `302` with the presigned `Location`.
- Because the routes are `@Public()`, the principal is optional — resolve the viewer's channel only when a valid token is present, so an anonymous request never 401s.
- The metadata response exposes the thumbnail as a **direct public URL** on the thumbnails bucket (`TD-03`), not a presigned one — that is the point of the public-read policy.
- Create `src/videos/dto/video-response.dto.ts` for the serialized shape, decorated for Swagger.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | A non-`ready` video raises `VideoNotFoundException` for a stranger and `VideoNotReadyException` for its owner; the download presign carries the content-disposition parameter |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against **real DB + MinIO**: the issued stream URL answers a `Range` request with `206` and a correct `Content-Range`; the download URL responds with `Content-Disposition: attachment` |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId` returns 200 anonymously for a `ready` video and 404 for a `draft` one; `GET /videos/:publicId/stream` returns 302 anonymously and the target serves `206` for a ranged request; `GET /videos/:publicId/download` returns 302 with an attachment disposition; two videos have distinct `publicId`s |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- An anonymous client can fetch metadata and stream a `ready` video — no token required
- Ranged playback returns `206 Partial Content` without downloading the whole file
- Download delivers the object with an attachment disposition and the original filename
- A `draft`, `processing` or `failed` video is `404` for everyone except its owner

---

### SI-03.12 — OpenAPI Refresh and Full-Flow E2E

**Description:** Regenerate the exported spec so the new endpoints are documented (`openapi-docs-nestjs/TD-02`), and cover the whole capability chain in one end-to-end test that exercises the real infrastructure.

**Technical actions:**

- Run `npm run openapi:export` and commit the refreshed `nestjs-project/openapi.json`.
- Verify `src/openapi-export.integration-spec.ts` still passes and extend its assertions to the `videos` tag.
- Add a full-flow scenario to `test/videos.e2e-spec.ts`: register + confirm + login (reusing the Phase 02 helpers) → initiate upload → `PUT` the parts to the presigned URLs → complete → drive the processing service inline (the e2e process is not the worker container, so it invokes `VideoProcessingService` directly rather than waiting on a container) → assert `ready` with duration, dimensions and thumbnail → `GET /videos/:publicId/stream` → follow the redirect with a `Range` header → assert `206`.
- Update `.env.example` and `nestjs-project/README.md` with the new services and variables.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/openapi-export.integration-spec.ts` | Integration | The exported spec contains the `videos` tag and all six paths with their documented responses |
| `test/videos.e2e-spec.ts` | E2E | The full chain from registration to a `206` ranged playback response, against real MinIO, Redis, Postgres and FFmpeg |

**Dependencies:** SI-03.11

**Acceptance criteria:**

- `openapi.json` documents all six video endpoints
- The full-flow e2e passes against the real Compose stack
- The complete Definition of Done passes: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` (exit 0) and `npm run lint`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identity; never in a public URL |
| public_id | varchar(16) | unique, not null | `randomBytes(8).toString('base64url')` — 11 chars (`TD-07`) |
| channel_id | uuid | not null, FK → `channels.id` | Owner (`TD-11` authorization anchor) |
| title | varchar(255) | not null | Supplied at upload initiation |
| status | `videos_status_enum` | not null, default `'draft'` | `draft` \| `processing` \| `ready` \| `failed` (`TD-09`) |
| original_filename | varchar(255) | not null | Used for the download disposition |
| mime_type | varchar(100) | not null | Validated against the supported set |
| storage_key | varchar(512) | nullable | `videos/{id}/source{ext}` (`TD-03`) |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; cleared on complete/abort |
| size_bytes | bigint | nullable | Declared at init, **corrected from `headObject`** on complete. TypeORM returns `bigint` as `string` |
| thumbnail_key | varchar(512) | nullable | `thumbnails/{id}/thumb.jpg`; set by the worker |
| duration_seconds | integer | nullable | From `ffprobe` |
| width | integer | nullable | From `ffprobe` |
| height | integer | nullable | From `ffprobe` |
| video_codec | varchar(50) | nullable | From `ffprobe` |
| audio_codec | varchar(50) | nullable | From `ffprobe`; null for video-only files |
| processing_error | text | nullable | Set only on terminal failure (`TD-09`) |
| created_at | timestamp | not null, auto | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one; a channel has many videos)
**Indexes:** `(public_id)` — unique; `(channel_id)`; `(status)`

---

### API Contracts

#### POST /videos/uploads (SI-03.6)

**Auth:** Bearer JWT required.

**Request body:**
- title: string, required — 1..255
- filename: string, required — 1..255
- mimeType: string, required — one of `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`
- sizeBytes: integer, required — positive, ≤ `UPLOAD_MAX_SIZE_BYTES` (10 GiB)

**Response 201:**
- videoId: string (uuid)
- publicId: string — 11 chars
- uploadId: string — S3 multipart id
- partSizeBytes: integer — 67108864
- parts: array of `{ partNumber: integer, url: string }`
- expiresIn: integer — seconds (3600)

**Error responses:**
- 401: missing or invalid token
- 404 CHANNEL_NOT_FOUND: the authenticated user has no channel
- 400 VIDEO_TOO_LARGE: `sizeBytes` above the configured maximum
- 415 UNSUPPORTED_VIDEO_TYPE: `mimeType` outside the supported set
- 400 validation error: malformed body

---

#### POST /videos/:videoId/uploads/complete (SI-03.7)

**Auth:** Bearer JWT required; caller must own the video's channel.

**Request body:**
- parts: array, required, non-empty — `{ partNumber: integer ≥ 1, etag: string }`

**Response 200:**
- videoId: string (uuid)
- publicId: string
- status: string — always `processing`

**Error responses:**
- 401: missing or invalid token
- 404 VIDEO_NOT_FOUND: unknown video, **or** a video owned by another channel
- 409 VIDEO_NOT_IN_DRAFT: the upload was already completed or aborted
- 400 UPLOAD_COMPLETION_FAILED: storage rejected the part/ETag list
- 400 validation error: malformed body

---

#### DELETE /videos/:videoId/upload (SI-03.8)

**Auth:** Bearer JWT required; caller must own the video's channel.

**Response 204:** No content.

**Error responses:**
- 401: missing or invalid token
- 404 VIDEO_NOT_FOUND: unknown video, or another channel's video
- 409 VIDEO_NOT_IN_DRAFT: the upload was already completed

---

#### GET /videos/:publicId (SI-03.11)

**Auth:** Public. A valid token, when present, additionally reveals the caller's own non-`ready` videos.

**Response 200:**
- publicId: string
- title: string
- status: string
- durationSeconds: integer \| null
- width: integer \| null
- height: integer \| null
- thumbnailUrl: string \| null — direct public URL on the thumbnails bucket
- sizeBytes: string \| null — `bigint` serialized as string
- channel: `{ id: string, nickname: string }`
- createdAt: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or a non-`ready` video the caller does not own

---

#### GET /videos/:publicId/stream (SI-03.11)

**Auth:** Public.

**Response 302:** `Location` — a presigned GET URL on the videos bucket, TTL 300 s. The target answers HTTP `Range` requests with `206 Partial Content` and `Content-Range`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or a non-`ready` video the caller does not own
- 409 VIDEO_NOT_READY: the caller owns the video but it is not `ready`

---

#### GET /videos/:publicId/download (SI-03.11)

**Auth:** Public.

**Response 302:** `Location` — a presigned GET URL carrying `response-content-disposition=attachment; filename="<original_filename>"`, TTL 300 s.

**Error responses:** identical to `GET /videos/:publicId/stream`.

---

### Authorization Matrix

Source: `phase-03-videos/TD-11`. The global `JwtAuthGuard` inherited from Phase 02 denies by default; `@Public()` is the opt-out.

| Endpoint | Guard | Anonymous | Authenticated, not owner | Owner |
|----------|-------|-----------|--------------------------|-------|
| `POST /videos/uploads` | JWT | 401 | 201 (creates in **their own** channel) | 201 |
| `POST /videos/:id/uploads/complete` | JWT | 401 | 404 | 200 |
| `DELETE /videos/:id/upload` | JWT | 401 | 404 | 204 |
| `GET /videos/:publicId` — `ready` | `@Public()` | 200 | 200 | 200 |
| `GET /videos/:publicId` — non-`ready` | `@Public()` | 404 | 404 | 200 |
| `GET /videos/:publicId/stream` — `ready` | `@Public()` | 302 | 302 | 302 |
| `GET /videos/:publicId/stream` — non-`ready` | `@Public()` | 404 | 404 | 409 |
| `GET /videos/:publicId/download` — `ready` | `@Public()` | 302 | 302 | 302 |
| `GET /videos/:publicId/download` — non-`ready` | `@Public()` | 404 | 404 | 409 |

**Invariant:** a video belonging to another channel is always reported as `404`, never `403`. Ownership must not be probeable, and an unprocessed upload's existence must not leak.

**Phase boundary:** public/unlisted visibility is a **Fase 04** capability. In this phase every `ready` video is publicly readable, matching the anonymous-access characteristic declared in `docs/project-plan.md`. Phase 04 layers its visibility filter over `findByPublicId` without restructuring the resolver.

---

### Error Catalog

New `DomainException` subclasses, following the Phase 02 contract (`errorCode`, `httpStatus`, `message`), rendered by the existing global `DomainExceptionFilter` into `{ statusCode, error, message }`.

| Error code | HTTP | Raised when | Introduced in |
|------------|------|-------------|---------------|
| `CHANNEL_NOT_FOUND` | 404 | The authenticated user has no channel to attach the video to | SI-03.2 |
| `VIDEO_TOO_LARGE` | 400 | Declared `sizeBytes` exceeds `UPLOAD_MAX_SIZE_BYTES` | SI-03.6 |
| `UNSUPPORTED_VIDEO_TYPE` | 415 | `mimeType` is outside the supported set | SI-03.6 |
| `VIDEO_NOT_FOUND` | 404 | Unknown video, another channel's video, or a non-`ready` video the caller does not own | SI-03.7 |
| `VIDEO_NOT_IN_DRAFT` | 409 | Complete or abort attempted on a video that has left `draft` | SI-03.7 |
| `UPLOAD_COMPLETION_FAILED` | 400 | Storage rejected the supplied part/ETag list | SI-03.7 |
| `VIDEO_NOT_READY` | 409 | The owner requests stream/download of their own non-`ready` video | SI-03.11 |

`processing_error` is **not** an HTTP error — it is a persisted diagnostic on the video row, surfaced through `status = failed`.

---

### Events / Messages

Source: `phase-03-videos/TD-01`, `TD-09` (including the 2026-07-28 revision).

#### Queue: `video-processing`

| Property | Value | Rationale |
|----------|-------|-----------|
| Broker | Redis (`redis:8-alpine`, `--appendonly yes`) | Job durability is Redis durability (`TD-01` Cons) |
| Producer | API — `VideoQueueService.enqueueProcessing` (SI-03.5) | |
| Consumer | `video-worker` container only — `VideoProcessor` (SI-03.10) | The API must not register the processor (`TD-04`) |

#### Job: `process-video`

**Payload:**

```json
{ "videoId": "<uuid>" }
```

The payload is deliberately minimal — the worker re-reads the row, so a job that waits in the queue can never act on stale metadata.

**Job options:**

| Option | Value | Source |
|--------|-------|--------|
| `attempts` | 3 | `TD-09` |
| `backoff` | `{ type: 'exponential', delay: 5000 }` | `TD-09` |
| `removeOnComplete` | `{ count: 100 }` | `TD-09` — bounded history |
| `removeOnFail` | `false` | `TD-09` — failed jobs retained for inspection |

**Worker options:**

| Option | Value | Source |
|--------|-------|--------|
| `concurrency` | 2 | `TD-04` — CPU-bound work isolated from the API |
| `stalledInterval` | 60000 ms | `TD-09` revision (`OQ-1`) — jobs are long-lived by design under `TD-06` |
| `maxStalledCount` | 2 | `TD-09` revision (`OQ-1`) |

**Outcomes:**

| Outcome | Effect on the video row |
|---------|------------------------|
| Success | `status = ready`; `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_key` persisted |
| Non-final attempt failure | Row untouched (`processing`); BullMQ retries after backoff |
| Final attempt failure | `status = failed`; `processing_error` persisted |
| Stall budget exhausted | Treated as a final failure — same terminal path, so `processing` always has a way out |

**Status transitions:**

```
draft ──(POST .../uploads/complete)──► processing ──(worker success)──► ready
                     │                       │
          (DELETE .../upload)        (attempts or stall budget exhausted)
                     │                       │
                     ▼                       ▼
              row deleted                 failed
```

---

### Storage Layout

Source: `phase-03-videos/TD-03`.

| Bucket | Policy | Keys | Contents |
|--------|--------|------|----------|
| `streamtube-videos` | Private | `videos/{videoId}/source{ext}` | Uploaded source files; reachable only via presigned URLs the API issues after authorization |
| `streamtube-thumbnails` | Public-read | `thumbnails/{videoId}/thumb.jpg` | Worker-generated frames; served directly so Phases 04/05 can render listings without a signing round-trip |

Both buckets are created idempotently at application bootstrap (SI-03.4) — a cold `docker compose up` self-provisions with no manual `mc` step.

---

### Environment Variables

| Variable | Default | Consumed by |
|----------|---------|-------------|
| `S3_ENDPOINT` | `http://minio:9000` | Server-side S3 calls and the worker's presigned read |
| `S3_PUBLIC_ENDPOINT` | `http://minio:9000` (dev) | Presigning URLs handed to external clients |
| `S3_REGION` | `us-east-1` | SigV4 signer (value arbitrary, presence mandatory) |
| `S3_ACCESS_KEY_ID` | — (**required**) | Both S3 clients |
| `S3_SECRET_ACCESS_KEY` | — (**required**) | Both S3 clients |
| `S3_FORCE_PATH_STYLE` | `true` | Both S3 clients — **mandatory for MinIO** |
| `S3_VIDEOS_BUCKET` | `streamtube-videos` | Storage service |
| `S3_THUMBNAILS_BUCKET` | `streamtube-thumbnails` | Storage service |
| `UPLOAD_PART_SIZE_BYTES` | `67108864` (64 MiB) | Part-count computation |
| `UPLOAD_MAX_SIZE_BYTES` | `10737418240` (10 GiB) | Initiation validation |
| `UPLOAD_URL_TTL_SECONDS` | `3600` | Part presigning |
| `DELIVERY_URL_TTL_SECONDS` | `300` | Stream/download presigning |
| `WORKER_URL_TTL_SECONDS` | `7200` | Worker FFmpeg input presigning |
| `REDIS_HOST` | `redis` | BullMQ connection |
| `REDIS_PORT` | `6379` | BullMQ connection |
| `VIDEO_QUEUE_NAME` | `video-processing` | Producer and consumer |
| `VIDEO_JOB_ATTEMPTS` | `3` | Job options |
| `VIDEO_JOB_BACKOFF_MS` | `5000` | Job options |
| `VIDEO_WORKER_CONCURRENCY` | `2` | Worker options |
| `VIDEO_STALLED_INTERVAL_MS` | `60000` | Worker options |
| `VIDEO_MAX_STALLED_COUNT` | `2` | Worker options |

> **Why `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` are separate.** SigV4 signs the `Host` header, so an endpoint cannot be substituted after signing. A URL signed against `http://minio:9000` is unusable outside the Compose network; one signed against a browser-facing host is unusable by the worker. Two clients, each signing for its own consumer, is the only correct resolution. In dev both point at `http://minio:9000` so integration and e2e specs — which run inside the network — exercise the real path.

---

## Dependency Map

```
SI-03.1 (no deps — deps, config, minio, redis, ffmpeg in dev image)
├── SI-03.4 (storage module)
└── SI-03.5 (queue module + producer)

SI-03.2 (no deps — ChannelsService.findByUserId)
└── SI-03.3 (Video entity + migration)

SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6 (upload initiation)
    ├── SI-03.7 (upload completion + enqueue)
    └── SI-03.8 (upload abort)

SI-03.4
└── SI-03.9 (FfmpegRunner + VideoProcessingService)

SI-03.5 + SI-03.7 + SI-03.9
└── SI-03.10 (worker process, image, compose service)
    └── SI-03.11 (metadata, streaming, download)
        └── SI-03.12 (OpenAPI refresh + full-flow e2e)
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4, SI-03.5 (parallel) → SI-03.6 → SI-03.7, SI-03.8 (parallel) → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12

---

## Deliverables

- [ ] MinIO object storage service running in Docker Compose, with both buckets auto-provisioned at bootstrap
- [ ] Redis queue broker running in Docker Compose with persistence enabled
- [ ] `video-worker` container running in Docker Compose from its own FFmpeg-bearing image
- [ ] Migration creating the `videos` table, its status enum, FK to `channels` and indexes — reversible without leaving orphan objects
- [ ] Upload of files up to 10GB via presigned S3 multipart, with **no video byte passing through the API**
- [ ] Automatic pre-registration of the video as `draft` when the upload is initiated
- [ ] Automatic processing after upload completion — duration, resolution and codecs extracted with `ffprobe`
- [ ] Automatic thumbnail generation from a video frame, stored in the public thumbnails bucket
- [ ] Unique public URL per video (11-char `base64url`), enforced by a unique index
- [ ] Streaming via `302` to a presigned URL answering `Range` requests with `206 Partial Content`
- [ ] Download endpoint delivering the file with an attachment disposition and the original filename
- [ ] Video status lifecycle `draft → processing → ready | failed` reflected in the database, with bounded retries and a persisted `processing_error`
- [ ] Upload abort endpoint releasing both the draft row and the multipart parts
- [ ] `openapi.json` regenerated with all six video endpoints documented
- [ ] Unit tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`, exit 0)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Root `CLAUDE.md` updated with the videos module, endpoints, queue/worker and storage — consistent with the code

**Explicitly deferred (recorded, not dropped):**

- Bucket lifecycle rule `AbortIncompleteMultipartUpload` for silently abandoned uploads — `TD-12` adopts the explicit abort endpoint and records the lifecycle rule as the natural follow-up
- Bucket CORS configuration for browser-origin part uploads — no frontend consumes this API in Phase 03
- Video visibility (public/unlisted), title/description editing, custom thumbnails and the management panel — **Fase 04**
