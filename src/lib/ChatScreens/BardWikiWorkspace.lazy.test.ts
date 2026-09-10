import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'svelte/compiler'
import { describe, expect, it } from 'vitest'

type AstNode = {
  source?: AstNode
  type?: string
  value?: unknown
  [key: string]: unknown
}

function walkAst(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== 'object') return
  const astNode = node as AstNode
  visit(astNode)
  for (const [key, value] of Object.entries(astNode)) {
    if (key === 'metadata' || key === 'parent') continue
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit)
    } else {
      walkAst(value, visit)
    }
  }
}

function importCounts(source: string, specifier: string): { dynamic: number; eager: number } {
  const ast = parse(source, { filename: 'src/lib/ChatScreens/ChatScreen.svelte', modern: true })
  let dynamic = 0
  let eager = 0
  const countImport = (node: AstNode) => {
    if (node.source?.value !== specifier) return
    if (node.type === 'ImportExpression') dynamic += 1
    if (node.type === 'ImportDeclaration') eager += 1
  }
  walkAst(ast.instance?.content, countImport)
  walkAst(ast.module?.content, countImport)
  return { dynamic, eager }
}

describe('BardWiki workspace loading boundary', () => {
  it('keeps the workspace behind the active-chat lazy modal', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/ChatScreen.svelte'), 'utf8')
    const workspace = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/BardWikiWorkspace.svelte'), 'utf8')

    const workspaceImports = importCounts(source, './BardWikiWorkspace.svelte')
    expect(workspaceImports.dynamic).toBeGreaterThan(0)
    expect(workspaceImports.eager).toBe(0)
    expect(source).toContain('if (bardWikiChatId !== selectedChatId) openBardWiki = false')
    expect(source).toContain(
      'if (!request || !selectedChatId || selectedCharacter?.chaId !== request.characterId) return',
    )
    expect(source).toContain('bardWikiWorkspaceOpenRequest.set(null)')
    expect(workspace).toContain('grid-cols-1 md:grid-cols-[minmax(13rem,18rem)_1fr]')
  })
})
