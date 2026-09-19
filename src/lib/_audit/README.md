# UI Audit Gates

This directory contains DOM-level audit acceptance probes. They run in the
default frontend lane so they share its Vitest startup and transform work.

Agents may select one exact audit probe with:

```sh
pnpm test -- src/lib/_audit/<owner>.test.ts
```

The user/CI `pnpm test:all` aggregate includes the complete audit set. The
minimal `pnpm test:agent` profile excludes these untagged presentation audits.

Keep ordinary component regressions next to their components. Use this directory
only for cross-cutting audit acceptance probes that benefit from a dedicated
location.
