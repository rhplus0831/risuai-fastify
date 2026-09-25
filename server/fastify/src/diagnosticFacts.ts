import { diagnosticErrorFields } from '@risuai/protocol/diagnostics'
import { projectRemoteDiagnosticFacts, type RemoteDiagnosticFact } from '@risuai/protocol/remote-diagnostics'
import {
  diagnosticLocationsTrusted,
  recordDiagnosticEventForDatabase,
  type DiagnosticOperationReferences,
} from './diagnosticContext.js'
import { generationRejectionCodes } from './generationRejectionCounters.js'
import { GenerationInputValidationError } from './prompt/generationInputDecoder.js'

export function diagnosticRejectionFacts(payload: unknown): RemoteDiagnosticFact[] {
  return generationRejectionCodes(payload).map((value, index) => ({
    id: index === 0 ? 'rejection.code' : `rejection.code.${index}`,
    type: 'rejection-code',
    value,
  }))
}

/** Only closed classifications and application coordinates enter the journal. */
export function diagnosticErrorFacts(error: unknown, db?: object): RemoteDiagnosticFact[] {
  const fields = diagnosticErrorFields(error)
  const facts: RemoteDiagnosticFact[] = [
    { id: 'error.name', type: 'error-name', value: fields.errorName ?? 'UnknownError' },
    ...diagnosticRejectionFacts(error),
  ]
  try {
    if (error instanceof GenerationInputValidationError) {
      facts.push(
        { id: 'validation.domain', type: 'validation-domain', value: error.domain },
        { id: 'validation.owner', type: 'validation-owner', value: error.validationOwner },
        { id: 'validation.rule', type: 'validation-rule', value: error.validationRule },
        { id: 'validation.value-kind', type: 'value-kind', value: error.valueKind },
      )
      if (error.validationFieldRef)
        facts.push({ id: 'validation.field', type: 'field', value: error.validationFieldRef })
    }
    if (diagnosticLocationsTrusted(db)) {
      facts.push(
        ...(fields.locations ?? []).map(
          (value, index): RemoteDiagnosticFact => ({
            id: `error.location.${index}`,
            type: 'location',
            value,
          }),
        ),
      )
    }
  } catch {
    // An unusual thrown value must not affect the observed operation.
  }
  return projectRemoteDiagnosticFacts(facts)
}

/** Workers can report caught errors without depending on a request's async context. */
export function recordDiagnosticErrorForDatabase(
  db: object,
  input: Record<string, unknown>,
  error: unknown,
  refs: DiagnosticOperationReferences = {},
): void {
  try {
    recordDiagnosticEventForDatabase(db, input, refs, diagnosticErrorFacts(error, db))
  } catch {
    /* Diagnostics never control worker completion or cleanup. */
  }
}
