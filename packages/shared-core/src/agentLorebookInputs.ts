import { isAgentOnlyLorebookEntry } from './agentOnlyLorebook.js'

export interface AgentLorebookInputLike {
  key: string
  displayName: string
  required: boolean
}

export interface AgentLorebookEntryLike {
  agentOnly?: unknown
  extentions?: unknown
  alwaysActive?: boolean
  key?: string
  secondkey?: string
  comment?: string
  content?: string
  mode?: string
}

export interface AgentLorebookOwnerLike<TEntry extends AgentLorebookEntryLike = AgentLorebookEntryLike> {
  globalLore?: readonly TEntry[]
  localLore?: readonly TEntry[]
}

export type AgentLorebookInputResolution<
  TInput extends AgentLorebookInputLike = AgentLorebookInputLike,
  TEntry extends AgentLorebookEntryLike = AgentLorebookEntryLike,
> =
  | {
      status: 'resolved'
      input: TInput
      scope: 'chat' | 'character'
      entry: TEntry
      content: string
    }
  | {
      status: 'optional_missing'
      input: TInput
    }
  | {
      status: 'missing' | 'ambiguous' | 'not_agent_only' | 'invalid_entry' | 'empty'
      input: TInput
      scope?: 'chat' | 'character'
      message: string
    }

export function resolveAgentLorebookInput<TInput extends AgentLorebookInputLike, TEntry extends AgentLorebookEntryLike>(
  input: TInput,
  currentChar: Pick<AgentLorebookOwnerLike<TEntry>, 'globalLore'>,
  currentChat: Pick<AgentLorebookOwnerLike<TEntry>, 'localLore'>,
): AgentLorebookInputResolution<TInput, TEntry> {
  const displayName = input.displayName.trim()
  const chatMatches = matchingEntries(currentChat.localLore, displayName)
  const characterMatches = matchingEntries(currentChar.globalLore, displayName)
  const scope = chatMatches.length > 0 ? 'chat' : 'character'
  const matches = chatMatches.length > 0 ? chatMatches : characterMatches

  if (matches.length === 0) {
    if (!input.required) return { status: 'optional_missing', input }
    return {
      status: 'missing',
      input,
      message: `Required Agent lorebook input was not found: ${displayName}`,
    }
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      scope,
      message: `Multiple ${scope}-level lorebook entries use the display name: ${displayName}`,
    }
  }

  const entry = matches[0]
  if (!isAgentOnlyLorebookEntry(entry)) {
    return {
      status: 'not_agent_only',
      input,
      scope,
      message: `Lorebook entry must be marked Agent-only: ${displayName}`,
    }
  }
  if (entry.mode === 'folder' || entry.mode === 'child') {
    return {
      status: 'invalid_entry',
      input,
      scope,
      message: `Agent-only lorebook input must be a regular lorebook entry: ${displayName}`,
    }
  }
  if (!entry.content?.trim()) {
    return {
      status: 'empty',
      input,
      scope,
      message: `Agent-only lorebook input is empty: ${displayName}`,
    }
  }
  return {
    status: 'resolved',
    input,
    scope,
    entry,
    content: entry.content,
  }
}

function matchingEntries<TEntry extends AgentLorebookEntryLike>(
  entries: readonly TEntry[] | undefined,
  displayName: string,
): TEntry[] {
  return (entries ?? []).filter((entry) => entry.mode !== 'folder' && entry.comment?.trim() === displayName)
}
