import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { prebuiltNAIpresets, prebuiltPresets } from '../src/legacyGenerationDefaults.js'
import { parseSource, resolveModule } from '../../../util/test-support/source-contract.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

describe('Fastify legacy generation defaults ownership', () => {
  it('keeps database normalization on the Fastify-owned compatibility module', () => {
    const consumer = 'server/fastify/src/databaseDefaults.ts'
    const owner = 'server/fastify/src/legacyGenerationDefaults.ts'
    const databaseDefaults = parseSource(consumer, source(consumer))
    const ownerTarget = fs.realpathSync(path.join(repoRoot, owner))
    const ownerImport = databaseDefaults.statements.find(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        resolveModule(repoRoot, consumer, node.moduleSpecifier.text) === ownerTarget,
    )
    const bindings = ownerImport?.importClause?.namedBindings
    const importedNames =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((item) => item.propertyName?.text ?? item.name.text)
        : []

    expect(importedNames).toEqual(expect.arrayContaining(['prebuiltNAIpresets', 'prebuiltPresets']))
  })

  it('contains exactly the legacy fields consumed by database normalization', () => {
    expect(Object.keys(prebuiltPresets)).toEqual(['OAI'])
    expect(Object.keys(prebuiltPresets.OAI)).toEqual(['mainPrompt', 'jailbreak', 'ooba', 'ainconfig'])
    expect(Object.keys(prebuiltNAIpresets)).toEqual([
      'topK',
      'topP',
      'topA',
      'tailFreeSampling',
      'repetitionPenalty',
      'repetitionPenaltyRange',
      'repetitionPenaltySlope',
      'repostitionPenaltyPresence',
      'seperator',
      'frequencyPenalty',
      'presencePenalty',
      'typicalp',
      'starter',
    ])
  })
})
