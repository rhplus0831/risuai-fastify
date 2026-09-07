import { getContext } from 'svelte'
import type { ChatReadOwners } from './chatReadOwners.svelte'
import { sharedChatReadOwners } from './sharedChatReadOwners.svelte'

export const CHAT_READ_OWNERS_CONTEXT = Symbol('chat-read-owners')

/** Resolve once during component initialization; the owners keep their scope reactive. */
export function getChatReadOwnersContext(): ChatReadOwners {
  return getContext<ChatReadOwners | undefined>(CHAT_READ_OWNERS_CONTEXT) ?? sharedChatReadOwners
}
