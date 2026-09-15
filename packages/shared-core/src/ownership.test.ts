import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { isInside, moduleSpecifiers, parseSource, resolveModule } from '../../../util/test-support/source-contract.js'
import {
  forwardingFacades,
  packageExports,
  requiredImports,
  retiredPaths,
} from '../../../util/test-support/shared-core-ownership.js'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const parsed = new Map<string, ts.SourceFile>()
function source(file: string): ts.SourceFile {
  if (!parsed.has(file)) parsed.set(file, parseSource(file, fs.readFileSync(path.join(repoRoot, file), 'utf8')))
  return parsed.get(file)!
}

function forwardsOnly(file: ts.SourceFile, specifier: string, expectedExports: readonly string[] = ['*']): boolean {
  const exports: string[] = []
  for (const statement of file.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== specifier
    )
      return false
    if (!statement.exportClause) exports.push('*')
    else if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly || element.propertyName) return false
        exports.push(element.name.text)
      }
    } else return false
  }
  return exports.sort().join(',') === [...expectedExports].sort().join(',')
}

function exportedNames(file: ts.SourceFile): string[] {
  return file.statements.flatMap((node) => {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.map((element) => element.name.text)
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      return node.name ? [node.name.text] : []
    }
    return []
  })
}

function declaredFunctions(file: ts.SourceFile): string[] {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) names.push(node.name.text)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      names.push(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

// This verifies the imported binding reaches a call or re-export. Behavioral tests
// beside the algorithm and its consumers remain responsible for the result.
function usesImportedFunction(file: ts.SourceFile, specifier: string, symbol: string): boolean {
  const options = { noResolve: true, noLib: true }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name) => (name === file.fileName ? file : undefined)
  const checker = ts.createProgram([file.fileName], options, host).getTypeChecker()
  const locals = new Set<ts.Symbol>()
  for (const node of file.statements) {
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === specifier
    ) {
      if (!node.exportClause) return true
      if (
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === symbol)
      )
        return true
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === specifier
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (
            !node.importClause?.isTypeOnly &&
            !binding.isTypeOnly &&
            (binding.propertyName ?? binding.name).text === symbol
          ) {
            const local = checker.getSymbolAtLocation(binding.name)
            if (local) locals.add(local)
          }
        }
      }
    }
  }
  let used = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const called = checker.getSymbolAtLocation(node.expression)
      if (called && locals.has(called)) used = true
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      if (
        node.exportClause.elements.some((element) => {
          const local = checker.getExportSpecifierLocalTargetSymbol(element)
          return !element.isTypeOnly && local && locals.has(local)
        })
      )
        used = true
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return used
}

describe('@risuai/shared-core ownership', () => {
  it.each(Object.entries(requiredImports))('keeps consumers on %s', (specifier, consumers) => {
    for (const consumer of consumers) {
      const references = moduleSpecifiers(source(consumer))
      if (specifier.endsWith('/')) {
        const sharedReferences = references.filter((reference) => reference.startsWith(specifier))
        expect(sharedReferences.length, consumer).toBeGreaterThan(0)
        for (const reference of sharedReferences)
          expect(resolveModule(repoRoot, consumer, reference), consumer).toBeDefined()
      } else {
        const target = resolveModule(repoRoot, consumer, specifier)
        expect(target, `${consumer}: ${specifier} must resolve`).toBeDefined()
        expect(
          specifier.startsWith('.')
            ? references.some((reference) => resolveModule(repoRoot, consumer, reference) === target)
            : references.includes(specifier),
          `${consumer}: ${specifier}`,
        ).toBe(true)
      }
    }
  })

  it('publishes the retained package subpaths and root exports', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/shared-core/package.json'), 'utf8'))
    const index = 'packages/shared-core/src/index.ts'
    const rootExports = source(index)
      .statements.filter(
        (node): node is ts.ExportDeclaration => ts.isExportDeclaration(node) && !node.isTypeOnly && !node.exportClause,
      )
      .flatMap((node) =>
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text] : [],
      )
    for (const [subpath, implementation] of Object.entries(packageExports)) {
      expect(manifest.exports[subpath], subpath).toBe(implementation)
      const target = path.resolve(repoRoot, 'packages/shared-core', implementation)
      expect(fs.existsSync(target), implementation).toBe(true)
      expect(
        rootExports.some((specifier) => resolveModule(repoRoot, index, specifier) === target),
        subpath,
      ).toBe(true)
    }
  })

  it('keeps compatibility-only facades free of another implementation', () => {
    for (const [file, [specifier, exports]] of Object.entries(forwardingFacades)) {
      expect(forwardsOnly(source(file), specifier, exports), file).toBe(true)
    }
    for (const retired of retiredPaths) expect(fs.existsSync(path.join(repoRoot, retired)), retired).toBe(false)
  })

  it('keeps Fastify imports out of browser-owned implementations', () => {
    const violations: string[] = []
    const serverRoot = path.join(repoRoot, 'server/fastify')
    for (const entry of fs.readdirSync(serverRoot, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.ts')) continue
      const importer = `server/fastify/${entry}`
      for (const specifier of moduleSpecifiers(source(importer))) {
        const target =
          resolveModule(repoRoot, importer, specifier) ??
          (specifier.startsWith('.') ? path.resolve(repoRoot, path.dirname(importer), specifier) : undefined)
        if ((target && isInside(path.join(repoRoot, 'src'), target)) || specifier.startsWith('src/')) {
          violations.push(`${importer}: ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  }, 15_000)

  it('retains browser-only adapters and projected credential exports', () => {
    for (const [file, names] of Object.entries({
      'src/ts/agentLorebookInputs.ts': ['lorebookEntriesForOriginalRisuExport'],
      'src/ts/moduleActivation.ts': ['resolveActiveModuleIdentifiers', 'resolveActiveModuleStates'],
      'src/ts/model/providerCredentialRecords.ts': ['normalizeProjectedProviderCredentials'],
      'packages/shared-core/src/providerCredentialRecords.ts': ['normalizeProjectedProviderCredentials'],
    })) {
      expect(exportedNames(source(file)), file).toEqual(expect.arrayContaining(names))
    }
    const sharedDependencies = moduleSpecifiers(source('packages/shared-core/src/moduleActivation.ts'))
    for (const forbidden of ['agentPresetResolver', 'personaModuleLinks']) {
      expect(
        sharedDependencies.some((specifier) => specifier.includes(forbidden)),
        forbidden,
      ).toBe(false)
    }
    const normalization = source('src/ts/process/promptTemplateNormalization.ts')
    expect(
      usesImportedFunction(
        normalization,
        '@risuai/shared-core/prompt-template-normalization',
        'normalizePromptTemplate',
      ),
    ).toBe(true)
    const wrapper = normalization.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'normalizePromptTemplate',
    )
    expect(wrapper?.body?.statements).toHaveLength(1)
    expect(ts.isReturnStatement(wrapper!.body!.statements[0])).toBe(true)
  })

  it('uses shared punctuation and chat-page bindings without duplicate helper bodies', () => {
    for (const file of requiredImports['@risuai/shared-core/punctuation']) {
      expect(usesImportedFunction(source(file), '@risuai/shared-core/punctuation', 'trimUntilPunctuation'), file).toBe(
        true,
      )
    }
    for (const file of requiredImports['@risuai/shared-core/chat-page']) {
      expect(usesImportedFunction(source(file), '@risuai/shared-core/chat-page', 'normalizeChatPageIndex'), file).toBe(
        true,
      )
      expect(declaredFunctions(source(file)), file).not.toContain('normalizeChatPage')
    }
    expect(declaredFunctions(source('server/fastify/src/prompt/cbsAdapter.ts'))).not.toContain('sfc32')
    expect(declaredFunctions(source('server/fastify/src/prompt/cbsAdapter.ts'))).not.toContain('pickHashRand')
    expect(declaredFunctions(source('src/ts/agentLorebookInputs.ts'))).not.toContain('resolveAgentLorebookInput')
  })

  it.each([
    ['personaSelectionIdentity', 'mintDeterministicPersonaId'],
    ['hypaV3PresetSelectionIdentity', 'mintDeterministicHypaV3PresetId'],
  ])('keeps %s identity repair independent of imports and UUID randomness', (file, mint) => {
    const owner = source(`packages/shared-core/src/${file}.ts`)
    expect(declaredFunctions(owner)).toContain(mint)
    expect(moduleSpecifiers(owner)).toEqual([])
    const identifiers: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) identifiers.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(owner)
    expect(identifiers).not.toContain('randomUUID')
  })

  it('rejects comment-only imports, unused bindings, and a facade with a local body', () => {
    const specifier = '@risuai/shared-core/punctuation'
    const comment = parseSource('fixture.ts', `// export * from '${specifier}'`)
    expect(moduleSpecifiers(comment)).toEqual([])
    expect(forwardsOnly(comment, specifier)).toBe(false)
    expect(forwardsOnly(parseSource('fixture.ts', `export type * from '${specifier}'`), specifier)).toBe(false)
    expect(
      forwardsOnly(parseSource('fixture.ts', `export { trimUntilPunctuation } from '${specifier}'`), specifier),
    ).toBe(false)
    const unused = parseSource('fixture.ts', `import { isLastCharPunctuation as punctuation } from '${specifier}';`)
    expect(usesImportedFunction(unused, specifier, 'isLastCharPunctuation')).toBe(false)
    const shadowed = parseSource(
      'fixture.ts',
      `${unused.text}\nfunction run(punctuation: () => void) { punctuation() }`,
    )
    expect(usesImportedFunction(shadowed, specifier, 'isLastCharPunctuation')).toBe(false)
    const used = parseSource('fixture.ts', `${unused.text}\nexport const result = punctuation('hello!')`)
    expect(usesImportedFunction(used, specifier, 'isLastCharPunctuation')).toBe(true)
    expect(
      forwardsOnly(parseSource('fixture.ts', `export * from "${specifier}";\nexport function local() {}`), specifier),
    ).toBe(false)
    const component = parseSource(
      'fixture.svelte',
      `<script lang="ts">${used.text}</script><p>import fake from 'browser'</p>`,
    )
    expect(moduleSpecifiers(component)).toEqual([specifier])
  })
})
