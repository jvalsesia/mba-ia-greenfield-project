# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Modules implemented so far: `auth/`, `users/`, `channels/`, `videos/` (+ `videos/processing/` for the worker), `storage/`, `queue/`, `mail/`, `common/`, `config/`, `database/`, `swagger/`. Also hosts the video worker entrypoint (`src/worker.ts`, `src/worker.module.ts`).
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, issues presigned storage URLs, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage. Container `video-worker`, built from `nestjs-project/Dockerfile.worker`
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails. Two buckets: `streamtube-videos` (private) and `streamtube-thumbnails` (public-read)
- **Message Queue** (Redis + BullMQ) → video processing job queue. Decided in `docs/decisions/technical-decisions-phase-03-videos.md` (TD-01); no longer TBD
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos (Phase 03)

Implemented in `nestjs-project/src/videos/`, with object storage in `src/storage/` and the queue registration in `src/queue/`. Full planning artifacts live in `docs/phases/phase-03-videos/`.

**The organising principle: large media never transits the API process** — not on upload, not on the worker's read, not on playback. Every path that would move video bytes through Node.js was rejected for one that does not.

### Upload — presigned S3 multipart

A single S3 `PUT` caps at 5 GB, so a 10GB object requires multipart. The client uploads parts **directly to storage**; the API only handles control-plane calls:

1. `POST /videos/uploads` — creates the video row as `draft`, opens the multipart upload, returns one presigned `PUT` target per part (64 MiB parts; 10 GiB ⇒ 160 parts).
2. Client `PUT`s each part straight to MinIO/S3 and collects the `ETag`s.
3. `POST /videos/:videoId/uploads/complete` — assembles the parts, re-reads the real size from `HeadObject`, sets `processing`, enqueues the job.
4. `DELETE /videos/:videoId/upload` — aborts the multipart upload and drops the draft row.

### Processing — the `video-worker` container

`src/worker.ts` bootstraps `WorkerModule` via `NestFactory.createApplicationContext` (no HTTP listener). It consumes the `video-processing` queue and runs `ffprobe` / `ffmpeg` through `FfmpegRunner` (`child_process.spawn`, no wrapper library).

The worker **never downloads the source**: FFmpeg is handed a presigned URL and reads it over HTTP with range requests. `-ss` goes before `-i` so it seeks to the thumbnail frame instead of decoding from the start.

Retries come from `TD-09`: 3 attempts, exponential backoff from 5s, `stalledInterval` 60s, `maxStalledCount` 2. A non-final failure leaves the row in `processing`; an exhausted budget writes `failed` with `processing_error`.

### Delivery — 302 to a presigned URL

- `GET /videos/:publicId` — metadata. Thumbnails are returned as **direct public URLs** (public-read bucket), not signed.
- `GET /videos/:publicId/stream` — `302` to a 5-minute presigned URL; the storage layer answers `Range` with `206 Partial Content`.
- `GET /videos/:publicId/download` — same, plus `Content-Disposition: attachment` baked in **before** signing.

### Status lifecycle

`draft` → `processing` → `ready` | `failed`. Abort deletes the row from `draft`.

### Authorization

The three upload endpoints require a JWT and are scoped to the caller's channel. The three delivery endpoints are `@Public()`: a `ready` video is readable by anyone, matching the project's anonymous-access characteristic. A `draft`, `processing` or `failed` video answers **404 to everyone except its owner** — never 403, so a video's existence is not probeable. Owners requesting their own unprocessed video get `409 VIDEO_NOT_READY`.

Visibility (public/unlisted) is **Phase 04** — it layers over the same resolver.

### Two S3 clients, deliberately

SigV4 signs the `Host` header, so an endpoint cannot be substituted after signing. `S3_ENDPOINT` signs URLs for in-network consumers (server-side calls, the worker's FFmpeg input); `S3_PUBLIC_ENDPOINT` signs URLs handed to external clients. `forcePathStyle: true` is **mandatory** for MinIO.

### Running it

```bash
cd nestjs-project
docker compose up -d          # api, db, mailpit, minio, redis, video-worker
docker compose logs video-worker
```

Buckets are created idempotently at application bootstrap — no manual `mc` step.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.