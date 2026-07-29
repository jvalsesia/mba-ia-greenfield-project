---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-28T15:12:27-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T15:10:45-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-28T15:11:55-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "CLAUDE.md mandates context7 for library docs, but .mcp.json registers only postgres"
    resolved_by: library-refs.md § Provenance (substitute sources accepted and disclosed)
  - id: IC-2
    status: resolved
    summary: "TD-10 requires real FFmpeg in integration tests; only the worker image gets ffmpeg (TD-04)"
    resolved_by: phase-03-videos/TD-10 (Revision 2026-07-28 — ffmpeg added to Dockerfile.dev)
  - id: AMB-1
    status: resolved
    summary: "Authorization for /stream and /download of a ready video is undefined in phase 03"
    resolved_by: phase-03-videos/TD-11
  - id: MD-1
    status: resolved
    summary: "No decision on cleanup of orphaned/abandoned multipart uploads"
    resolved_by: phase-03-videos/TD-12
  - id: DG-1
    status: resolved
    summary: "ChannelsService exposes no way to resolve the authenticated user's channel"
    resolved_by: context.md § Prerequisites Established During Validation (ChannelsService.findByUserId)
  - id: OQ-1
    status: resolved
    summary: "Stalled-job handling for a worker killed mid-job is named in TD-09 but not decided"
    resolved_by: phase-03-videos/TD-09 (Revision 2026-07-28 — stalledInterval / maxStalledCount)
advisories: []
---

# phase-03-videos — Validation

_Second pass. The first pass reported 6 open issues; `plan-resolve` closed all of them by adding `TD-11` and `TD-12`, appending Revisions to `TD-09` and `TD-10`, writing `library-refs.md`, and recording the `DG-1` prerequisite in `context.md`. This pass re-ran every check against the updated artifacts._

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._ Every capability bullet in `context.md` § Capability Coverage maps to at least one decided TD.

### Dependency Gaps

_None._ The single gap found (`DG-1`) is recorded as a prerequisite in `context.md` and must be consumed by an SI in `plan-build`.

### Inherited Constraint Conflicts

_None._ The Phase 02 inheritances this phase relies on — the global `JwtAuthGuard` with `@Public()` opt-out, the `DomainException` hierarchy and filter, `class-validator` DTOs, and the 1:1 user↔channel relation — are all used as-is. `TD-11` extends the guard's default via `@Public()` rather than bypassing it.

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_Not applicable — this phase has no UI surface (see `context.md` § Non-UI / Deferred Capabilities)._

## Cross-slice Advisories

_Not applicable — phase 03 has exactly one `scope_type: phase` decisions doc (monolithic phase), so cross-slice coverage cannot gap._

## Active Suppressions

_None._

## Resolved Issues

### IC-1 — `context7` mandated by the project rules but unavailable in this repository

**Resolved by:** `library-refs.md` § Provenance and the `context7` gap.

The rule in `CLAUDE.md` stands; what changed is that the gap is now disclosed rather than silently worked around. `library-refs.md` names the substitute sources actually used and their order of authority — npm registry metadata for version/module-format/peer-range facts, official AWS documentation for the S3 multipart limits — and carries an explicit obligation into `SI-03.1` to re-confirm every version against `package-lock.json` after install. Configuring a `context7` server remains the correct permanent fix and is outside this phase's scope.

### IC-2 — FFmpeg required by the test strategy but absent from the container that runs tests

**Resolved by:** Revision on `phase-03-videos/TD-10`, dated 2026-07-28.

`ffmpeg` is installed in `Dockerfile.dev` in addition to `Dockerfile.worker`. This keeps `TD-04`'s intent intact — the production API image still ships without FFmpeg — while letting the whole suite run with one command in the one container the project's conventions sanction. The alternative of splitting the suite across two containers was rejected because it would make the Definition of Done depend on two separate commands.

### AMB-1 — Authorization for `/stream` and `/download`

**Resolved by:** `phase-03-videos/TD-11`.

`ready` videos are publicly streamable and downloadable (`@Public()`), matching the anonymous-access characteristic declared in `docs/project-plan.md`. Videos in `draft`, `processing` or `failed` return `404` to everyone except the owning channel — `404` rather than `403` so an unprocessed upload's existence is not disclosed. Phase 04's visibility model layers over the same resolver.

### MD-1 — Cleanup of orphaned multipart uploads

**Resolved by:** `phase-03-videos/TD-12`.

An explicit `DELETE /videos/:id/upload` endpoint, authorised to the owning channel, calls `AbortMultipartUpload` and deletes the `draft` row. The bucket lifecycle rule that would additionally cover silent abandonment is recorded in the TD as a follow-up rather than adopted, because no test in this phase could meaningfully assert a multi-day rule.

### DG-1 — No way to resolve the authenticated user's channel

**Resolved by:** `context.md` § Prerequisites Established During Validation.

`ChannelsModule` gains a `findByUserId(userId)` lookup and exports it; `VideosService` consumes it rather than querying the `channels` table directly, per the Single Responsibility rule in the root `CLAUDE.md`. This is an action item, not a technical decision — there is no competing option — so it is recorded as a prerequisite for `plan-build` to place in an SI rather than as a TD.

### OQ-1 — Stalled-job handling

**Resolved by:** Revision on `phase-03-videos/TD-09`, dated 2026-07-28.

`stalledInterval: 60_000` ms and `maxStalledCount: 2`. A job that exhausts its stall budget is treated as a failed attempt and follows the same terminal path, setting the video to `failed` with `processing_error` — so `processing` always has a way out even when a worker dies mid-job.
