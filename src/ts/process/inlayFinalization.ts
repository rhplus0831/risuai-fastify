import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import type { ClientChatOccupancyAuthority } from '../server/chatOccupancy'
import {
  abandonPreparedGenerationInlay,
  beginPreparedGenerationInlay,
  finalizePreparedGenerationInlay,
} from './generationEffectLedger'

export interface ServerBackedInlayPreparation {
  effectLedger: ServerGenerationEffectLedgerRef
  chatOccupancyAuthority: ClientChatOccupancyAuthority
  operationId: string
  preparationId: string
  expectedData: string
}

export interface ServerBackedInlayFinalization extends ServerBackedInlayPreparation {
  finalData: string
}

/** The accepted-operation effect route carries database lineage and uses the
 * preparation id as a stable server receipt identity. Provider work must not
 * start until this returns true. */
export async function prepareServerBackedInlayMessage(input: ServerBackedInlayPreparation): Promise<boolean> {
  return (
    (await beginPreparedGenerationInlay(input.effectLedger, input.chatOccupancyAuthority, {
      operationId: input.operationId,
      preparationId: input.preparationId,
      expectedData: input.expectedData,
    })) === 'accepted'
  )
}

export async function finalizeServerBackedInlayMessage(input: ServerBackedInlayFinalization): Promise<boolean> {
  return (
    (await finalizePreparedGenerationInlay(input.effectLedger, input.chatOccupancyAuthority, {
      operationId: input.operationId,
      preparationId: input.preparationId,
      expectedData: input.expectedData,
      finalData: input.finalData,
    })) === 'accepted'
  )
}

export async function abandonServerBackedInlayMessage(input: ServerBackedInlayPreparation): Promise<boolean> {
  return (
    (await abandonPreparedGenerationInlay(input.effectLedger, input.chatOccupancyAuthority, {
      operationId: input.operationId,
      preparationId: input.preparationId,
    })) === 'accepted'
  )
}
