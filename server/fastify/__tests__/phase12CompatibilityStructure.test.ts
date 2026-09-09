import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

type Owner = {
  production: string
  anchors: readonly string[]
}

const CLOSED_STRING_VOCABULARIES = {
  'server/fastify/src/routeManifest.ts': {
    ProtocolRouteAuthDecision: ['conditional', 'diagnostics-read', 'public', 'required'],
    ProtocolRouteActiveWriterDecision: [
      'active-writer',
      'auth-session',
      'not-applicable',
      'read-only-post',
      'runtime-generation',
      'runtime-proxy',
      'stateless-helper',
      'writer-registration',
    ],
  },
  'server/fastify/src/config.ts': {
    RequestTraceMode: ['agent', 'human'],
  },
  'src/ts/platform.ts': {
    RisuEnvironmentLabel: ['fastify'],
  },
  'src/ts/polyfill.ts': {
    BaselineRuntimeFeature: [
      'arrayAt',
      'arrayFindLast',
      'arrayFindLastIndex',
      'objectFromEntries',
      'objectHasOwn',
      'promiseAllSettled',
      'promiseAny',
      'stringReplaceAll',
      'structuredClone',
    ],
  },
  'src/ts/startupReadiness.ts': {
    StartupMilestoneRecordResult: ['duplicate', 'pending', 'transitioned'],
  },
  'packages/protocol/src/startupTelemetry.ts': {
    StartupStep: [
      'background-readiness',
      'background-runtime',
      'chat-hydration-runtime',
      'chat-readiness',
      'generation-recovery',
      'plugin-runtime',
      'push-runtime',
      'writer-bootstrap',
      'writer-event-subscription',
      'writer-initialize',
      'writer-outbox-prepare',
      'writer-owner-adoption',
      'writer-pending-replay',
      'writer-projection-install',
      'writer-receipt-flush',
      'writer-resource-hydration',
      'writer-runtime-services',
    ],
  },
  'src/ts/server/pushNotifications.ts': {
    DisablePushNotificationCleanupStep: [
      'local-unsubscribe',
      'server-deletion',
      'service-worker',
      'subscription-inspection',
    ],
    PushNotificationFallbackReason: [
      'notification-unavailable',
      'permission-default',
      'push-unavailable',
      'server-registration-failed',
      'service-worker-failed',
      'service-worker-unavailable',
      'subscription-failed',
      'vapid-unavailable',
    ],
  },
} as const

const PROPERTY_VOCABULARIES = {
  'server/fastify/src/auth.ts': {
    VerifyResult: {
      reason: ['bad-alg', 'bad-signature', 'error', 'expired', 'malformed', 'missing', 'unknown-key'],
    },
  },
  'src/ts/server/pushNotifications.ts': {
    EnablePushNotificationsResult: {
      status: ['enabled', 'fallback', 'permission-denied'],
    },
    DisablePushNotificationsResult: {
      status: ['disabled', 'partial'],
    },
  },
} as const

const RATE_LIMIT_OWNERS: Record<string, Owner> = {
  supportDiagnosticsRateLimit: rateOwner('server/fastify/src/remoteDiagnostics.ts', 'supportDiagnosticsRateLimit'),
  browserDiagnosticsRateLimit: rateOwner(
    'server/fastify/src/routes/browserDiagnostics.ts',
    'browserDiagnosticsRateLimit',
  ),
  authSetupRateLimit: rateOwner('server/fastify/src/routes/auth.ts', 'authSetupRateLimit'),
  authLoginRateLimit: rateOwner('server/fastify/src/routes/auth.ts', 'authLoginRateLimit'),
  authCryptoRateLimit: rateOwner('server/fastify/src/routes/legacyStorage.ts', 'authCryptoRateLimit'),
  proxyFetchRateLimit: rateOwner('server/fastify/src/routes/proxy.ts', 'proxyFetchRateLimit'),
  providerOperationRateLimit: rateOwner(
    'server/fastify/src/routes/providerOperations.ts',
    'providerOperationRateLimit',
  ),
  openAITranscriptionRateLimit: rateOwner(
    'server/fastify/src/routes/openAITranscription.ts',
    'openAITranscriptionRateLimit',
  ),
  imageGenerationRateLimit: rateOwner('server/fastify/src/routes/imageGeneration.ts', 'imageGenerationRateLimit'),
  mcpOAuthRefreshRateLimit: rateOwner('server/fastify/src/routes/mcpOAuthRefresh.ts', 'mcpOAuthRefreshRateLimit'),
  ttsSynthesisRateLimit: rateOwner('server/fastify/src/routes/tts.ts', 'ttsSynthesisRateLimit'),
  proxyStreamCreateRateLimit: rateOwner('server/fastify/src/routes/streamJobs.ts', 'proxyStreamCreateRateLimit'),
  importRateLimit: rateOwner('server/fastify/src/routes/save.ts', 'importRateLimit'),
  assetExistsRateLimit: rateOwner('server/fastify/src/routes/assets.ts', 'assetExistsRateLimit'),
  storageUsageRateLimit: rateOwner('server/fastify/src/routes/storageUsage.ts', 'storageUsageRateLimit'),
  generationSubmitRateLimit: rateOwner('server/fastify/src/routes/generationChat.ts', 'generationSubmitRateLimit'),
}

const LIMIT_CLASS_OWNERS: Record<string, Owner> = {
  request_receive_timeout: {
    production: 'server/fastify/src/app.ts',
    anchors: ['REQUEST_RECEIVE_TIMEOUT_MS', 'requestTimeout: REQUEST_RECEIVE_TIMEOUT_MS'],
  },
  authenticated_body_bytes: {
    production: 'server/fastify/src/routes/pushNotifications.ts',
    anchors: ['PUSH_SUBSCRIPTION_BODY_LIMIT', 'onRequest: async'],
  },
  expanded_payload_bytes: {
    production: 'server/fastify/src/risuSave/importLimits.ts',
    anchors: ['assertExpandedSizeWithinLimit', 'exceeds size limit'],
  },
  stream_concurrency_and_buffering: {
    production: 'server/fastify/src/streamJobs.ts',
    anchors: ['PROXY_STREAM_MAX_PENDING_BYTES', 'DURABLE_REPLAY_MAX_AGGREGATE_BYTES'],
  },
  response_backpressure: {
    production: 'server/fastify/src/streamBackpressure.ts',
    anchors: ['STREAM_CLIENT_MAX_BUFFERED_BYTES', 'wouldExceedStreamBuffer'],
  },
  diagnostic_retention: {
    production: 'server/fastify/src/requestHistory.ts',
    anchors: ['REQUEST_HISTORY_TOTAL_MAX_BYTES', 'pruneRequestHistory'],
  },
}

const DIAGNOSTIC_OWNERS: Record<string, Owner> = {
  request_trace: {
    production: 'server/fastify/src/requestTrace.ts',
    anchors: ['TRACE_ENTRY_LIMIT', 'STARTUP_TELEMETRY_ROUTE', "'[redacted]'"],
  },
  request_history: {
    production: 'server/fastify/src/requestHistory.ts',
    anchors: ['redactRequestHistoryValue', 'REQUEST_HISTORY_TOTAL_MAX_BYTES'],
  },
  generation_trace_sidecar: {
    production: 'server/fastify/src/generation/generationTraceSidecar.ts',
    anchors: ['SECRET_KEY_PATTERN', 'PEM_PATTERN', 'DEFAULT_GENERATION_TRACE_MAX_GZIP_BYTES'],
  },
  startup_telemetry: {
    production: 'server/fastify/src/routes/startupTelemetry.ts',
    anchors: ['STARTUP_TELEMETRY_BODY_LIMIT', 'metadata-only contract'],
  },
  production_bundle_negative: {
    production: 'util/bundle-boundary-report.ts',
    anchors: ['protectedBoundary', 'initialViolations'],
  },
}

const PLATFORM_OWNERS: Record<string, Owner> = {
  baseline_feature_polyfills: {
    production: 'src/ts/polyfill.ts',
    anchors: ['BASELINE_RUNTIME_FEATURES', 'detectBaselineRuntimeSupport'],
  },
  fastify_browser_runtime: {
    production: 'src/ts/platform.ts',
    anchors: ["RisuEnvironmentLabel = 'fastify'", 'isFastifyServer = true'],
  },
  web_push_client_lifecycle: {
    production: 'src/ts/server/pushNotifications.ts',
    anchors: ['PushNotificationFallbackReason', 'DisablePushNotificationCleanupStep'],
  },
  web_push_server_lifecycle: {
    production: 'server/fastify/src/pushNotifications.ts',
    anchors: ['PUSH_DELIVERY_TIMEOUT_MS', 'isExpiredPushSubscriptionError'],
  },
}

const RECOVERY_OWNERS: Record<string, Owner> = {
  interrupted_restore_before_open: {
    production: 'server/fastify/src/app.ts',
    anchors: ['recoverInterruptedRestoreSwaps(db, config.dataDir, app.log)', 'backfillLegacyHypaV3MemoryRows'],
  },
  generation_startup_reconciliation: {
    production: 'server/fastify/src/app.ts',
    anchors: ['reconcileGenerationOperationsAtStartup', 'reconcileGenerationEffectsAtStartup'],
  },
  orderly_shutdown: {
    production: 'server/fastify/src/app.ts',
    anchors: ["app.addHook('onClose'", 'await generationJobRegistry.settleRunners()', "failureCode: 'server_shutdown'"],
  },
  fallback_session_reopen: {
    production: 'server/fastify/src/auth.ts',
    anchors: ['sessionTokensPath', 'persistKnownSessionTokens'],
  },
}

const SIGNED_PLATFORM_NO_PORT_BOUNDARIES = {
  wrapper_runtimes: {
    absentPaths: ['src-tauri', 'capacitor.config.ts', 'server/hono', 'server.sh', 'server.bat'],
    absentPackages: ['@tauri-apps/api', '@tauri-apps/cli', '@capacitor/core', 'electron'],
  },
  peerjs_multi_user: {
    absentPaths: ['src/ts/sync/multiuser.ts'],
    absentPackages: ['peerjs'],
  },
  account_and_drive_sync: {
    absentPaths: [
      'src/ts/storage/accountStorage.ts',
      'src/ts/drive/drive.ts',
      'src/ts/drive/accounter.ts',
      'src/ts/sionyw.ts',
      'src/lib/Setting/Pages/FilesSettings.svelte',
      'public/functions/drive.js',
    ],
    absentPackages: ['openid-client'],
  },
  browser_local_authority: {
    absentPaths: ['src/ts/storage/opfsStorage.ts', 'src/ts/storage/persistant.ts', 'src/preload.ts', 'public/sw.js'],
    absentPackages: [],
  },
} as const

describe('Phase 12 runtime, platform, limit, and diagnostic structure', () => {
  it('closes every auth, route-policy, runtime, startup, and push vocabulary', () => {
    for (const [relativePath, vocabularies] of Object.entries(CLOSED_STRING_VOCABULARIES)) {
      const source = readRepoFile(relativePath)
      for (const [typeName, expected] of Object.entries(vocabularies)) {
        expect(typeAliasStringUnion(source, typeName), `${relativePath}:${typeName}`).toEqual(expected)
      }
    }

    const routeOperations = readRepoFile('packages/protocol/src/routeOperation.ts')
    expect(constStringArray(routeOperations, 'PROTOCOL_ROUTE_METHODS')).toEqual([
      'GET',
      'HEAD',
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
      'OPTIONS',
    ])
    expect(constStringArray(routeOperations, 'PROTOCOL_ROUTE_PATH_MATCHES')).toEqual(['exact', 'prefix', 'pattern'])
    expect(constStringArray(routeOperations, 'PROTOCOL_ROUTE_STREAM_CLASSES')).toEqual([
      'none',
      'binary',
      'sse',
      'sse-optional',
      'websocket',
      'proxy',
    ])
    expect(constStringArray(routeOperations, 'PROTOCOL_ROUTE_CACHE_BEHAVIORS')).toEqual([
      'unspecified',
      'request-hash',
      'immutable',
      'conditional',
      'no-cache',
      'no-store',
    ])
    expect(constStringArray(routeOperations, 'PROTOCOL_ROUTE_DURABILITY_TAGS')).toEqual([
      'none',
      'revisioned-command',
      'durable-generation',
      'server-job',
    ])
    expect(constStringArray(routeOperations, 'PROTOCOL_ROUTE_RESPONSE_CLASSES')).toEqual([
      'structured',
      'binary',
      'sse',
      'structured-or-sse',
      'websocket',
      'proxy',
    ])

    for (const [relativePath, aliases] of Object.entries(PROPERTY_VOCABULARIES)) {
      const source = readRepoFile(relativePath)
      for (const [typeName, properties] of Object.entries(aliases)) {
        for (const [propertyName, expected] of Object.entries(properties)) {
          expect(
            typePropertyStringUnion(source, typeName, propertyName),
            `${relativePath}:${typeName}.${propertyName}`,
          ).toEqual(expected)
        }
      }
    }

    expect(constStringArray(readRepoFile('src/ts/polyfill.ts'), 'BASELINE_RUNTIME_FEATURES')).toEqual(
      CLOSED_STRING_VOCABULARIES['src/ts/polyfill.ts'].BaselineRuntimeFeature,
    )
    expect(constStringArray(readRepoFile('src/ts/startupReadiness.ts'), 'STARTUP_CAPABILITIES')).toEqual([
      'canRenderShell',
      'canApplyRoutes',
      'canMutate',
      'pluginsReady',
      'canGenerate',
    ])
    expect(
      constStringArray(readRepoFile('packages/protocol/src/startupTelemetry.ts'), 'STARTUP_TELEMETRY_MILESTONES'),
    ).toEqual([
      'entry',
      'shell-mounted',
      'reader-ready',
      'writer-ready',
      'plugins-ready',
      'chat-ready',
      'background-ready',
    ])
    expect(
      constStringArray(readRepoFile('packages/protocol/src/startupTelemetry.ts'), 'STARTUP_TELEMETRY_FAILURE_CODES'),
    ).toEqual([
      'writer-bootstrap-failed',
      'push-initialization-failed',
      'plugin-initialization-failed',
      'generation-recovery-failed',
      'selected-character-hydration-failed',
      'selected-chat-hydration-failed',
      'selected-prompt-template-hydration-failed',
      'runtime-initialization-failed',
    ])
  })

  it('requires every declared route rate limit and every limit class to retain production owners', () => {
    expect(Object.keys(RATE_LIMIT_OWNERS).sort()).toEqual(
      exportedVariableNames(readRepoFile('server/fastify/src/routeRateLimits.ts'), /RateLimit$/).sort(),
    )
    verifyOwners(RATE_LIMIT_OWNERS)
    verifyOwners(LIMIT_CLASS_OWNERS)
  })

  it('keeps diagnostics, supported-platform boundaries, and restart paths attached to production owners', () => {
    verifyOwners(DIAGNOSTIC_OWNERS)
    verifyOwners(PLATFORM_OWNERS)
    verifyOwners(RECOVERY_OWNERS)

    const appSource = readRepoFile('server/fastify/src/app.ts')
    expect(appSource.indexOf('recoverInterruptedRestoreSwaps(db')).toBeLessThan(
      appSource.indexOf('backfillLegacyHypaV3MemoryRows('),
    )
    expect(appSource.indexOf('reconcileGenerationOperationsAtStartup(db')).toBeLessThan(
      appSource.indexOf('registerGenerationRoutes(app'),
    )
    expect(appSource.indexOf("app.addHook('onClose'")).toBeLessThan(appSource.indexOf('db.close()'))
  })

  it('keeps each signed platform no-port boundary absent without removing supported web and recovery surfaces', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const packageNames = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ])

    for (const [boundary, policy] of Object.entries(SIGNED_PLATFORM_NO_PORT_BOUNDARIES)) {
      for (const relativePath of policy.absentPaths) {
        expect(existsSync(path.join(REPO_ROOT, relativePath)), `${boundary}: ${relativePath}`).toBe(false)
      }
      for (const packageName of policy.absentPackages) {
        expect(packageNames.has(packageName), `${boundary}: ${packageName}`).toBe(false)
      }
    }

    expect(readRepoFile('src/ts/storage/autoStorage.ts')).toContain('this.realStorage = new FastifyStorage()')
    expect(existsSync(path.join(REPO_ROOT, 'src/ts/storage/backup.ts'))).toBe(true)
    expect(existsSync(path.join(REPO_ROOT, 'server/fastify/src/routes/backups.ts'))).toBe(true)
    expect(existsSync(path.join(REPO_ROOT, 'public/service-worker.js'))).toBe(true)

    const manifest = JSON.parse(readRepoFile('public/manifest.json')) as Record<string, unknown>
    expect(manifest.display).toBe('standalone')
    expect(manifest).not.toHaveProperty('share_target')
    expect(manifest).not.toHaveProperty('file_handlers')
  })
})

function rateOwner(production: string, rateLimit: string): Owner {
  return {
    production,
    anchors: [rateLimit],
  }
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function verifyOwners(owners: Readonly<Record<string, Owner>>): void {
  for (const [name, owner] of Object.entries(owners)) {
    const production = readRepoFile(owner.production)
    for (const anchor of owner.anchors) expect(production, `${name} production anchor`).toContain(anchor)
  }
}

function sourceFile(source: string): ts.SourceFile {
  return ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function declarations(source: ts.SourceFile): Map<string, ts.TypeNode | ts.InterfaceDeclaration> {
  const result = new Map<string, ts.TypeNode | ts.InterfaceDeclaration>()
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) result.set(statement.name.text, statement.type)
    if (ts.isInterfaceDeclaration(statement)) result.set(statement.name.text, statement)
  }
  return result
}

function typeAliasStringUnion(source: string, typeName: string): string[] {
  const parsed = sourceFile(source)
  const declaration = declarations(parsed).get(typeName)
  if (!declaration || ts.isInterfaceDeclaration(declaration)) throw new Error(`type alias ${typeName} not found`)
  const members = ts.isUnionTypeNode(declaration) ? declaration.types : [declaration]
  return members
    .map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
        throw new Error(`${typeName} contains a non-string member: ${member.getText(parsed)}`)
      }
      return member.literal.text
    })
    .sort()
}

function typePropertyStringUnion(source: string, typeName: string, propertyName: string): string[] {
  const parsed = sourceFile(source)
  const allDeclarations = declarations(parsed)
  const root = allDeclarations.get(typeName)
  if (!root) throw new Error(`type ${typeName} not found`)
  return [...collectPropertyStrings(root, propertyName, allDeclarations, new Set())].sort()
}

function collectPropertyStrings(
  node: ts.TypeNode | ts.InterfaceDeclaration,
  propertyName: string,
  allDeclarations: Map<string, ts.TypeNode | ts.InterfaceDeclaration>,
  visiting: Set<string>,
): Set<string> {
  const values = new Set<string>()
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const member of node.types)
      addAll(values, collectPropertyStrings(member, propertyName, allDeclarations, visiting))
    return values
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return collectPropertyStrings(node.type, propertyName, allDeclarations, visiting)
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText()
    if (visiting.has(name)) return values
    const target = allDeclarations.get(name)
    return target ? collectPropertyStrings(target, propertyName, allDeclarations, new Set(visiting).add(name)) : values
  }
  const members = ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node) ? node.members : []
  for (const member of members) {
    if (!ts.isPropertySignature(member) || propertyText(member.name) !== propertyName || !member.type) continue
    addAll(values, stringLiterals(member.type))
  }
  return values
}

function propertyText(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  throw new Error('computed property names are not supported in closed vocabularies')
}

function stringLiterals(node: ts.TypeNode): Set<string> {
  const result = new Set<string>()
  if (ts.isUnionTypeNode(node)) {
    for (const member of node.types) addAll(result, stringLiterals(member))
  } else if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    result.add(node.literal.text)
  }
  return result
}

function addAll(target: Set<string>, source: Iterable<string>): void {
  for (const value of source) target.add(value)
}

function constStringArray(source: string, variableName: string): string[] {
  const parsed = sourceFile(source)
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName || !declaration.initializer)
        continue
      const array = unwrapArrayInitializer(declaration.initializer)
      return array.elements.map((element) => {
        if (!ts.isStringLiteral(element)) throw new Error(`${variableName} contains a dynamic member`)
        return element.text
      })
    }
  }
  throw new Error(`const array ${variableName} not found`)
}

function unwrapArrayInitializer(expression: ts.Expression): ts.ArrayLiteralExpression {
  if (ts.isArrayLiteralExpression(expression)) return expression
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrapArrayInitializer(expression.expression)
  }
  if (ts.isCallExpression(expression) && expression.arguments[0]) return unwrapArrayInitializer(expression.arguments[0])
  throw new Error(`expected a static array, received ${expression.getText()}`)
}

function exportedVariableNames(source: string, pattern: RegExp): string[] {
  const parsed = sourceFile(source)
  const names: string[] = []
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && pattern.test(declaration.name.text)) names.push(declaration.name.text)
    }
  }
  return names
}
