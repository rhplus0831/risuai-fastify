import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export type ClientConsumerLane = 'production' | 'test' | 'browser-smoke' | 'server'
export type ClientResourceFamily =
  | 'broad-settings-shell'
  | 'leaf-settings-collections'
  | 'character-chat'
  | 'prompt-template'
  | 'lorebook'
  | 'script-definition'
  | 'model-translator'
  | 'compatibility-infrastructure'
  | 'cross-cutting'

export type ClientConsumerRole =
  | 'read'
  | 'mutation'
  | 'render'
  | 'hydration'
  | 'draft'
  | 'generation'
  | 'recovery'
  | 'diagnostic'
  | 'test-fixture'
  | 'definition'

export interface ClientConsumerObservation {
  lane: ClientConsumerLane
  file: string
  detector: string
  symbol: string
  count: number
}

export interface BridgeFamilyObservation {
  file: string
  family: string
  exportedWatchers: string[]
  exportedFlushers: string[]
}

export interface TemporarySeamObservation {
  id: 'character-aggregate-endpoint'
  file: string
  marker: string
  count: number
}

export interface ClientResourceObservation {
  consumers: ClientConsumerObservation[]
  bridgeFamilies: BridgeFamilyObservation[]
  temporarySeams: TemporarySeamObservation[]
}

export interface ClientConsumerPolicy {
  resourceFamily: ClientResourceFamily
  role: ClientConsumerRole
  targetOwnerApi: string
  workstream1Dependency: string
  workstream2Dependency: string
  migrationPhase: string
  removalTrigger: string
}

export interface ClientResourceBaseline {
  schemaVersion: 1
  openingAnchor: string
  conventionRelease: string
  policy: string
  policies: Record<string, ClientConsumerPolicy>
  consumers: Array<{
    lane: ClientConsumerLane
    detector: string
    symbol: string
    policy: string
    files: Array<{ file: string; count: number }>
  }>
  bridgeFamilies: Array<
    BridgeFamilyObservation & {
      targetOwnerApi: string
      migrationPhase: string
      dependencyCursor: string
      removalTrigger: string
    }
  >
  temporarySeams: Array<
    TemporarySeamObservation & {
      owner: string
      disposition: string
      migrationPhase: string
      removalTrigger: string
    }
  >
}

export type ClientResourceOwnerCapability = 'complete' | 'partial' | 'missing' | 'blocked' | 'not-applicable'

export interface ClientResourceOwnerGapMatrix {
  schemaVersion: 1
  source: {
    baseline: string
    openingAnchor: string
    inventoryCursor: string
    policyCount: number
    consumerGroupCount: number
    referenceCount: number
  }
  capabilityKeys: string[]
  owners: Record<
    string,
    {
      dependencies: { workstream1: string; workstream2: string }
      capabilities: Record<string, ClientResourceOwnerCapability>
      gap: string
      evidence: string[]
    }
  >
  policies: Record<string, { owner: string }>
  foundations: Record<
    string,
    {
      status: string
      resource: string
      ownerApi: string
      workstream1Cursor: string
      workstream2Cursor: string
      capabilities: string[]
      remaining: string
    }
  >
}

const OWNER_CAPABILITY_KEYS = ['selectors', 'resourceState', 'commands', 'draftRecovery', 'contractTests']
const OWNER_CAPABILITY_STATES = new Set<ClientResourceOwnerCapability>([
  'complete',
  'partial',
  'missing',
  'blocked',
  'not-applicable',
])

const EXACT_IDENTIFIER_DETECTORS = new Map<string, string>([
  ['getDatabase', 'aggregate-read'],
  ['setDatabase', 'aggregate-replacement'],
  ['setDatabaseLite', 'aggregate-replacement'],
  ['getResourceDatabase', 'resource-facade-read'],
  ['composeResourceDatabaseSnapshot', 'aggregate-snapshot'],
  ['resourceDatabaseCompatibilityProxy', 'aggregate-proxy'],
  ['withTrustedResourceWrite', 'trusted-write'],
  ['setResourceWriteGuardEnabled', 'write-guard-control'],
  ['isResourceWriteGuardEnabled', 'write-guard-control'],
  ['withServerResourceApply', 'trusted-write'],
  ['getServerResourceApplyEpoch', 'facade-epoch'],
  ['withResourceDatabaseWrite', 'trusted-write'],
  ['setResourceDatabaseWriteGuardEnabled', 'write-guard-control'],
  ['isResourceDatabaseWriteActive', 'write-guard-control'],
  ['registerPendingBridgePatchFlusher', 'bridge-registry'],
  ['flushRegisteredPendingBridgePatches', 'bridge-registry'],
  ['flushRegisteredPendingBridgePatch', 'bridge-registry'],
  ['registerPendingBridgeOwnershipResetter', 'bridge-registry'],
  ['resetRegisteredPendingBridgeOwnershipState', 'bridge-registry'],
  ['flushAllPendingBridgePatches', 'lifecycle-flush'],
  ['startBridgePatchLifecycleFlush', 'lifecycle-flush'],
])

const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.svelte']
const TEMPORARY_SEAM_MARKERS = [
  {
    id: 'character-aggregate-endpoint' as const,
    markers: ['/api/v1/characters/aggregate', '/characters/aggregate'],
  },
]

function normalizePath(value: string): string {
  return value.replaceAll(path.sep, '/')
}

function repoPath(repoRoot: string, absolutePath: string): string {
  return normalizePath(path.relative(repoRoot, absolutePath))
}

function walkFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const files: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath))
    else if (entry.isFile() && SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) files.push(absolutePath)
  }
  return files.sort()
}

function clientLane(file: string): ClientConsumerLane {
  if (file.startsWith('server/fastify/browser-smoke/')) return 'browser-smoke'
  if (file.startsWith('server/fastify/src/')) return 'server'
  if (/(?:^|\/)(?:__tests__|tests|__fixtures__)(?:\/|$)/.test(file) || /\.test\.[^.]+$/.test(file)) return 'test'
  return 'production'
}

function scriptSegments(file: string, source: string): string[] {
  if (!file.endsWith('.svelte')) return [source]
  return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1])
}

function detectorForIdentifier(node: ts.Identifier): string | null {
  const symbol = node.text
  const exact = EXACT_IDENTIFIER_DETECTORS.get(symbol)
  if (
    exact &&
    ['aggregate-read', 'aggregate-replacement', 'resource-facade-read', 'aggregate-snapshot'].includes(exact)
  ) {
    return ts.isCallExpression(node.parent) && node.parent.expression === node ? exact : null
  }
  if (exact) return exact
  // Owner-specific projection epochs are stale-response fences, not aggregate
  // facade epochs. Only the retired broad epoch symbols above belong here.
  if (/^(?:watchServerBacked|syncServerBacked|flushPendingServerBacked|flushPendingPromptTemplate)/.test(symbol)) {
    return 'bridge-lifecycle'
  }
  return null
}

function collectFileConsumers(repoRoot: string, file: string): ClientConsumerObservation[] {
  const relative = repoPath(repoRoot, file)
  const counts = new Map<string, ClientConsumerObservation>()
  const source = fs.readFileSync(file, 'utf8')
  for (const [index, segment] of scriptSegments(file, source).entries()) {
    const sourceFile = ts.createSourceFile(
      `${file}#script-${index}`,
      segment,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const detector = detectorForIdentifier(node)
        // Whole-database import/replacement owns this internal call; it is not
        // an application consumer of the retired aggregate facade.
        const retainedWholeDatabaseReplacement =
          relative === 'src/ts/storage/database.svelte.ts' &&
          detector === 'aggregate-replacement' &&
          node.text === 'setDatabaseLite'
        if (detector && !retainedWholeDatabaseReplacement) {
          const key = `${detector}\0${node.text}`
          const current = counts.get(key)
          if (current) current.count += 1
          else {
            counts.set(key, {
              lane: clientLane(relative),
              file: relative,
              detector,
              symbol: node.text,
              count: 1,
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return [...counts.values()]
}

function exportedBridgeSymbols(file: string): { watchers: string[]; flushers: string[] } {
  const source = fs.readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const exported = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      exported.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return {
    watchers: [...exported].filter((name) => name.startsWith('watch')).sort(),
    flushers: [...exported].filter((name) => name.startsWith('flush')).sort(),
  }
}

function bridgeFamilyName(file: string): string {
  return path.basename(file).replace(/Bridge\.svelte\.ts$/, '')
}

function countText(source: string, marker: string): number {
  let count = 0
  let offset = 0
  while ((offset = source.indexOf(marker, offset)) >= 0) {
    count += 1
    offset += marker.length
  }
  return count
}

function collectTemporarySeams(repoRoot: string, files: readonly string[]): TemporarySeamObservation[] {
  const rows: TemporarySeamObservation[] = []
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    for (const seam of TEMPORARY_SEAM_MARKERS) {
      for (const marker of seam.markers) {
        const count = countText(source, marker)
        if (count > 0) rows.push({ id: seam.id, file: repoPath(repoRoot, file), marker, count })
      }
    }
  }
  return rows.sort((left, right) =>
    `${left.id}\0${left.file}\0${left.marker}`.localeCompare(`${right.id}\0${right.file}\0${right.marker}`),
  )
}

export function collectClientResourceObservation(repoRoot: string): ClientResourceObservation {
  const roots = ['src', 'server/fastify/src', 'server/fastify/__tests__', 'server/fastify/browser-smoke']
  const files = [...new Set(roots.flatMap((root) => walkFiles(path.join(repoRoot, root))))].sort()
  const temporarySeamFiles = [...new Set([...files, ...walkFiles(path.join(repoRoot, 'packages/protocol/src'))])].sort()
  const consumers = files.flatMap((file) => collectFileConsumers(repoRoot, file))
  consumers.sort((left, right) =>
    `${left.lane}\0${left.file}\0${left.detector}\0${left.symbol}`.localeCompare(
      `${right.lane}\0${right.file}\0${right.detector}\0${right.symbol}`,
    ),
  )
  const bridgeFiles = walkFiles(path.join(repoRoot, 'src/ts/server')).filter(
    (file) => file.endsWith('Bridge.svelte.ts') && !file.endsWith('.test.ts'),
  )
  const bridgeFamilies = bridgeFiles
    .map((file) => {
      const exported = exportedBridgeSymbols(file)
      return {
        file: repoPath(repoRoot, file),
        family: bridgeFamilyName(file),
        exportedWatchers: exported.watchers,
        exportedFlushers: exported.flushers,
      }
    })
    .sort((left, right) => left.file.localeCompare(right.file))
  return { consumers, bridgeFamilies, temporarySeams: collectTemporarySeams(repoRoot, temporarySeamFiles) }
}

function resourceFamily(file: string, detector: string): ClientResourceFamily {
  if (
    [
      'aggregate-proxy',
      'trusted-write',
      'write-guard-control',
      'bridge-registry',
      'lifecycle-flush',
      'facade-epoch',
    ].includes(detector) ||
    file.includes('/resourceState.svelte') ||
    file.includes('/resourceWriteGuard.svelte') ||
    file.includes('/bridgeFlush') ||
    file.includes('/pendingBridgeFlushRegistry')
  ) {
    return 'compatibility-infrastructure'
  }
  const lower = file.toLowerCase()
  if (lower.includes('lorebook')) return 'lorebook'
  if (lower.includes('scriptdefinition') || lower.includes('/process/triggers') || lower.includes('/process/modules')) {
    return 'script-definition'
  }
  if (lower.includes('prompt')) return 'prompt-template'
  if (lower.includes('character') || lower.includes('chat') || lower.includes('message')) return 'character-chat'
  if (lower.includes('model') || lower.includes('translator') || lower.includes('translation'))
    return 'model-translator'
  if (
    lower.includes('plugin') ||
    lower.includes('persona') ||
    lower.includes('preset') ||
    lower.includes('loadout') ||
    lower.includes('agent') ||
    lower.includes('module')
  ) {
    return 'leaf-settings-collections'
  }
  if (
    lower.endsWith('src/app.svelte') ||
    lower.includes('/bootstrap') ||
    lower.includes('/globalapi') ||
    lower.includes('/utilstate') ||
    lower.includes('/storage/database.svelte') ||
    lower.includes('/settings') ||
    lower.includes('/shell')
  ) {
    return 'broad-settings-shell'
  }
  return 'cross-cutting'
}

function consumerRole(row: ClientConsumerObservation): ClientConsumerRole {
  if (row.lane === 'test') return 'test-fixture'
  if (row.file.includes('/storage/database.svelte') || row.file.includes('/resourceState.svelte')) return 'definition'
  if (row.detector.includes('write') || row.detector === 'aggregate-replacement') return 'mutation'
  if (row.detector.includes('bridge') || row.detector === 'lifecycle-flush') return 'recovery'
  if (row.detector.includes('epoch')) return 'diagnostic'
  if (row.file.endsWith('.svelte') || row.file.endsWith('App.svelte')) return 'render'
  if (row.file.includes('/process/') || row.file.includes('/translator/')) return 'generation'
  if (row.file.includes('/bootstrap') || row.file.includes('/hydration')) return 'hydration'
  return 'read'
}

function targetOwnerApi(family: ClientResourceFamily): string {
  switch (family) {
    case 'character-chat':
      return 'character/chat selectors, hydration state, drafts, and command projections'
    case 'prompt-template':
      return 'canonical prompt-preset owner selectors, drafts, and prompt commands'
    case 'lorebook':
      return 'scope-specific lorebook owners, drafts, and commands'
    case 'script-definition':
      return 'character/module script-definition owners, drafts, and commands'
    case 'model-translator':
      return 'model-profile and translator-preset owners released by Workstream 2'
    case 'leaf-settings-collections':
      return 'stable-id collection/settings owner selectors and commands'
    case 'broad-settings-shell':
      return 'explicit settings groups and shell resource selectors'
    case 'compatibility-infrastructure':
      return 'remove after all owner-specific consumers reach zero'
    default:
      return 'explicit resource set or documented diagnostic subscription'
  }
}

function migrationPhase(family: ClientResourceFamily): string {
  switch (family) {
    case 'leaf-settings-collections':
    case 'model-translator':
      return 'Workstream 3 Phase 2 or matching owner phase'
    case 'character-chat':
      return 'Workstream 3 Phase 3'
    case 'prompt-template':
    case 'lorebook':
    case 'script-definition':
      return 'Workstream 3 Phase 4'
    case 'broad-settings-shell':
    case 'cross-cutting':
      return 'Workstream 3 Phase 5'
    case 'compatibility-infrastructure':
      return 'Workstream 3 Phase 6'
  }
}

function policyForConsumer(row: ClientConsumerObservation): ClientConsumerPolicy {
  const family = resourceFamily(row.file, row.detector)
  if (row.lane === 'test') {
    return {
      resourceFamily: family,
      role: 'test-fixture',
      targetOwnerApi: 'test-only aggregate adapter over explicit resource-owner state',
      workstream1Dependency:
        'Released owner contracts; production imports are forbidden by the static architecture gate',
      workstream2Dependency:
        'Canonical persisted owners released; the adapter does not participate in production state',
      migrationPhase: 'Workstream 3 Phase 7 retained test-fixture decision',
      removalTrigger: 'Retain only while compatibility fixtures need whole-database setup or assertions.',
    }
  }
  const workstream2Dependency =
    family === 'prompt-template'
      ? 'Workstream 2 Phase 3 prompt owner'
      : family === 'model-translator'
        ? 'Workstream 2 Phase 2/4 owner for the exact domain'
        : family === 'lorebook' || family === 'script-definition'
          ? 'Workstream 2 disposition/repair hold for the exact family'
          : 'Prove the resource is already singular or wait for its Workstream 2 release'
  return {
    resourceFamily: family,
    role: consumerRole(row),
    targetOwnerApi: targetOwnerApi(family),
    workstream1Dependency: 'Matching Workstream 1 protocol/operation contract release',
    workstream2Dependency,
    migrationPhase: migrationPhase(family),
    removalTrigger:
      'Owner-specific read, command, queued/failure rollback, reload, and browser proof pass for this consumer.',
  }
}

export function createClientResourceBaseline(
  observation: ClientResourceObservation,
  openingAnchor: string,
  conventionRelease: string,
): ClientResourceBaseline {
  const policies: Record<string, ClientConsumerPolicy> = {}
  const groupedConsumers = new Map<
    string,
    {
      lane: ClientConsumerLane
      detector: string
      symbol: string
      policy: string
      files: Array<{ file: string; count: number }>
    }
  >()
  for (const consumer of observation.consumers) {
    const policy = policyForConsumer(consumer)
    const policyId = `${policy.resourceFamily}:${policy.role}`
    policies[policyId] ??= policy
    const key = `${consumer.lane}\0${consumer.detector}\0${consumer.symbol}\0${policyId}`
    const group = groupedConsumers.get(key) ?? {
      lane: consumer.lane,
      detector: consumer.detector,
      symbol: consumer.symbol,
      policy: policyId,
      files: [],
    }
    group.files.push({ file: consumer.file, count: consumer.count })
    groupedConsumers.set(key, group)
  }
  const consumers = [...groupedConsumers.values()].sort((left, right) =>
    `${left.lane}\0${left.detector}\0${left.symbol}\0${left.policy}`.localeCompare(
      `${right.lane}\0${right.detector}\0${right.symbol}\0${right.policy}`,
    ),
  )
  return {
    schemaVersion: 1,
    openingAnchor,
    conventionRelease,
    policy:
      'New normal-runtime aggregate reads, trusted writes, bridge families, lifecycle flushes, broad epochs, and unclassified seams are forbidden. Baseline changes require an explicit reviewed owner, dependency, phase, and removal trigger.',
    policies: Object.fromEntries(Object.entries(policies).sort(([left], [right]) => left.localeCompare(right))),
    consumers,
    bridgeFamilies: observation.bridgeFamilies.map((bridge) => {
      const family = bridge.family.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
      return {
        ...bridge,
        targetOwnerApi: `${family} owner-scoped selectors, commands, drafts, optimistic projection, and rollback`,
        migrationPhase:
          bridge.family === 'character' || bridge.family === 'chat'
            ? 'Workstream 3 Phase 3'
            : bridge.family === 'settings'
              ? 'Workstream 3 Phase 5'
              : 'Workstream 3 Phase 4',
        dependencyCursor: 'Matching Workstream 1 contract and Workstream 2 canonical-owner release',
        removalTrigger: 'Final production consumer passes read/mutation/failure/rollback/reload/browser proof.',
      }
    }),
    temporarySeams: observation.temporarySeams.map((seam) => ({
      ...seam,
      owner: 'Fastify compatibility character/chat resource read',
      disposition: 'retained external compatibility; first-party production clients use narrow owners',
      migrationPhase: 'Workstream 3 Phase 7 retained-seam decision',
      removalTrigger:
        'Remove after path-only access telemetry records zero supported-client requests for 30 consecutive days.',
    })),
  }
}

function observationProjection(baseline: ClientResourceBaseline): ClientResourceObservation {
  return {
    consumers: baseline.consumers
      .flatMap((group) =>
        group.files.map(({ file, count }) => ({
          lane: group.lane,
          file,
          detector: group.detector,
          symbol: group.symbol,
          count,
        })),
      )
      .sort((left, right) =>
        `${left.lane}\0${left.file}\0${left.detector}\0${left.symbol}`.localeCompare(
          `${right.lane}\0${right.file}\0${right.detector}\0${right.symbol}`,
        ),
      ),
    bridgeFamilies: baseline.bridgeFamilies.map(
      ({
        targetOwnerApi: _targetOwnerApi,
        migrationPhase: _migrationPhase,
        dependencyCursor: _dependencyCursor,
        removalTrigger: _removalTrigger,
        ...bridge
      }) => bridge,
    ),
    temporarySeams: baseline.temporarySeams.map(
      ({
        owner: _owner,
        disposition: _disposition,
        migrationPhase: _migrationPhase,
        removalTrigger: _removalTrigger,
        ...seam
      }) => seam,
    ),
  }
}

export function validateClientResourceBaseline(baseline: ClientResourceBaseline): string[] {
  const errors: string[] = []
  if (baseline.schemaVersion !== 1) errors.push('client resource schemaVersion must be 1')
  if (!baseline.openingAnchor || !baseline.conventionRelease || !baseline.policy) {
    errors.push('client resource baseline is missing its anchor, convention release, or policy')
  }
  for (const [id, policy] of Object.entries(baseline.policies)) {
    for (const [field, value] of Object.entries(policy)) {
      if (typeof value !== 'string' || !value.trim()) errors.push(`client resource policy ${id} has empty ${field}`)
    }
  }
  const consumerKeys = new Set<string>()
  for (const consumer of baseline.consumers) {
    const key = `${consumer.lane}\0${consumer.detector}\0${consumer.symbol}\0${consumer.policy}`
    if (consumerKeys.has(key)) errors.push(`duplicate client resource consumer group: ${key}`)
    consumerKeys.add(key)
    if (!baseline.policies[consumer.policy]) {
      errors.push(`client resource consumer group ${key} uses unknown policy ${consumer.policy}`)
    }
    const files = new Set<string>()
    for (const file of consumer.files) {
      if (files.has(file.file)) errors.push(`client resource consumer group ${key} repeats ${file.file}`)
      files.add(file.file)
      if (file.count < 1) errors.push(`client resource consumer group ${key} has invalid count for ${file.file}`)
    }
  }
  for (const bridge of baseline.bridgeFamilies) {
    if (!bridge.targetOwnerApi || !bridge.migrationPhase || !bridge.dependencyCursor || !bridge.removalTrigger) {
      errors.push(`bridge family ${bridge.family} has incomplete ownership metadata`)
    }
  }
  for (const seam of baseline.temporarySeams) {
    if (!seam.owner || !seam.disposition || !seam.migrationPhase || !seam.removalTrigger) {
      errors.push(`temporary seam ${seam.id} in ${seam.file} has incomplete ownership metadata`)
    }
  }
  return errors
}

export function validateClientResourceOwnerGapMatrix(
  repoRoot: string,
  baseline: ClientResourceBaseline,
  matrix: ClientResourceOwnerGapMatrix,
): string[] {
  const errors: string[] = []
  const expectedTopLevelKeys = ['capabilityKeys', 'foundations', 'owners', 'policies', 'schemaVersion', 'source']
  if (JSON.stringify(Object.keys(matrix).sort()) !== JSON.stringify(expectedTopLevelKeys)) {
    errors.push('client resource owner gap matrix has unexpected top-level fields')
  }
  if (matrix.schemaVersion !== 1) errors.push('client resource owner gap matrix schemaVersion must be 1')
  if (
    matrix.source?.baseline !==
    '.archived-docs/architecture-and-migration/client-resource-ownership/client-resource-baseline.json'
  ) {
    errors.push('client resource owner gap matrix must reference the frozen Phase 0 baseline')
  }
  if (matrix.source?.openingAnchor !== baseline.openingAnchor) {
    errors.push('client resource owner gap matrix opening anchor does not match the frozen baseline')
  }
  if (!matrix.source?.inventoryCursor?.trim()) {
    errors.push('client resource owner gap matrix is missing its Phase 0 inventory cursor')
  }

  const policyKeys = Object.keys(baseline.policies).sort()
  const matrixPolicyKeys = Object.keys(matrix.policies ?? {}).sort()
  const consumerGroupCount = baseline.consumers.length
  const referenceCount = baseline.consumers.reduce(
    (total, consumer) => total + consumer.files.reduce((fileTotal, file) => fileTotal + file.count, 0),
    0,
  )
  if (matrix.source?.policyCount !== policyKeys.length) {
    errors.push(`client resource owner gap matrix policy count must be ${policyKeys.length}`)
  }
  if (matrix.source?.consumerGroupCount !== consumerGroupCount) {
    errors.push(`client resource owner gap matrix consumer group count must be ${consumerGroupCount}`)
  }
  if (matrix.source?.referenceCount !== referenceCount) {
    errors.push(`client resource owner gap matrix reference count must be ${referenceCount}`)
  }
  if (JSON.stringify(matrixPolicyKeys) !== JSON.stringify(policyKeys)) {
    errors.push('client resource owner gap matrix policy rows do not exactly match the frozen baseline')
  }
  if (JSON.stringify(matrix.capabilityKeys) !== JSON.stringify(OWNER_CAPABILITY_KEYS)) {
    errors.push('client resource owner gap matrix capability keys have drifted')
  }

  const expectedOwners = [...new Set(Object.values(baseline.policies).map((policy) => policy.resourceFamily))].sort()
  if (JSON.stringify(Object.keys(matrix.owners ?? {}).sort()) !== JSON.stringify(expectedOwners)) {
    errors.push('client resource owner gap matrix owners do not exactly match the frozen resource families')
  }
  for (const [ownerId, owner] of Object.entries(matrix.owners ?? {})) {
    if (!owner.dependencies?.workstream1?.trim() || !owner.dependencies?.workstream2?.trim()) {
      errors.push(`client resource owner ${ownerId} is missing an exact Workstream 1 or Workstream 2 dependency`)
    }
    if (
      JSON.stringify(Object.keys(owner.capabilities ?? {}).sort()) !== JSON.stringify([...OWNER_CAPABILITY_KEYS].sort())
    ) {
      errors.push(`client resource owner ${ownerId} must classify every owner capability exactly once`)
    }
    for (const [capability, state] of Object.entries(owner.capabilities ?? {})) {
      if (!OWNER_CAPABILITY_STATES.has(state)) {
        errors.push(`client resource owner ${ownerId} has invalid ${capability} state ${JSON.stringify(state)}`)
      }
    }
    if (!owner.gap?.trim()) errors.push(`client resource owner ${ownerId} has no bounded gap`)
    if (!owner.evidence?.length) errors.push(`client resource owner ${ownerId} has no evidence`)
    for (const evidence of owner.evidence ?? []) {
      const [evidencePath] = evidence.split('#', 1)
      if (!evidencePath || !fs.existsSync(path.join(repoRoot, evidencePath))) {
        errors.push(`client resource owner ${ownerId} evidence does not exist: ${evidence}`)
      }
    }
  }

  for (const [policyId, row] of Object.entries(matrix.policies ?? {})) {
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(['owner'])) {
      errors.push(`client resource owner policy ${policyId} must contain only its owner mapping`)
    }
    if (!matrix.owners?.[row.owner])
      errors.push(`client resource owner policy ${policyId} uses unknown owner ${row.owner}`)
    if (baseline.policies[policyId]?.resourceFamily !== row.owner) {
      errors.push(`client resource owner policy ${policyId} does not map to its frozen resource family`)
    }
  }

  const foundations = Object.entries(matrix.foundations ?? {}).filter(
    ([, foundation]) => foundation.status === 'implemented',
  )
  if (foundations.length === 0) errors.push('client resource owner gap matrix has no implemented foundation')
  for (const [foundationId, foundation] of foundations) {
    const [ownerPath, anchor] = foundation.ownerApi.split('#')
    if (!ownerPath || !anchor || !fs.existsSync(path.join(repoRoot, ownerPath))) {
      errors.push(`client resource owner foundation ${foundationId} has an invalid owner API: ${foundation.ownerApi}`)
    } else if (!fs.readFileSync(path.join(repoRoot, ownerPath), 'utf8').includes(anchor)) {
      errors.push(`client resource owner foundation ${foundationId} owner API anchor is missing: ${anchor}`)
    }
    if (
      !foundation.resource?.trim() ||
      !foundation.workstream1Cursor?.trim() ||
      !foundation.workstream2Cursor?.trim()
    ) {
      errors.push(`client resource owner foundation ${foundationId} has incomplete dependency metadata`)
    }
    for (const capability of foundation.capabilities ?? []) {
      if (!OWNER_CAPABILITY_KEYS.includes(capability)) {
        errors.push(`client resource owner foundation ${foundationId} has unknown capability ${capability}`)
      }
    }
    if (!foundation.remaining?.trim()) {
      errors.push(`client resource owner foundation ${foundationId} has no bounded remaining work`)
    }
  }
  return errors
}

export function compareClientResourceBaseline(
  observation: ClientResourceObservation,
  baseline: ClientResourceBaseline,
): string[] {
  const errors = validateClientResourceBaseline(baseline)
  if (JSON.stringify(observationProjection(baseline)) !== JSON.stringify(observation)) {
    errors.push('client resource ownership inventory drifted; regenerate and review the baseline')
  }
  return errors
}
