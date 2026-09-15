import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { TARGETED_MUTATION_PATHS } from '../src/commands/mutations.js'
import {
  BARDWIKI_WRITE_TABLES,
  BROAD_WRITE_TABLES,
  COMMAND_METRIC_REVIEW_GATES,
  assertCommandMetricGate,
  type CommandMetricGate,
  type CommandMutationMetric,
} from './helpers/commandMetricGates.js'
import { assertOnlyRowsWritten } from './helpers/rowStability.js'

// Verification budget: the gate map is the single budget surface for every
// command write path, so it must stay in lock-step with the runtime and no narrow
// path may quietly lose its `dbJsonWriteMs: 0` floor or its written-table budget.
// These are pure static invariants (no app harness): they scan the server source
// for the `mutationPath` labels the runtime can emit and cross-check them against
// `COMMAND_METRIC_REVIEW_GATES`. A new route, a renamed label, or a loosened gate
// fails here before it can silently widen a write.

const SRC_DIR = path.resolve(fileURLToPath(new URL('../src', import.meta.url)))

/** Every `.ts` file under `server/fastify/src`, recursively. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * The set of `mutationPath` labels the runtime can actually emit, gathered from
 * literal/template expressions and references to the shared vehicle table
 * (`mutationPath: TARGETED_MUTATION_PATHS.collection`), including conditional
 * branches. The `mutationPath: args.mutationPath` pass-through and the
 * `mutationPath: string` type field are intentionally not matched.
 */
function collectMutationPathExpression(expression: ts.Expression, labels: Set<string>): void {
  if (ts.isStringLiteralLike(expression)) {
    labels.add(expression.text)
    return
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'TARGETED_MUTATION_PATHS'
  ) {
    const key = expression.name.text as keyof typeof TARGETED_MUTATION_PATHS
    const value = TARGETED_MUTATION_PATHS[key]
    expect(value, `TARGETED_MUTATION_PATHS.${key} referenced by a route is not defined`).toBeTruthy()
    labels.add(value)
    return
  }
  if (ts.isConditionalExpression(expression)) {
    collectMutationPathExpression(expression.whenTrue, labels)
    collectMutationPathExpression(expression.whenFalse, labels)
  } else if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    collectMutationPathExpression(expression.expression, labels)
  }
}

function collectEmittedMutationPathsFromText(text: string, fileName = 'mutation-path-probe.ts'): Set<string> {
  const labels = new Set<string>()
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'mutationPath') ||
        (ts.isStringLiteralLike(node.name) && node.name.text === 'mutationPath'))
    ) {
      collectMutationPathExpression(node.initializer, labels)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return labels
}

function collectEmittedMutationPaths(): Set<string> {
  const labels = new Set<string>()
  for (const file of listSourceFiles(SRC_DIR)) {
    for (const label of collectEmittedMutationPathsFromText(readFileSync(file, 'utf8'), file)) labels.add(label)
  }
  return labels
}

const GATE_KEYS = Object.keys(COMMAND_METRIC_REVIEW_GATES)
const GATE_ENTRIES = Object.entries(COMMAND_METRIC_REVIEW_GATES) as Array<[string, CommandMetricGate]>

// The broad before-state baselines. They are intentionally not narrow: they
// carry a documented table budget but not the `dbJsonWriteMs: 0` floor a
// targeted path must hold.
const BROAD_BASELINE_GATES = ['hydrated', 'message-free'] as const

function hasTableBudget(gate: CommandMetricGate): boolean {
  return Boolean(gate.expectedTables || gate.maxTables || gate.forbiddenTables)
}

function pluginStorageMetric(writtenTables?: string[]): CommandMutationMetric {
  return {
    type: 'plugin-storage-probe',
    mutationPath: 'targeted-plugin-storage',
    loadMs: 0,
    cloneMutateMs: 0,
    sqliteSyncMs: 0,
    dbJsonWriteMs: 0,
    totalMs: 0,
    writtenTables,
  }
}

describe('command mutation-range budgets', () => {
  it('discovers literal, template, and shared-table mutation path expressions through the AST', () => {
    expect(
      [
        ...collectEmittedMutationPathsFromText(`
          const literal = { mutationPath: "hydrated" }
          const template = { 'mutationPath': \`targeted-message\` }
          const shared = {
            mutationPath: condition
              ? TARGETED_MUTATION_PATHS.settings
              : TARGETED_MUTATION_PATHS.collection,
          }
          const passThrough = { mutationPath: args.mutationPath }
        `),
      ].sort(),
    ).toEqual(['hydrated', 'targeted-collection', 'targeted-message', 'targeted-settings'])
  })

  it('rejects an unexpected row inserted after the stability snapshot', () => {
    expect(() =>
      assertOnlyRowsWritten(
        { stable: 1 },
        {
          stable: 1,
          unexpected: 2,
        },
      ),
    ).toThrow(/unrelated row "unexpected" was inserted/)
  })

  it('allows target row inserts and deletes while preserving unrelated rows', () => {
    expect(() =>
      assertOnlyRowsWritten(
        {
          stable: 1,
          deletedTarget: 2,
        },
        {
          stable: 1,
          insertedTarget: 3,
        },
        ['deletedTarget', 'insertedTarget'],
      ),
    ).not.toThrow()
  })

  it('the review gates exactly match the mutation paths emitted at runtime', () => {
    const emitted = [...collectEmittedMutationPaths()].sort()
    expect(emitted.length).toBeGreaterThanOrEqual(GATE_KEYS.length)
    expect(emitted).toEqual([...GATE_KEYS].sort())
  })

  it('every narrow mutation gate fixes dbJsonWriteMs: 0 and declares a written-table budget', () => {
    const targeted = GATE_ENTRIES.filter(([key]) => key.startsWith('targeted-') || key.startsWith('generation-effect-'))
    // There is at least one targeted path per Tier write family.
    expect(targeted.length).toBeGreaterThanOrEqual(5)
    for (const [key, gate] of targeted) {
      expect(gate.dbJsonWriteMs, `${key} must fix dbJsonWriteMs to 0`).toBe(0)
      expect(hasTableBudget(gate), `${key} must declare a written-table budget`).toBe(true)
    }
  })

  it('the broad baselines keep a documented written-table budget', () => {
    for (const key of BROAD_BASELINE_GATES) {
      const gate = COMMAND_METRIC_REVIEW_GATES[key]
      expect(hasTableBudget(gate), `${key} must keep its broad table budget`).toBe(true)
    }
  })

  it('no table budget escapes the known physical-table universe', () => {
    const universe = new Set<string>([
      ...BARDWIKI_WRITE_TABLES,
      ...BROAD_WRITE_TABLES,
      'chat_hypa_v3',
      'generation_effects',
      'inlay_catalog',
      'memory_chunks',
      'memory_jobs',
      'messages',
    ])
    for (const [key, gate] of GATE_ENTRIES) {
      for (const field of ['expectedTables', 'maxTables', 'forbiddenTables'] as const) {
        for (const table of gate[field] ?? []) {
          expect(universe.has(table), `${key}.${field} names unknown table "${table}"`).toBe(true)
        }
      }
    }
  })

  it('rejects a metric that omits writtenTables when its gate declares a table budget', () => {
    expect(() => assertCommandMetricGate(pluginStorageMetric())).toThrow(
      'targeted-plugin-storage.writtenTables is required by its table budget',
    )
  })

  it('accepts writtenTables that satisfy the configured table budget', () => {
    expect(assertCommandMetricGate(pluginStorageMetric(['plugin_custom_storage']))).toBe(
      COMMAND_METRIC_REVIEW_GATES['targeted-plugin-storage'],
    )
  })

  it('classifies atomic IGP completion as an exact-message/effect mutation with bounded derived invalidation', () => {
    const metric: CommandMutationMetric = {
      type: 'message.updated',
      mutationPath: 'generation-effect-igp-commit',
      loadMs: 0,
      cloneMutateMs: 0,
      sqliteSyncMs: 0,
      dbJsonWriteMs: 0,
      totalMs: 0,
      writtenTables: ['generation_effects', 'messages'],
    }
    expect(assertCommandMetricGate(metric)).toBe(COMMAND_METRIC_REVIEW_GATES['generation-effect-igp-commit'])

    expect(() => assertCommandMetricGate({ ...metric, writtenTables: ['chats', ...metric.writtenTables!] })).toThrow(
      'generation-effect-igp-commit wrote tables outside maxTables',
    )
  })
})
