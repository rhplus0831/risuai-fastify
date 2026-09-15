import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Closed-world inventory for the flat model/runtime fields which are being
 * retired. This intentionally scans only database-shaped receivers; request
 * DTOs and canonical profile/runtime objects also have fields named
 * `temperature`, `maxResponse`, etc., but are not flat Database access.
 *
 * Every entry is a literal source marker with an expected occurrence count.
 * A changed count is a deliberate regeneration signal: add or remove an
 * entry here with its exact disposition before landing a new access.
 */
type Classification =
  | 'effective-projection'
  | 'context-free-fallback'
  | 'compatibility'
  | 'static-import-export'
  | 'ordinary-pending'

type InventoryEntry = {
  path: string
  marker: string
  classification: Classification
  expectedCount: number
  reason: string
}

type AccessOccurrence = {
  marker: string
  line: number
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const roots = ['src/ts', 'src/lib', 'server/fastify/src', 'packages/shared-core/src'] as const
const fields = [
  'aiModel',
  'subModel',
  'modelRoles',
  'maxContext',
  'maxResponse',
  'temperature',
  'top_p',
  'top_k',
] as const

const inventory: readonly InventoryEntry[] = [
  {
    path: 'server/fastify/src/prompt/cbsAdapter.ts',
    marker: 'database.aiModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason:
      'checked generation projection adapted to required legacy CBS scalars; resolved prompt scope takes precedence',
  },
  {
    path: 'server/fastify/src/prompt/cbsAdapter.ts',
    marker: 'database.subModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason:
      'checked generation projection adapted to required legacy CBS scalars; resolved prompt scope takes precedence',
  },
  {
    path: 'server/fastify/src/prompt/cbsAdapter.ts',
    marker: 'database.maxContext',
    classification: 'effective-projection',
    expectedCount: 1,
    reason:
      'checked generation projection adapted to required legacy CBS scalars; resolved prompt scope takes precedence',
  },
  // Effective database projections intentionally feed legacy-shaped helpers.
  {
    path: 'server/fastify/src/translation/rawMessageTranslation.ts',
    marker: 'dispatchDatabase.aiModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'profile-backed translation dispatch projection',
  },
  {
    path: 'server/fastify/src/translation/rawMessageTranslation.ts',
    marker: 'dispatchDatabase.maxResponse',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'translator-step response override',
  },
  {
    path: 'server/fastify/src/prompt/luaRuntime.ts',
    marker: 'database.maxResponse',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'profile-backed Lua runtime projection',
  },
  {
    path: 'server/fastify/src/prompt/luaRuntime.ts',
    marker: 'database.temperature',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'profile-backed Lua runtime projection',
  },
  {
    path: 'server/fastify/src/prompt/profileGenerationFields.ts',
    marker: 'database.aiModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'materializes the selected profile for legacy prompt helpers',
  },
  {
    path: 'server/fastify/src/routes/generation.ts',
    marker: 'next.aiModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'completion request profile projection',
  },
  {
    path: 'server/fastify/src/routes/generation.ts',
    marker: 'next.maxResponse',
    classification: 'effective-projection',
    expectedCount: 2,
    reason: 'completion request profile projection/explicit override',
  },
  {
    path: 'server/fastify/src/routes/generation.ts',
    marker: 'next.temperature',
    classification: 'effective-projection',
    expectedCount: 2,
    reason: 'completion request profile projection/explicit override',
  },
  {
    path: 'server/fastify/src/prompt/assemble.ts',
    marker: 'db.aiModel',
    classification: 'effective-projection',
    expectedCount: 5,
    reason: 'assembly receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/assemble.ts',
    marker: 'db.maxContext',
    classification: 'effective-projection',
    expectedCount: 3,
    reason: 'assembly receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/assemble.ts',
    marker: 'db.maxResponse',
    classification: 'effective-projection',
    expectedCount: 2,
    reason: 'assembly receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/assemble.ts',
    marker: 'state.database.aiModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'assembly receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/assemble.ts',
    marker: 'state.database.maxContext',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'assembly receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/assemble.ts',
    marker: 'input.state.database.maxContext',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'assembly receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/assemble.ts',
    marker: 'input.state.database.maxResponse',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'assembly receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/history.ts',
    marker: 'db.aiModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'history formatting receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/templates.ts',
    marker: 'db.aiModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'template formatting receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/prompt/templates.ts',
    marker: 'ctx.database.aiModel',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'template formatting receives an effective database snapshot',
  },
  {
    path: 'server/fastify/src/routes/generationChat.ts',
    marker: 'database.maxContext',
    classification: 'effective-projection',
    expectedCount: 2,
    reason: 'generation info is projected from the effective database',
  },
  {
    path: 'server/fastify/src/routes/generationChat.ts',
    marker: 'db.maxContext',
    classification: 'effective-projection',
    expectedCount: 1,
    reason: 'generation info is projected from the effective database',
  },

  // Deliberate fallback branches retain compatibility for context-free callers.
  {
    path: 'packages/shared-core/src/modelProfileResolver.ts',
    marker: 'database.modelRoles',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'legacy role selection fallback',
  },
  {
    path: 'packages/shared-core/src/modelProfileResolver.ts',
    marker: 'database.maxContext',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'legacy runtime default fallback',
  },
  {
    path: 'packages/shared-core/src/modelProfileResolver.ts',
    marker: 'database.maxResponse',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'legacy runtime default fallback',
  },
  {
    path: 'packages/shared-core/src/modelProfileResolver.ts',
    marker: 'database.temperature',
    classification: 'context-free-fallback',
    expectedCount: 2,
    reason: 'legacy runtime default fallback',
  },
  {
    path: 'packages/shared-core/src/modelProfileResolver.ts',
    marker: 'database.top_p',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'legacy runtime default fallback',
  },
  {
    path: 'packages/shared-core/src/modelProfileResolver.ts',
    marker: 'database.top_k',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'legacy runtime default fallback',
  },
  {
    path: 'packages/shared-core/src/cbsRegistry.ts',
    marker: 'db.aiModel',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'CBS context-free fallback when host supplies no role context',
  },
  {
    path: 'packages/shared-core/src/cbsRegistry.ts',
    marker: 'db.subModel',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'CBS context-free fallback when host supplies no role context',
  },
  {
    path: 'packages/shared-core/src/cbsRegistry.ts',
    marker: 'db.maxContext',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'CBS context-free fallback when host supplies no role context',
  },
  {
    path: 'src/ts/process/request/request.ts',
    marker: 'db.maxContext',
    classification: 'context-free-fallback',
    expectedCount: 3,
    reason: 'request adapter fallback without a resolved profile',
  },
  {
    path: 'src/ts/process/request/request.ts',
    marker: 'db.maxResponse',
    classification: 'context-free-fallback',
    expectedCount: 5,
    reason: 'request adapter fallback without a resolved profile',
  },
  {
    path: 'src/ts/process/request/request.ts',
    marker: 'db.temperature',
    classification: 'context-free-fallback',
    expectedCount: 6,
    reason: 'request adapter fallback without a resolved profile',
  },
  {
    path: 'src/ts/process/request/request.ts',
    marker: 'db.top_p',
    classification: 'context-free-fallback',
    expectedCount: 4,
    reason: 'request adapter fallback without a resolved profile',
  },
  {
    path: 'src/ts/process/request/request.ts',
    marker: 'db.top_k',
    classification: 'context-free-fallback',
    expectedCount: 2,
    reason: 'request adapter fallback without a resolved profile',
  },
  {
    path: 'src/ts/process/request/shared.ts',
    marker: 'db.temperature',
    classification: 'context-free-fallback',
    expectedCount: 2,
    reason: 'request parameter fallback without runtime options',
  },
  {
    path: 'src/ts/process/request/shared.ts',
    marker: 'db.top_p',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'request parameter fallback without runtime options',
  },
  {
    path: 'src/ts/process/request/shared.ts',
    marker: 'db.top_k',
    classification: 'context-free-fallback',
    expectedCount: 2,
    reason: 'request parameter fallback without runtime options',
  },
  {
    path: 'src/ts/process/sendChatContext.ts',
    marker: 'database.maxContext',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'send-context fallback for incomplete profile data',
  },
  {
    path: 'src/ts/process/memory/hypav3.ts',
    marker: 'database.maxResponse',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'Hypa response fallback for incomplete profile data',
  },
  {
    path: 'src/ts/process/memory/hypav3.ts',
    marker: 'db.subModel',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'diagnostic-only legacy model label',
  },
  {
    path: 'src/ts/process/models/modelString.ts',
    marker: 'db.aiModel',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'explicit name/context-free generation label fallback',
  },
  {
    path: 'server/fastify/src/prompt/chatDispatch.ts',
    marker: 'db.aiModel',
    classification: 'context-free-fallback',
    expectedCount: 6,
    reason: 'provider dispatch fallback when no profile context is supplied',
  },
  {
    path: 'server/fastify/src/prompt/chatDispatch.ts',
    marker: 'args.database.maxResponse',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'dispatch metadata fallback',
  },
  {
    path: 'server/fastify/src/prompt/chatDispatch.ts',
    marker: 'args.database.maxContext',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'dispatch metadata fallback',
  },
  {
    path: 'server/fastify/src/prompt/chatDispatch.ts',
    marker: 'db.maxResponse',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'dispatch fallback without output-token override',
  },
  {
    path: 'server/fastify/src/prompt/chatDispatch.ts',
    marker: 'db.maxContext',
    classification: 'context-free-fallback',
    expectedCount: 3,
    reason: 'dispatch fallback without profile context',
  },
  {
    path: 'server/fastify/src/prompt/chatDispatch.ts',
    marker: 'db.temperature',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'dispatch fallback without profile context',
  },
  {
    path: 'server/fastify/src/prompt/chatDispatch.ts',
    marker: 'db.top_p',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'dispatch fallback without profile context',
  },
  {
    path: 'server/fastify/src/prompt/chatDispatch.ts',
    marker: 'db.top_k',
    classification: 'context-free-fallback',
    expectedCount: 1,
    reason: 'dispatch fallback without profile context',
  },
  {
    path: 'server/fastify/src/prompt/tokenizerConfig.ts',
    marker: 'db.aiModel',
    classification: 'context-free-fallback',
    expectedCount: 8,
    reason: 'tokenizer helper fallback for a database-shaped caller',
  },

  // Explicit compatibility and current authoring/import/export boundaries.
  {
    path: 'src/lib/Setting/Pages/OtherBotSettings.svelte',
    marker: 'database.maxResponse',
    classification: 'compatibility',
    expectedCount: 1,
    reason: 'legacy settings fallback after profile read',
  },
  {
    path: 'src/lib/Setting/Pages/OtherBotSettings.svelte',
    marker: 'database.maxContext',
    classification: 'compatibility',
    expectedCount: 1,
    reason: 'legacy settings fallback after profile read',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'db.aiModel',
    classification: 'static-import-export',
    expectedCount: 3,
    reason: 'database snapshot/import/export compatibility shape',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'db.subModel',
    classification: 'static-import-export',
    expectedCount: 3,
    reason: 'database snapshot/import/export compatibility shape',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'db.modelRoles',
    classification: 'static-import-export',
    expectedCount: 3,
    reason: 'database snapshot/import/export compatibility shape',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'db.maxContext',
    classification: 'static-import-export',
    expectedCount: 3,
    reason: 'database snapshot/import/export compatibility shape',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'db.maxResponse',
    classification: 'static-import-export',
    expectedCount: 3,
    reason: 'database snapshot/import/export compatibility shape',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'db.temperature',
    classification: 'static-import-export',
    expectedCount: 3,
    reason: 'database snapshot/import/export compatibility shape',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'db.top_p',
    classification: 'static-import-export',
    expectedCount: 2,
    reason: 'database snapshot/import/export compatibility shape',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'db.top_k',
    classification: 'static-import-export',
    expectedCount: 3,
    reason: 'database snapshot/import/export compatibility shape',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'newPres.aiModel',
    classification: 'static-import-export',
    expectedCount: 1,
    reason: 'legacy preset application',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'newPres.subModel',
    classification: 'static-import-export',
    expectedCount: 1,
    reason: 'legacy preset application',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'newPres.modelRoles',
    classification: 'static-import-export',
    expectedCount: 1,
    reason: 'legacy preset application',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'newPres.maxContext',
    classification: 'static-import-export',
    expectedCount: 1,
    reason: 'legacy preset application',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'newPres.maxResponse',
    classification: 'static-import-export',
    expectedCount: 1,
    reason: 'legacy preset application',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'newPres.temperature',
    classification: 'static-import-export',
    expectedCount: 1,
    reason: 'legacy preset application',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'newPres.top_p',
    classification: 'static-import-export',
    expectedCount: 1,
    reason: 'legacy preset application',
  },
  {
    path: 'src/ts/storage/database.svelte.ts',
    marker: 'newPres.top_k',
    classification: 'static-import-export',
    expectedCount: 1,
    reason: 'legacy preset application',
  },
  {
    path: 'server/fastify/src/databaseDefaults.ts',
    marker: 'database.modelRoles',
    classification: 'static-import-export',
    expectedCount: 2,
    reason: 'schema/default/import normalization boundary',
  },
  {
    path: 'src/ts/process/sendChatPromptAssembly.ts',
    marker: 'database.maxResponse',
    classification: 'compatibility',
    expectedCount: 1,
    reason: 'explicit fallback for profiles without a response-token budget',
  },
]

function productionFiles(): string[] {
  const files: string[] = []
  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, root)
    for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(ts|svelte)$/.test(entry.name)) continue
      const relative = path.relative(repoRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
      if (
        relative.endsWith('.test.ts') ||
        relative.endsWith('.test.svelte') ||
        relative.includes('/__tests__/') ||
        relative.includes('/__fixtures__/')
      )
        continue
      files.push(relative)
    }
  }
  return files.sort()
}

function scanAccesses(): Map<string, AccessOccurrence[]> {
  const receivers =
    '(?:db|database|state\\.database|scope\\.database|context\\.database|ctx\\.database|args\\.database|input\\.state\\.database|input\\.settings|dispatchDatabase|next|newPres|getDatabase\\(\\))'
  const access = new RegExp(`(?<![A-Za-z0-9_.])${receivers}\\.(${fields.join('|')})\\b`, 'g')
  const found = new Map<string, AccessOccurrence[]>()
  for (const relative of productionFiles()) {
    const lines = fs.readFileSync(path.join(repoRoot, relative), 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/'))
        return
      const code = line.replace(/\/\/.*$/, '')
      for (const match of code.matchAll(access)) {
        const marker = match[0]
        const key = `${relative}\u0000${marker}`
        const occurrences = found.get(key) ?? []
        occurrences.push({ marker, line: index + 1 })
        found.set(key, occurrences)
      }
    })
  }
  return found
}

function describeOccurrences(occurrences: readonly AccessOccurrence[] | undefined): string {
  return occurrences?.map(({ marker, line }) => `${marker} (line ${line})`).join(', ') ?? 'none'
}

describe('flat model/runtime access closed world', () => {
  it('classifies every database-shaped access and enumerates ordinary-pending consumers', () => {
    const found = scanAccesses()
    const expected = new Map<string, InventoryEntry>()
    for (const entry of inventory) {
      const key = `${entry.path}\u0000${entry.marker}`
      expect(expected.has(key), `duplicate inventory marker: ${entry.path}:${entry.marker}`).toBe(false)
      expected.set(key, entry)
      expect(
        found.get(key)?.length ?? 0,
        `${entry.path}:${entry.marker} count changed (found ${describeOccurrences(found.get(key))}); update this gate with an explicit file/marker classification`,
      ).toBe(entry.expectedCount)
    }

    const unclassified = [...found.entries()]
      .filter(([key]) => !expected.has(key))
      .map(([key, occurrences]) => {
        const [relative, marker] = key.split('\u0000')
        return `${relative}:${describeOccurrences(occurrences)} (add an exact file/marker classification)`
      })
    expect(
      unclassified,
      'new flat model/runtime access is unclassified; the failure lists exact file, marker, and source lines',
    ).toEqual([])

    // Keep this manifest explicit even when the current Phase 2 slice has no
    // ordinary-pending entries; a future ordinary access must be reviewed and
    // named here instead of being silently absorbed by a fallback category.
    const ordinaryPending = inventory
      .filter((entry) => entry.classification === 'ordinary-pending')
      .map((entry) => `${entry.path}:${entry.marker} (${entry.reason})`)
    const expectedOrdinaryPending: readonly string[] = []
    expect(ordinaryPending).toEqual(expectedOrdinaryPending)
  })
})
