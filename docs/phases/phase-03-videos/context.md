---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-28T14:15:36-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T15:04:11-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-07-28T14:15:36-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-07-28T14:15:36-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-28T14:15:36-03:00"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-07-28T14:15:36-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-28T14:15:36-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-07-28T14:15:36-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição das informações do vídeo, thumbnail customizada, categorias, visibilidade pública/unlisted, fluxo de rascunho → publicação e painel de gerenciamento (Fase 04). Página de visualização e player (Fase 05). Likes, comentários e inscrições (Fase 06). Nenhuma tela é entregue nesta fase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a Fase 03 não lista nenhuma tela entre suas capacidades; a interface de vídeo (upload, player, painel) é entregue nas Fases 04 e 05.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta. O vídeo pertence a um canal, e o canal é criado no cadastro pela Fase 02 (relação 1:1 com o usuário).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | 10GB Upload Strategy | decided | A (Presigned S3 multipart, direct to storage) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Bucket and Object Key Layout | decided | A (Two buckets — videos private, thumbnails public-read) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Worker Runtime and Deployment Shape | decided | A (Same codebase, separate entrypoint + image) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | FFmpeg Invocation (metadata + thumbnail) | decided | A (Direct `child_process.spawn`) | — (ffmpeg binary in worker image) |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | How the Worker Reads the Source File | decided | A (Presigned GET URL as FFmpeg input) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Unique Public Video URL Strategy | decided | A (`randomBytes(8).toString('base64url')` + unique index) | — (`node:crypto`) |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Streaming and Download Delivery Path | decided | A (`302` to short-lived presigned GET URL) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Failure Handling | decided | A (`draft`→`processing`→`ready`\|`failed`, 3 retries) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend | Test Strategy for Storage, Queue and FFmpeg | decided | A (Real MinIO/Redis/FFmpeg in integration + e2e) | — |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Backend | Authorization Model for Video Delivery | decided | A (`ready` public; non-`ready` owner-only) | — |
| phase-03-videos/TD-12 | technical-decisions-phase-03-videos.md | Backend | Abandoned Multipart Upload Cleanup | decided | A (Explicit `DELETE /videos/:id/upload`) | — |
| openapi-docs-nestjs/TD-01 | technical-decisions-openapi-docs-nestjs.md | Backend | OpenAPI Documentation Tooling | decided | A (@nestjs/swagger + CLI plugin) | @nestjs/swagger |
| openapi-docs-nestjs/TD-02 | technical-decisions-openapi-docs-nestjs.md | Backend | OpenAPI Spec Artifact Strategy | decided | C (Runtime UI + exported `openapi.json`) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` — phase-scope doc (this phase)
- `docs/decisions/technical-decisions-openapi-docs-nestjs.md` — correlated ad-hoc doc (`related_phases: []`). Included because this phase adds the first video endpoints, and TD-01/TD-02 there govern how every new endpoint is documented and how `nestjs-project/openapi.json` is regenerated. TD-03 (production exposure policy) is not affected by this phase and is omitted.

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-10 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-10 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09, phase-03-videos/TD-12 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-10 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08, phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08, phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A — BullMQ + Redis. The phase needs retry-with-exponential-backoff, a durable failed-job record and a dedicated worker process, and BullMQ provides all three as configuration rather than as code we must write and test ourselves. `@nestjs/bullmq` 11.x declares `@nestjs/core` ^11 as a peer, so it matches the installed framework version exactly, and BullMQ ships a CommonJS build compatible with the project's `ts-jest` setup. pg-boss's "no new container" advantage is real but is paid for with hand-wired lifecycle code and a second schema owner inside the project's own database; RabbitMQ's routing power is unused at one-producer/one-consumer. The added Redis container is the honest cost of this choice.

**Libraries:** `bullmq`, `@nestjs/bullmq`

### phase-03-videos/TD-02

**Recommendation:** Option A — presigned multipart upload direct to storage. It is the only option that keeps 10GB of video out of the API process entirely, which is the literal requirement; Options B and C both terminate the stream in Node.js and differ only in how gracefully they recover from a drop. Option A also resolves the 5 GB single-`PUT` ceiling by construction, gives per-part retry for free, and is the same handshake the code would use against production S3. Concretely: part size **64 MiB** (10GB → ~160 parts, under the 10,000-part cap and above the 5 MiB minimum), presigned URL TTL **1 hour**, and a declared `sizeBytes` validated against a **10 GiB** ceiling at initiation.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-03

**Recommendation:** Option A — two buckets, videos private and thumbnails public-read. The two asset classes genuinely differ: a video is the protected payload whose delivery the API must gate, while a thumbnail is a small derived image that Phases 04 and 05 will render in listings by the dozen. Expressing that difference as bucket policy is simpler and cheaper than signing every thumbnail. Keys: `videos/{videoId}/source{ext}` and `thumbnails/{videoId}/thumb.jpg`.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Option A — same codebase, separate entrypoint and image. It satisfies the architecture's process separation and keeps FFmpeg out of the API image, while avoiding the duplication tax that a standalone project charges for a boundary this phase does not need. Concretely: `src/worker.ts` bootstrapping `NestFactory.createApplicationContext`, `src/videos/worker/` for the processor, a `Dockerfile.worker` installing `ffmpeg`, and a `video-worker` Compose service sharing `.env` and depending on `db`, `redis` and `minio`.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Option A — direct `spawn`. The phase needs exactly two FFmpeg invocations, and both are single, well-documented command lines; a wrapper's abstraction earns its keep on filter graphs and transcode pipelines, neither of which is in scope. Direct `spawn` keeps FFmpeg's own stderr — the only useful signal when a file fails to decode — and an injected `FfmpegRunner` interface gives clean unit tests without shipping a dependency whose maintenance the project would inherit. Argument arrays passed to `spawn` are not shell-interpreted, so storage keys and URLs cannot inject shell syntax.

**Libraries:** — (requires the `ffmpeg`/`ffprobe` binaries in the worker image)

### phase-03-videos/TD-06

**Recommendation:** Option A — presigned URL as FFmpeg input. The phase's defining constraint is that 10GB files must not be moved around gratuitously, and this honours it in the worker exactly as TD-02 honours it in the API: the bytes stay in object storage and only the needed ranges are read via FFmpeg's HTTP protocol. Downloading to a temp file caps worker concurrency on disk rather than CPU. Presigned TTL for worker reads: **2 hours**.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Option A — `randomBytes(8).toString('base64url')` with a unique index. It produces the short shareable URL the capability implies while adding no dependency, and it sidesteps the ESM/CJS friction that disqualifies current `nanoid` (v6 is ESM-only) for this CommonJS codebase. Uniqueness is guaranteed by the `UNIQUE` constraint on `public_id` with a bounded insert retry, not by entropy alone.

**Libraries:** — (`node:crypto`, standard library)

### phase-03-videos/TD-08

**Recommendation:** Option A — `302` to a short-lived presigned GET URL. The phase's organising principle is that large media never transits the API, and applying it to playback as well as upload keeps the architecture coherent; proxying reintroduces on the read path exactly the bottleneck TD-02 removed from the write path, and asks us to hand-write range handling that S3 already implements. TTL **5 minutes**. Download reuses the same signature with `response-content-disposition=attachment`.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Option A — four states with bounded retries and a persisted failure reason. It is exactly the lifecycle the phase brief specifies (`rascunho → processando → pronto/erro`), and it separates the two failure classes that matter: transient faults, which retries hide, and bad input, which must reach the user. Concretely: `attempts: 3`, exponential backoff with a 5s base, and `processing_error` persisted on terminal failure.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Option A — real infrastructure in integration and e2e, mocks confined to unit tests. The project already treats PostgreSQL this way, and the same reasoning applies with more force to storage and queue, where the contracts (presigned signatures, multipart ETags, `206` responses, `ffprobe` JSON) are defined by the external service rather than by our code. A `lavfi`-generated fixture keeps the repository free of binary test assets.

**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** Option A. It is the only option that follows the project plan as written rather than adding or withholding a rule; the anonymous-access characteristic is stated at the top of `docs/project-plan.md` and applies from the moment videos become playable. `/stream` and `/download` are `@Public()` and serve a video only when `status = ready`; a `draft`, `processing` or `failed` video returns `404` to everyone except the owning channel. Phase 04 layers its visibility filter over the same resolver.

**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** Option A. An explicit `DELETE /videos/:id/upload`, authorised to the owning channel, calls `AbortMultipartUpload` and deletes the `draft` row — closing the case the client can actually signal and giving the upload flow the cancel path a 10GB UI needs. The bucket lifecycle rule that would also cover silent abandonment is recorded as the natural follow-up rather than dropped.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (@nestjs/swagger + CLI plugin) — official NestJS tooling; the CLI plugin infers DTO schemas from TypeScript types, so decorators stay minimal.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + exported `openapi.json`) — Swagger UI is served at runtime and the spec is additionally exported to `nestjs-project/openapi.json`, which the frontend consumes for type generation.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.

**Libraries:** —

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — the documented NestJS approach; the project already uses decorators extensively. All Phase 03 request DTOs inherit this.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — machine-readable error codes in a `{ statusCode, error, message }` envelope. Every Phase 03 domain error extends `DomainException` and is rendered by the existing global filter.

**Libraries:** —

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — _diverged during implementation:_ custom guards with `@nestjs/jwt` only. Phase 03 inherits the resulting global `JwtAuthGuard` + `@Public()` opt-out; owner-scoped video endpoints authenticate through it.

**Libraries:** `@nestjs/jwt@^11.0.0`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. Every new variable is added to the schema **and** to `.env.example`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`. Schema changes only via versioned migrations in `src/database/migrations/`. _(from phase 01)_
- Each domain gets its own feature module registering `TypeOrmModule.forFeature([...])` and exporting both `TypeOrmModule` and its service (see `ChannelsModule`). _(from phase 02)_
- Entities use `@PrimaryGeneratedColumn('uuid')`, `snake_case` column/property names, and `@CreateDateColumn` / `@UpdateDateColumn` named `created_at` / `updated_at`. _(from phase 02)_
- Domain errors extend the abstract `DomainException` (`errorCode`, `httpStatus`, `message`) declared in `src/common/exceptions/domain.exception.ts` and are rendered by the global `DomainExceptionFilter`. _(from phase 02)_
- Controllers carry `@ApiTags`, `@ApiOperation` and one `@ApiResponse` per documented status, referencing `ApiErrorEnvelope` via `getSchemaPath` for error shapes. Endpoints are protected by the global `JwtAuthGuard` unless annotated `@Public()`. _(from phase 02 + openapi-docs-nestjs)_
- The authenticated principal is read via the `@CurrentUser()` decorator typed as `JwtPayload`. _(from phase 02)_
- Test suffixes: `*.spec.ts` (unit, all collaborators mocked), `*.integration-spec.ts` (real DB/services, next to the source), `*.e2e-spec.ts` (full HTTP via supertest, in `test/`). Integration and e2e run with `--runInBand`. _(from phase 02)_
- Test `DataSource` objects pass entity classes and migration classes explicitly as arrays — never glob strings, which break under `ts-jest`. _(from phase 02)_
- Every `npm`/`npx`/`tsc`/test command runs **inside** the Compose container, never on the host. Service hostnames are Compose service names (`db`, `mailpit`), never `localhost`. _(from phase 01)_
- Non-TypeScript runtime assets must be declared in `nest-cli.json` under `compilerOptions.assets`, or they are missing from `dist/` after build. _(from phase 02)_

## Prerequisites Established During Validation

Resolved from `validation.md`; recorded here so `plan-build` places them in an SI rather than leaving them to be improvised at implementation time.

| Ref | Prerequisite | Resolution |
|-----|--------------|------------|
| DG-1 | `ChannelsService` exposes only `createChannel(userId, email)`, so there is no sanctioned way to answer "which channel does this JWT belong to?" — which every upload initiation needs. | `ChannelsModule` gains a `findByUserId(userId)` lookup and exports it. The lookup belongs to `ChannelsModule`, not to `VideosService`, per the Single Responsibility rule in the root `CLAUDE.md` (a module must not query another domain's tables). |
| IC-2 | The `nestjs-api` container image (`Dockerfile.dev`) has no `ffmpeg`, but `TD-10` requires real FFmpeg in integration tests and the project convention runs every test in that container. | `ffmpeg` is installed in `Dockerfile.dev` alongside `Dockerfile.worker`. Recorded as a Revision on `TD-10`. The production API image is unaffected. |
| IC-1 | `CLAUDE.md` mandates `context7` for library docs; the server is not registered in this repository's `.mcp.json`. | Substitute primary sources (npm registry metadata + official AWS documentation) accepted for this phase, with the gap and the substitutes disclosed in `library-refs.md` § Provenance. Versions must be re-confirmed against `package-lock.json` at `SI-03.1`. |
| OQ-1 | `TD-09` decided the retry policy for jobs that *fail* but not the behaviour for jobs that *stall* — a distinct BullMQ mechanism, and one that matters because `TD-06` makes jobs long-lived by design. | `stalledInterval: 60_000`, `maxStalledCount: 2`; a stall-exhausted job follows the same terminal path as a failed one. Recorded as a Revision on `TD-09`. |

## Inherited Deferred Capabilities

| Capability | Deferred in | Status | Note |
|------------|-------------|--------|------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | phase-02-auth | delivered later | Delivered by `phase-02-auth-frontend` once `next-frontend/` was initialized. Not a blocker for this phase. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| _(none)_ | — | Every capability of Fase 03 is backend-side and delivered in this phase. `docs/project-plan.md` lists no screen among the phase's bullets, so nothing is deferred to a UI slice. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces three collaborators the suite has never exercised — object storage, a queue broker and an external binary — and `phase-03-videos/TD-10` fixes how they are tested: real MinIO, real Redis and real FFmpeg in `*.integration-spec.ts` and `*.e2e-spec.ts`, with mocks confined to `*.spec.ts`. The video fixture is generated at test time with `ffmpeg -f lavfi` rather than committed as a binary. Cleanup between suites follows the existing table-truncation discipline, extended to emptying the test bucket prefix and flushing the test queue. Specific layer coverage by SI is recorded in `progress.md`.
