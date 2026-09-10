import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { moduleSpecifiers, parseSource, resolveModule } from '../../../util/test-support/source-contract.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const serverRoots = ['server/fastify/src', 'server/fastify/__tests__', 'server/fastify/browser-smoke']

function typescriptFiles(root: string): string[] {
  const absolute = path.join(repoRoot, root)
  if (!fs.existsSync(absolute)) return []
  return fs.readdirSync(absolute, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !/\.(?:cts|mts|ts|tsx)$/.test(entry.name)) return []
    return [path.join(entry.parentPath, entry.name)]
  })
}

function forbiddenDependencyOffenders(files: string[], forbiddenFiles: string[]): string[] {
  const forbiddenTargets = new Map(
    forbiddenFiles.map((file) => [fs.realpathSync(path.join(repoRoot, file)), file] as const),
  )

  return files.flatMap((file) => {
    const absolute = path.join(repoRoot, file)
    const source = parseSource(file, fs.readFileSync(absolute, 'utf8'))
    return moduleSpecifiers(source).flatMap((specifier) => {
      const target = resolveModule(repoRoot, file, specifier)
      const forbidden = target ? forbiddenTargets.get(target) : undefined
      return forbidden ? [`${file} -> ${specifier} (${forbidden})`] : []
    })
  })
}

function relativeTypescriptFiles(root: string): string[] {
  return typescriptFiles(root).map((file) => path.relative(repoRoot, file))
}

describe('Fastify application-model type ownership', () => {
  it('has no production, server-test, or browser-smoke import of the browser aggregate database module', () => {
    const offenders = forbiddenDependencyOffenders(serverRoots.flatMap(relativeTypescriptFiles), [
      'src/ts/storage/database.svelte.ts',
    ])

    expect(offenders).toEqual([])
  })

  it.each([
    {
      name: 'Lua runtime stays independent from the browser parser',
      consumers: ['server/fastify/src/prompt/luaRuntime.ts'],
      forbidden: ['src/ts/parser/parser.svelte.ts'],
    },
    {
      name: 'memory embedding stays independent from browser Hypa memory',
      consumers: [
        'server/fastify/src/embeddingOperations.ts',
        'server/fastify/src/memoryEmbeddingModel.ts',
        'server/fastify/src/memoryEmbedJobHandler.ts',
      ],
      forbidden: ['src/ts/process/memory/hypamemory.ts'],
    },
    {
      name: 'legacy generation defaults stay independent from browser prompt templates',
      consumers: ['server/fastify/src/databaseDefaults.ts', 'server/fastify/src/legacyGenerationDefaults.ts'],
      forbidden: ['src/ts/process/templates/templates.ts'],
    },
  ])('$name', ({ consumers, forbidden }) => {
    expect(forbiddenDependencyOffenders(consumers, forbidden)).toEqual([])
  })

  it('exports finite selected database and row contracts without aggregate escape types', () => {
    const ownerPath = path.join(repoRoot, 'server/fastify/src/prompt/serverTypes.ts')
    const configPath = path.join(repoRoot, 'server/fastify/tsconfig.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
    const program = ts.createProgram([ownerPath], parsed.options)
    const checker = program.getTypeChecker()
    const owner = program.getSourceFile(ownerPath)!
    const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(owner)!)
    const contracts = {
      GenerationSettings: ['temperature', 'customModels', 'promptTemplate'],
      FastifyDatabase: ['characters', 'temperature'],
      FastifyChat: ['message', 'generationSettings'],
      FastifyMessage: ['role', 'data'],
      FastifyCharacter: ['chaId', 'chats'],
      FastifyLoreBook: ['content', 'mode'],
      FastifyCustomScript: ['in', 'out'],
      FastifyMessagePresetInfo: ['promptText', 'promptName'],
    }

    for (const [name, requiredProperties] of Object.entries(contracts)) {
      const symbol = exports.find((entry) => entry.name === name)
      expect(symbol, name).toBeDefined()
      const contract = checker.getDeclaredTypeOfSymbol(symbol!)
      expect(contract.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never), name).toBe(0)
      expect(checker.getIndexInfosOfType(contract), name).toEqual([])
      const properties = checker.getPropertiesOfType(contract)
      expect(
        properties.map((property) => property.name),
        name,
      ).toEqual(expect.arrayContaining(requiredProperties))
      for (const property of properties) {
        const value = checker.getTypeOfSymbolAtLocation(property, owner)
        expect(value.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown), `${name}.${property.name}`).toBe(0)
      }
    }
  })
})
