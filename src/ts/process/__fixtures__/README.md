# Send Chat Fixture Dataset

This directory is the maintained fixture dataset for prompt assembly and
send-chat parity tests.

## Layout

| Path | Purpose |
| --- | --- |
| `db/*.json` | Input database snapshots for fixture scenarios. |
| `expected/*.json` | Expected snapshots captured after each scenario. |
| `mocks/` | Test doubles for browser/runtime side effects. |
| `loadFixture.ts` | Shared fixture loader and state preparation helpers. |
| `snapshot.ts` | Snapshot capture and comparison helpers. |

Use `UPDATE_FIXTURES=1` only when intentionally rewriting expected fixture
snapshots. Review fixture diffs as test data changes, not as generated noise.

When adding a scenario, keep the same basename across `db` and `expected`
where possible. That makes parity failures easier to trace.
