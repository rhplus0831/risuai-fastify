import { expect } from 'vitest'

// Reusable mutation-range review-gate template. A command's `command_mutation`
// metric is checked against the gate for its `mutationPath`: every timing
// section is present, db.json is never rewritten on a targeted path, and the set
// of physical tables the command wrote (`writtenTables`) matches what a
// narrowed write is allowed to touch. Import this from any command/metric test
// instead of re-deriving the gates inline.

export const COMMAND_METRIC_SECTIONS = ['loadMs', 'cloneMutateMs', 'sqliteSyncMs', 'dbJsonWriteMs', 'totalMs'] as const

export type CommandMetricSection = (typeof COMMAND_METRIC_SECTIONS)[number]

/**
 * The physical tables the broad `replaceAll*` writers rewrite for any single
 * sub-row change. Sorted to match `takeTableWrites()` output. A `message-free`
 * mutation rewrites exactly this set; a `hydrated` mutation additionally loads
 * every chat's messages and writes the message store (`messages` /
 * `chat_hypa_v3`) only when a message actually changed.
 */
export const BROAD_WRITE_TABLES = [
  'bot_presets',
  'characters',
  'chats',
  'greeting_translations',
  'hypa_v3_presets',
  'loadouts',
  'lore_books',
  'model_presets',
  'modules',
  'personas',
  'plugin_custom_storage',
  'plugins',
  'prompt_presets',
  'prompt_templates',
  'settings',
  'translator_presets',
] as const

const MESSAGE_STORE_TABLES = ['chat_hypa_v3', 'messages'] as const

export const BARDWIKI_WRITE_TABLES = [
  'bardwiki_change_manifest',
  'bardwiki_chat_settings',
  'bardwiki_document_search',
  'bardwiki_document_sources',
  'bardwiki_document_versions',
  'bardwiki_documents',
  'bardwiki_jobs',
  'bardwiki_links',
  'bardwiki_rebuild_staging',
  'bardwiki_turn_receipts',
] as const

export interface CommandMetricGate {
  reviewGate: string
  sections: readonly CommandMetricSection[]
  /** Required exact value of `dbJsonWriteMs` (0 for every targeted path). */
  dbJsonWriteMs?: number
  /** Exact set of physical tables the path must write (sorted). */
  expectedTables?: readonly string[]
  /** The path's `writtenTables` must be a subset of this set. */
  maxTables?: readonly string[]
  /** The path's `writtenTables` must be disjoint from this set. */
  forbiddenTables?: readonly string[]
}

export const COMMAND_METRIC_REVIEW_GATES = {
  // Broad baselines (not yet narrowed). These are the over-broad paths the
  // workstream measures the before-state of.
  hydrated: {
    reviewGate: 'hydrated commands rewrite the full table set and may touch the message store',
    sections: COMMAND_METRIC_SECTIONS,
    maxTables: [...BROAD_WRITE_TABLES, ...MESSAGE_STORE_TABLES].sort(),
  },
  'message-free': {
    reviewGate: 'message-free commands should avoid message history synchronization work',
    sections: COMMAND_METRIC_SECTIONS,
    expectedTables: BROAD_WRITE_TABLES,
  },
  // Already-targeted paths.
  'targeted-message': {
    reviewGate: 'targeted message commands should not rewrite db.json',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: MESSAGE_STORE_TABLES,
  },
  'targeted-generation': {
    reviewGate: 'targeted generation persistence writes only the active chat row and message store',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: ['chats', ...MESSAGE_STORE_TABLES].sort(),
  },
  'generation-effect-igp-commit': {
    reviewGate:
      'atomic IGP completion writes only its exact assistant message and effect receipt, plus derived memory/wiki invalidation rows for that changed transcript',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: [
      'bardwiki_jobs',
      'bardwiki_turn_receipts',
      'generation_effects',
      'memory_chunks',
      'memory_jobs',
      'messages',
    ],
  },
  'generation-effect-inlay-prepare': {
    reviewGate: 'inlay preparation writes only the exact generation-effect obligation marker',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    expectedTables: ['generation_effects'],
  },
  'generation-effect-inlay-finalize': {
    reviewGate:
      'inlay finalization writes only its exact assistant message and generation-effect state, plus derived memory/wiki invalidation rows for that changed transcript',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: [
      'bardwiki_jobs',
      'bardwiki_turn_receipts',
      'generation_effects',
      'memory_chunks',
      'memory_jobs',
      'messages',
    ],
  },
  'generation-effect-inlay-abandon': {
    reviewGate: 'inlay abandonment writes only the exact generation-effect obligation marker',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    expectedTables: ['generation_effects'],
  },
  'targeted-assembly': {
    reviewGate:
      'prompt-assembly persistence writes only the active chat row and message store, including when a chat-var write rides along',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: ['chats', ...MESSAGE_STORE_TABLES].sort(),
  },
  'targeted-character-selection': {
    reviewGate: 'character selection should update only the selected character row and settings',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    expectedTables: ['characters', 'settings'],
  },
  // Targeted mutation vehicles used by narrowed command routes.
  'targeted-settings': {
    reviewGate:
      'settings-scalar commands should issue one UPDATE settings (plus hypa_v3_presets only for a memory-group hypaV3Presets patch) and never touch characters, chats, or the other collections',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: ['hypa_v3_presets', 'settings'],
  },
  'targeted-character-row': {
    reviewGate:
      "character-scoped edits write that character row (+ its own chat rows on folder-cascade / chats-reorder / fork, + the forked chat's messages, + settings only when a pointer moved) and never another collection table",
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: ['chat_hypa_v3', 'characters', 'chats', 'greeting_translations', 'messages', 'settings'],
    forbiddenTables: [
      'bot_presets',
      'hypa_v3_presets',
      'loadouts',
      'lore_books',
      'modules',
      'personas',
      'plugin_custom_storage',
      'plugins',
      'prompt_templates',
      'translator_presets',
    ],
  },
  'targeted-chat-row': {
    reviewGate: 'single chat-row edits write that chat row plus its parent character row only when a pointer moved',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: ['characters', 'chats'],
  },
  'targeted-collection': {
    reviewGate: 'collection edits write only the changed collection table plus its pointer scalar',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    forbiddenTables: ['characters', 'chats'],
  },
  'targeted-cross-owner': {
    reviewGate: 'cross-owner deletion writes only the explicitly cascaded owner rows',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: ['characters', 'chats', 'loadouts', 'modules', 'personas', 'settings'],
  },
  'targeted-plugin-storage': {
    reviewGate: 'plugin custom storage writes touch only plugin_custom_storage',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    expectedTables: ['plugin_custom_storage'],
  },
  'targeted-inlay-catalog': {
    reviewGate: 'inlay catalog commands touch only the catalog row set and never immutable asset bytes',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    expectedTables: ['inlay_catalog'],
  },
  'targeted-greeting-translation': {
    reviewGate: 'greeting translation commits touch only the normalized greeting translation store',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    expectedTables: ['greeting_translations'],
  },
  'targeted-bardwiki': {
    reviewGate: 'BardWiki commands write only the normalized per-chat wiki, receipt, and job tables',
    sections: COMMAND_METRIC_SECTIONS,
    dbJsonWriteMs: 0,
    maxTables: BARDWIKI_WRITE_TABLES,
  },
} satisfies Record<string, CommandMetricGate>

export type CommandMutationPath = keyof typeof COMMAND_METRIC_REVIEW_GATES

export interface CommandMutationMetric {
  metric?: string
  type?: string
  resource?: string
  revision?: number
  status?: string
  loadMs?: number
  cloneMutateMs?: number
  sqliteSyncMs?: number
  dbJsonWriteMs?: number
  totalMs?: number
  mutationPath?: string
  writtenTables?: string[]
}

/** Look up the review gate for a metric's `mutationPath`, asserting one exists. */
export function commandMetricReviewGate(metric: CommandMutationMetric): CommandMetricGate {
  const mutationPath = metric.mutationPath
  expect(mutationPath, `missing mutationPath for ${metric.type}`).toBeTruthy()
  const gate = COMMAND_METRIC_REVIEW_GATES[mutationPath as keyof typeof COMMAND_METRIC_REVIEW_GATES]
  expect(gate, `missing command metric review gate for ${mutationPath}`).toBeTruthy()
  return gate
}

/**
 * Assert a `command_mutation` metric satisfies the review gate for its
 * `mutationPath`: every timing section is a non-negative number, `dbJsonWriteMs`
 * matches when the gate fixes it, and `writtenTables` is present whenever the
 * gate declares an exact / subset / disjoint table constraint and respects it.
 */
export function assertCommandMetricGate(metric: CommandMutationMetric): CommandMetricGate {
  const gate = commandMetricReviewGate(metric)
  for (const section of gate.sections) {
    expect(metric[section], `${metric.type}.${section}`).toBeGreaterThanOrEqual(0)
  }
  if (typeof gate.dbJsonWriteMs === 'number') {
    expect(metric.dbJsonWriteMs, `${metric.type}.dbJsonWriteMs`).toBe(gate.dbJsonWriteMs)
  }
  const written = metric.writtenTables
  const hasTableBudget = Boolean(gate.expectedTables || gate.maxTables || gate.forbiddenTables)
  if (hasTableBudget) {
    expect(written, `${metric.mutationPath}.writtenTables is required by its table budget`).toEqual(expect.any(Array))
  }
  if (written) {
    if (gate.expectedTables) {
      expect(written, `${metric.mutationPath}.writtenTables`).toEqual([...gate.expectedTables])
    }
    if (gate.maxTables) {
      const allowed = new Set(gate.maxTables)
      const extra = written.filter((table) => !allowed.has(table))
      expect(extra, `${metric.mutationPath} wrote tables outside maxTables`).toEqual([])
    }
    if (gate.forbiddenTables) {
      const forbidden = new Set(gate.forbiddenTables)
      const violated = written.filter((table) => forbidden.has(table))
      expect(violated, `${metric.mutationPath} wrote forbidden tables`).toEqual([])
    }
  }
  return gate
}
