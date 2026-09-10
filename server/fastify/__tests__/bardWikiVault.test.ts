import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import * as fflate from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBardWikiDocument,
  hashBardWikiDocumentContent,
  listBardWikiDocumentVersions,
  listBardWikiDocuments,
} from '../src/bardWikiRepository.js'
import {
  applyBardWikiVaultImport,
  decodeBardWikiVault,
  encodeBardWikiVault,
  planBardWikiVaultImport,
} from '../src/bardWikiVault.js'
import { openDatabase } from '../src/db.js'

let dataDir: string
let db: DatabaseSync

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-vault-'))
  db = openDatabase(dataDir)
  seedChat('character-a', 'chat-a')
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function seedChat(characterId: string, chatId: string): void {
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run(characterId, '{}')
  db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)').run(
    chatId,
    characterId,
    '{}',
  )
}

function createDocument(
  id: string,
  logicalPath: string,
  overrides: Partial<Parameters<typeof createBardWikiDocument>[1]> = {},
) {
  return createBardWikiDocument(db, {
    id,
    chatId: 'chat-a',
    kind: 'concept',
    title: logicalPath.split('/').at(-1) ?? logicalPath,
    logicalPath,
    aliases: [],
    markdown: `## ${logicalPath}\nBody`,
    commandRevision: 1,
    ...overrides,
  })
}

describe('BardWiki Markdown vault export', () => {
  it('is deterministic and preserves Unicode, links, metadata, and normalized path collisions', () => {
    createDocument('alpha-document', 'Lore/별', {
      title: '별',
      aliases: ['Star', '星'],
      markdown: '## 별\r\nSee [[Lore/별.md]].',
      contextPolicy: 'pinned',
      reviewState: 'needs_review',
    })
    createDocument('beta-document', 'Lore/별.md', { title: '별 문서' })

    const first = encodeBardWikiVault(db, 'chat-a')
    const second = encodeBardWikiVault(db, 'chat-a')
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)

    const entries = Object.keys(fflate.unzipSync(first)).sort()
    expect(entries).toEqual(['Lore/별.md', 'Lore/별~beta-doc.md', 'manifest.json'])
    const decoded = decodeBardWikiVault(first)
    expect(decoded.documents).toEqual([
      expect.objectContaining({
        bardwikiId: 'alpha-document',
        title: '별',
        aliases: ['Star', '星'],
        contextPolicy: 'pinned',
        reviewState: 'needs_review',
        markdown: '## 별\nSee [[Lore/별.md]].',
      }),
      expect.objectContaining({ bardwikiId: 'beta-document', logicalPath: 'Lore/별.md' }),
    ])
  })

  it('does not export raw source transcript text in provenance', () => {
    createDocument('document-a', 'Events/Arrival', {
      actor: 'model',
      reason: 'analysis',
      receiptId: null,
      jobId: null,
      markdown: '## Arrival\nSafe summary only.',
    })
    const archive = encodeBardWikiVault(db, 'chat-a')
    expect(Buffer.from(archive).includes(Buffer.from('raw source message'))).toBe(false)
    expect(decodeBardWikiVault(archive).documents[0]).not.toHaveProperty('provenance')
  })
})

describe('BardWiki Markdown vault import', () => {
  it('round-trips into an empty authoritative corpus and rebuilds derived rows', () => {
    createDocument('document-a', 'People/Alice', {
      title: 'Alice',
      aliases: ['Al'],
      markdown: '## Alice\nVisits [[Places/Inn]].',
    })
    createDocument('document-b', 'Places/Inn', { title: 'Inn', markdown: '## Inn\nOpen late.' })
    const decoded = decodeBardWikiVault(encodeBardWikiVault(db, 'chat-a'))
    db.prepare('DELETE FROM bardwiki_documents WHERE chat_id = ?').run('chat-a')

    const preview = planBardWikiVaultImport(db, 'chat-a', decoded, 'skip')
    expect(preview).toMatchObject({ creates: 2, replacements: 0, noops: 0, skips: 0, applicable: true })
    const applied = applyBardWikiVaultImport(db, 'chat-a', decoded, 'skip', [], 2)
    expect(applied.creates).toBe(2)
    expect(listBardWikiDocuments(db, 'chat-a').map(({ id }) => id)).toEqual(['document-a', 'document-b'])
    expect(db.prepare('SELECT COUNT(*) AS count FROM bardwiki_links').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM bardwiki_document_search').get()).toEqual({ count: 2 })
    expect(listBardWikiDocumentVersions(db, 'document-a')[0]).toMatchObject({ actor: 'user', reason: 'import' })
  })

  it('reports skip and deterministic rename conflicts without mutating during dry-run', () => {
    const original = createDocument('document-a', 'Lore/A')
    const decoded = decodeBardWikiVault(encodeBardWikiVault(db, 'chat-a'))
    db.prepare('DELETE FROM bardwiki_documents WHERE chat_id = ?').run('chat-a')
    createDocument('document-a', 'Lore/A', { markdown: '## Changed\nLocal value.' })

    expect(planBardWikiVaultImport(db, 'chat-a', decoded, 'skip')).toMatchObject({ skips: 1, renames: 0 })
    const rename = planBardWikiVaultImport(db, 'chat-a', decoded, 'rename')
    expect(rename).toMatchObject({ creates: 1, skips: 0, renames: 1, applicable: true })
    expect(rename.actions[0]).toMatchObject({
      sourceDocumentId: original.id,
      action: 'create',
      conflict: 'id_and_path',
      logicalPath: expect.stringMatching(/^Lore\/A~[a-f0-9]{8}$/u),
    })
    expect(listBardWikiDocuments(db, 'chat-a')).toHaveLength(1)
  })

  it('requires an exact version and hash fence before replacement', () => {
    createDocument('document-a', 'Lore/A', { markdown: '## Imported\nValue.' })
    const decoded = decodeBardWikiVault(encodeBardWikiVault(db, 'chat-a'))
    db.prepare('DELETE FROM bardwiki_documents WHERE chat_id = ?').run('chat-a')
    const local = createDocument('document-a', 'Lore/A', { markdown: '## Local\nValue.' })

    expect(planBardWikiVaultImport(db, 'chat-a', decoded, 'replace')).toMatchObject({ applicable: false, skips: 1 })
    const preview = planBardWikiVaultImport(db, 'chat-a', decoded, 'replace', [
      { documentId: local.id, version: local.version, contentHash: local.contentHash },
    ])
    expect(preview).toMatchObject({ applicable: true, replacements: 1 })
    applyBardWikiVaultImport(
      db,
      'chat-a',
      decoded,
      'replace',
      [{ documentId: local.id, version: local.version, contentHash: local.contentHash }],
      2,
    )
    expect(listBardWikiDocuments(db, 'chat-a')[0].markdown).toBe('## Imported\nValue.')
  })

  it('rolls back every planned document when any import write fails', () => {
    createDocument('document-a', 'Lore/A')
    createDocument('document-b', 'Lore/B')
    const decoded = decodeBardWikiVault(encodeBardWikiVault(db, 'chat-a'))
    db.prepare('DELETE FROM bardwiki_documents WHERE chat_id = ?').run('chat-a')
    db.exec(`
      CREATE TRIGGER fail_second_bardwiki_import
      BEFORE INSERT ON bardwiki_documents
      WHEN NEW.id = 'document-b'
      BEGIN
        SELECT RAISE(FAIL, 'injected import failure');
      END;
      BEGIN IMMEDIATE;
    `)
    try {
      expect(() => applyBardWikiVaultImport(db, 'chat-a', decoded, 'skip', [], 2)).toThrow(/injected import failure/u)
      db.exec('ROLLBACK')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    expect(listBardWikiDocuments(db, 'chat-a')).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM bardwiki_document_versions').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM bardwiki_document_search').get()).toEqual({ count: 0 })
  })

  it.each(['../escape.md', '/absolute.md', 'safe\\escape.md'])('rejects unsafe archive path %s', (entryName) => {
    const archive = fflate.zipSync({
      'manifest.json': new TextEncoder().encode('{"format":"risu-bardwiki-vault","version":1,"documents":[]}'),
      [entryName]: new Uint8Array(),
    })
    expect(() => decodeBardWikiVault(archive)).toThrowError(expect.objectContaining({ code: 'bardwiki_invalid_vault' }))
  })

  it('rejects duplicate normalized logical paths before mutation', () => {
    createDocument('document-a', 'Lore/A')
    createDocument('document-b', 'Lore/B')
    const entries = fflate.unzipSync(encodeBardWikiVault(db, 'chat-a'))
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8')) as {
      documents: Array<{
        bardwikiId: string
        kind: 'concept'
        title: string
        logicalPath: string
        aliases: string[]
        contextPolicy: 'relevant'
        reviewState: 'active'
        version: number
        contentHash: string
        exportPath: string
      }>
    }
    const colliding = manifest.documents[1]
    const markdownFile = Buffer.from(entries[colliding.exportPath]).toString('utf8')
    const frontmatterEnd = markdownFile.indexOf('\n---\n', 4)
    const markdown = markdownFile.slice(frontmatterEnd + 5)
    colliding.logicalPath = 'lore/a'
    colliding.contentHash = hashBardWikiDocumentContent({ ...colliding, markdown })
    const { exportPath, ...frontmatter } = colliding
    entries[exportPath] = new TextEncoder().encode(`---\n${JSON.stringify(frontmatter)}\n---\n${markdown}`)
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    expect(() => decodeBardWikiVault(fflate.zipSync(entries))).toThrowError(
      expect.objectContaining({
        code: 'bardwiki_invalid_vault',
        message: 'Vault manifest contains duplicate logical paths',
      }),
    )
  })

  it('rejects content hash mismatches before mutation', () => {
    createDocument('document-a', 'Lore/A')
    const archive = encodeBardWikiVault(db, 'chat-a')
    const entries = fflate.unzipSync(archive)
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8')) as {
      documents: Array<{ contentHash: string }>
    }
    manifest.documents[0].contentHash = '0'.repeat(64)
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    expect(() => decodeBardWikiVault(fflate.zipSync(entries))).toThrowError(
      expect.objectContaining({ code: 'bardwiki_invalid_vault' }),
    )
  })

  it('rejects malformed UTF-8 before mutation', () => {
    createDocument('document-a', 'Lore/A')
    expect(() =>
      decodeBardWikiVault(
        fflate.zipSync({
          'manifest.json': Uint8Array.from([0xc3, 0x28]),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'bardwiki_invalid_vault' }))
  })
})
