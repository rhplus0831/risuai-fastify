# Generation effect retention: core case additions

Recorded on 2026-09-25 with the change that settles abandoned non-durable
effect claims, prunes settled effect rows after seven days, makes the startup
backfill one-shot per lineage, and adds `generation.effectClaims` to the support
diagnostics state snapshot.

`server/fastify/__tests__/generationEffects.test.ts` is already listed in
`util/core-test-contract.ts`, so the cases added to it are core cases. Each was
run against the mutation below with the rest of the change in place; the
previous core lane (the file before these cases) passed every mutation.

| Case | Production mutation | Result |
| --- | --- | --- |
| settles an abandoned non-durable claim after its lease and never delivers it again | `claimGenerationEffectInTransaction`: the lazy settlement condition `current.effect_class !== 'durable'` replaced with `false`, so an expired ephemeral claim stays `claimed` | Fails on the second claim: expected `already_receipted` with `claim_lease_expired`, received a live claim |
| backfills a completed operation after current-attempt cleanup with exact accepted scope (updated expected outcome) | `reconcileGenerationEffectsAtStartup`: the marker check `if (backfilled) return 0` disabled, so every startup walks completed operations again | Fails: the first call after app startup recreates 7 rows instead of 0 |
| prunes settled effects after retention, keeps them pruned across restart, and acknowledges pruned claims | `pruneSettledGenerationEffects`: the sibling guard narrowed from `status IN ('pending', 'claimed')` to `status IN ('claimed')`, so a generation with a pending effect loses its receipts | Fails: expected 0 pruned while a sibling is pending, received 6 |

The extended-tier `supportDiagnosticsState.test.ts` case was also checked. With
`durableLive` and `durableExpired` swapped in `readSupportDiagnosticsState`, the
seeded snapshot (two live durable claims, one expired durable claim, one
ephemeral claim) fails with `durableLive: 1, durableExpired: 2`. An earlier
draft seeded one of each and did not catch the swap; the seed was made
asymmetric for that reason.

Updated expected outcome: the backfill case previously expected repeated
backfill on every call and after deleting a single row. One-shot backfill is the
intended behavior change, so the case now clears the marker to emulate a
pre-marker database, expects one backfill, and expects a deleted row to stay
absent afterwards.
