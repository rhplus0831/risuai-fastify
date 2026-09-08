# Remote Diagnostics Phases

Start at [status](../status.md), read [PLAN.md](../PLAN.md), then the relevant
phase and relevant [inventory](../inventory.md) entries.

| Phase | Document                                                                        |
| ----- | ------------------------------------------------------------------------------- |
| 0     | [Contract and inventory](phase-0-contract-and-inventory.md)                     |
| 1     | [Remote access](phase-1-remote-access.md)                                       |
| 2     | [Diagnostic depth and durability](phase-2-depth-and-durability.md)              |
| 3     | [Browser evidence](phase-3-browser-evidence.md)                                 |
| 4     | [Verification and operational readiness](phase-4-verification-and-readiness.md) |

Each slice changes one cohesive boundary and finishes with the owning focused
checks. A phase may span several tasks or commits. Record actual progress and
evidence only in status; create a separate slice document only when a bounded
handoff needs one. Keep shared schema/collector/composition edits sequential.

Use project-required read-only parallel source exploration for broad code
cross-checks. Privacy and authorization tests accompany implementation in each
phase. Follow the [plan's validation policy](../PLAN.md#validation-and-completion)
and root AGENTS guidance; do not import test or approval exceptions from
archived workstreams. Successful local phase acceptance does not deploy code
or provision access to production.

## Plan Document Validation

The default current-document set does not include this plan directory. Run
`pnpm check:docs` plus this explicit plan/index check from the repository root:

```sh
pnpm exec tsx -e '
import { readdirSync } from "node:fs";
import { validateCurrentDocumentation } from "./util/current-documentation-validator.ts";
const root = ".archived-docs/protocol-and-persistence/remote-diagnostics";
const documents = ["docs/plan/README.md", ".archived-docs/protocol-and-persistence/README.md", ...[root, `${root}/phases`].flatMap(dir =>
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
pnpm exec prettier --ignore-path /dev/null --check docs/plan/README.md .archived-docs/protocol-and-persistence/README.md '.archived-docs/protocol-and-persistence/remote-diagnostics/**/*.md'
git diff --check
```

Update this check if the plan later needs nested slice documents; do not assume
they are covered by the direct-file enumeration.
