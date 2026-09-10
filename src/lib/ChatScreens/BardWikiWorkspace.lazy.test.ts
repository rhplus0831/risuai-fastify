import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('BardWiki workspace loading boundary', () => {
  it('keeps the workspace behind the active-chat lazy modal', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/ChatScreen.svelte'), 'utf8')
    const workspace = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/BardWikiWorkspace.svelte'), 'utf8')

    expect(source).toContain("const loadBardWikiWorkspace = () => import('./BardWikiWorkspace.svelte')")
    expect(source).not.toMatch(/import\s+BardWikiWorkspace\s+from/)
    expect(source).toContain('testId="bardwiki-workspace"')
    expect(source).toContain('if (bardWikiChatId !== selectedChatId) openBardWiki = false')
    expect(source).toContain(
      'if (!request || !selectedChatId || selectedCharacter?.chaId !== request.characterId) return',
    )
    expect(source).toContain('bardWikiWorkspaceOpenRequest.set(null)')
    expect(workspace).toContain('grid-cols-1 md:grid-cols-[minmax(13rem,18rem)_1fr]')
    expect(workspace).toContain('aria-modal="true"')
  })
})
