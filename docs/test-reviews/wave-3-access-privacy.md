# Access and privacy review, third wave

Reviewed on 2026-09-21 from `bf99853b10f491f5cb56ccbb51a771f1fecf7658` in an
isolated worktree. All temporary source mutations were restored. The final
change contains the four owned test files and this report.

| Entry   | Suite                                                                             | Before | After | Outcome  |
| ------- | --------------------------------------------------------------------------------- | -----: | ----: | -------- |
| TL-0020 | [routeProtection.test.ts](../../server/fastify/__tests__/routeProtection.test.ts) |     17 |    17 | Improved |
| TL-0024 | [auth.test.ts](../../server/fastify/__tests__/auth.test.ts)                       |     11 |    16 | Improved |
| TL-0026 | [requestHistory.test.ts](../../server/fastify/__tests__/requestHistory.test.ts)   |      9 |     9 | Improved |
| TL-0027 | [bootstrap.test.ts](../../server/fastify/__tests__/bootstrap.test.ts)             |      8 |     8 | Improved |

## Findings and changes

Route protection already checks every live API route against the manifest,
independent literal exception allowlists, auth before raw-body parsing, HEAD
exclusions, and route-specific rate limits. Those assertions remain intact.
The public asset-existence case formerly accepted any status except 401; it now
requires a successful response and the empty missing-assets result. The missing
writer-header case now first proves the latched writer can import on the same
fixture. It then rejects a conflicting missing-header import and verifies the
accepted settings and revision remain unchanged. Rejecting every latched writer
can no longer make this suite pass.

Authentication already covers bounded/persisted key caches, fallback-token
reopening and expiry, loopback-only agent bypass, password setup, and exactly-once
route verification before work. Four new signed-assertion cases independently
exercise expiry, an unsupported declared algorithm, an unregistered signing key,
and an altered signature. Each uses real ECDSA signing and verifies a valid
registered assertion before and after the rejected variation. The expired token
has a historical issuance time before its expiry; expiry is its only invalid
condition. A fifth case changes the expiry or secret of a persisted fallback
token, checks rejection, and confirms the original token remains valid after
reopening auth state.

Request-history retention, migration, streaming completion timing, UTF-8 bounds,
and credential-free profile projections already had useful checks. The existing
redaction case read through the production getter despite promising secrecy
before persistence. It now inspects raw SQLite columns both while pending and
after completion. Context and toggle fields carry distinct secrets alongside
safe values, and safe context, toggle, and metadata values must survive. This
catches both missing field redaction and moving password masking from storage
to the read path.

Bootstrap already uses exact metadata objects for initialized and uninitialized
databases, verifies authentication and revision, exercises the occupancy rollback
override, reconstructs legacy writer-scoped finalization state across restart,
and checks settings migration. Its compression test populated 64 jobs but only
compared compressed and uncompressed responses. It now also checks the exact
64 expected chat/job/mode projections, using the fixture's IDs and a literal
mode. Matching compressed bytes can no longer hide a consistently wrong job
projection.

## Targeted mutation evidence

Each final mutation ran alone against its entire owning test file with one
worker and no file parallelism. The original-suite runs used unchanged files
from the reviewed baseline; the final runs used the improved files. Every
failure was inspected at the intended behavioral assertion, with no import,
setup, or timeout failure counted as detection.

| Temporary source mutation                                                                                                                                                               | Original result | Final result         | Protected assertion                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------- | ------------------------------------------------------------------------------------ |
| Disable signed-assertion expiry rejection in `auth.ts`.                                                                                                                                 | 11 passed       | 1 failed / 15 passed | A correctly signed, previously issued expired assertion is rejected.                 |
| Disable the signed assertion's `ES256` algorithm guard.                                                                                                                                 | 11 passed       | 1 failed / 15 passed | An ECDSA-signed assertion declaring another algorithm is rejected.                   |
| Disable signed-assertion public-key registration checking.                                                                                                                              | 11 passed       | 1 failed / 15 passed | A correctly signed assertion from an unregistered key is rejected.                   |
| Return success regardless of the signature verification result.                                                                                                                         | 11 passed       | 1 failed / 15 passed | Altering the valid registered assertion's signature is rejected.                     |
| Disable fallback-token hash registration checking.                                                                                                                                      | 11 passed       | 1 failed / 15 passed | Changing a persisted token's expiry or secret is rejected.                           |
| Return 500 from the otherwise valid public asset-existence handler.                                                                                                                     | 17 passed       | 1 failed / 16 passed | The public route must successfully serve its documented probe.                       |
| Reject every mutation after an active-writer session is latched.                                                                                                                        | 17 passed       | 1 failed / 16 passed | The latched writer's otherwise valid import succeeds.                                |
| Pass history context directly to its bounded serializer without redaction.                                                                                                              | 9 passed        | 1 failed / 8 passed  | Known credentials are absent from pending raw context columns.                       |
| Pass history toggles directly to their bounded serializer without redaction.                                                                                                            | 9 passed        | 1 failed / 8 passed  | Secret-shaped toggle values are absent from pending raw columns.                     |
| Restore the original `password=...` value into the otherwise sanitized, bounded error before writing; compensate by applying the existing string redactor in the getter's summary path. | 9 passed        | 1 failed / 8 passed  | The completed raw row cannot contain the password even when getter output is masked. |
| Change every bootstrap active-job mode to `continue` while preserving the other projection fields.                                                                                      | 8 passed        | 1 failed / 7 passed  | The compression fixture's send jobs retain their exact projected modes.              |

All **11 targeted baseline survivors are now caught**. This is a selected
experiment set, not an exhaustive mutation score. The signed probes were
repeated after adding the historical issuance time. The password-deferral probe
preserves the existing error bound and uses the normal password-key redactor;
it does not rely on embedding a fixture credential in the read path.

## Validation and conservation

Dependencies were installed with `pnpm install --offline --frozen-lockfile` in
the isolated worktree, without a root dependency-directory symlink.

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts --no-file-parallelism --maxWorkers=1 server/fastify/__tests__/routeProtection.test.ts server/fastify/__tests__/auth.test.ts server/fastify/__tests__/requestHistory.test.ts server/fastify/__tests__/bootstrap.test.ts --reporter=json --outputFile=/tmp/wave3-access-baseline.json
pnpm exec vitest run --config server/fastify/vitest.config.ts --no-file-parallelism --maxWorkers=1 server/fastify/__tests__/routeProtection.test.ts server/fastify/__tests__/auth.test.ts server/fastify/__tests__/requestHistory.test.ts server/fastify/__tests__/bootstrap.test.ts --reporter=json --outputFile=/tmp/wave3-access-final.json
```

Baseline: **4 files, 45 passed**. Restored final: **4 files, 50 passed**.
The file/full-test-name multiset comparison retains all 45 original identities
and adds five auth cases. No cases were renamed, moved, deleted, skipped, or
retagged. The two existing `@module-tag core` declarations, runtime routing,
shared helpers, and runner configuration remain unchanged. These server-only
test edits add no client aggregate fixture references.

Each mutation uses the same Vitest options with only its owning test file and
an output path `/tmp/wave3-access-<phase>-<mutation>.json`. The temporary runner
is `/tmp/wave3-access-mutations.py`; consolidated before/after results are in
`/tmp/wave3-access-mutations-summary.json`. These local artifacts are supplemental;
the table above preserves the reviewed mutations and results in the repository.

Prettier, `pnpm check:docs`, and `git diff --check` passed. Shared typechecks and
integrated validation belong to the parent wave. No full repository or browser
suite was run for this localized test-only batch.

## Adjacent ownership and limits

A survivor in an assigned file does not establish that the whole repository
lacked protection. [smoke.test.ts](../../server/fastify/__tests__/smoke.test.ts)
already exercises expired ECDSA assertions through HTTP.
[activeWriter.test.ts](../../server/fastify/__tests__/activeWriter.test.ts)
owns broader takeover, connection, lineage, and stale mutation matrices.
[requestHistoryRoutes.test.ts](../../server/fastify/__tests__/requestHistoryRoutes.test.ts)
owns history route access, no-store responses, and deletion.
[generationEffects.test.ts](../../server/fastify/__tests__/generationEffects.test.ts)
owns modern immutable-session finalization/effect recovery, and
[durableGeneration.test.ts](../../server/fastify/__tests__/durableGeneration.test.ts)
owns nonempty active-job lifecycle and regenerate targets. Those matrices were
not duplicated here. No production defect or shared API change was required.
