# Read-Only App UX Phases

Start at [status](../status.md), read [PLAN.md](../PLAN.md), then the active phase
and its [inventory](../inventory.md) entries.

| Phase | Document                                                                           |
| ----- | ---------------------------------------------------------------------------------- |
| 0     | [Contract and inventory](phase-0-contract-and-inventory.md)                        |
| 1     | [Reader boundary and navigation data](phase-1-reader-boundary-and-data.md)         |
| 2     | [Shared shell and navigation](phase-2-shared-shell-and-navigation.md)              |
| 3     | [Shared transcript and passive display](phase-3-transcript-and-passive-display.md) |
| 4     | [Lifecycle and action containment](phase-4-lifecycle-and-containment.md)           |
| 5     | [Verification and rollout](phase-5-verification-and-rollout.md)                    |

Each slice changes one cohesive boundary and ends with the relevant focused
checks. Record progress and evidence only in status. Keep dependent shell,
selection, and resource-owner changes sequential; use read-only parallel source
cross-checks when broad exploration is needed under local project guidance.

Controls, routes, callbacks, and effects must be protected as their surfaces are
introduced. Phase 4 integrates and challenges those protections. Settings,
plugin panels, and interactive scripts are excluded throughout every phase.
Routine interface and extraction decisions are implementation work, not new
product-scope questions. Follow the [validation policy](../PLAN.md#validation-and-completion)
and root AGENTS guidance.

## Plan Document Validation

The default current-document set does not include this directory. From the
repository root, run `pnpm check:docs` and this explicit plan/index check:

```sh
pnpm exec tsx -e '
import { readdirSync } from "node:fs";
import { validateCurrentDocumentation } from "./util/current-documentation-validator.ts";
const root = ".archived-docs/ui-and-user-input/read-only-app-ux";
const documents = ["docs/plan/README.md", ".archived-docs/README.md", ".archived-docs/ui-and-user-input/README.md", ...[root, `${root}/phases`].flatMap(dir =>
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
pnpm exec prettier --ignore-path /dev/null --check docs/plan/README.md .archived-docs/README.md .archived-docs/ui-and-user-input/README.md '.archived-docs/ui-and-user-input/read-only-app-ux/**/*.md'
git diff --check
```

Update the explicit enumeration if nested slice documents are introduced. Do
not assume those documents are covered by a successful default docs check.
