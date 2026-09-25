import type { Message } from '../storage/database.svelte'
import { getChatMessageOwnerState } from '../server/chatMessageHydration.svelte'
import { canUseGenerationOperationProtocol } from '../server/generationOperations'
import {
  resolveServerPromptAssembly,
  type ServerPromptAssemblyInput,
  type ServerPromptAssemblyRoute,
} from './request/serverPromptAssembly'

export interface ChatSendPreflightInput extends ServerPromptAssemblyInput {
  pendingUserMessage?: Message | null
}

/**
 * Run the same prompt-assembly capability gate as sendChat against the turn
 * that would exist after a successful append, without mutating the transcript.
 */
export function preflightChatSendBeforeMutation(input: ChatSendPreflightInput): ServerPromptAssemblyRoute {
  const { pendingUserMessage, ...assemblyInput } = input
  const ownerState =
    typeof assemblyInput.currentChat.id === 'string'
      ? getChatMessageOwnerState(assemblyInput.currentChat.id)
      : undefined
  const diagnostics = {
    pendingUserMessageSupplied: pendingUserMessage != null,
    transcriptOwner: ownerState
      ? {
          messageCount: ownerState.messages.length,
          sameMessageArray: ownerState.messages === assemblyInput.currentChat.message,
        }
      : null,
    generationOperationProtocol: canUseGenerationOperationProtocol(),
  } satisfies Partial<ServerPromptAssemblyInput>

  if (!pendingUserMessage) {
    return resolveServerPromptAssembly({
      ...assemblyInput,
      ...diagnostics,
    })
  }

  return resolveServerPromptAssembly({
    ...assemblyInput,
    ...diagnostics,
    currentChat: {
      ...assemblyInput.currentChat,
      message: [...(assemblyInput.currentChat.message ?? []), pendingUserMessage],
    },
  })
}
