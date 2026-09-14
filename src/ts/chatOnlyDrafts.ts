const CHAT_ONLY_DRAFT_PREFIX = 'risu:chat-only-draft:v1:'

export interface ChatOnlyDraftScope {
  readonly databaseLineage: string
  readonly sessionId: string
  readonly chatId: string
}

function encoded(value: string): string {
  return encodeURIComponent(value)
}

function validScope(scope: ChatOnlyDraftScope): boolean {
  return Boolean(scope.databaseLineage.trim() && scope.sessionId.trim() && scope.chatId.trim())
}

export function chatOnlyDraftStorageKey(scope: ChatOnlyDraftScope): string | null {
  if (!validScope(scope)) return null
  return `${CHAT_ONLY_DRAFT_PREFIX}${encoded(scope.databaseLineage)}:${encoded(scope.sessionId)}:${encoded(scope.chatId)}`
}

function sessionNamespace(scope: ChatOnlyDraftScope): string | null {
  if (!validScope(scope)) return null
  return `${CHAT_ONLY_DRAFT_PREFIX}${encoded(scope.databaseLineage)}:${encoded(scope.sessionId)}:`
}

function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * Remove copied or stale page-session drafts before reading the current one.
 * A duplicated tab receives a fresh page-session id, so its copied
 * sessionStorage cannot reveal or adopt the original tab's draft.
 */
export function pruneChatOnlyDraftsForScope(scope: ChatOnlyDraftScope, storage = browserSessionStorage()): void {
  const namespace = sessionNamespace(scope)
  if (!storage || !namespace) return
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (key?.startsWith(CHAT_ONLY_DRAFT_PREFIX) && !key.startsWith(namespace)) storage.removeItem(key)
    }
  } catch {}
}

export function readChatOnlyDraft(scope: ChatOnlyDraftScope, storage = browserSessionStorage()): string {
  const key = chatOnlyDraftStorageKey(scope)
  if (!storage || !key) return ''
  pruneChatOnlyDraftsForScope(scope, storage)
  try {
    return storage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function writeChatOnlyDraft(
  scope: ChatOnlyDraftScope,
  value: string,
  storage = browserSessionStorage(),
): boolean {
  const key = chatOnlyDraftStorageKey(scope)
  if (!storage || !key) return false
  try {
    if (value) storage.setItem(key, value)
    else storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
