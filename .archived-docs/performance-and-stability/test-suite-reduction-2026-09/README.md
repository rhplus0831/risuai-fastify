# Test Suite Reduction 2026-09: Retired Inventory And Worklist

Archived on 2026-09-22 (Phase 6 of the core-suite work). These documents were
the per-file priority inventory and review worklist that preceded the
reduction. They describe the 1,034-file suite of 2026-09-19 at `528c6d62b`,
not the current suite, and no tooling reads them.

| Record | Contents |
| --- | --- |
| [`TEST-LIST.md`](TEST-LIST.md) | Priority inventory of every test file with severity, frequency, and coverage judgements. Its tiers were the deletion input for Phase 5. |
| [`TEST-LIST-KR.md`](TEST-LIST-KR.md) | Korean translation of the inventory. |
| [`TEST-LIST-UPDATE.md`](TEST-LIST-UPDATE.md) | Post-snapshot update notes. |
| [`TEST-REVIEW-WORKLIST.md`](TEST-REVIEW-WORKLIST.md), [`TEST-REVIEW-WORKLIST.json`](TEST-REVIEW-WORKLIST.json) | Per-file review worklist of 443 Critical and High entries; 30 were completed before the approach was retired because per-file auditing only grew the suite. |

Why retired: the owner's audit found that most of the inventoried tests did not
protect the product (54 of 63 sampled production mutations survived the
Critical-rated files). The replacement is a small mutation-proven core suite
(`util/core-test-contract.ts`, `pnpm test:agent`) plus a real-boundary extended
tier, with the policy in `AGENTS.md` under Test Policy. The reduction is
recorded in `docs/test-reviews/core-suite-gap-analysis.md`,
`core-suite-phase-2.md`, `core-suite-phase-3.md`, and `core-suite-phase-5.md`.
The retained pilot and wave review reports under `docs/test-reviews/` link to
the worklist here.

Relative links inside the archived files were written for their original
`docs/` location and are not maintained; most of the files they point at were
deleted in Phase 5.
