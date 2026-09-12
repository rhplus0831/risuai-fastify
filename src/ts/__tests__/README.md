# Explicit Frontend Performance Gates

This directory contains shared clone-cost helpers plus render-cost and send-path
performance gates. They are useful regression protection, but they are heavier
than ordinary feature tests, so the default frontend lane excludes them.

Agents may run one performance contract explicitly with:

```sh
pnpm test -- src/ts/__tests__/renderCostHarness.test.ts
pnpm test -- src/ts/__tests__/sendCloneCountProbe.test.ts
```

The focused runner preserves one-worker isolation. The user/CI `pnpm test:all`
aggregate owns both contracts together.

## Ownership

| Files | Purpose |
| --- | --- |
| `cloneCostHarness.ts` | Shared snapshot-shape, rollback, and clone-instrumentation helpers used by focused regression tests across `src/`. |
| `renderCostHarness*.ts` | DOM/render-cost regression probes for GUI reload behavior. |
| `sendCloneCountProbe*.ts` | Send-path clone-count regression probe. |
| `test/fixtures/largeCorpusFixture.ts` | Shared large-corpus fixture used by client and server cost regressions. |
| `latestOperationTestAssertions.ts` | Shared newer-operation-wins assertion helper used by browser/server-facing tests; test support, not a performance gate. |

Keep new performance gates here and add their exact paths to
`vitest.performance-tests.ts`. UI audit probes belong in `src/lib/_audit`.
