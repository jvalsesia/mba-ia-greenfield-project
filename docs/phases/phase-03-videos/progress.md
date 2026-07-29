# phase-03-videos — Progress

**Status:** completed
**SIs:** 12/12 completed

**Definition of Done (final run):**

- `npm test -- --runInBand` — 34 suites, **231 tests passing**
- `npm run test:e2e` — 4 suites, **69 tests passing**
- `npx tsc --noEmit` — exit 0
- `npm run lint` — exit 0 (1 inherited warning, 0 errors)

---

### SI-03.1 — Dependencies, Configuration Namespaces, and Storage/Queue Infrastructure
- **Status:** completed
- **Tests:** 10/10 passing (`env.validation.integration-spec.ts`)
- **Observations:** `library-refs.md` reconciled against the installed tree per the `IC-1` obligation — `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` resolved to **3.1097.0**, not the 3.1096.0 recorded at research time; pins updated. `storage.config` splits `S3_ENDPOINT` from `S3_PUBLIC_ENDPOINT` because SigV4 signs the `Host` header, so an endpoint cannot be substituted after signing. Redis runs with `--appendonly yes`: BullMQ job durability is Redis durability. `ffmpeg` installed in `Dockerfile.dev` as well as the worker image (resolves `IC-2`), since the project's convention runs every test inside `nestjs-api`.

### SI-03.2 — Channel Lookup by User
- **Status:** completed
- **Tests:** 28/28 passing (`channels.service.spec.ts`, `channels.service.integration-spec.ts`)
- **Observations:** Resolves `DG-1`. `findByUserId` lives in `ChannelsService`, not `VideosService` — `channels` is that module's table, per the Single Responsibility rule in the root `CLAUDE.md`.

### SI-03.3 — Video Entity, Public ID Generator, and Migration
- **Status:** completed
- **Tests:** 13/13 passing (`public-id.util.spec.ts`, `video.entity.integration-spec.ts`, `migrations.integration-spec.ts`)
- **Observations:** `size_bytes` is `bigint`, which TypeORM returns as a **string**; typing it as `number` would silently corrupt sizes near the 10 GiB ceiling, so the entity property and the API response both keep it a string. Adding the FK to `channels` surfaced two ordering bugs in shared test helpers: the migration spec deadlocked dropping tables concurrently, and `cleanAllTables` deleted channels before videos. Both now run children-first, sequentially.

### SI-03.4 — Storage Module (S3 Client, Presigning, Bucket Bootstrap)
- **Status:** completed
- **Tests:** 12/12 passing (`storage.keys.spec.ts`, `storage.service.integration-spec.ts`)
- **Observations:** Two S3 clients, not one — the internal endpoint for server-side calls and the worker's reads, the public endpoint for URLs handed to external clients. `forcePathStyle: true` is mandatory for MinIO; the SDK's virtual-hosted default cannot resolve a container hostname. `responseContentDisposition` is passed to `GetObjectCommand` **before** signing — appending it afterwards invalidates the signature. Integration tests run against the real MinIO: a two-part upload assembles into bytes matching the source (parts submitted deliberately out of order), a ranged GET returns `206` with a correct `Content-Range`, abort removes the upload from `ListMultipartUploads`, and anonymous reads succeed on thumbnails while failing on videos.

### SI-03.5 — Queue Module and Job Producer
- **Status:** completed
- **Tests:** 4/4 passing (`video-queue.service.spec.ts`, `video-queue.service.integration-spec.ts`)
- **Observations:** The queue name is read from `process.env` at module-load time, because `@InjectQueue` / `@Processor` resolve their DI token when the decorator evaluates — before `ConfigModule` runs. Compose now passes `.env` via `env_file` so the value exists before any application code executes. The integration spec pauses the queue for its duration: once the worker container was running it consumed the job before the assertions could observe it.

### SI-03.6 — Upload Initiation (Draft Pre-registration + Presigned Parts)
- **Status:** completed
- **Tests:** 25/25 unit + e2e coverage (`videos.service.spec.ts`, `videos.e2e-spec.ts`)
- **Observations:** A 10 GiB declared upload yields exactly 160 parts of 64 MiB — under S3's 10,000-part cap and above its 5 MiB minimum. `public_id` insertion retries on a unique violation; the constraint, not the generator's entropy, is what guarantees uniqueness.

### SI-03.7 — Upload Completion and Automatic Processing Trigger
- **Status:** completed
- **Tests:** covered by `videos.service.spec.ts` and `videos.e2e-spec.ts`
- **Observations:** `size_bytes` is re-read from `HeadObject` rather than trusted from the client's declaration. The status write happens **before** the enqueue — a job arriving first would read a `draft` row and fail spuriously; a unit test pins that ordering.

### SI-03.8 — Upload Abort
- **Status:** completed
- **Tests:** covered by `videos.service.spec.ts` and `videos.e2e-spec.ts`
- **Observations:** Implements `TD-12`. The complementary bucket lifecycle rule for silently abandoned uploads is recorded as a follow-up, not shipped — no test in this phase could meaningfully assert a multi-day rule.

### SI-03.9 — FFmpeg Runner and Video Processing Service
- **Status:** completed
- **Tests:** 19/19 passing (`video-metadata.spec.ts`, `video-processing.service.spec.ts`, `video-processing.service.integration-spec.ts`)
- **Observations:** `-ss` is placed **before** `-i` so FFmpeg seeks to the thumbnail frame rather than decoding from the start — the property that makes `TD-06`'s HTTP-input strategy fast on a large file. Arguments are passed to `spawn` as an array with `shell: false`, so a signed URL can never be interpreted as shell syntax. Integration tests drive real FFmpeg against real MinIO with a `lavfi`-generated fixture, and assert the JPEG magic number so an empty file cannot pass.

### SI-03.10 — Worker Process, Image, and Compose Service
- **Status:** completed
- **Tests:** 7/7 passing (`video.processor.spec.ts`) plus the worker-container e2e
- **Observations:** `WorkerModule` lists entities explicitly rather than auto-loading — its graph registers only `Video` via `forFeature`, but `Video` relates to `Channel` and `Channel` to `User`, and TypeORM needs the whole reachable graph or it fails at startup (this failed first and was fixed). `@Processor` is provided only in the worker graph, so the API never consumes jobs. A non-final attempt leaves the row in `processing`; only an exhausted attempt budget writes `failed` with `processing_error`.

### SI-03.11 — Video Delivery: Metadata, Streaming, and Download
- **Status:** completed
- **Tests:** covered by `videos.service.spec.ts` (authorization matrix) and `videos.e2e-spec.ts` (real `302` → `206`)
- **Observations:** Implements `TD-11`. A non-`ready` video answers `404` to strangers and `409 VIDEO_NOT_READY` to its owner; ownership is never reported as `403`, so a video's existence is not probeable. `JwtAuthGuard` was extended to attach the principal on `@Public()` routes when a valid token is present — the delivery endpoints are public but behave differently for the owner.

### SI-03.12 — OpenAPI Refresh and Full-Flow E2E
- **Status:** completed
- **Tests:** 17/17 passing (`videos.e2e-spec.ts`); full e2e suite 69/69
- **Observations:** `openapi.json` regenerated with all six video paths. `npm run test:e2e` was running suites **in parallel** against one database despite `CLAUDE.md` documenting `--runInBand`; adding the videos suite exposed it as cross-suite FK violations. `maxWorkers: 1` is now pinned in `test/jest-e2e.json` so the guarantee holds however jest is invoked. One e2e test enqueues a real job and waits for the `video-worker` container to finish it, with no manual step.

---

## Out-of-scope work done first (separate branches, merged through `dev`)

Both were pre-existing failures that blocked this phase's Definition of Done. Neither is Phase 03 scope, so each was fixed on its own `bugfix/*` branch before implementation started.

### `bugfix/migration-spec-idempotency`
`migrations.integration-spec.ts` was green only against a virgin schema. Its `beforeAll` dropped the managed tables but not the enum type they use, and Postgres keeps enum types independent of the tables referencing them — so the previous run's `afterAll` left `verification_tokens_type_enum` behind and the next run failed on `CREATE TYPE`. The failure also left the `DataSource` open, so jest hung instead of reporting it. Verified by running the full suite twice consecutively.

### `bugfix/eslint-baseline`
`npm run lint` failed on `dev` with **150 errors** before any Phase 03 work. Fixed by typing what was untyped, not by relaxing rules — no eslint config was changed. Four origins: supertest's `any` response bodies (now a typed helper in `src/test/api-response.ts`), untyped mailpit helpers, `jest.Mocked<T>` collaborators producing unbound-method references and forcing 35 `as any` casts, and two production sites reaching driver-error fields through `as any`.

---

## Known gaps and follow-ups

| Item | Why it is open |
|------|----------------|
| `nestjs-project/.env.example` not updated | The file is blocked for read **and** write by this environment's permission settings, so it could not be edited. Every new key is documented in `phase-03-videos.md` § Environment Variables and declared in `src/config/env.validation.ts`, which is the source of truth. |
| `context7` MCP unavailable | Recorded as `IC-1`; substitute sources are disclosed in `library-refs.md` § Provenance. Configuring the server remains the permanent fix. |
| Bucket lifecycle rule for abandoned uploads | `TD-12` adopts the explicit abort endpoint and records the lifecycle rule as the natural follow-up. |
| Bucket CORS for browser-origin part uploads | No frontend consumes this API in Phase 03; needed when the upload screen lands in Phase 04. |
| Pre-existing lint warning | `auth.service.integration-spec.ts:479` — `no-unsafe-argument`, a warning rather than an error; does not fail `npm run lint`. |
