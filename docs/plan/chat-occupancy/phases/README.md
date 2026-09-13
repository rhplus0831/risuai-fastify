# Chat Occupancy Phases

Read [status](../status.md), [PLAN.md](../PLAN.md), then the active phase and its
[inventory](../inventory.md) entries. Progress belongs only in status.

1. [Phase 0: Contract and inventory](phase-0-contract-and-inventory.md).
2. [Phase 1: Server occupancy and enforcement](phase-1-server-occupancy-and-enforcement.md).
3. [Phase 2: Chat-only interaction](phase-2-chat-only-interaction.md).
4. [Phase 3: Recovery and completion](phase-3-recovery-and-completion.md).
5. [Phase 4: Integrated verification and release](phase-4-integrated-verification-and-release.md).

## Execution Rules

- Each phase depends on the preceding phase's acceptance and completion commit.
  Shared authority, bootstrap, command, and recovery owners are changed
  sequentially. Use parallel read-only research for broad cross-checks.
- Each slice should have a concrete observable outcome and focused validation.
  Tests are part of implementation, not deferred wholesale to Phase 4.
- Keep unfinished behavior behind a coherent rollout boundary. An intermediate
  phase passing tests does not authorize releasing incomplete chat-only mode.
- Every phase, including Phase 0, must follow the exact
  [mandatory completion gate](../PLAN.md#mandatory-phase-completion-gate): full
  suite pass, GPT 6 Astra High independent review, fixes/retest/review, status,
  and commit. No phase is accepted by document preparation alone.
- Keep the reviewer read-only and the source stable while review runs. If the
  environment cannot provide the requested reviewer or complete a required
  check, retain the unaccepted status and report the blocker.

## Plan Document Validation

The default current-document validator does not enumerate this planning
package. Run `pnpm check:docs` plus this explicit check from the repository root:

```sh
pnpm exec tsx -e '
import { readdirSync } from "node:fs";
import { validateCurrentDocumentation } from "./util/current-documentation-validator.ts";
const root = "docs/plan/chat-occupancy";
const documents = ["docs/plan/README.md", ...[root, `${root}/phases`].flatMap(dir =>
  readdirSync(dir).filter(name => name.endsWith(".md")).map(name => `${dir}/${name}`))];
const result = validateCurrentDocumentation({
  documentPaths: documents,
  indexSpecs: [
    { directory: root, index: `${root}/status.md` },
    { directory: `${root}/phases`, index: `${root}/phases/README.md` }
  ],
  literalPathExemptions: []
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
'
pnpm exec prettier --ignore-path /dev/null --check docs/plan/README.md 'docs/plan/chat-occupancy/**/*.md'
git diff --check
```

Update enumeration/indexes when adding nested slice documents. At closeout,
validate the entire archived package and affected archive indexes at their new
paths. Recording the results does not turn document validation into runtime or
phase-completion evidence.
