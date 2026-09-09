# Unified Read-Only Workspace Phases

Start at [status](../status.md), read [PLAN.md](../PLAN.md), then the active
phase and the relevant [inventory](../inventory.md) rows.

| Phase | Document                                                                              |
| ----- | ------------------------------------------------------------------------------------- |
| 0     | [Contract, inventory, and baseline](phase-0-contract-inventory-and-baseline.md)       |
| 1     | [Access and readiness model](phase-1-access-and-readiness-model.md)                   |
| 2     | [Role-first bootstrap](phase-2-role-first-bootstrap.md)                               |
| 3     | [Unified shell and navigation](phase-3-unified-shell-and-navigation.md)               |
| 4     | [Transcript and composer containment](phase-4-transcript-and-composer-containment.md) |
| 5     | [Role transitions and performance](phase-5-role-transitions-and-performance.md)       |
| 6     | [Rollout cleanup and closeout](phase-6-rollout-cleanup-and-closeout.md)               |

## Execution Rules

- Phases are sequential because bootstrap, client session, App routing,
  navigation, and chat presentation share authority and lifecycle boundaries.
- A phase may contain multiple cohesive implementation slices. Record completed
  and remaining slices only in `status.md`; do not turn phase documents into
  execution logs.
- Create a slice document only when a bounded handoff needs durable context.
  Index it here or in a phase-local `README.md`; do not pre-create empty slices.
- Protect controls, handlers, effects, shortcuts, drops, and delayed
  continuations in the phase that exposes or shares their surface. Later
  integration testing does not excuse an earlier unguarded boundary.
- Keep incomplete behavior behind one whole-path rollout boundary. Do not ship
  independently selectable bootstrap, navigation, and composer combinations.
- Use the project-mandated parallel read-only research for broad architectural
  cross-checks. Shared implementation owners remain sequential.
- Current source and architecture guides remain authoritative until behavior
  ships. Record discovered source/document mismatches in `status.md` before
  deciding which contract to change.
- Follow Crunch Mode: do not run `pnpm test:agent` or `pnpm test:all`. Run the
  smallest relevant focused tests, type/build checks, measurements, and selected
  browser journeys.
- A build or generated artifact is evidence only for the command that produced
  it. Do not describe an unexecuted browser journey as passing because its build
  succeeded.

## Phase Acceptance

Every accepted phase records in `status.md`:

- final source revision and the exact changed boundary;
- focused commands and outcomes;
- failed attempts and their resolution;
- required browser/performance artifact identity and environment;
- confirmation that reader mutation/generation invariants remain intact; and
- residual limitations or the explicit absence of known remaining phase work.

Do not accept a phase with a known failing required check or an unresolved
scope/replanning trigger. If concurrent source changes invalidate evidence,
recheck the affected final owners rather than relying on an earlier result.

## Plan Document Validation

The default current-document validator does not recursively enumerate this
package. From the repository root, run `pnpm check:docs` and the explicit package
check below after planning changes:

```sh
pnpm exec tsx -e '
import { readdirSync } from "node:fs";
import { validateCurrentDocumentation } from "./util/current-documentation-validator.ts";
const root = ".archived-docs/ui-and-user-input/unified-read-only-workspace";
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
pnpm exec prettier --ignore-path /dev/null --check docs/plan/README.md .archived-docs/README.md .archived-docs/ui-and-user-input/README.md '.archived-docs/ui-and-user-input/unified-read-only-workspace/**/*.md'
git diff --check
```

Update the explicit enumeration if nested slice directories are added. At final
closeout, validate the archived package and its archive indexes at their new
paths before removing the active-plan entry.
