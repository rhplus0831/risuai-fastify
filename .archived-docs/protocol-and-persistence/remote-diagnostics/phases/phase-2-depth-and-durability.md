# Phase 2: Diagnostic Depth and Durability

Dependency: Phase 1 read/helper boundary accepted. Owners: inventory D01–D07,
D09, D11. Progress belongs in [status](../status.md).

## Outcome

Remote evidence survives ordinary server restarts within finite retention and
can explain where a generation/provider/persistence operation failed without
requesting content-bearing logs.

## Bounded Slices

### 2a. Event contracts and reliable correlation

- Add event-specific exact schemas for the coverage families in the plan.
  Preserve v1 compatibility through the chosen versioning/projection strategy.
- Replace the generic metric mapping with explicit adapters. Fix producer UID
  gaps, background operation context, phase/status loss, and diagnostics-only
  timer initialization. Preserve app isolation and report expired correlation.
- Propagate independent operation/attempt references through generation,
  provider attempts, finalization, and recovery. Do not export raw domain IDs
  or private mapping tables. Define which correlation survives a restart.

### 2b. Safe journal

- Persist validated records in the dedicated bounded store. Implement sequence
  cursors, retention and loss accounting, startup revalidation/pruning, reset
  cleanup, and bounded close behavior.
- Enforce age/count/byte/queue/record bounds on writes and reads. Corrupt records,
  unavailable/full storage, slow writes, and stale cursors produce fixed
  diagnostic outcomes, never raw fallback or application failure.
- Keep operational writes outside domain revisions, command receipts, writer
  authority, and mutation events. Support snapshot-consistent bounded reads
  during concurrent recording and retention.

### 2c. Useful event families

- Add safe HTTP summaries, generation stages/prompt shape, provider transport
  and streaming outcomes, persistence/cleanup/retry states, and script/plugin
  execution counts. Map adapter differences to finite categories, including
  unknown/unsupported, rather than exposing custom labels.
- Reuse summary calculations only by extracting approved fields. Omit content
  hashes, exact text, arbitrary object keys, model/profile names, tool payloads,
  Lua log values, and sidecar references.
- Add build/instance/collection health context and explicit measurement units.
  Use monotonic durations and local comparisons for changed/unchanged facts.
- Collect without enabling raw request tracing, full prompt sidecars, or raw
  protocol logging. Exclude diagnostic transport capture and avoid self-generated
  event storms. Bound overhead for long streams and high request volume.

## Acceptance and Evidence

- Inject provider timeout, partial-stream disconnect/cancellation, journal
  failure, authoritative commit failure, and recovery success. Fetched events
  identify the phase and disposition with valid correlation and durations.
- Distinguish failure before provider dispatch from an ambiguous transport
  failure after the provider may have run; do not infer safe replay solely
  from a missing completion event.
- Verify diagnostics-only, raw-metrics-on, collection-disabled, and full-prompt
  flag combinations. Safe output never acquires body/sidecar data from a flag.
- Reproduce background retry and UID-window eviction with synthetic work;
  preserve app isolation and represent missing correlation honestly.
- Restart and exercise retention while paginating. Retained records remain
  available, expired/corrupt records are excluded, and losses are explicit.
- Simulate journal failures/backpressure and prove command acceptance,
  generation completion, revisions, and recovery are unchanged.
- Seed canaries in all content paths and scan decoded/decompressed
  agent-readable artifacts, including serialized journal records and errors.
  Unknown fields, malformed bodies, and oversize records cannot create previews.
- Older browser reports remain valid; helper/schema version mismatch fails
  safely and reports incompatibility.

Use focused schema, collector, journal, generation/retry/provider/stream, and
trace-separation tests, followed by the required cross-layer aggregate at the
completed batch. Record synthetic workload bounds and any measured overhead.
