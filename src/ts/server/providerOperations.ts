import { captureClientWriteOperation, assertClientWriteOperation } from '../clientWriteOperation'
import { language } from '../../lang'
import { MASKED_MODEL_PROFILE_SECRET } from '../model/modelProfileSecrets'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import type {
  ProviderOperation,
  ProviderOperationCredential,
  ProviderOperationRequest,
  ProviderOperationSuccess,
} from '@risuai/protocol/provider-operation'

const PROVIDER_OPERATIONS_ENDPOINT = '/api/v1/provider-operations'

export interface ProviderOperationCredentialOptions {
  profileId?: string | null
}

export interface RequestProviderOperationOptions {
  credential: ProviderOperationCredential
  input?: ProviderOperationRequest['input']
  signal?: AbortSignal | null
}

export function providerOperationCredential(
  apiKey: string | null | undefined,
  options: ProviderOperationCredentialOptions = {},
): ProviderOperationCredential {
  if (apiKey === MASKED_MODEL_PROFILE_SECRET) {
    const profileId = options.profileId?.trim()
    return profileId ? { source: 'model-profile', profileId } : { source: 'stored' }
  }
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return { source: 'provided', apiKey }
  }
  return { source: 'none' }
}

export async function requestProviderOperation<T>(
  operation: ProviderOperation,
  options: RequestProviderOperationOptions,
): Promise<T> {
  const clientOperation = captureClientWriteOperation()
  const auth = await getNodeServerProxyAuth()
  assertClientWriteOperation(clientOperation)
  const response = await fetch(PROVIDER_OPERATIONS_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'risu-auth': auth,
    },
    body: JSON.stringify({
      operation,
      credential: options.credential,
      ...(options.input ? { input: options.input } : {}),
    } satisfies ProviderOperationRequest),
    signal: options.signal ?? undefined,
  })
  if (!response.ok) {
    throw new Error(language.errors.providerOperationFailed(response.status))
  }

  const body = (await response.json()) as Partial<ProviderOperationSuccess>
  if (!body || body.operation !== operation || !Object.prototype.hasOwnProperty.call(body, 'data')) {
    throw new Error(language.errors.providerOperationResponseMalformed)
  }
  assertClientWriteOperation(clientOperation)
  return body.data as T
}
