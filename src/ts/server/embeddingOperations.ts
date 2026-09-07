import { captureClientWriteOperation, assertClientWriteOperation } from '../clientWriteOperation'
import { isMaskedProviderSecret } from '../providerSecretMask'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import type {
  ContextualRemoteEmbeddingModel,
  CustomEmbeddingConfiguration,
  EmbeddingGroupsOperationSuccess,
  EmbeddingInputType,
  EmbeddingOperationCredential,
  EmbeddingOperationRequest,
  EmbeddingTextsOperationSuccess,
  RemoteEmbeddingModel,
} from '@risuai/protocol/embedding-operation'

const EMBEDDING_OPERATIONS_ENDPOINT = '/api/v1/embedding-operations'

export interface RemoteEmbeddingRequestOptions {
  credential: EmbeddingOperationCredential
  signal?: AbortSignal | null
}

export interface RemoteEmbeddingTextsRequestOptions extends RemoteEmbeddingRequestOptions {
  model: Exclude<RemoteEmbeddingModel, ContextualRemoteEmbeddingModel>
  inputType: EmbeddingInputType
  input: string[]
  custom?: CustomEmbeddingConfiguration
}

export interface RemoteEmbeddingGroupsRequestOptions extends RemoteEmbeddingRequestOptions {
  model: ContextualRemoteEmbeddingModel
  inputType: EmbeddingInputType
  groups: string[][]
}

export function embeddingOperationCredential(value: unknown): EmbeddingOperationCredential {
  if (isMaskedProviderSecret(value)) return { source: 'stored' }
  if (typeof value === 'string' && value.trim().length > 0) {
    return { source: 'provided', apiKey: value }
  }
  return { source: 'none' }
}

export async function requestRemoteEmbeddingTexts(options: RemoteEmbeddingTextsRequestOptions): Promise<number[][]> {
  const request: EmbeddingOperationRequest = {
    operation: 'texts',
    model: options.model,
    inputType: options.inputType,
    input: options.input,
    credential: options.credential,
    ...(options.custom ? { custom: options.custom } : {}),
  }
  const body = await requestEmbeddingOperation(request, options.signal)
  if (body.operation !== 'texts' || !validVectors(body.vectors, options.input.length, body.dimension)) {
    throw new Error('Embedding operation response was malformed')
  }
  return body.vectors
}

export async function requestRemoteEmbeddingGroups(
  options: RemoteEmbeddingGroupsRequestOptions,
): Promise<number[][][]> {
  const request: EmbeddingOperationRequest = {
    operation: 'groups',
    model: options.model,
    inputType: options.inputType,
    groups: options.groups,
    credential: options.credential,
  }
  const body = await requestEmbeddingOperation(request, options.signal)
  if (
    body.operation !== 'groups' ||
    body.groups.length !== options.groups.length ||
    !body.groups.every((group, index) => validVectors(group, options.groups[index].length, body.dimension))
  ) {
    throw new Error('Embedding operation response was malformed')
  }
  return body.groups
}

async function requestEmbeddingOperation(
  request: EmbeddingOperationRequest,
  signal?: AbortSignal | null,
): Promise<EmbeddingTextsOperationSuccess | EmbeddingGroupsOperationSuccess> {
  const operation = captureClientWriteOperation()
  const auth = await getNodeServerProxyAuth()
  assertClientWriteOperation(operation)
  const response = await fetch(EMBEDDING_OPERATIONS_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'risu-auth': auth,
    },
    body: JSON.stringify(request),
    cache: 'no-store',
    signal: signal ?? undefined,
  })

  if (!response.ok) {
    let code = `embedding_operation_failed_${response.status}`
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body?.error === 'string' && body.error.length <= 128) code = body.error
    } catch {}
    throw new Error(code)
  }

  const body = (await response.json()) as EmbeddingTextsOperationSuccess | EmbeddingGroupsOperationSuccess
  assertClientWriteOperation(operation)
  return body
}

function validVectors(value: unknown, expectedCount: number, dimension: number): value is number[][] {
  return (
    Number.isInteger(dimension) &&
    dimension > 0 &&
    Array.isArray(value) &&
    value.length === expectedCount &&
    value.every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length === dimension &&
        vector.every((entry) => typeof entry === 'number' && Number.isFinite(entry)),
    )
  )
}
