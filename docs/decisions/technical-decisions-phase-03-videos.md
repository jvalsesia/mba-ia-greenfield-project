---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-28
scope_description: "Video upload and processing foundation: object storage layout, background job queue, 10GB direct-to-storage upload handshake, FFmpeg worker for metadata/thumbnail extraction, unique public video URL, range streaming and download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns every capability of this phase: the `videos` module (upload handshake, status lifecycle, unique URL, streaming/download delivery), the object storage integration, the queue producer, and the FFmpeg worker process. Also owns the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — **no open decision in this document.** Phase 03 is a backend-only phase: `docs/project-plan.md` lists no screen among its capabilities, and the video UI (upload screen, player page, management panel) is delivered by Phases 04 and 05. No frontend TD applies.

**Object storage is not an open decision.** `docs/project-plan.md` and `docs/diagrams/software-arch.mermaid` already fix S3-compatible object storage (MinIO locally in Docker, S3 in production). What this document decides is *how* to use it — bucket/key layout (TD-03), the upload handshake (TD-02) and the delivery path (TD-08) — not *which* storage.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and the C4 container diagram leave the Message Queue explicitly as **TBD** — this is the single genuinely open stack decision of the phase. The queue carries one job type in this phase (`process-video`), enqueued by the API when an upload completes and consumed by a separate worker container. The choice determines a new Compose service (or the absence of one), the NestJS integration surface, and how retries/backoff/failure states are expressed. The video status lifecycle (TD-09) and the worker runtime (TD-04) both depend on this decision.

**Options:**

### Option A: BullMQ + Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue. The API injects a `Queue` and calls `add()`; the worker declares a `@Processor()` class consuming the same queue name. Adds one Redis container to Compose.
- **Pros:** `@nestjs/bullmq` is a first-party NestJS package with declared support for `@nestjs/core` ^11 — matching the installed NestJS 11. Retries with exponential backoff, per-job attempts, concurrency, job progress, delayed jobs, and a failed-job set are native primitives, not hand-rolled. Largest ecosystem for this use case; the producer/consumer split maps directly onto the API/worker container split. CJS build (`dist/cjs`), so it drops into the project's CommonJS + ts-jest setup without ESM friction.
- **Cons:** Adds Redis as a new infrastructure dependency (one more container, one more service to keep healthy). Redis persistence must be enabled (AOF) or jobs are lost on broker restart. Two datastores to reason about instead of one.

### Option B: pg-boss (queue inside the existing PostgreSQL)
- Job queue implemented as tables in the PostgreSQL instance already in the stack. `pg-boss` manages its own schema, polling, and job states.
- **Pros:** Zero new infrastructure — no extra Compose service, no extra healthcheck, no new failure mode. Jobs and domain data share one transaction boundary, so "create video row + enqueue job" can be genuinely atomic. Postgres durability comes for free.
- **Cons:** No official NestJS module — the lifecycle (start/stop, graceful shutdown, worker registration) is wired by hand. Polling-based, so latency and DB load grow with poll frequency. Its schema lives in the same database the project's migrations own, which muddies the migration story. Far less operational tooling than BullMQ for inspecting stuck/failed jobs.

### Option C: RabbitMQ (`@golevelup/nestjs-rabbitmq` or NestJS microservice transport)
- A dedicated AMQP broker container; the API publishes to an exchange, the worker binds a queue.
- **Pros:** A real message broker with mature routing, per-message acknowledgement, and dead-letter exchanges. Well suited if the project later grows fan-out to several independent consumers.
- **Cons:** Heaviest option operationally (broker + management plane) for a phase with exactly one job type and one consumer. Retry-with-backoff and delayed redelivery require explicit DLX/TTL plumbing rather than a config flag. The NestJS integration is community-maintained, not first-party.

**Recommendation:** **Option A — BullMQ + Redis.** The phase needs retry-with-exponential-backoff, a durable failed-job record and a dedicated worker process, and BullMQ provides all three as configuration rather than as code we must write and test ourselves. `@nestjs/bullmq` 11.x declares `@nestjs/core` ^11 as a peer, so it matches the installed framework version exactly, and BullMQ ships a CommonJS build compatible with the project's `ts-jest` setup. pg-boss's "no new container" advantage is real but is paid for with hand-wired lifecycle code and a second schema owner inside the project's own database; RabbitMQ's routing power is unused at one-producer/one-consumer. The added Redis container is the honest cost of this choice.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-02: 10GB Upload Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The phase's headline non-functional requirement is a 10GB upload that does not degrade the API. This is an architecture decision, not a tuning exercise: it determines whether video bytes ever traverse the Node.js process, what the client-facing handshake looks like, and where the draft video row is created. A hard constraint drives it: **a single S3 `PUT` — including a presigned one — caps at 5 GB**, so a 10GB object *cannot* be uploaded in one request against S3-compatible storage. Multipart upload (max 10,000 parts, 5 MiB–5 GiB per part, last part exempt from the minimum) is the only S3 mechanism that reaches 10GB.

**Options:**

### Option A: Presigned multipart upload — client uploads directly to storage
- Three API calls frame the transfer, and no video byte passes through the API. `POST /videos/uploads` creates the draft video row and calls `CreateMultipartUpload`, returning the `videoId`, `uploadId` and a batch of presigned `UploadPart` URLs. The client `PUT`s each part straight to MinIO/S3 and collects the returned `ETag`s. `POST /videos/:id/uploads/complete` sends the part/ETag list back; the API calls `CompleteMultipartUpload` and enqueues the processing job.
- **Pros:** The API never buffers, streams or proxies the payload — Node.js event-loop and memory stay flat regardless of file size, which is exactly what "sem impacto na performance" asks for. Parts upload in parallel and a failed part is retried individually instead of restarting 10GB. Works unchanged against real S3 in production. `AbortMultipartUpload` gives a clean cancel/cleanup path.
- **Cons:** The most elaborate client contract of the three — the client must chunk the file, track ETags per part, and call complete. Requires CORS configuration on the bucket for browser clients. Orphaned multipart uploads (client abandons midway) accumulate storage until aborted by a lifecycle rule or a cleanup routine.

### Option B: Stream the upload through the API into storage
- The client `POST`s the file to a NestJS endpoint; the handler pipes the request stream into `@aws-sdk/lib-storage`'s `Upload`, which performs the multipart upload server-side.
- **Pros:** Simplest possible client contract — one request, one file field. Storage credentials never leave the server. No bucket CORS needed.
- **Cons:** Every byte crosses the API process. One 10GB upload occupies a Node.js connection and its buffers for the entire transfer; a handful of concurrent uploads saturate the API's network and memory — the precise failure the capability forbids. A dropped connection loses the whole transfer with no resume. API instances must be scaled for transfer bandwidth rather than for request throughput.

### Option C: tus resumable upload protocol (`@tus/server`)
- An open resumable-upload protocol. The client creates an upload, `PATCH`es chunks at tracked offsets, and can resume after a disconnect.
- **Pros:** Best-in-class resumability semantics, including across browser sessions. Mature client libraries (Uppy).
- **Cons:** The tus server still terminates the byte stream in the API process — it inherits Option B's core problem while adding a protocol and a dependency. Its S3 store is an extra integration layer over the same multipart primitive Option A uses directly. Significant new surface for a capability that S3 multipart already satisfies.

**Recommendation:** **Option A — presigned multipart upload direct to storage.** It is the only option that keeps 10GB of video out of the API process entirely, which is the literal requirement; Options B and C both terminate the stream in Node.js and differ only in how gracefully they recover from a drop. Option A also resolves the 5 GB single-`PUT` ceiling by construction, gives per-part retry for free, and is the same handshake the code would use against production S3. The added client complexity is real and is the price of the requirement. Concretely: part size **64 MiB** (10GB → ~160 parts, comfortably under the 10,000-part cap and above the 5 MiB minimum), presigned URL TTL **1 hour**, and a declared `sizeBytes` validated against a **10 GiB** ceiling at initiation.

**Decision:** A (Presigned S3 multipart upload, direct to storage)

---

## TD-03: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails have different sizes, different access patterns and different sensitivity. The layout decided here is a cross-component contract — it is referenced by the storage service, the worker, the Compose bootstrap that creates the buckets, and the environment schema — and it constrains what the delivery decision (TD-08) can do, because a public-read bucket and a presigned-only bucket give different delivery options.

**Options:**

### Option A: Two buckets — `streamtube-videos` (private) and `streamtube-thumbnails` (public-read)
- Video objects at `videos/{videoId}/source{ext}`; thumbnails at `thumbnails/{videoId}/thumb.jpg`. The video bucket denies anonymous access; the thumbnail bucket carries a public-read policy.
- **Pros:** Access policy is expressed at the bucket level, where S3 and MinIO naturally enforce it, instead of per-object. Thumbnails become directly linkable from `<img src>` with no signing round-trip and are trivially CDN-frontable in production — which is what Phases 04/05 will need. Bucket-level lifecycle rules (e.g. aborting incomplete multipart uploads) can target videos without touching thumbnails.
- **Cons:** Two buckets to create and configure at bootstrap instead of one. Thumbnails are world-readable by anyone who knows the video id, so an unlisted video's thumbnail is not secret.

### Option B: Single bucket `streamtube-media`, all private, prefixes per kind
- One bucket with `videos/{videoId}/…` and `thumbnails/{videoId}/…` prefixes; every read goes through a presigned URL or an API proxy.
- **Pros:** One bucket to provision. Uniform access rule — nothing is public, so visibility (public/unlisted, Phase 04) is enforced entirely by the API.
- **Cons:** Every thumbnail render costs a signing round-trip or an API proxy hop, which is wasteful for a listing page showing dozens of thumbnails. Presigned thumbnail URLs expire, so they cannot be cached in HTML or by a CDN.

**Recommendation:** **Option A — two buckets, videos private and thumbnails public-read.** The two asset classes genuinely differ: a video is the protected payload whose delivery the API must gate, while a thumbnail is a small derived image that Phases 04 and 05 will render in listings by the dozen. Expressing that difference as bucket policy is simpler and cheaper than signing every thumbnail, and it leaves the video bucket with a single, uniform "never public" rule. The exposure this accepts is bounded and explicit: a thumbnail is guessable only from the `videoId`, and it carries no content beyond one frame the uploader chose to publish.

**Decision:** A (Two buckets — `streamtube-videos` private, `streamtube-thumbnails` public-read)

---

## TD-04: Worker Runtime and Deployment Shape

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram models the Video Worker as a container distinct from the API. The worker needs the FFmpeg binaries (which the API does not) and must not compete with HTTP request handling for CPU, since transcoding-class work saturates cores. What is open is whether it is a separate codebase or a second entrypoint into the existing one, and how it is packaged.

**Options:**

### Option A: Same codebase, separate entrypoint and Docker image
- A `src/worker.ts` bootstraps `NestFactory.createApplicationContext(WorkerModule)` — a Nest context with no HTTP listener. A `Dockerfile.worker` builds from the same source with `ffmpeg` installed, and Compose runs it as a `video-worker` service.
- **Pros:** Entities, config namespaces, the storage service and the domain exception types are shared by import — no duplication and no drift between what the API writes and what the worker reads. One `package.json`, one lint/tsc/test pipeline, one migration owner. The separate image keeps the ~100MB FFmpeg install out of the API image, and the separate container gives the process isolation the architecture calls for.
- **Cons:** Both images build from the same context, so an API-only change still rebuilds the worker image. The worker module graph must be curated so importing it does not drag in HTTP controllers.

### Option B: Separate npm project (`video-worker/`)
- A standalone Node project with its own manifest, consuming the queue and the storage.
- **Pros:** Hard boundary; the worker can diverge in runtime and dependencies freely.
- **Cons:** Entity definitions, storage keys, config parsing and status enums must be duplicated or extracted into a shared package — a monorepo tooling decision this phase has no reason to take on. Two test suites and two toolchains for one deliverable. The Definition of Done (`tsc`, lint, tests) would have to be satisfied twice.

### Option C: In-process worker inside the API container
- The API registers the BullMQ processor in its own process.
- **Pros:** No new container, no new image, simplest Compose.
- **Cons:** FFmpeg competes with HTTP handling for CPU in the same process tree, so a single long processing job degrades API latency — and the architecture diagram explicitly models the worker as its own container. Cannot be scaled independently of the API.

**Recommendation:** **Option A — same codebase, separate entrypoint and image.** It satisfies the architecture's process separation and keeps FFmpeg out of the API image, while avoiding the duplication tax that Option B charges for a boundary this phase does not need; Option C is ruled out by the diagram and by the CPU-contention argument. Concretely: `src/worker.ts` + `src/videos/worker/` for the processor, a `Dockerfile.worker` installing `ffmpeg`, and a `video-worker` Compose service sharing the `.env` and depending on `db`, `redis` and `minio`.

**Decision:** A (Same codebase, separate entrypoint and Docker image)

---

## TD-05: FFmpeg Invocation — Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** The worker must read duration, resolution, codec and container from the uploaded file, and cut one frame into a JPEG thumbnail. Both are FFmpeg-family operations (`ffprobe` for the former, `ffmpeg` for the latter). The decision is how the Node process drives those binaries, which determines the error surface, how the operation is unit-testable, and whether a dependency is added.

**Options:**

### Option A: Direct `child_process.spawn` of `ffprobe` / `ffmpeg`
- `ffprobe -v error -print_format json -show_format -show_streams <input>` returns parseable JSON; `ffmpeg -ss <t> -i <input> -frames:v 1 -q:v 2 -f image2 <out.jpg>` cuts the frame. A thin `FfmpegRunner` wraps `spawn`, and the service depends on that interface.
- **Pros:** No dependency, no wrapper semantics to learn — the FFmpeg CLI *is* the documented API, and its flags are stable across versions. Full control over argument construction, stdout/stderr capture and exit codes, so failures surface as real diagnostics instead of a wrapper's generic error. Injecting the runner makes the service unit-testable without a binary, while integration tests exercise the real one. Argument arrays passed to `spawn` are not shell-interpreted, so storage keys and URLs cannot inject shell syntax.
- **Cons:** Command construction and JSON parsing are hand-written (roughly 40–60 lines). No convenience helpers for progress events or filter graphs.

### Option B: `fluent-ffmpeg`
- A fluent JS wrapper (`ffmpeg(input).screenshots({...})`, `ffmpeg.ffprobe(...)`).
- **Pros:** Terser call sites for common operations. Built-in progress events. Widely used in tutorials, so patterns are easy to find.
- **Cons:** Adds a runtime dependency plus a separate `@types` package for a task the CLI already expresses in two commands. The project's needs (one probe, one frame extract) use a sliver of its surface. Its maintenance cadence has been intermittent, which is a poor trade for code that must run unattended in a worker. Errors arrive wrapped, obscuring the underlying FFmpeg stderr that actually explains a decode failure.

**Recommendation:** **Option A — direct `spawn`.** The phase needs exactly two FFmpeg invocations, and both are single, well-documented command lines; a wrapper's abstraction earns its keep on filter graphs and transcode pipelines, neither of which is in scope. Direct `spawn` keeps FFmpeg's own stderr — the only useful signal when a file fails to decode — and an injected `FfmpegRunner` interface gives clean unit tests without shipping a dependency whose maintenance the project would inherit.

**Decision:** A (Direct `child_process.spawn` of `ffprobe`/`ffmpeg`)

---

## TD-06: How the Worker Reads the Source File

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** The uploaded object lives in MinIO, not on the worker's filesystem, but FFmpeg needs an input. At 10GB this is not a detail: the naive path copies the entire object to local disk before probing it. The decision governs the worker's disk footprint and how long a job holds resources — and it depends on TD-02 having placed the file in object storage rather than on a shared volume.

**Options:**

### Option A: Presigned GET URL as the FFmpeg input
- The worker asks the storage service for a short-lived presigned GET URL and passes it directly as FFmpeg's input. FFmpeg's HTTP protocol issues HTTP Range requests, so `ffprobe` fetches only the header/index regions and `ffmpeg -ss <t> -i <url>` seeks to the target frame without reading the file linearly.
- **Pros:** No local copy — worker disk stays flat whether the video is 5MB or 10GB, and no temp-file cleanup path can leak. Job wall time is dominated by the seek, not by a full transfer, so a 10GB video is probed in seconds. Identical against production S3.
- **Cons:** Depends on FFmpeg being built with network protocol support (true for standard distro builds). An MP4 whose `moov` atom sits at the end costs extra range requests to locate the index. A presigned URL expiring mid-job fails the job — TTL must exceed the worst-case job duration.

### Option B: Download the object to a temp file, then run FFmpeg
- The worker `GetObject`s to `/tmp/{videoId}` and passes the path to FFmpeg, deleting it in a `finally`.
- **Pros:** FFmpeg reads local disk, which is the most predictable I/O path and immune to network hiccups mid-probe. No URL expiry concern.
- **Cons:** Requires up to 10GB of free disk **per concurrent job**, making worker concurrency a function of disk rather than CPU. Transfers the whole file just to read a header and one frame — minutes of pure overhead per large video. Introduces temp-file lifecycle as a failure mode (leaks on crash, fills the volume).

**Recommendation:** **Option A — presigned URL as FFmpeg input.** The phase's defining constraint is that 10GB files must not be moved around gratuitously, and this option honours it in the worker exactly as TD-02 honours it in the API: the bytes stay in object storage and only the needed ranges are read. Option B's robustness is real but is bought with a per-job disk budget equal to the largest supported upload, which caps concurrency on the wrong resource. Set the presigned TTL for worker reads to **2 hours**, comfortably above any realistic probe-and-frame job.

**Decision:** A (Presigned GET URL as FFmpeg input)

---

## TD-07: Unique Public Video URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a public identifier that appears in its URL and cannot collide with another video's. The internal primary key is a UUID (the convention established by the Phase 02 entities), but the public identifier is a separate concern: it is user-visible, it is typed and shared, and Phases 04/05 will route on it. The choice is a cross-component contract — entity column, unique index, API contract and route parameter all cite it.

**Options:**

### Option A: Short random slug from `node:crypto`, unique-indexed
- `randomBytes(8).toString('base64url')` yields an 11-character URL-safe string (~64 bits of entropy) stored in a `public_id` column with a unique constraint; a collision on insert is retried.
- **Pros:** Short and clean in a URL (`/watch/V1StGXR8_Z5`), the shape users expect from a video platform. No dependency — `node:crypto` is standard library. Cryptographically random, so ids are not enumerable and one video's URL reveals nothing about another's. The database unique constraint, not the generator, is the final authority on uniqueness, so correctness does not rest on a probability argument.
- **Cons:** A second identifier per row alongside the UUID primary key — code must be clear about which one crosses the API boundary. Needs a retry path on the (astronomically unlikely) collision.

### Option B: Reuse the UUID primary key as the public identifier
- The route is `/watch/{uuid}`.
- **Pros:** Nothing new — no column, no index, no generator, no collision path. One identifier, zero ambiguity.
- **Cons:** A 36-character URL is unwieldy to share and unlike any comparable platform. Leaks the internal primary key into the public surface, coupling the URL to the storage identity forever.

### Option C: `nanoid`
- The de-facto library for short URL-safe ids.
- **Pros:** Purpose-built, well-audited, configurable alphabet and length.
- **Cons:** **nanoid 6 is ESM-only** (`"type": "module"`, `engines.node ^22 || ^24 || >=26`) and the backend is CommonJS compiled by `ts-jest` — adopting it means pinning the legacy 3.x line or taking on ESM interop in a CJS project. That cost buys a `randomBytes` call the standard library already provides.

**Recommendation:** **Option A — `randomBytes(8).toString('base64url')` with a unique index.** It produces the short shareable URL the capability implies while adding no dependency, and it sidesteps the ESM/CJS friction that disqualifies current `nanoid` for this codebase. Option B is the cheapest but permanently welds a 36-character internal key into the public URL. Uniqueness is guaranteed by the `UNIQUE` constraint on `public_id` with a bounded insert retry, not by entropy alone.

**Decision:** A (`randomBytes(8).toString('base64url')` + unique index)

---

## TD-08: Streaming and Download Delivery Path

**Scope:** Backend

**Capability:** Transversal — covers: `Reprodução via streaming (sem necessidade de download completo)`, `Download do vídeo pelo usuário`

**Context:** A `<video>` element plays by issuing HTTP Range requests and expecting `206 Partial Content` with a `Content-Range` header; download is the same object served with `Content-Disposition: attachment`. The decision is whether the API sits in the byte path for playback. It is the read-side mirror of TD-02 and is constrained by TD-03: the video bucket is private, so anonymous playback must be authorised by the API one way or another.

**Options:**

### Option A: API returns `302` to a short-lived presigned GET URL
- `GET /videos/:publicId/stream` authorises the request (video exists, status `ready`, visibility allows it), then redirects to a presigned GET URL. The player follows the redirect and negotiates Range directly with MinIO/S3, which answers `206` natively. `GET /videos/:publicId/download` issues the same URL with `response-content-disposition=attachment` so the object downloads under its original filename.
- **Pros:** Consistent with TD-02 — video bytes never cross the API on the way out either, so playback bandwidth does not scale API instances. Range/`206`/`Content-Range` are handled by the storage layer, which implements them correctly and completely; there is no hand-written range parser to get wrong. In production the presigned URL is trivially swapped for a CDN signed URL. Authorisation still runs on every request, because the redirect is only issued after the check.
- **Cons:** The presigned URL is a bearer capability for its lifetime — it can be copied out of devtools and shared until it expires, so TTL must be short. Two round-trips before the first byte. The client must follow redirects (browsers and `<video>` do; test clients need `.redirects()`).

### Option B: API proxies the range request
- The endpoint parses the `Range` header, calls `GetObject` with the matching byte range, and pipes the result back with `206` and `Content-Range`.
- **Pros:** The storage URL is never exposed and cannot be shared. Per-request authorisation over every byte, giving exact control. `206` is emitted by our own code, which is the most direct thing to assert in a test.
- **Cons:** Every played byte crosses the API process — the same failure mode TD-02 rejects for upload, now on the read path where concurrency is far higher. Range parsing (open-ended, suffix, multi-range, unsatisfiable) must be implemented and tested correctly. API instances end up scaled for streaming bandwidth.

**Recommendation:** **Option A — `302` to a short-lived presigned GET URL.** The phase's organising principle is that large media never transits the API, and applying it to playback as well as upload keeps the architecture coherent; Option B reintroduces on the read path exactly the bottleneck Option A of TD-02 removed from the write path, and asks us to hand-write range handling that S3 already implements. The shareability window is the accepted trade-off and is bounded by a **5-minute** TTL — the standard signed-URL pattern used by real video platforms. Authorisation is unaffected: the API still resolves and checks the video on every request before signing.

**Decision:** A (`302` redirect to short-lived presigned GET URL)

---

## TD-09: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Processamento automático do vídeo após upload (extração de duração e metadados)`

**Context:** The video row is created before its file exists (pre-registration as draft) and is only playable after the worker succeeds, so status is the state machine tying the API, the queue and the worker together. It is cited by the entity, the migration, the API contracts and the worker, and Phase 04 builds its draft→publish flow directly on top of it — making the set of states and the failure semantics a contract, not an implementation detail.

**Options:**

### Option A: Four states — `draft` → `processing` → `ready` | `failed`, with BullMQ retries and a stored failure reason
- `POST /videos/uploads` inserts the row as `draft`. `complete` flips it to `processing` and enqueues the job. The worker sets `ready` on success. BullMQ retries 3 times with exponential backoff; after the final attempt the worker sets `failed` and persists `processing_error`.
- **Pros:** Matches the lifecycle named in the phase brief (`rascunho → processando → pronto/erro`) exactly, with no invented states. Retries absorb transient faults (storage blip, worker restart) without any user-visible state change, while a genuinely undecodable file lands in `failed` with a diagnostic the user can act on. `failed` is terminal and explicit, so a stuck video is distinguishable from one still processing. Four states are enough for Phase 04 to layer `published` on top without rework.
- **Cons:** `processing_error` is free text, so it is a diagnostic rather than a machine-readable error code. A worker killed mid-job leaves the row in `processing` until BullMQ's stalled-job detection re-queues it.

### Option B: Add an explicit `uploading` state before `draft`
- Five states, distinguishing "multipart upload open" from "row created".
- **Pros:** The in-flight upload is directly observable in the database.
- **Cons:** Adds a state the phase brief does not name, and it carries no information the multipart upload's own existence does not already carry. More transitions to test and to explain for no capability served.

### Option C: No retries — first failure is terminal
- The worker attempts once; any error sets `failed`.
- **Pros:** Simplest possible semantics; failures surface immediately.
- **Cons:** A restarting worker or a momentary storage error permanently fails a perfectly good 10GB upload, forcing a full re-upload. Unacceptable for the file sizes this phase targets.

**Recommendation:** **Option A — four states with bounded retries and a persisted failure reason.** It is exactly the lifecycle the phase brief specifies, and it separates the two failure classes that matter: transient faults, which retries hide, and bad input, which must reach the user. Option B adds a state with no consumer; Option C's fragility is disqualifying when a single failure costs a 10GB re-upload. Concretely: `attempts: 3`, exponential backoff with a 5s base, `removeOnComplete` bounded, and failed jobs retained for inspection.

**Decision:** A (`draft` → `processing` → `ready` | `failed`, 3 retries with backoff)

**Revisions:**
- 2026-07-28 — Added explicit stalled-job settings: `stalledInterval: 60_000` (ms) and `maxStalledCount: 2`; a job exceeding the stall budget is treated as a failed attempt and follows the same terminal path, setting the video to `failed` with `processing_error`. Rationale: resolves `OQ-1` from `validation.md`. TD-06 makes jobs long-lived by design (probing a 10GB object over HTTP), so a default stall window risks re-queuing a job that is still running, and leaving the setting unstated left `processing` without a terminal state when a worker dies mid-job.

---

## TD-10: Test Strategy for Storage, Queue and FFmpeg

**Scope:** Backend

**Capability:** Transversal — covers: `Serviço de armazenamento de arquivos (vídeos e thumbnails)`, `Serviço de processamento em segundo plano (filas)`, `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** Phase 03 introduces three collaborators the existing suite has never exercised: object storage, a queue broker and an external binary. The project's testing convention (`*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts`) says *which* suffix maps to *which* kind of test, but not whether this new infrastructure should be faked or run for real — and that answer determines what the Compose file must provide during a test run. It is a cross-component decision: Compose, the Jest configuration and every new test file depend on it.

**Options:**

### Option A: Real MinIO, real Redis and real FFmpeg in integration/e2e; mocks only in unit tests
- Integration specs talk to the actual `minio` and `redis` Compose services and shell out to the real `ffmpeg`, using a tiny fixture clip generated on the fly with `ffmpeg -f lavfi -i testsrc`. Unit specs mock the storage client, the queue and the `FfmpegRunner` to test branching logic in isolation.
- **Pros:** Exercises the behaviour that actually breaks — presigned URL signing, multipart completion, Range semantics, real `ffprobe` JSON output — none of which a hand-written mock reproduces faithfully. Matches how the existing suite already treats PostgreSQL: real service, real queries. The Compose stack is a hard deliverable of this phase anyway, so the infrastructure is present at test time by construction. A generated fixture keeps no binary blob in the repository.
- **Cons:** Integration tests now require three services up rather than one, so a partial stack yields confusing failures. Test runtime grows. Shared MinIO buckets and Redis keys need cleanup between suites, mirroring the table-cleanup discipline already in place.

### Option B: Mock the S3 client and the queue; test only against PostgreSQL
- Storage and queue are stubbed everywhere; only the database is real.
- **Pros:** Fast, hermetic, no new services needed to run the suite.
- **Cons:** The most failure-prone parts of the phase — signing, multipart assembly, Range responses, FFmpeg's actual output — would be verified only against our assumptions about them. A mock that returns the ETag shape we imagined proves nothing about the shape MinIO returns. The phase brief explicitly rejects simulating what the Compose stack can run for real.

**Recommendation:** **Option A — real infrastructure in integration and e2e, mocks confined to unit tests.** The project already treats PostgreSQL this way, and the same reasoning applies with more force to storage and queue, where the contracts (presigned signatures, multipart ETags, `206` responses, `ffprobe` JSON) are defined by the external service rather than by our code. The extra services are not an added cost here: shipping them in Compose is itself a deliverable of the phase. A `lavfi`-generated fixture keeps the repository free of binary test assets. Cleanup follows the existing convention — truncate tables, empty the test bucket prefix, and flush the test queue between suites.

**Decision:** A (Real MinIO, Redis and FFmpeg in integration and e2e)

**Revisions:**
- 2026-07-28 — `ffmpeg` is installed in `Dockerfile.dev` in addition to `Dockerfile.worker`. Rationale: resolves `IC-2` from `validation.md`. TD-04 keeps FFmpeg out of the API image, but the project convention (`nestjs-project/CLAUDE.md`) runs every test inside the `nestjs-api` container, whose image had neither binary — so FFmpeg-touching integration specs would have failed with `ENOENT`. Installing it in the *dev* image only keeps the production API image unchanged and keeps the whole suite runnable with a single command in a single container.

---

## TD-11: Authorization Model for Video Delivery

**Scope:** Backend

**Capability:** Transversal — covers: `Reprodução via streaming (sem necessidade de download completo)`, `Download do vídeo pelo usuário`

**Context:** Raised as `AMB-1` in `validation.md`. TD-08 decides the delivery *mechanism* (a `302` to a presigned URL issued only after the API checks the video) but never states what that check is. The gap is real rather than merely unstated, because the natural discriminator does not exist yet: `Visibilidade do vídeo: público ou unlisted` is a **Fase 04** capability, so Phase 03 has no visibility column to consult. Meanwhile the global `JwtAuthGuard` inherited from Phase 02 denies every route by default unless annotated `@Public()`, so silence here means "authenticated-only" by accident rather than by decision.

**Options:**

### Option A: `ready` videos are publicly streamable and downloadable; non-`ready` videos are owner-only
- `GET /videos/:publicId/stream` and `GET /videos/:publicId/download` are `@Public()`. Both resolve the video by `public_id` and serve it only when `status = ready`. A video in `draft`, `processing` or `failed` returns `404` to everyone except the owning channel, which sees its real status.
- **Pros:** Matches the project's stated characteristic — *"qualquer pessoa pode assistir vídeos sem cadastro"* — without inventing a rule the plan does not contain. Returning `404` rather than `403` for non-`ready` videos avoids leaking the existence of an unprocessed upload. Phase 04 layers its visibility check on top of the same resolver without restructuring anything.
- **Cons:** Until Phase 04 ships visibility, every `ready` video is world-readable — there is no way to keep one unlisted in the interim.

### Option B: Streaming public, download authenticated
- `/stream` is `@Public()`; `/download` requires a valid JWT.
- **Pros:** Slightly raises the cost of bulk scraping of original files while keeping playback open.
- **Cons:** Invents a restriction the project plan does not ask for — the bullet says only `Download do vídeo pelo usuário`. Asymmetric rules on two endpoints serving the same object are hard to justify and easy to forget.

### Option C: Both endpoints owner-only in this phase
- Phase 03 delivers the mechanism; Phase 04 opens it to the public alongside visibility.
- **Pros:** Most conservative; nothing is exposed before the visibility model exists.
- **Cons:** Directly contradicts the anonymous-access characteristic already declared in `docs/project-plan.md`, and would make the phase's own streaming deliverable unverifiable from an anonymous client.

**Recommendation:** **Option A.** It is the only option that follows the project plan as written rather than adding or withholding a rule; the anonymous-access characteristic is stated at the top of `docs/project-plan.md` and applies from the moment videos become playable. The interim exposure that Option A accepts is bounded — a `ready` video in Phase 03 is one its owner uploaded and processed successfully, and Phase 04 introduces visibility as a filter over the same resolver rather than as a rewrite. `404`-for-non-`ready` keeps unprocessed uploads invisible.

**Decision:** A (`ready` → public stream + download; non-`ready` → owner-only, `404` otherwise)

---

## TD-12: Abandoned Multipart Upload Cleanup

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Raised as `MD-1` in `validation.md`. TD-02's Cons name the cost — *"Orphaned multipart uploads accumulate storage until aborted by a lifecycle rule or a cleanup routine"* — but no TD decides the treatment. This is the expected outcome of any interrupted transfer at the file sizes this phase targets, and it leaves two artefacts behind: a `draft` video row and billable multipart parts in the bucket.

**Options:**

### Option A: Explicit abort endpoint
- `DELETE /videos/:id/upload`, authorised to the owning channel, calls `AbortMultipartUpload` and deletes the `draft` row.
- **Pros:** Gives the client a first-class way to cancel, which a 10GB upload UI needs regardless. End-to-end testable with the real MinIO already in the stack — the abort is observable via `ListMultipartUploads`. Small, self-contained SI.
- **Cons:** Only covers clients that *tell* us they are giving up; a client that simply disappears still leaks.

### Option B: Abort endpoint plus a bucket lifecycle rule
- Option A, plus an `AbortIncompleteMultipartUpload` rule (e.g. 7 days) applied to the video bucket during MinIO bootstrap.
- **Pros:** Also covers silent abandonment, closing the leak completely.
- **Cons:** One more bootstrap step to write and to test, and a rule whose effect is only observable after days — awkward to cover meaningfully in the suite.

### Option C: Defer cleanup to Phase 04
- Record the debt; let the phase that owns the draft→publish flow implement it.
- **Pros:** Keeps this phase smaller.
- **Cons:** Ships a known storage leak with no client-facing way to cancel an upload in progress.

**Recommendation:** **Option A.** It closes the case that the client can actually signal and gives the upload flow the cancel path it needs, at the cost of one small endpoint that the real MinIO in Compose can verify end to end. Option B's lifecycle rule is the right long-term complement but buys coverage for silent abandonment that no test in this phase could meaningfully assert; it is recorded here as the natural follow-up rather than dropped. Option C leaves the phase without a cancel path at all.

**Decision:** A (Explicit `DELETE /videos/:id/upload` abort endpoint; bucket lifecycle rule noted as a follow-up)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background job queue technology | A — BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-02 | Backend | 10GB upload strategy | A — Presigned S3 multipart, direct to storage | A |
| TD-03 | Backend | Bucket and object key layout | A — Two buckets: videos private, thumbnails public-read | A |
| TD-04 | Backend | Worker runtime and deployment shape | A — Same codebase, separate entrypoint + image | A |
| TD-05 | Backend | FFmpeg invocation for metadata and thumbnail | A — Direct `child_process.spawn` of `ffprobe`/`ffmpeg` | A |
| TD-06 | Backend | How the worker reads the source file | A — Presigned GET URL as FFmpeg input | A |
| TD-07 | Backend | Unique public video URL strategy | A — `randomBytes(8).toString('base64url')` + unique index | A |
| TD-08 | Backend | Streaming and download delivery path | A — `302` to short-lived presigned GET URL | A |
| TD-09 | Backend | Video status lifecycle and failure handling | A — `draft`→`processing`→`ready`\|`failed`, 3 retries | A |
| TD-10 | Backend | Test strategy for storage, queue and FFmpeg | A — Real MinIO/Redis/FFmpeg in integration and e2e | A |
| TD-11 | Backend | Authorization model for video delivery | A — `ready` public; non-`ready` owner-only | A |
| TD-12 | Backend | Abandoned multipart upload cleanup | A — Explicit `DELETE /videos/:id/upload` abort endpoint | A |

---

## Notes on Sources

- S3 multipart limits (max 10,000 parts; 5 MiB–5 GiB per part, last part exempt; **5 GB ceiling for a single `PUT`**) — [Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) and [Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html). This is the constraint that makes multipart mandatory in TD-02.
- Package versions and compatibility metadata below were read from the npm registry on 2026-07-28 and are pinned in `library-refs.md` at the `plan-resolve` stage: `bullmq@5.81.2` (CJS build, peer `redis >=5.0.0`), `@nestjs/bullmq@11.0.4` (peers `@nestjs/core` ^10||^11, `bullmq` ^3||^4||^5), `@aws-sdk/client-s3@3.1096.0`, `@aws-sdk/s3-request-presigner@3.1096.0`, `nanoid@6.0.0` (`"type": "module"` — ESM-only, the fact that disqualifies Option C of TD-07).
- **`context7` MCP was not available in this session** — `.mcp.json` in this repository registers only the `postgres` server, and no `context7` server is reachable. Library facts above were therefore taken from the npm registry (versions, module format, peer ranges) and official vendor documentation (AWS S3) rather than via `context7`, as `CLAUDE.md` requires. This gap is recorded as an issue for `plan-validate` to surface, and every version asserted here must be re-confirmed against the installed lockfile at `plan-resolve` time.
