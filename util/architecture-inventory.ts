import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import Ajv2020 from 'ajv/dist/2020.js'
import { GENERATION_REJECTION_CODES } from '../packages/protocol/src/generationRejectionCodes.js'
import {
  collectClientResourceObservation,
  compareClientResourceBaseline,
  createClientResourceBaseline,
  type ClientResourceBaseline,
  type ClientResourceOwnerGapMatrix,
  validateClientResourceOwnerGapMatrix,
} from './client-resource-inventory.js'

export type CrossRuntimeLane = 'production' | 'server-test' | 'browser-smoke'
export type ImportKind = 'static' | 're-export' | 'import-equals' | 'dynamic' | 'require' | 'import-type'
export type ImportUsage = 'runtime' | 'type-only' | 'mixed'

export interface CrossRuntimeEdge {
  lane: CrossRuntimeLane
  importer: string
  specifier: string
  target: string
  kind: ImportKind
  usage: ImportUsage
  symbols: string[]
  count: number
}

export interface NonLiteralModuleReference {
  lane: CrossRuntimeLane
  importer: string
  kind: 'dynamic' | 'require'
  count: number
}

export interface ProjectReferenceObservation {
  consumer: string
  target: string
}

export interface MetadataObservation {
  id: string
  owner: string
  path: string
  count: number
}

export interface CrossRuntimeObservation {
  edges: CrossRuntimeEdge[]
  nonLiteralModuleReferences: NonLiteralModuleReference[]
  projectReferences: ProjectReferenceObservation[]
  metadata: MetadataObservation[]
}

export type BoundaryCategory =
  | 'wire-contract'
  | 'pure-runtime-behavior'
  | 'browser-application-model'
  | 'test-fixture'
  | 'server-only-behavior'
  | 'accidental-dependency'

export interface BoundaryPolicy {
  category: BoundaryCategory
  targetOwner: string
  migrationPhase: string
  exceptionOwner: string
  reviewTrigger: string
}

export interface CrossRuntimeBaseline {
  schemaVersion: 1
  openingAnchor: string
  conventions: {
    protocol: string
    sharedRuntime: string
    server: string
    fixtures: string
  }
  policies: Record<string, BoundaryPolicy>
  edges: Array<CrossRuntimeEdge & { policy: string }>
  nonLiteralModuleReferences: Array<
    NonLiteralModuleReference & { owner: string; disposition: string; reviewTrigger: string }
  >
  projectReferences: Array<
    ProjectReferenceObservation & { owner: string; purpose: string; removalPhase: string; reviewTrigger: string }
  >
  metadata: Array<
    MetadataObservation & { authority: string; migrationPhase: string; driftRule: string; reviewTrigger: string }
  >
}

export type CompatibilityDisposition =
  | 'canonical'
  | 'migrate'
  | 'import-only'
  | 'export-only'
  | 'explicit-compatibility'
  | 'temporary'
  | 'quarantine'
  | 'remove'

export interface CompatibilityProbe {
  path: string
  kind: 'identifier' | 'text'
  value: string
  expectedCount: number
}

export interface CompatibilitySurface {
  id: string
  family: 'model-configuration' | 'prompt-template' | 'translator' | 'repair' | 'interchange'
  surface: string
  currentOwner: string
  roles: Array<'read' | 'write' | 'fallback' | 'repair' | 'import' | 'export' | 'backup' | 'recovery'>
  currentPrecedence: string
  missingBehavior: string
  malformedBehavior: string
  damagedDatabaseBehavior: string
  historicalFixture: string
  provenance: string
  disposition: CompatibilityDisposition
  targetOwner: string
  migrationPhase: string
  oldReaderOrExporter: string
  rollbackProof: string
  workstream3Cursor: string
  probes: CompatibilityProbe[]
}

export interface CompatibilityBaseline {
  schemaVersion: 1
  openingAnchor: string
  conventionRelease: string
  decisionPolicy: string
  surfaces: CompatibilitySurface[]
}

const POLICY_IDS = {
  wire: 'protocol-wire-contract',
  pure: 'shared-pure-runtime',
  application: 'browser-application-model',
  fixture: 'test-fixture',
  server: 'server-only-extraction',
  accidental: 'accidental-browser-support',
} as const

export const DEFAULT_BOUNDARY_POLICIES: Record<string, BoundaryPolicy> = {
  [POLICY_IDS.wire]: {
    category: 'wire-contract',
    targetOwner: '@risuai/protocol explicit subpath',
    migrationPhase: 'Workstream 1 Phase 1, then consuming Phase 4/5 slice',
    exceptionOwner: 'Cross-runtime boundaries maintainers',
    reviewTrigger: 'Protocol parity is proven and all consumers use the explicit package subpath.',
  },
  [POLICY_IDS.pure]: {
    category: 'pure-runtime-behavior',
    targetOwner: 'audited framework-neutral shared runtime package',
    migrationPhase: 'Workstream 1 Phase 3, then consuming Phase 4/5 slice',
    exceptionOwner: 'Cross-runtime boundaries maintainers',
    reviewTrigger: 'A neutral leaf extraction passes browser/server parity and the shared import audit.',
  },
  [POLICY_IDS.application]: {
    category: 'browser-application-model',
    targetOwner: 'narrow protocol/shared domain input plus runtime-owned adapter',
    migrationPhase: 'Workstream 1 Phase 4',
    exceptionOwner: 'Fastify domain owner',
    reviewTrigger: 'The server consumer no longer needs a browser aggregate or application model declaration.',
  },
  [POLICY_IDS.fixture]: {
    category: 'test-fixture',
    targetOwner: 'runtime-neutral test fixture adjacent to its owning lane',
    migrationPhase: 'Workstream 1 Phase 4',
    exceptionOwner: 'Owning test lane maintainer',
    reviewTrigger: 'The fixture is moved or the retained test-only exception receives an explicit closeout decision.',
  },
  [POLICY_IDS.server]: {
    category: 'server-only-behavior',
    targetOwner: 'server/fastify narrow server-owned implementation',
    migrationPhase: 'Workstream 1 Phase 4',
    exceptionOwner: 'Fastify domain owner',
    reviewTrigger: 'The server-owned behavior no longer imports its browser implementation.',
  },
  [POLICY_IDS.accidental]: {
    category: 'accidental-dependency',
    targetOwner: 'owning browser-smoke/server-test support boundary',
    migrationPhase: 'Workstream 1 Phase 4 or 5',
    exceptionOwner: 'Owning smoke or server-test maintainer',
    reviewTrigger: 'Equivalent neutral support exists or the exception is explicitly retained at closeout.',
  },
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts']
const RUNTIME_PROTOCOL_TARGETS = [
  '/process/displaySourceProtocol.ts',
  '/process/request/clientContext.ts',
  '/process/request/serverToolProtocol.ts',
  '/server/characterSummaryProtocol.ts',
  '/server/embeddingOperationsProtocol.ts',
  '/server/imageGenerationProtocol.ts',
  '/server/mcpOAuthRefreshProtocol.ts',
  '/server/providerOperationsProtocol.ts',
  '/server/shellProtocol.ts',
  '/server/standaloneSettingsProtocol.ts',
  '/server/ttsProtocol.ts',
]
const APPLICATION_MODEL_TARGETS = [
  '/storage/database.svelte.ts',
  '/process/index.svelte.ts',
  '/parser/parser.svelte.ts',
  '/process/modules.ts',
  '/process/prompt.ts',
  '/process/triggers.ts',
]

function repoPath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replaceAll(path.sep, '/')
}

function walkSourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const files: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkSourceFiles(absolutePath))
    else if (entry.isFile() && SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(absolutePath)
    }
  }
  return files.sort()
}

function sourceKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  return ts.ScriptKind.TS
}

interface ModuleReference {
  kind: ImportKind
  specifier: string | null
}

const PACKAGE_IMPORT_BOUNDARIES = [
  {
    id: 'protocol-import-boundary',
    root: 'packages/protocol/src',
    allowedBareImports: new Set(['@sinclair/typebox', '@sinclair/typebox/value']),
  },
  {
    id: 'shared-core-import-boundary',
    root: 'packages/shared-core/src',
    allowedBareImports: new Set<string>(),
  },
] as const

function moduleReferences(file: string, source: string): ModuleReference[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceKind(file))
  const references: ModuleReference[] = []
  const record = (kind: ImportKind, node: ts.Expression | undefined): void => {
    references.push({ kind, specifier: node && ts.isStringLiteralLike(node) ? node.text : null })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      record('static', node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record('re-export', node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record('import-equals', node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record('import-type', node.argument.literal)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) record('dynamic', node.arguments[0])
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        record('require', node.arguments[0])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolvePackageModule(importer: string, specifier: string): string | null {
  const rawTarget = path.resolve(path.dirname(importer), specifier)
  const candidates = [
    rawTarget,
    `${rawTarget}.ts`,
    `${rawTarget}.tsx`,
    `${rawTarget}.mts`,
    `${rawTarget}.cts`,
    path.join(rawTarget, 'index.ts'),
    rawTarget.replace(/\.js$/, '.ts'),
    rawTarget.replace(/\.mjs$/, '.mts'),
    rawTarget.replace(/\.cjs$/, '.cts'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null
}

export function validatePackageImportBoundaries(repoRoot: string): string[] {
  const errors: string[] = []
  for (const boundary of PACKAGE_IMPORT_BOUNDARIES) {
    const absoluteRoot = path.join(repoRoot, boundary.root)
    const runtimeFiles = walkSourceFiles(absoluteRoot).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    )
    if (runtimeFiles.length === 0) errors.push(`${boundary.id}: no runtime modules found under ${boundary.root}`)
    for (const file of runtimeFiles) {
      const relative = repoPath(repoRoot, file)
      const references = moduleReferences(file, fs.readFileSync(file, 'utf8'))
      for (const reference of references) {
        if (reference.specifier === null) {
          errors.push(`${boundary.id}: ${relative} has a non-literal ${reference.kind} module reference`)
          continue
        }
        if (!reference.specifier.startsWith('.')) {
          if (!boundary.allowedBareImports.has(reference.specifier)) {
            errors.push(`${boundary.id}: ${relative} imports disallowed bare module ${reference.specifier}`)
          }
          continue
        }
        const target = resolvePackageModule(file, reference.specifier)
        if (!target || !isInsideDirectory(absoluteRoot, target)) {
          errors.push(`${boundary.id}: ${relative} imports outside its package boundary via ${reference.specifier}`)
        }
      }
    }
  }
  return errors
}

interface RawSendBinding {
  file: string
  localName: string
}

function runtimeClientSourceFiles(repoRoot: string, directory = path.join(repoRoot, 'src')): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['__fixtures__', '__tests__', 'docs'].includes(entry.name)) return []
      return runtimeClientSourceFiles(repoRoot, absolute)
    }
    const relative = repoPath(repoRoot, absolute)
    if (!/\.(?:svelte|ts)$/.test(entry.name) || /\.(?:d|spec|test)\.ts$/.test(entry.name)) return []
    return [relative]
  })
}

function clientModuleSource(repoRoot: string, file: string): string {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
  if (!file.endsWith('.svelte')) return source
  return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
}

function resolvesToRawGenerationModule(file: string, specifier: string): boolean {
  const rawGenerationModule = 'src/ts/process/index.svelte'
  if (specifier.startsWith('src/')) return specifier === rawGenerationModule
  return repoPath('', path.normalize(path.join(path.dirname(file), specifier))) === rawGenerationModule
}

function importedRawSendBindings(repoRoot: string, file: string): RawSendBinding[] {
  const source = clientModuleSource(repoRoot, file)
  const bindings: RawSendBinding[] = []
  for (const match of source.matchAll(/import\s*{([\s\S]*?)}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!resolvesToRawGenerationModule(file, match[2])) continue
    for (const imported of match[1].split(',')) {
      const sendBinding = /^\s*sendChat(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(imported)
      if (sendBinding) bindings.push({ file, localName: sendBinding[1] ?? 'sendChat' })
    }
  }
  for (const match of source.matchAll(/(?:const|let)\s*{([\s\S]*?)}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!resolvesToRawGenerationModule(file, match[2])) continue
    for (const imported of match[1].split(',')) {
      const sendBinding = /^\s*sendChat(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*$/.exec(imported)
      if (sendBinding) bindings.push({ file, localName: sendBinding[1] ?? 'sendChat' })
    }
  }
  return bindings
}

function callCount(source: string, localName: string): number {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...source.matchAll(new RegExp(`\\b${escaped}\\s*\\(`, 'g'))].length
}

function stringRecordInitializer(repoRoot: string, file: string, name: string): Record<string, string> | null {
  const initializer = namedInitializer(repoRoot, file, name)
  if (!ts.isObjectLiteralExpression(initializer)) return null
  const result: Record<string, string> = {}
  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) return null
    const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined
    if (!key) return null
    result[key] = property.initializer.text
  }
  return result
}

export function validateRawGenerationBoundary(repoRoot: string): string[] {
  const errors: string[] = []
  const expectedBindings = [
    { file: 'src/lib/ChatScreens/DefaultChatScreen.svelte', localName: 'sendChat', calls: 1 },
    { file: 'src/lib/SideBars/DevTool.svelte', localName: 'sendChat', calls: 1 },
    { file: 'src/ts/hotkey.ts', localName: 'sendChat', calls: 1 },
    { file: 'src/ts/plugins/apiV3/v3.svelte.ts', localName: 'processSendChat', calls: 1 },
    { file: 'src/ts/process/acceptedSendCoordinator.svelte.ts', localName: 'sendChat', calls: 2 },
  ]
  const bindings = runtimeClientSourceFiles(repoRoot)
    .flatMap((file) => importedRawSendBindings(repoRoot, file))
    .map((binding) => ({
      ...binding,
      calls: callCount(clientModuleSource(repoRoot, binding.file), binding.localName),
    }))
    .sort((left, right) => left.file.localeCompare(right.file))
  if (stableJson(bindings) !== stableJson(expectedBindings)) {
    errors.push(
      `raw-generation-callers: expected ${JSON.stringify(expectedBindings)}, observed ${JSON.stringify(bindings)}`,
    )
  }

  const internalCoordinator = clientModuleSource(repoRoot, 'src/ts/process/index.svelte.ts')
  if (callCount(internalCoordinator, 'sendChat') !== 2) {
    errors.push(
      'raw-generation-callers: src/ts/process/index.svelte.ts must contain exactly two internal sendChat calls',
    )
  }
  const requiredMarkers = [
    ['src/lib/ChatScreens/DefaultChatScreen.svelte', 'continue: continued'],
    ['src/lib/SideBars/DevTool.svelte', "preview: previewJoin !== 'prompt'"],
    ['src/ts/hotkey.ts', 'previewPrompt: true'],
    ['src/ts/plugins/apiV3/v3.svelte.ts', 'return processSendChat(-1'],
    ['src/ts/process/acceptedSendCoordinator.svelte.ts', 'async function attemptGeneration'],
    ['src/ts/process/reattach.ts', 'getGenerationProcessRuntime()'],
    ['src/ts/process/reattach.ts', 'reattachJobId: job.jobId'],
  ] as const
  for (const [file, marker] of requiredMarkers) {
    if (!fs.readFileSync(path.join(repoRoot, file), 'utf8').includes(marker)) {
      errors.push(`raw-generation-callers: ${file} is missing required marker ${JSON.stringify(marker)}`)
    }
  }
  const operationIds = stringRecordInitializer(
    repoRoot,
    'src/ts/server/browserOperationManifest.ts',
    'BROWSER_RAW_GENERATION_OPERATION_IDS',
  )
  const expectedOperationIds = {
    atomicSubmit: 'generation-operation-submit',
    compatibilityChat: 'generation-chat',
  }
  if (stableJson(operationIds) !== stableJson(expectedOperationIds)) {
    errors.push(
      `raw-generation-callers: BROWSER_RAW_GENERATION_OPERATION_IDS expected ${JSON.stringify(expectedOperationIds)}, observed ${JSON.stringify(operationIds)}`,
    )
  }
  const expectedAtomicCalls = [
    ['src/lib/ChatScreens/DefaultChatScreen.svelte', 'message: userMessage'],
    ['src/lib/SideBars/DevTool.svelte', 'message: autopilot[i]'],
    ['src/ts/plugins/apiV3/v3.svelte.ts', 'coordinateAcceptedChatSend({ target, message })'],
    ['src/ts/process/command.ts', 'message: e'],
    ['src/ts/process/files/multisend.ts', 'message: text'],
  ] as const
  for (const [file, atomicCall] of expectedAtomicCalls) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    if (!source.includes('canUseGenerationOperationProtocol')) {
      errors.push(`raw-generation-callers: ${file} is missing the capability gate`)
    }
    if (!source.includes(atomicCall)) {
      errors.push(`raw-generation-callers: ${file} is missing atomic submit marker ${JSON.stringify(atomicCall)}`)
    }
    if (!source.includes('appendCurrentChatUserMessageForSend')) {
      errors.push(`raw-generation-callers: ${file} is missing the compatibility append path`)
    }
  }
  return errors
}

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
type ModelRuntimeClassification =
  | 'effective-projection'
  | 'context-free-fallback'
  | 'compatibility'
  | 'static-import-export'
  | 'ordinary-pending'

type ModelRuntimeInventoryEntry = {
  path: string
  marker: string
  classification: ModelRuntimeClassification
  expectedCount: number
  reason: string
}

type ModelRuntimeAccessOccurrence = {
  marker: string
  line: number
}

const MODEL_RUNTIME_ROOTS = ['src/ts', 'src/lib', 'server/fastify/src', 'packages/shared-core/src'] as const
const MODEL_RUNTIME_FIELDS = [
  'aiModel',
  'subModel',
  'modelRoles',
  'maxContext',
  'maxResponse',
  'temperature',
  'top_p',
  'top_k',
] as const

const MODEL_RUNTIME_INVENTORY: readonly ModelRuntimeInventoryEntry[] = [
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

function modelRuntimeProductionFiles(repoRoot: string): string[] {
  const files: string[] = []
  for (const root of MODEL_RUNTIME_ROOTS) {
    const absoluteRoot = path.join(repoRoot, root)
    for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(ts|svelte)$/.test(entry.name)) continue
      const relative = repoPath(repoRoot, path.join(entry.parentPath, entry.name))
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

function scanModelRuntimeAccesses(repoRoot: string): Map<string, ModelRuntimeAccessOccurrence[]> {
  const receivers =
    '(?:db|database|state\\.database|scope\\.database|context\\.database|ctx\\.database|args\\.database|input\\.state\\.database|input\\.settings|dispatchDatabase|next|newPres|getDatabase\\(\\))'
  const access = new RegExp(`(?<![A-Za-z0-9_.])${receivers}\\.(${MODEL_RUNTIME_FIELDS.join('|')})\\b`, 'g')
  const found = new Map<string, ModelRuntimeAccessOccurrence[]>()
  for (const relative of modelRuntimeProductionFiles(repoRoot)) {
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

function describeModelRuntimeOccurrences(occurrences: readonly ModelRuntimeAccessOccurrence[] | undefined): string {
  return occurrences?.map(({ marker, line }) => `${marker} (line ${line})`).join(', ') ?? 'none'
}

export function validateModelRuntimeFlatAccessBoundary(repoRoot: string): string[] {
  const errors: string[] = []
  const found = scanModelRuntimeAccesses(repoRoot)
  const expected = new Map<string, ModelRuntimeInventoryEntry>()
  for (const entry of MODEL_RUNTIME_INVENTORY) {
    const key = `${entry.path}\u0000${entry.marker}`
    if (expected.has(key)) {
      errors.push(`model-runtime-flat-access: duplicate inventory marker ${entry.path}:${entry.marker}`)
      continue
    }
    expected.set(key, entry)
    const count = found.get(key)?.length ?? 0
    if (count !== entry.expectedCount) {
      errors.push(
        `model-runtime-flat-access: ${entry.path}:${entry.marker} expected ${entry.expectedCount}, observed ${count} (${describeModelRuntimeOccurrences(found.get(key))})`,
      )
    }
  }
  for (const [key, occurrences] of found) {
    if (expected.has(key)) continue
    const [relative, marker] = key.split('\u0000')
    errors.push(
      `model-runtime-flat-access: unclassified ${relative}:${describeModelRuntimeOccurrences(occurrences)} for ${marker}`,
    )
  }
  for (const entry of MODEL_RUNTIME_INVENTORY) {
    if (entry.classification === 'ordinary-pending') {
      errors.push(
        `model-runtime-flat-access: ordinary pending access remains at ${entry.path}:${entry.marker} (${entry.reason})`,
      )
    }
  }
  return errors
}

function literalText(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null
}

function importedSymbols(node: ts.ImportDeclaration): { symbols: string[]; usage: ImportUsage } {
  const clause = node.importClause
  if (!clause) return { symbols: ['<side-effect>'], usage: 'runtime' }
  const symbols: Array<{ name: string; typeOnly: boolean }> = []
  if (clause.name) symbols.push({ name: 'default', typeOnly: clause.isTypeOnly })
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    symbols.push({ name: '*', typeOnly: clause.isTypeOnly })
  } else if (clause.namedBindings) {
    for (const element of clause.namedBindings.elements) {
      symbols.push({
        name: element.propertyName?.text ?? element.name.text,
        typeOnly: clause.isTypeOnly || element.isTypeOnly,
      })
    }
  }
  const typeCount = symbols.filter((symbol) => symbol.typeOnly).length
  const usage: ImportUsage = typeCount === 0 ? 'runtime' : typeCount === symbols.length ? 'type-only' : 'mixed'
  return { symbols: symbols.map((symbol) => symbol.name).sort(), usage }
}

function exportedSymbols(node: ts.ExportDeclaration): { symbols: string[]; usage: ImportUsage } {
  if (!node.exportClause) return { symbols: ['*'], usage: node.isTypeOnly ? 'type-only' : 'runtime' }
  if (ts.isNamespaceExport(node.exportClause)) {
    return { symbols: ['*'], usage: node.isTypeOnly ? 'type-only' : 'runtime' }
  }
  const symbols = node.exportClause.elements.map((element) => ({
    name: element.propertyName?.text ?? element.name.text,
    typeOnly: node.isTypeOnly || element.isTypeOnly,
  }))
  const typeCount = symbols.filter((symbol) => symbol.typeOnly).length
  const usage: ImportUsage = typeCount === 0 ? 'runtime' : typeCount === symbols.length ? 'type-only' : 'mixed'
  return { symbols: symbols.map((symbol) => symbol.name).sort(), usage }
}

function canonicalTarget(repoRoot: string, importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const rawTarget = path.resolve(path.dirname(importer), specifier)
  const candidates = [
    rawTarget,
    `${rawTarget}.ts`,
    `${rawTarget}.tsx`,
    path.join(rawTarget, 'index.ts'),
    rawTarget.replace(/\.js$/, '.ts'),
    rawTarget.replace(/\.mjs$/, '.mts'),
    rawTarget.replace(/\.cjs$/, '.cts'),
  ]
  const existing = candidates.find((candidate) => fs.existsSync(candidate))
  if (!existing) return null
  const sourceRoot = path.join(repoRoot, 'src')
  const relative = path.relative(sourceRoot, existing)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return repoPath(repoRoot, existing)
}

interface RawEdge extends Omit<CrossRuntimeEdge, 'count'> {}

function collectFileEdges(
  repoRoot: string,
  lane: CrossRuntimeLane,
  file: string,
): {
  edges: RawEdge[]
  nonLiteral: Array<Omit<NonLiteralModuleReference, 'count'>>
} {
  const source = fs.readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceKind(file))
  const importer = repoPath(repoRoot, file)
  const edges: RawEdge[] = []
  const nonLiteral: Array<Omit<NonLiteralModuleReference, 'count'>> = []

  const record = (specifier: string, kind: ImportKind, usage: ImportUsage, symbols: string[]): void => {
    const target = canonicalTarget(repoRoot, file, specifier)
    if (!target) return
    edges.push({ lane, importer, specifier, target, kind, usage, symbols: [...new Set(symbols)].sort() })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const { symbols, usage } = importedSymbols(node)
      record(node.moduleSpecifier.text, 'static', usage, symbols)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const { symbols, usage } = exportedSymbols(node)
      record(node.moduleSpecifier.text, 're-export', usage, symbols)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literalText(node.moduleReference.expression)
      if (specifier) record(specifier, 'import-equals', node.isTypeOnly ? 'type-only' : 'runtime', ['*'])
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        record(argument.literal.text, 'import-type', 'type-only', ['*'])
      }
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (dynamicImport || requireCall) {
        const specifier = literalText(node.arguments[0])
        const kind = dynamicImport ? 'dynamic' : 'require'
        if (specifier) record(specifier, kind, 'runtime', ['*'])
        else nonLiteral.push({ lane, importer, kind })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { edges, nonLiteral }
}

export function collectSourceFileModuleEdges(
  repoRoot: string,
  lane: CrossRuntimeLane,
  file: string,
): {
  edges: CrossRuntimeEdge[]
  nonLiteralModuleReferences: NonLiteralModuleReference[]
} {
  const observed = collectFileEdges(repoRoot, lane, file)
  return {
    edges: aggregate(
      observed.edges,
      (edge) =>
        `${edge.lane}\0${edge.importer}\0${edge.specifier}\0${edge.target}\0${edge.kind}\0${edge.usage}\0${edge.symbols.join(',')}`,
    ),
    nonLiteralModuleReferences: aggregate(
      observed.nonLiteral,
      (reference) => `${reference.lane}\0${reference.importer}\0${reference.kind}`,
    ),
  }
}

function aggregate<T extends object>(rows: T[], key: (row: T) => string): Array<T & { count: number }> {
  const grouped = new Map<string, T & { count: number }>()
  for (const row of rows) {
    const id = key(row)
    const current = grouped.get(id)
    if (current) current.count += 1
    else grouped.set(id, { ...row, count: 1 })
  }
  return [...grouped.values()].sort((left, right) => key(left).localeCompare(key(right)))
}

function collectProjectReferences(repoRoot: string): ProjectReferenceObservation[] {
  const configs = ['server/fastify/tsconfig.json', 'tsconfig.browser-smoke.json']
  return configs
    .flatMap((config) => {
      const configPath = path.join(repoRoot, config)
      const read = ts.readConfigFile(configPath, ts.sys.readFile)
      if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
      const references = (read.config.references ?? []) as Array<{ path?: string }>
      return references.flatMap((reference) => {
        if (!reference.path) return []
        let target = path.resolve(path.dirname(configPath), reference.path)
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'tsconfig.json')
        else if (!path.extname(target)) target = `${target}.json`
        return [{ consumer: config, target: repoPath(repoRoot, target) }]
      })
    })
    .sort((left, right) => `${left.consumer}\0${left.target}`.localeCompare(`${right.consumer}\0${right.target}`))
}

function namedInitializer(repoRoot: string, file: string, name: string): ts.Expression {
  const absolutePath = path.join(repoRoot, file)
  const sourceFile = ts.createSourceFile(
    absolutePath,
    fs.readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourceKind(file),
  )
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      initializer = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!initializer) throw new Error(`Could not find ${name} in ${file}`)
  while (
    ts.isAsExpression(initializer) ||
    ts.isSatisfiesExpression(initializer) ||
    ts.isParenthesizedExpression(initializer)
  ) {
    initializer = initializer.expression
  }
  return initializer
}

function collectionSize(initializer: ts.Expression): number {
  if (ts.isArrayLiteralExpression(initializer)) return initializer.elements.length
  if (ts.isObjectLiteralExpression(initializer)) return initializer.properties.length
  throw new Error('Expected an array or object literal architecture catalog')
}

function countLiteralRouteRegistrations(repoRoot: string): number {
  let count = 0
  const routeRoot = path.join(repoRoot, 'server/fastify/src/routes')
  for (const file of walkSourceFiles(routeRoot)) {
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      sourceKind(file),
    )
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'app' &&
        ['get', 'post', 'patch', 'put', 'delete', 'options', 'head'].includes(node.expression.name.text) &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        count += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return count
}

function collectMetadata(repoRoot: string): MetadataObservation[] {
  return [
    {
      id: 'server-route-policy',
      owner: 'Fastify authentication and active-writer authority',
      path: 'server/fastify/src/routeManifest.ts#PROTOCOL_ROUTE_POLICIES',
      count: collectionSize(
        namedInitializer(repoRoot, 'server/fastify/src/routeManifest.ts', 'PROTOCOL_ROUTE_POLICIES'),
      ),
    },
    {
      id: 'shared-route-operation-catalog',
      owner: 'Browser-safe non-authoritative route transport metadata',
      path: 'packages/protocol/src/routeOperation.ts#PROTOCOL_ROUTE_OPERATION_CATALOG',
      count: collectionSize(
        namedInitializer(repoRoot, 'packages/protocol/src/routeOperation.ts', 'PROTOCOL_ROUTE_OPERATION_CATALOG'),
      ),
    },
    {
      id: 'literal-route-registrations',
      owner: 'Fastify route modules (observation only; prefixes and generated registrations need separate parity)',
      path: 'server/fastify/src/routes/**/*.ts#app.<method>(literal)',
      count: countLiteralRouteRegistrations(repoRoot),
    },
    {
      id: 'shared-durable-command-operation-catalog',
      owner: 'Browser-safe retained-intent operation catalog; never a security authority',
      path: 'packages/protocol/src/durableCommandOperation.ts#PROTOCOL_DURABLE_COMMAND_OPERATION_CATALOG',
      count: collectionSize(
        namedInitializer(
          repoRoot,
          'packages/protocol/src/durableCommandOperation.ts',
          'PROTOCOL_DURABLE_COMMAND_OPERATION_CATALOG',
        ),
      ),
    },
    {
      id: 'browser-resource-surfaces',
      owner: 'Shared browser hydration and cache resource metadata',
      path: 'packages/shared-core/src/resourceManifest.ts#RESOURCE_SURFACE_MANIFEST',
      count: collectionSize(
        namedInitializer(repoRoot, 'packages/shared-core/src/resourceManifest.ts', 'RESOURCE_SURFACE_MANIFEST'),
      ),
    },
    {
      id: 'browser-operation-bindings',
      owner: 'Browser-safe route operation relations; never a security authority',
      path: 'src/ts/server/browserOperationManifest.ts#BROWSER_OPERATION_BINDINGS',
      count: collectionSize(
        namedInitializer(repoRoot, 'src/ts/server/browserOperationManifest.ts', 'BROWSER_OPERATION_BINDINGS'),
      ),
    },
    {
      id: 'browser-operation-non-overlaps',
      owner: 'Reviewed browser-only operation vocabulary distinctions',
      path: 'src/ts/server/browserOperationManifest.ts#BROWSER_OPERATION_NON_OVERLAPS',
      count: collectionSize(
        namedInitializer(repoRoot, 'src/ts/server/browserOperationManifest.ts', 'BROWSER_OPERATION_NON_OVERLAPS'),
      ),
    },
    {
      id: 'server-command-event-catalog',
      owner: 'Fastify persisted command event vocabulary',
      path: 'server/fastify/src/commands/events.ts#COMMAND_EVENT_CATALOG',
      count: collectionSize(
        namedInitializer(repoRoot, 'server/fastify/src/commands/events.ts', 'COMMAND_EVENT_CATALOG'),
      ),
    },
  ].sort((left, right) => left.id.localeCompare(right.id))
}

export function collectCrossRuntimeObservation(repoRoot: string): CrossRuntimeObservation {
  const lanes: Array<{ lane: CrossRuntimeLane; roots: string[] }> = [
    { lane: 'production', roots: ['server/fastify/src'] },
    { lane: 'server-test', roots: ['server/fastify/__tests__', 'server/fastify/__fixtures__'] },
    { lane: 'browser-smoke', roots: ['server/fastify/browser-smoke'] },
  ]
  const rawEdges: RawEdge[] = []
  const rawNonLiteral: Array<Omit<NonLiteralModuleReference, 'count'>> = []
  for (const { lane, roots } of lanes) {
    for (const root of roots) {
      for (const file of walkSourceFiles(path.join(repoRoot, root))) {
        const observed = collectFileEdges(repoRoot, lane, file)
        rawEdges.push(...observed.edges)
        rawNonLiteral.push(...observed.nonLiteral)
      }
    }
  }
  const edges = aggregate(
    rawEdges,
    (edge) =>
      `${edge.lane}\0${edge.importer}\0${edge.specifier}\0${edge.target}\0${edge.kind}\0${edge.usage}\0${edge.symbols.join(',')}`,
  )
  const nonLiteralModuleReferences = aggregate(
    rawNonLiteral,
    (reference) => `${reference.lane}\0${reference.importer}\0${reference.kind}`,
  )
  return {
    edges,
    nonLiteralModuleReferences,
    projectReferences: collectProjectReferences(repoRoot),
    metadata: collectMetadata(repoRoot),
  }
}

function suggestedPolicy(target: string): string {
  if (target.includes('/__tests__/') || target.includes('/tests/') || target.includes('/__fixtures__/')) {
    return POLICY_IDS.fixture
  }
  if (RUNTIME_PROTOCOL_TARGETS.some((suffix) => target.endsWith(suffix))) return POLICY_IDS.wire
  if (APPLICATION_MODEL_TARGETS.some((suffix) => target.endsWith(suffix))) return POLICY_IDS.application
  if (target === 'src/lang/en.ts' || target.endsWith('/startupReadiness.ts') || target.endsWith('/routerRoute.ts')) {
    return POLICY_IDS.accidental
  }
  if (target.endsWith('/server/browserSmoke.ts')) return POLICY_IDS.accidental
  return POLICY_IDS.pure
}

export function createCrossRuntimeBaseline(
  observation: CrossRuntimeObservation,
  openingAnchor: string,
): CrossRuntimeBaseline {
  return {
    schemaVersion: 1,
    openingAnchor,
    conventions: {
      protocol:
        'Serialized requests, responses, events, versions, and taxonomies live in browser-safe @risuai/protocol subpaths.',
      sharedRuntime:
        'Only framework-neutral leaf behavior may enter an audited shared runtime package; it cannot depend on Svelte, DOM, Fastify, Node hosts, persistence, or aggregate Database state.',
      server:
        'Security, active-writer policy, persistence, credentials, filesystem, process, and host behavior remain under server/fastify.',
      fixtures:
        'Historical compatibility fixtures remain test-owned; shared fixture data may move without moving browser application modules into a server dependency.',
    },
    policies: DEFAULT_BOUNDARY_POLICIES,
    edges: observation.edges.map((edge) => ({ ...edge, policy: suggestedPolicy(edge.target) })),
    nonLiteralModuleReferences: observation.nonLiteralModuleReferences.map((reference) => ({
      ...reference,
      owner: 'Owning runtime lane',
      disposition: 'Grandfathered dynamic module selection; not currently resolved to the browser src tree.',
      reviewTrigger: 'The expression changes, becomes a browser-tree edge, or its owning Phase 4 slice migrates.',
    })),
    projectReferences: observation.projectReferences.map((reference) => ({
      ...reference,
      owner: 'check:server declaration prerequisite',
      purpose: 'Makes current browser-tree types available to Fastify/browser-smoke strict typechecks.',
      removalPhase: 'Workstream 1 Phase 6 after every requiring edge is migrated.',
      reviewTrigger:
        'The cross-runtime edge inventory reaches zero for consumers requiring emitted client declarations.',
    })),
    metadata: observation.metadata.map((entry) => ({
      ...entry,
      authority: entry.owner,
      migrationPhase: 'Workstream 1 Phase 2 exact operation/policy catalog',
      driftRule: 'Count and owner changes require a reviewed baseline update; policy parity is established in Phase 2.',
      reviewTrigger:
        'A route, durable operation, resource surface, cache/stream class, or command event is added or removed.',
    })),
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function observationProjection(baseline: CrossRuntimeBaseline): CrossRuntimeObservation {
  return {
    edges: baseline.edges.map(({ policy: _policy, ...edge }) => edge),
    nonLiteralModuleReferences: baseline.nonLiteralModuleReferences.map(
      ({ owner: _owner, disposition: _disposition, reviewTrigger: _reviewTrigger, ...reference }) => reference,
    ),
    projectReferences: baseline.projectReferences.map(
      ({
        owner: _owner,
        purpose: _purpose,
        removalPhase: _removalPhase,
        reviewTrigger: _reviewTrigger,
        ...reference
      }) => reference,
    ),
    metadata: baseline.metadata.map(
      ({
        authority: _authority,
        migrationPhase: _migrationPhase,
        driftRule: _driftRule,
        reviewTrigger: _reviewTrigger,
        ...entry
      }) => entry,
    ),
  }
}

export function validateCrossRuntimeBaseline(baseline: CrossRuntimeBaseline): string[] {
  const errors: string[] = []
  if (baseline.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  for (const [id, policy] of Object.entries(baseline.policies)) {
    if (!id.trim()) errors.push('policy ids must be non-empty')
    for (const [field, value] of Object.entries(policy)) {
      if (typeof value !== 'string' || !value.trim()) errors.push(`policy ${id} has an empty ${field}`)
    }
  }
  for (const edge of baseline.edges) {
    if (!baseline.policies[edge.policy])
      errors.push(`edge ${edge.importer} -> ${edge.target} uses unknown policy ${edge.policy}`)
  }
  for (const reference of baseline.projectReferences) {
    if (!reference.owner || !reference.purpose || !reference.removalPhase || !reference.reviewTrigger) {
      errors.push(`project reference ${reference.consumer} -> ${reference.target} has incomplete ownership metadata`)
    }
  }
  for (const entry of baseline.metadata) {
    if (!entry.authority || !entry.migrationPhase || !entry.driftRule || !entry.reviewTrigger) {
      errors.push(`metadata inventory ${entry.id} has incomplete ownership metadata`)
    }
  }
  return errors
}

export function compareCrossRuntimeBaseline(
  observation: CrossRuntimeObservation,
  baseline: CrossRuntimeBaseline,
): string[] {
  const errors = validateCrossRuntimeBaseline(baseline)
  const expected = stableJson(observationProjection(baseline))
  const actual = stableJson(observation)
  if (expected !== actual) {
    const expectedDigest = createHash('sha256').update(expected).digest('hex')
    const actualDigest = createHash('sha256').update(actual).digest('hex')
    errors.push(
      `cross-runtime architecture inventory drifted (expected sha256 ${expectedDigest}, observed ${actualDigest}); run util/architecture-inventory.ts --print-cross-runtime and review every manifest change`,
    )
  }
  return errors
}

function countTextOccurrences(source: string, value: string): number {
  if (!value) return 0
  let count = 0
  let offset = 0
  while ((offset = source.indexOf(value, offset)) >= 0) {
    count += 1
    offset += value.length
  }
  return count
}

function countIdentifierOccurrences(file: string, source: string, value: string): number {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceKind(file))
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === value) count += 1
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return count
}

export function observeCompatibilityProbe(repoRoot: string, probe: CompatibilityProbe): number {
  const absolutePath = path.join(repoRoot, probe.path)
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`Compatibility probe path does not exist: ${probe.path}`)
  }
  const source = fs.readFileSync(absolutePath, 'utf8')
  return probe.kind === 'identifier'
    ? countIdentifierOccurrences(absolutePath, source, probe.value)
    : countTextOccurrences(source, probe.value)
}

export function refreshCompatibilityBaseline(repoRoot: string, baseline: CompatibilityBaseline): CompatibilityBaseline {
  return {
    ...baseline,
    surfaces: baseline.surfaces.map((surface) => ({
      ...surface,
      probes: surface.probes.map((probe) => ({
        ...probe,
        expectedCount: observeCompatibilityProbe(repoRoot, probe),
      })),
    })),
  }
}

export function validateCompatibilityBaseline(repoRoot: string, baseline: CompatibilityBaseline): string[] {
  const errors: string[] = []
  if (baseline.schemaVersion !== 1) errors.push('compatibility schemaVersion must be 1')
  if (!baseline.openingAnchor || !baseline.conventionRelease || !baseline.decisionPolicy) {
    errors.push('compatibility baseline is missing its anchor, convention release, or decision policy')
  }
  const ids = new Set<string>()
  for (const surface of baseline.surfaces) {
    if (ids.has(surface.id)) errors.push(`duplicate compatibility surface id: ${surface.id}`)
    ids.add(surface.id)
    const requiredText: Array<[string, string]> = [
      ['surface', surface.surface],
      ['currentOwner', surface.currentOwner],
      ['currentPrecedence', surface.currentPrecedence],
      ['missingBehavior', surface.missingBehavior],
      ['malformedBehavior', surface.malformedBehavior],
      ['damagedDatabaseBehavior', surface.damagedDatabaseBehavior],
      ['historicalFixture', surface.historicalFixture],
      ['provenance', surface.provenance],
      ['targetOwner', surface.targetOwner],
      ['migrationPhase', surface.migrationPhase],
      ['oldReaderOrExporter', surface.oldReaderOrExporter],
      ['rollbackProof', surface.rollbackProof],
      ['workstream3Cursor', surface.workstream3Cursor],
    ]
    for (const [field, value] of requiredText) {
      if (!value.trim()) errors.push(`compatibility surface ${surface.id} has empty ${field}`)
    }
    if (surface.roles.length === 0) errors.push(`compatibility surface ${surface.id} has no roles`)
    if (surface.probes.length === 0) errors.push(`compatibility surface ${surface.id} has no closed-world probes`)
    const fixturePath = surface.historicalFixture.split('#', 1)[0]
    if (!fs.existsSync(path.join(repoRoot, fixturePath))) {
      errors.push(`compatibility surface ${surface.id} fixture does not exist: ${fixturePath}`)
    }
    for (const probe of surface.probes) {
      try {
        const actual = observeCompatibilityProbe(repoRoot, probe)
        if (actual !== probe.expectedCount) {
          errors.push(
            `compatibility surface ${surface.id} probe drifted: ${probe.path} ${probe.kind} ${JSON.stringify(probe.value)} expected ${probe.expectedCount}, observed ${actual}`,
          )
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  return errors
}

function loadBaseline(file: string): CrossRuntimeBaseline {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CrossRuntimeBaseline
}

function loadCompatibilityBaseline(file: string): CompatibilityBaseline {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CompatibilityBaseline
}

function loadClientResourceBaseline(file: string): ClientResourceBaseline {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ClientResourceBaseline
}

function loadClientResourceOwnerGapMatrix(file: string): ClientResourceOwnerGapMatrix {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ClientResourceOwnerGapMatrix
}

// The closed scope is mirrored in the generation rejection guide. There is no
// code-value ignore list: non-generation and post-dispatch observations need rows.
export const GENERATION_REJECTION_SCOPE = {
  roots: ['server/fastify/src', 'packages/shared-core/src'],
  codeConstructors: { GenerationAdmissionError: 1, OperationHttpError: 1 },
  codeClasses: [
    'GenerationAdmissionError',
    'OperationHttpError',
    'GenerationEffectiveConfigurationTooLargeError',
    'ChatGenerationSettingsIncompleteAssemblyError',
    'AgentPresetGenerationError',
    'BardWikiPinnedBudgetError',
    'BoundedRegexError',
    'RisuParserBudgetError',
  ],
  unions: [
    'AssembleAbortReason',
    'ChatGenerationSettingsMissingReason',
    'ModelProfileStatusReason',
    'ProviderUnsupportedReason',
  ],
  constants: ['CHAT_GENERATION_SETTINGS_INCOMPLETE_ERROR', 'HYPA_CONTEXT_TRUNCATION_CONFIRMATION_REQUIRED'],
  routes: [
    'server/fastify/src/routes/generation.ts',
    'server/fastify/src/routes/generationChat.ts',
    'server/fastify/src/routes/generationOperations.ts',
    'server/fastify/src/routes/generationEffects.ts',
  ],
  operationState: 'server/fastify/src/generationOperations.ts',
} as const

export interface GenerationRejectionObservation {
  path: string
  value: string
  kind: 'code' | 'union-member'
}

interface GenerationRejectionRow {
  id: string
  kind: GenerationRejectionObservation['kind'] | 'message-family' | 'validator-group'
  value: string
  layer: string
  condition: string
  transport: string[]
  anchors: Array<{ path: string; symbol?: string; substring?: string }>
  preFastify: { behavior: string; anchor: string; note: string }
  classification: string
  decision: string
  tests: string[]
}

export function collectGenerationRejections(repoRoot: string): {
  observations: GenerationRejectionObservation[]
  errors: string[]
} {
  const scope = GENERATION_REJECTION_SCOPE
  const files = scope.roots
    .flatMap((root) => walkSourceFiles(path.join(repoRoot, root)))
    .filter((file) => file.endsWith('.ts') && !/\.(?:test|spec|d)\.ts$/.test(file))
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
  })
  const checker = program.getTypeChecker()
  const observations = new Map<string, GenerationRejectionObservation>()
  const errors: string[] = []
  const seenUnions = new Set<string>()
  const seenClasses = new Set<string>()
  const seenConstants = new Set<string>()
  const stableCode = /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/
  const strings = (node: ts.Node): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text]
    if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue), ...strings(node.whenFalse)]
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
    ) {
      return [...strings(node.left), ...strings(node.right)]
    }
    const type = checker.getTypeAtLocation(node)
    return (type.isUnion() ? type.types : [type]).flatMap((part) => (part.isStringLiteral() ? [part.value] : []))
  }
  const nameOf = (node: ts.Node): string | undefined => {
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return undefined
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    return symbol?.name ?? (ts.isIdentifier(node) ? node.text : node.name.text)
  }
  for (const file of files) {
    const source = program.getSourceFile(file)!
    const relative = repoPath(repoRoot, file)
    const add = (value: string, kind: GenerationRejectionObservation['kind'] = 'code') => {
      observations.set(`${relative}\0${value}`, { path: relative, value, kind })
    }
    const collectCodes = (node: ts.Node) =>
      strings(node)
        .filter((value) => stableCode.test(value))
        .forEach((value) => add(value))
    const visit = (node: ts.Node, errorClass = false): void => {
      if (ts.isClassDeclaration(node)) {
        errorClass = !!node.name && (scope.codeClasses as readonly string[]).includes(node.name.text)
        if (errorClass) seenClasses.add(node.name!.text)
      }
      if (ts.isNewExpression(node)) {
        const name = nameOf(node.expression)
        const index =
          name && Object.hasOwn(scope.codeConstructors, name)
            ? scope.codeConstructors[name as keyof typeof scope.codeConstructors]
            : undefined
        if (index !== undefined) {
          const argument = node.arguments?.[index]
          const codes = argument ? strings(argument).filter((value) => stableCode.test(value)) : []
          if (!codes.length) errors.push(`${relative}: ${name} has no statically resolvable rejection code`)
          codes.forEach((value) => add(value))
        }
        if (name === 'Error' && ts.isThrowStatement(node.parent) && node.arguments?.[0]) {
          collectCodes(node.arguments[0])
        }
      }
      // Covers .send payloads, SSE reason/code objects, helpers returning error
      // bodies, and durable failureCode values, including conditional fallbacks.
      if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
        const key = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : ''
        const route = (scope.routes as readonly string[]).includes(relative)
        if (
          node.initializer &&
          ((errorClass && ['code', 'error'].includes(key)) ||
            (route && ['code', 'error', 'reason', 'failureCode'].includes(key)) ||
            (relative === scope.operationState && key === 'failureCode'))
        )
          collectCodes(node.initializer)
      }
      if (ts.isIdentifier(node) && (scope.constants as readonly string[]).includes(node.text)) {
        const values = strings(node)
        if (values.length) seenConstants.add(node.text)
        values.forEach((value) => add(value))
      }
      if (ts.isTypeAliasDeclaration(node) && (scope.unions as readonly string[]).includes(node.name.text)) {
        seenUnions.add(node.name.text)
        const type = checker.getTypeAtLocation(node)
        for (const member of type.isUnion() ? type.types : [type]) {
          if (member.isStringLiteral()) add(member.value, 'union-member')
          else {
            const code = member.getProperty('code')
            if (!code) errors.push(`${relative}: ${node.name.text} has a member without a literal code`)
            else {
              const codeType = checker.getTypeOfSymbolAtLocation(code, node)
              if (codeType.isStringLiteral()) add(codeType.value, 'union-member')
              else errors.push(`${relative}: ${node.name.text}.code is not a literal`)
            }
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, errorClass))
    }
    visit(source)
  }
  for (const [expected, seen, label] of [
    [scope.unions, seenUnions, 'union'],
    [scope.codeClasses, seenClasses, 'class'],
    [scope.constants, seenConstants, 'constant'],
  ] as const) {
    for (const name of expected)
      if (!seen.has(name)) errors.push(`generation-rejections: scoped ${label} ${name} is missing or unresolved`)
  }
  for (const route of scope.routes)
    if (!files.includes(path.join(repoRoot, route))) errors.push(`generation-rejections: route missing: ${route}`)
  return {
    observations: [...observations.values()].sort(
      (a, b) => a.path.localeCompare(b.path) || a.value.localeCompare(b.value),
    ),
    errors,
  }
}

export function validateGenerationRejectionRegister(
  repoRoot: string,
  collected = collectGenerationRejections(repoRoot),
): string[] {
  const errors = [...collected.errors]
  const registerPath = 'docs/structure/generation-rejection-register.json'
  const schemaPath = 'docs/structure/generation-rejection-register.schema.json'
  let rows: GenerationRejectionRow[]
  try {
    const document = JSON.parse(fs.readFileSync(path.join(repoRoot, registerPath), 'utf8'))
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, schemaPath), 'utf8'))
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
    if (!validate(document))
      return [
        ...errors,
        ...validate.errors!.map(
          (error) => `generation-rejections: ${registerPath}${error.instancePath}: ${error.message}`,
        ),
      ]
    rows = document.rows
  } catch (error) {
    return [...errors, `generation-rejections: ${error instanceof Error ? error.message : String(error)}`]
  }
  const expectedCodes = [...new Set(rows.filter((row) => row.kind === 'code').map((row) => row.value))].sort()
  if (JSON.stringify(expectedCodes) !== JSON.stringify(GENERATION_REJECTION_CODES)) {
    errors.push('generation-rejections: generated protocol codes differ from the register code values')
  }
  const ids = new Set<string>()
  const sourceCache = new Map<string, { text: string; ast: ts.SourceFile }>()
  const sourceAt = (file: string) => {
    if (!sourceCache.has(file)) {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8')
      sourceCache.set(file, { text, ast: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) })
    }
    return sourceCache.get(file)!
  }
  const observed = new Set(collected.observations.map((item) => `${item.path}\0${item.value}`))
  for (const row of rows) {
    const label = `generation-rejections: row ${row.id}`
    if (ids.has(row.id)) errors.push(`${label}: duplicate id`)
    ids.add(row.id)
    if (row.decision === 'keep' && row.classification !== 'protective')
      errors.push(`${label}: keep requires protective classification`)
    for (const anchor of row.anchors) {
      try {
        const source = sourceAt(anchor.path)
        if (anchor.substring && source.text.split(anchor.substring).length !== 2)
          errors.push(
            `${label}: ${anchor.path} anchor substring must occur exactly once: ${JSON.stringify(anchor.substring)}`,
          )
        if (anchor.symbol) {
          let found = false
          for (const statement of source.ast.statements) {
            if (
              !ts.canHaveModifiers(statement) ||
              !ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
            )
              continue
            if (ts.isVariableStatement(statement))
              found ||= statement.declarationList.declarations.some(
                (d) => ts.isIdentifier(d.name) && d.name.text === anchor.symbol,
              )
            else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node))
              found ||= (statement.name as ts.Identifier).text === anchor.symbol
          }
          if (!found) errors.push(`${label}: ${anchor.path} exported symbol ${anchor.symbol} is missing`)
        }
      } catch (error) {
        errors.push(`${label}: cannot read anchor ${anchor.path}: ${String(error)}`)
      }
    }
    if (row.kind === 'code' || row.kind === 'union-member') {
      for (const anchor of row.anchors) {
        if (!observed.has(`${anchor.path}\0${row.value}`)) {
          errors.push(
            `${label}: ${anchor.path}: value ${JSON.stringify(row.value)} is no longer collected at this anchored source path`,
          )
        }
      }
    } else if (
      !row.anchors.some((anchor) => {
        try {
          return sourceAt(anchor.path).text.includes(row.value)
        } catch {
          return false
        }
      })
    )
      errors.push(`${label}: value ${JSON.stringify(row.value)} is missing from anchored source`)
    for (const file of row.tests)
      if (!fs.existsSync(path.join(repoRoot, file))) errors.push(`${label}: test path missing: ${file}`)
  }
  for (const item of collected.observations) {
    if (
      !rows.some(
        (row) =>
          ['code', 'union-member'].includes(row.kind) &&
          row.value === item.value &&
          row.anchors.some((anchor) => anchor.path === item.path),
      )
    ) {
      errors.push(`generation-rejections: ${item.path}: unregistered rejection ${JSON.stringify(item.value)}`)
    }
  }
  if (errors.length === 0) errors.push(...updateGenerationRejectionTable(repoRoot, false))
  return errors
}

const REJECTION_TABLE_START = '<!-- generation-rejection-table:start -->'
const REJECTION_TABLE_END = '<!-- generation-rejection-table:end -->'

function generationRejectionTable(rows: GenerationRejectionRow[]): string {
  const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ')
  return [
    REJECTION_TABLE_START,
    '| ID | Value / family | Layer | Transport | Condition | Pre-Fastify | Decision |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.id} | ${cell(row.value)} | ${row.layer} | ${row.transport.join(', ')} | ${cell(row.condition)} | ${row.preFastify.behavior} | ${row.decision} |`,
    ),
    REJECTION_TABLE_END,
  ].join('\n')
}

function updateGenerationRejectionTable(repoRoot: string, write: boolean): string[] {
  const guidePath = path.join(repoRoot, 'docs/structure/generation-rejection-register.md')
  const registerPath = path.join(repoRoot, 'docs/structure/generation-rejection-register.json')
  const guide = fs.readFileSync(guidePath, 'utf8')
  const start = guide.indexOf(REJECTION_TABLE_START)
  const end = guide.indexOf(REJECTION_TABLE_END)
  if (
    start < 0 ||
    end < start ||
    guide.split(REJECTION_TABLE_START).length !== 2 ||
    guide.split(REJECTION_TABLE_END).length !== 2
  ) {
    return ['generation-rejections: guide must contain exactly one generated table marker pair']
  }
  const { rows } = JSON.parse(fs.readFileSync(registerPath, 'utf8')) as { rows: GenerationRejectionRow[] }
  const expected =
    guide.slice(0, start) + generationRejectionTable(rows) + guide.slice(end + REJECTION_TABLE_END.length)
  if (guide === expected) return []
  if (write) {
    fs.writeFileSync(guidePath, expected)
    return []
  }
  return [
    'generation-rejections: guide table drifted; run pnpm exec tsx util/architecture-inventory.ts --write-generation-rejection-table',
  ]
}

async function run(): Promise<void> {
  const repoRoot = process.cwd()
  const baselinePath = path.join(
    repoRoot,
    '.archived-docs/architecture-and-migration/cross-runtime-boundaries/baseline.json',
  )
  const compatibilityBaselinePath = path.join(
    repoRoot,
    '.archived-docs/architecture-and-migration/canonical-state-and-compatibility/compatibility-baseline.json',
  )
  const clientResourceBaselinePath = path.join(
    repoRoot,
    '.archived-docs/architecture-and-migration/client-resource-ownership/client-resource-baseline.json',
  )
  const clientResourceOwnerGapMatrixPath = path.join(
    repoRoot,
    '.archived-docs/architecture-and-migration/client-resource-ownership/owner-api-gap-matrix.json',
  )
  if (process.argv.includes('--write-generation-rejection-table')) {
    const errors = updateGenerationRejectionTable(repoRoot, true)
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('[architecture-inventory] Updated generation rejection guide table')
    return
  }
  const rejections = collectGenerationRejections(repoRoot)
  if (process.argv.includes('--print-generation-rejections')) {
    process.stdout.write(stableJson(rejections))
    return
  }
  const observation = collectCrossRuntimeObservation(repoRoot)
  if (process.argv.includes('--print-cross-runtime')) {
    process.stdout.write(
      stableJson(createCrossRuntimeBaseline(observation, 'c0df82d5240a29a33efa5995e08cc970e0147573')),
    )
    return
  }
  if (process.argv.includes('--print-compatibility')) {
    if (!fs.existsSync(compatibilityBaselinePath)) {
      throw new Error(`Missing compatibility baseline: ${compatibilityBaselinePath}`)
    }
    process.stdout.write(
      stableJson(refreshCompatibilityBaseline(repoRoot, loadCompatibilityBaseline(compatibilityBaselinePath))),
    )
    return
  }
  const clientResourceObservation = collectClientResourceObservation(repoRoot)
  if (process.argv.includes('--print-client-resources')) {
    process.stdout.write(
      stableJson(
        createClientResourceBaseline(
          clientResourceObservation,
          'c0df82d5240a29a33efa5995e08cc970e0147573',
          'b01e88b03461753afe8f573029ce2e5ab47892ef',
        ),
      ),
    )
    return
  }
  if (!fs.existsSync(baselinePath)) throw new Error(`Missing cross-runtime architecture baseline: ${baselinePath}`)
  if (!fs.existsSync(compatibilityBaselinePath)) {
    throw new Error(`Missing compatibility baseline: ${compatibilityBaselinePath}`)
  }
  if (!fs.existsSync(clientResourceBaselinePath)) {
    throw new Error(`Missing client resource baseline: ${clientResourceBaselinePath}`)
  }
  if (!fs.existsSync(clientResourceOwnerGapMatrixPath)) {
    throw new Error(`Missing client resource owner gap matrix: ${clientResourceOwnerGapMatrixPath}`)
  }
  const compatibilityBaseline = loadCompatibilityBaseline(compatibilityBaselinePath)
  const clientResourceBaseline = loadClientResourceBaseline(clientResourceBaselinePath)
  const errors = [
    ...validateGenerationRejectionRegister(repoRoot, rejections),
    ...validatePackageImportBoundaries(repoRoot),
    ...validateRawGenerationBoundary(repoRoot),
    ...validateModelRuntimeFlatAccessBoundary(repoRoot),
    ...compareCrossRuntimeBaseline(observation, loadBaseline(baselinePath)),
    ...validateCompatibilityBaseline(repoRoot, compatibilityBaseline),
    ...compareClientResourceBaseline(clientResourceObservation, clientResourceBaseline),
    ...validateClientResourceOwnerGapMatrix(
      repoRoot,
      clientResourceBaseline,
      loadClientResourceOwnerGapMatrix(clientResourceOwnerGapMatrixPath),
    ),
  ]
  if (errors.length > 0) {
    for (const error of errors) console.error(`[architecture-inventory] ${error}`)
    process.exitCode = 1
    return
  }
  console.log(
    `[architecture-inventory] PASS generation rejection register (${rejections.observations.length} source/value observations)`,
  )
  const runtimeEdges = observation.edges.reduce(
    (total, edge) => total + (edge.usage === 'type-only' ? 0 : edge.count),
    0,
  )
  const edgeCount = observation.edges.reduce((total, edge) => total + edge.count, 0)
  const laneCounts = Object.fromEntries(
    (['production', 'server-test', 'browser-smoke'] as const).map((lane) => [
      lane,
      observation.edges.filter((edge) => edge.lane === lane).reduce((total, edge) => total + edge.count, 0),
    ]),
  )
  console.log(
    `[architecture-inventory] PASS ${edgeCount} cross-runtime edges (${runtimeEdges} runtime/mixed) across production=${laneCounts.production}, server-test=${laneCounts['server-test']}, browser-smoke=${laneCounts['browser-smoke']}`,
  )
  const probeCount = compatibilityBaseline.surfaces.reduce((total, surface) => total + surface.probes.length, 0)
  console.log(
    `[architecture-inventory] PASS ${compatibilityBaseline.surfaces.length} compatibility surfaces with ${probeCount} closed-world probes`,
  )
  const clientConsumerCount = clientResourceBaseline.consumers.reduce(
    (total, consumer) => total + consumer.files.reduce((fileTotal, file) => fileTotal + file.count, 0),
    0,
  )
  console.log(
    `[architecture-inventory] PASS ${clientConsumerCount} test-fixture compatibility references across ${clientResourceBaseline.consumers.length} consumer groups, ${clientResourceBaseline.bridgeFamilies.length} bridge families, and ${clientResourceBaseline.temporarySeams.length} reviewed seam markers`,
  )
  console.log(
    `[architecture-inventory] PASS ${Object.keys(clientResourceBaseline.policies).length} client resource owner gap rows`,
  )
  console.log(
    `[architecture-inventory] PASS ${PACKAGE_IMPORT_BOUNDARIES.length} package import boundaries, raw generation caller ownership, and ${MODEL_RUNTIME_INVENTORY.length} model/runtime access classifications`,
  )
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  run().catch((error) => {
    console.error(`[architecture-inventory] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
