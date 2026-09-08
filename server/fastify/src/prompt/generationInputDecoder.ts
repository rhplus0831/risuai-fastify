import { createHash } from 'node:crypto'
import {
  validateGenerationSettings as settings,
  validateFastifyDatabase as database,
  validateGenerationPreflightInputs as preflight,
  validateProviderGenerationSettings as provider,
  validateMemoryGenerationSettings as memory,
  generationInputValidatorMetadata,
  type GenerationInputValidator,
} from './generationInputValidators.js'
import type {
  FastifyDatabase,
  GenerationSettings,
  GenerationPreflightInputs,
  ProviderGenerationSettings,
  MemoryGenerationSettings,
} from './serverTypes.js'
import type { DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'

type DisplayDiagnosticEvent = Extract<DiagnosticEventV2, { category: 'display' }>
export type GenerationInputValidationDomain = NonNullable<DisplayDiagnosticEvent['validationDomain']>
export type GenerationInputValidationOwner = NonNullable<DisplayDiagnosticEvent['validationOwner']>
export type GenerationInputValidationRule = NonNullable<DisplayDiagnosticEvent['validationRule']>
export type GenerationInputValueKind = NonNullable<DisplayDiagnosticEvent['valueKind']>
type ValidatorError = NonNullable<GenerationInputValidator<unknown>['errors']>[number]

function jsonPointerSegments(path: string): string[] {
  if (!path.startsWith('/')) return []
  return path
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function generationInputValidationOwner(path: string): GenerationInputValidationOwner {
  const segments = jsonPointerSegments(path)
  if (segments[0] === 'database') segments.shift()
  const root = segments[0]
  if (root === 'currentChar') return 'character'
  if (root === 'currentChat') return 'chat'
  if (root === 'characters') {
    if (segments.includes('message')) return 'message'
    if (segments.includes('hypaV3Data')) return 'memory'
    if (segments.includes('localLore') || segments.includes('globalLore')) return 'lorebook'
    if (segments.includes('chats')) return 'chat'
    return 'character'
  }
  if (root === 'modules') return 'module'
  if (root === 'promptPresets') return 'prompt-preset'
  if (root === 'personas') return 'persona'
  if (root === 'modelPresets') return 'model-preset'
  if (root === 'modelProfiles') return 'model-profile'
  if (root === 'providerCredentials') return 'provider-credential'
  if (root === 'agentPresets') return 'agent-preset'
  if (root === 'customModels') return 'custom-model'
  if (root === 'hypaV3Presets') return 'memory'
  return root ? 'settings' : 'unknown'
}

function schemaField(error: ValidatorError | undefined): string | null {
  if (!error) return null
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
    return error.params.missingProperty
  }
  let encoded: string | undefined
  for (const match of error.schemaPath.matchAll(/\/properties\/([^/]+)/gu)) encoded = match[1]
  if (!encoded) return null
  const field = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
  return /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/u.test(field) ? field : null
}

function validationFieldReference(error: ValidatorError | undefined): string | undefined {
  const field = schemaField(error)
  // The input is a generated schema field, never a persisted key or value. A
  // stable reference keeps remote evidence content-free while remaining
  // resolvable against the deployed generation-input schema.
  return field ? createHash('sha256').update(`generation-input-field:${field}`).digest('hex').slice(0, 16) : undefined
}

function generationInputValidationRule(keyword: string | undefined): GenerationInputValidationRule {
  if (keyword === 'type' || keyword === 'required' || keyword === 'const' || keyword === 'not') return keyword
  if (keyword === 'anyOf') return 'any-of'
  if (keyword === 'items') return 'items'
  if (keyword === 'minItems') return 'min-items'
  if (keyword === 'maxItems') return 'max-items'
  return 'other'
}

function valueAtValidationPath(value: unknown, error: ValidatorError | undefined): unknown {
  if (!error) return value
  let current = value
  for (const segment of jsonPointerSegments(error.instancePath)) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return undefined
    return Object.hasOwn(current, error.params.missingProperty)
      ? (current as Record<string, unknown>)[error.params.missingProperty]
      : undefined
  }
  return current
}

function generationInputValueKind(value: unknown): GenerationInputValueKind {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'other'
}

/** A persisted known field has a shape the generation domain cannot consume. */
export class GenerationInputValidationError extends Error {
  constructor(
    readonly domain: GenerationInputValidationDomain,
    readonly instancePath: string,
    readonly validationOwner: GenerationInputValidationOwner,
    readonly validationFieldRef: string | undefined,
    readonly validationRule: GenerationInputValidationRule,
    readonly valueKind: GenerationInputValueKind,
  ) {
    super(`Invalid ${domain} generation input at ${instancePath || '/'}`)
    this.name = 'GenerationInputValidationError'
  }
}

// Validation neither coerces, supplies defaults, strips imported extensions,
// nor copies the selected graph. Its checked implementation is generated at build time.

/** Compilation is absent at runtime; module import/parsing is measured separately. */
export function generationInputDecoderInitializationMetrics() {
  return { ...generationInputValidatorMetadata, runtimeCompilationMs: 0 }
}

function checked<T>(value: unknown, validate: GenerationInputValidator<T>, domain: GenerationInputValidationDomain): T {
  if (!validate(value)) {
    const error = validate.errors?.[0]
    const instancePath = error?.instancePath ?? ''
    throw new GenerationInputValidationError(
      domain,
      instancePath,
      generationInputValidationOwner(instancePath),
      validationFieldReference(error),
      generationInputValidationRule(error?.keyword),
      generationInputValueKind(valueAtValidationPath(value, error)),
    )
  }
  return value
}

/** A malformed stable Hypa selection already means no selection, never numeric fallback. */
function normalizeLegacyHypaSelection(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'selectedHypaV3PresetId' in value) {
    const selected = value.selectedHypaV3PresetId
    if (selected !== undefined && selected !== null && typeof selected !== 'string') {
      return { ...value, selectedHypaV3PresetId: null }
    }
  }
  return value
}

export function decodeGenerationSettings(value: unknown): GenerationSettings {
  return checked(normalizeLegacyHypaSelection(value), settings, 'settings')
}
export function decodeGenerationDatabase(value: unknown): FastifyDatabase {
  return checked(normalizeLegacyHypaSelection(value), database, 'database')
}
export function decodeGenerationPreflightInputs(value: unknown): GenerationPreflightInputs {
  if (value && typeof value === 'object' && 'database' in value) {
    const normalized = normalizeLegacyHypaSelection(value.database)
    if (normalized !== value.database) return checked({ ...value, database: normalized }, preflight, 'preflight')
  }
  return checked(value, preflight, 'preflight')
}

export function decodeProviderGenerationSettings(value: unknown): ProviderGenerationSettings {
  return checked(normalizeLegacyHypaSelection(value), provider, 'provider')
}
export function decodeMemoryGenerationSettings(value: unknown): MemoryGenerationSettings {
  return checked(normalizeLegacyHypaSelection(value), memory, 'memory')
}
