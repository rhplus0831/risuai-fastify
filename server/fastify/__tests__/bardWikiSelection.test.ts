import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBardWikiDocument, type BardWikiDocumentWriteInput } from '../src/bardWikiRepository.js'
import { openDatabase } from '../src/db.js'
import { loadBardWikiPromptSnapshot } from '../src/prompt/bardWikiPromptRepository.js'
import { buildBardWikiQuery } from '../src/prompt/bardWikiQuery.js'
import { BardWikiPinnedBudgetError, selectBardWikiPromptRows } from '../src/prompt/bardWikiSelection.js'

let dataDir: string
let db: DatabaseSync
let revision = 1

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-selection-'))
  db = openDatabase(dataDir)
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run('character-a', '{}')
  db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)').run(
    'chat-a',
    'character-a',
    '{}',
  )
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function createDocument(
  id: string,
  overrides: Partial<Omit<BardWikiDocumentWriteInput, 'id' | 'chatId' | 'commandRevision'>> = {},
): void {
  createBardWikiDocument(db, {
    id,
    chatId: 'chat-a',
    kind: 'other',
    title: id,
    logicalPath: `Notes/${id}`,
    aliases: [],
    contextPolicy: 'relevant',
    reviewState: 'active',
    markdown: `# ${id}\n\nReference for ${id}.`,
    commandRevision: revision++,
    ...overrides,
  })
}

function select(currentInput: string, maxLinkHops: 0 | 1 | 2 = 1, tokenBudget = 4_096) {
  const query = buildBardWikiQuery({ currentInput, recentMessages: [], recentMessageCount: 12 })
  const snapshot = loadBardWikiPromptSnapshot(db, { chatId: 'chat-a', query, maxLinkHops })
  return {
    query,
    snapshot,
    selection: selectBardWikiPromptRows({
      snapshot,
      query,
      maxDocuments: 8,
      maxLinkHops,
      tokenBudget,
      countRowTokens: (content) => Math.ceil(content.length / 4),
    }),
  }
}

describe('BardWiki query construction', () => {
  it('normalizes, bounds, deduplicates, and hashes the newest transcript window', () => {
    const query = buildBardWikiQuery({
      currentInput: 'Ａlice visits THE inn',
      recentMessages: ['discarded', 'Dragon dragon', 'Obelisk'],
      recentMessageCount: 2,
    })

    expect(query.normalizedText).toBe('alice visits the inn dragon dragon obelisk')
    expect(query.terms).toEqual(['alice', 'dragon', 'inn', 'obelisk', 'the', 'visits'])
    expect(query.recentMessagesUsed).toBe(2)
    expect(query.queryHash).toMatch(/^[a-f0-9]{64}$/u)
  })
})

describe('BardWiki prompt snapshot and selection', () => {
  it('orders exact title/alias, heading/body, and resolved links deterministically', () => {
    createDocument('pinned', {
      title: 'Rules of the Road',
      logicalPath: '00/Pinned',
      contextPolicy: 'pinned',
      markdown: 'Pinned reference.',
    })
    createDocument('alice', { title: 'Alice', logicalPath: '10/Alice', markdown: 'Alice is a ranger.' })
    createDocument('tavern', {
      title: 'Old Tavern',
      logicalPath: '20/Tavern',
      aliases: ['The Inn'],
      markdown: 'The common room is quiet.',
    })
    createDocument('dragon', {
      title: 'Bestiary',
      logicalPath: '30/Bestiary',
      markdown: '# Bestiary\n\nUnrelated preface.\n\n## Dragon Lair\n\nA red dragon sleeps here.\n\nTrailing lore.',
    })
    createDocument('obelisk', {
      title: 'Ruins',
      logicalPath: '40/Ruins',
      markdown: '# Ruins\n\nA black obelisk marks the gate.',
    })
    createDocument('linked-source', {
      title: 'Journey',
      logicalPath: '50/Journey',
      markdown: 'Alice travels to [[Hidden Vale]].',
    })
    createDocument('linked-target', {
      title: 'Hidden Vale',
      logicalPath: '60/Hidden Vale',
      markdown: 'Mist shrouds every path.',
    })

    const { selection } = select('Alice met us at The Inn near the dragon and obelisk during the journey')

    expect(selection.rows.map(({ documentId, reason }) => [documentId, reason])).toEqual([
      ['pinned', 'pinned'],
      ['linked-source', 'exact_title'],
      ['alice', 'exact_title'],
      ['tavern', 'exact_alias'],
      ['dragon', 'heading_token'],
      ['obelisk', 'body_token'],
      ['linked-target', 'link_1'],
    ])
    expect(selection.rows.find(({ documentId }) => documentId === 'dragon')).toMatchObject({
      excerptHeading: 'Dragon Lair',
    })
    expect(selection.rows.every(({ content }) => content.includes('untrusted reference data'))).toBe(true)
    expect(selection.diagnostics.selected).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ markdown: expect.anything() })]),
    )
  })

  it('deduplicates one/two-hop links and excludes never, review, archived, and deleted state', () => {
    createDocument('source', { title: 'Source', markdown: '[[Middle]] and [[Target]].' })
    createDocument('middle', { title: 'Middle', markdown: '[[Target]] and [[Missing]].' })
    createDocument('target', { title: 'Target', markdown: 'Target-only lore.' })
    createDocument('never', { title: 'Forbidden', contextPolicy: 'never' })
    createDocument('review', { title: 'Review', reviewState: 'needs_review' })
    createDocument('archived', { title: 'Archived', reviewState: 'archived' })

    const { selection } = select('Source', 2)

    expect(selection.rows.map(({ documentId }) => documentId)).toEqual(['source', 'middle', 'target'])
    expect(selection.diagnostics.linkedCandidateCount).toBe(2)
    expect(selection.diagnostics.unresolvedLinkCount).toBe(1)
  })

  it('degrades to mandatory documents when the derived search index is incomplete', () => {
    createDocument('pinned', { contextPolicy: 'pinned', markdown: 'Pinned survives.' })
    createDocument('relevant', { title: 'Needle', markdown: 'A searchable needle.' })
    db.prepare("DELETE FROM bardwiki_document_search WHERE document_id = 'relevant'").run()

    const { snapshot, selection } = select('needle')

    expect(snapshot.indexState).toBe('degraded')
    expect(selection.rows.map(({ documentId }) => documentId)).toEqual(['pinned'])
    expect(selection.diagnostics.reason).toBe('degraded_index')
  })

  it('fails pinned overflow instead of silently truncating the reference', () => {
    createDocument('pinned', {
      contextPolicy: 'pinned',
      markdown: `A complete pinned paragraph ${'that must fit '.repeat(20)}`,
    })

    expect(() => select('anything', 0, 32)).toThrowError(BardWikiPinnedBudgetError)
    expect(() => select('anything', 0, 32)).toThrowError(
      expect.objectContaining({ code: 'bardwiki_pinned_budget_exceeded' }),
    )
  })

  it('uses stable path/id ties and complete-paragraph budget cuts', () => {
    createDocument('z-id', { title: 'First alpha', logicalPath: 'B/Note', markdown: 'alpha one.' })
    createDocument('a-id', { title: 'Second alpha', logicalPath: 'A/Note', markdown: 'alpha two.' })

    const first = select('alpha', 0, 1_000).selection
    const second = select('alpha', 0, 1_000).selection

    expect(first.rows.map(({ documentId }) => documentId)).toEqual(['a-id', 'z-id'])
    expect(second).toEqual(first)
  })

  it('keeps a Phase 0-sized corpus behind the 512-candidate and 32-selection bounds', () => {
    const insertDocument = db.prepare(
      `INSERT INTO bardwiki_documents (
        id, chat_id, kind, title, logical_path, normalized_path, aliases_json,
        context_policy, review_state, markdown, content_hash, version
      ) VALUES (?, 'chat-a', 'other', ?, ?, ?, '[]', 'relevant', 'active', ?, ?, 1)`,
    )
    const insertSearch = db.prepare(
      `INSERT INTO bardwiki_document_search (
        document_id, chat_id, title_terms, alias_terms, heading_terms, body_terms
      ) VALUES (?, 'chat-a', ?, '', '', ?)`,
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      for (let index = 0; index < 2_000; index++) {
        const id = `bulk-${index.toString().padStart(4, '0')}`
        const title = `Archive ${index}`
        const logicalPath = `Bulk/${index.toString().padStart(4, '0')}`
        const body = `needle record ${index}`
        insertDocument.run(id, title, logicalPath, logicalPath.toLowerCase(), body, `hash-${id}`)
        insertSearch.run(id, title.toLowerCase(), body)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    const query = buildBardWikiQuery({ currentInput: 'needle', recentMessages: [], recentMessageCount: 12 })
    const snapshot = loadBardWikiPromptSnapshot(db, { chatId: 'chat-a', query, maxLinkHops: 1 })
    const selection = selectBardWikiPromptRows({
      snapshot,
      query,
      maxDocuments: 32,
      maxLinkHops: 1,
      tokenBudget: 32_768,
      countRowTokens: (content) => Math.ceil(content.length / 4),
    })
    expect(snapshot.directCandidateIds).toHaveLength(512)
    expect(selection.diagnostics.candidateCount).toBe(512)
    expect(selection.rows).toHaveLength(32)
  })
})
