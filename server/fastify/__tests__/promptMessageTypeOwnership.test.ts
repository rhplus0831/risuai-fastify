import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  exportedInterfaceProperties,
  moduleSpecifiers,
  parseSource,
  resolveModule,
} from '../../../util/test-support/source-contract.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function parsedSource(file: string): ts.SourceFile {
  return parseSource(file, fs.readFileSync(path.join(repoRoot, file), 'utf8'))
}

function expectNoForbiddenImports(consumers: string[], forbiddenFiles: string[]): void {
  const forbiddenTargets = new Set(forbiddenFiles.map((file) => fs.realpathSync(path.join(repoRoot, file))))
  const offenders = consumers.flatMap((consumer) =>
    moduleSpecifiers(parsedSource(consumer)).flatMap((specifier) => {
      const resolved = resolveModule(repoRoot, consumer, specifier)
      return resolved && forbiddenTargets.has(resolved) ? [`${consumer} -> ${specifier}`] : []
    }),
  )
  expect(offenders).toEqual([])
}

function exportedTypeAlias(source: ts.SourceFile, name: string): ts.TypeAliasDeclaration | undefined {
  return source.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === name &&
      !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  )
}

function exportedInterface(source: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
  return source.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) &&
      node.name.text === name &&
      !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  )
}

function propertyType(source: ts.SourceFile, owner: ts.InterfaceDeclaration, name: string): ts.TypeNode | undefined {
  return owner.members.find(
    (member): member is ts.PropertySignature => ts.isPropertySignature(member) && member.name.getText(source) === name,
  )?.type
}

function stringLiterals(type: ts.TypeNode | undefined): string[] {
  if (!type) return []
  if (ts.isUnionTypeNode(type)) return type.types.flatMap(stringLiterals)
  return ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal) ? [type.literal.text] : []
}

describe('prompt transfer type ownership', () => {
  it('keeps prompt-message consumers behind exported Fastify-owned records', () => {
    expectNoForbiddenImports(
      [
        'server/fastify/src/memoryPlanner.ts',
        'server/fastify/src/memoryChunkPlanner.ts',
        'server/fastify/src/memorySummaryPrompt.ts',
        'server/fastify/src/memorySummaryAdapter.ts',
        'server/fastify/src/prompt/agentPresetExecution.ts',
        'server/fastify/src/prompt/assetLookup.ts',
        'server/fastify/src/prompt/assemble.ts',
        'server/fastify/src/prompt/chatDispatch.ts',
        'server/fastify/src/prompt/history.ts',
        'server/fastify/src/prompt/lorebook.ts',
        'server/fastify/src/prompt/luaRuntime.ts',
        'server/fastify/src/prompt/memory.ts',
        'server/fastify/src/prompt/memoryAdapter.ts',
        'server/fastify/src/prompt/budgetFinalize.ts',
        'server/fastify/src/prompt/plainSections.ts',
        'server/fastify/src/prompt/preflight.ts',
        'server/fastify/src/prompt/prefixTokenMemo.ts',
        'server/fastify/src/prompt/staticSections.ts',
        'server/fastify/src/prompt/templates.ts',
        'server/fastify/src/prompt/promptSummary.ts',
        'server/fastify/src/prompt/tokens.ts',
        'server/fastify/src/prompt/triggerDataEffects.ts',
        'server/fastify/src/routes/generation.ts',
        'server/fastify/src/routes/generationChat.ts',
      ],
      ['src/ts/process/index.svelte.ts'],
    )

    const owner = parsedSource('server/fastify/src/prompt/promptMessage.ts')
    expect(exportedInterfaceProperties(owner, 'PromptMessage')).toBeDefined()
    expect(exportedInterfaceProperties(owner, 'PromptMultimodal')).toBeDefined()
  })

  it('keeps prompt-memory query projection behind exported Fastify-owned records', () => {
    const ownerFile = 'server/fastify/src/promptMemoryQuery.ts'
    expectNoForbiddenImports([ownerFile], ['src/ts/storage/database.svelte.ts'])

    const owner = parsedSource(ownerFile)
    expect(exportedInterfaceProperties(owner, 'PromptMemoryQueryMessage')).toBeDefined()
    expect(exportedInterfaceProperties(owner, 'PromptMemoryQueryDatabase')).toBeDefined()
    const database = exportedInterface(owner, 'PromptMemoryQueryDatabase')
    const bases = database?.heritageClauses
      ?.filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      .flatMap((clause) => clause.types.map((base) => base.expression.getText(owner)))
    expect(bases).toContain('MemoryEmbeddingSettings')
  })

  it('keeps prompt-template consumers behind the closed Fastify-owned card union', () => {
    const consumers = [
      'server/fastify/src/prompt/assemble.ts',
      'server/fastify/src/prompt/memory.ts',
      'server/fastify/src/prompt/preflight.ts',
      'server/fastify/src/prompt/templates.ts',
    ]
    expectNoForbiddenImports(consumers, ['src/ts/process/prompt.ts'])

    const owner = parsedSource('server/fastify/src/prompt/promptTemplate.ts')
    const card = exportedTypeAlias(owner, 'PromptTemplateCard')
    const members = card && ts.isUnionTypeNode(card.type) ? card.type.types : []
    const memberNames = members.map((member) =>
      ts.isTypeReferenceNode(member) ? member.typeName.getText(owner) : '<inline>',
    )
    expect([...memberNames].sort()).toEqual(
      [
        'PromptItemAuthorNote',
        'PromptItemCache',
        'PromptItemChat',
        'PromptItemChatML',
        'PromptItemPlain',
        'PromptItemTyped',
      ].sort(),
    )

    const cardTypes = members.flatMap((member) => {
      if (!ts.isTypeReferenceNode(member)) return []
      const declaration = exportedInterface(owner, member.typeName.getText(owner))
      return stringLiterals(declaration && propertyType(owner, declaration, 'type'))
    })
    expect([...cardTypes].sort()).toEqual(
      [
        'authornote',
        'cache',
        'chat',
        'chatML',
        'cot',
        'description',
        'jailbreak',
        'lorebook',
        'memory',
        'persona',
        'plain',
        'postEverything',
      ].sort(),
    )

    const chat = exportedInterface(owner, 'PromptItemChat')
    const rangeEnd = chat && propertyType(owner, chat, 'rangeEnd')
    const rangeEndMembers = rangeEnd && ts.isUnionTypeNode(rangeEnd) ? rangeEnd.types : []
    expect(rangeEndMembers).toHaveLength(2)
    expect(rangeEndMembers.filter((member) => member.kind === ts.SyntaxKind.NumberKeyword)).toHaveLength(1)
    expect(
      rangeEndMembers.filter(
        (member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) && member.literal.text === 'end',
      ),
    ).toHaveLength(1)

    const cache = exportedInterface(owner, 'PromptItemCache')
    expect([...stringLiterals(cache && propertyType(owner, cache, 'role'))].sort()).toEqual(
      ['all', 'assistant', 'system', 'user'].sort(),
    )
  })
})
