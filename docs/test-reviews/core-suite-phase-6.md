# Core suite Phase 6: policy and retired documents

Completed on 2026-09-22 after [core-suite-phase-5.md](core-suite-phase-5.md).
Documentation only; no code, test, configuration, or baseline changed.

## Policy

`AGENTS.md` gained a **Test Policy** section. In short:

1. Two tiers. The core tier (`util/core-test-contract.ts` cases tagged `core`,
   plus `@core` Playwright journeys) is the protection and runs in
   `pnpm test:agent`. The extended tier runs in `pnpm test:all` and CI and is
   not protection an agent may rely on.
2. A behavior-preserving change that breaks an extended-tier test means the
   test was implementation-coupled: delete it, do not repair it. A real
   regression is fixed in the code. An intended behavior change updates the
   core case's expected outcome and says so in the commit.
3. A new test must drive a public boundary (Fastify `inject` over real SQLite,
   Playwright against the smoke build, or real modules with only process edges
   replaced) and must fail before the fix or under a production mutation.
4. No `vi.mock`, `vi.doMock`, or `vi.spyOn` on `src/`, `server/`, or
   `packages/`; no call-count, internal-state, or source-text assertions.
5. No tests under `src/lib`; visible behavior is protected by browser
   journeys. Structural rules go into `util/architecture-inventory.ts`.
6. Core promotion requires recorded mutation proof in `docs/test-reviews/`.
7. No test inventories, priority lists, or per-file review worklists.

`docs/structure/testing-and-operations.md` ("Visible State Test Contract")
now points state-to-DOM coverage at browser journeys instead of mounted Svelte
component tests, matching the policy.

## Retired documents

`docs/TEST-LIST.md`, `TEST-LIST-KR.md`, `TEST-LIST-UPDATE.md`,
`TEST-REVIEW-WORKLIST.md`, and `TEST-REVIEW-WORKLIST.json` (2.2 MB, the
1,034-file snapshot of 2026-09-19 and its 443-entry worklist, 30 entries
completed) moved to
`.archived-docs/performance-and-stability/test-suite-reduction-2026-09/` with a
README explaining why. Nothing in the tooling read them. Links from
`docs/tests/README.md` and the pilot and wave reports under
`docs/test-reviews/` were updated or removed.

## Lane split kept

Merging `pnpm test:agent` into `pnpm test:all` was considered and rejected.
After Phase 5 the agent lane takes about 2 minutes plus the smoke build, while
`test:all` takes 8.3 minutes, 5.7 of them the 175 browser journeys. The two
lanes serve different purposes: the agent lane is the mutation-proven
protection an agent runs when the `AGENTS.md` workflow calls for it; the full
lane is the owner's and CI's complete verification. Revisit if the extended
browser suite shrinks below about two minutes.

## Not done here

`docs/test-reviews/` still holds the owner's pilot and wave review reports and
the four core-suite reports. They are current records of this workstream and
were left in place; move them to the archive topic when the workstream closes.
