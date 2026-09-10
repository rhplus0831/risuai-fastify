export type AgentPresetDeleteImpactOwner = 'settings' | 'characters' | 'loadouts'
export type AgentPresetDeleteImpactUnavailableReason = 'loading' | 'error' | 'invalid' | 'missing'

export interface AgentPresetDeleteImpactUnavailable {
  status: 'unavailable'
  owner: AgentPresetDeleteImpactOwner
  reason: AgentPresetDeleteImpactUnavailableReason
}

export type AgentPresetPostDeleteSelection =
  | { source: 'globalDefault'; presetId: string; presetName: string }
  | { source: 'none' }

export interface AgentPresetDeleteImpactChat {
  characterId: string
  characterName: string
  chatId: string
  chatName: string
  postDeleteSelection: AgentPresetPostDeleteSelection
}

export interface AgentPresetDeleteImpactLoadout {
  loadoutId: string
  loadoutName: string
  postDeleteSelection: { source: 'none' }
}

export interface AgentPresetDeleteImpact {
  status: 'ready'
  presetId: string
  presetName: string
  globalDefault: {
    affected: boolean
    beforePresetId?: string
    beforePresetName?: string
    postDeleteSelection: AgentPresetPostDeleteSelection
  }
  chats: AgentPresetDeleteImpactChat[]
  loadouts: AgentPresetDeleteImpactLoadout[]
}

export type AgentPresetDeleteImpactResult = AgentPresetDeleteImpact | AgentPresetDeleteImpactUnavailable

interface PresetProjection {
  id?: unknown
  name?: unknown
}

interface ChatProjection {
  id?: unknown
  name?: unknown
  generationSettings?: unknown
}

interface CharacterProjection {
  chaId?: unknown
  name?: unknown
  chats?: unknown
}

interface LoadoutProjection {
  id?: unknown
  name?: unknown
  agentPresetId?: unknown
}

export function projectAgentPresetDeleteImpact(input: {
  presetId: string
  presets: readonly PresetProjection[]
  defaultPresetId?: unknown
  characters: readonly CharacterProjection[]
  loadouts: readonly LoadoutProjection[]
}): AgentPresetDeleteImpactResult {
  const presets = uniqueNamedRows(input.presets, 'id')
  if (!presets) return unavailable('settings', 'invalid')
  const target = presets.find((preset) => preset.id === input.presetId)
  if (!target) return unavailable('settings', 'missing')

  const defaultPresetId = nonBlankString(input.defaultPresetId)
  const defaultPreset = defaultPresetId ? presets.find((preset) => preset.id === defaultPresetId) : undefined
  if (defaultPresetId && !defaultPreset) return unavailable('settings', 'invalid')

  const remainingDefault = defaultPreset?.id === input.presetId ? undefined : defaultPreset
  const postDeleteDefault = selectionForPreset(remainingDefault)
  const chats = projectChats(input.characters, input.presetId, postDeleteDefault)
  if (!chats) return unavailable('characters', 'invalid')
  const loadouts = projectLoadouts(input.loadouts, input.presetId)
  if (!loadouts) return unavailable('loadouts', 'invalid')

  return {
    status: 'ready',
    presetId: target.id,
    presetName: target.name,
    globalDefault: {
      affected: defaultPreset?.id === input.presetId,
      ...(defaultPreset ? { beforePresetId: defaultPreset.id, beforePresetName: defaultPreset.name } : {}),
      postDeleteSelection: postDeleteDefault,
    },
    chats,
    loadouts,
  }
}

function projectChats(
  characters: readonly CharacterProjection[],
  presetId: string,
  postDeleteSelection: AgentPresetPostDeleteSelection,
): AgentPresetDeleteImpactChat[] | undefined {
  const characterIds = new Set<string>()
  const impacts: AgentPresetDeleteImpactChat[] = []

  for (const character of characters) {
    const characterId = nonBlankString(character.chaId)
    if (!characterId || characterIds.has(characterId) || !Array.isArray(character.chats)) return undefined
    characterIds.add(characterId)
    const chatIds = new Set<string>()

    for (const candidate of character.chats as ChatProjection[]) {
      if (!isRecord(candidate)) return undefined
      const chatId = nonBlankString(candidate.id)
      if (!chatId || chatIds.has(chatId)) return undefined
      chatIds.add(chatId)
      if (candidate.generationSettings !== undefined && !isRecord(candidate.generationSettings)) return undefined
      const generationSettings = candidate.generationSettings as Record<string, unknown> | undefined
      const selectedPresetId = generationSettings?.agentPresetId
      if (selectedPresetId !== undefined && typeof selectedPresetId !== 'string') return undefined
      if (selectedPresetId !== presetId) continue

      impacts.push({
        characterId,
        characterName: displayName(character.name, characterId),
        chatId,
        chatName: displayName(candidate.name, chatId),
        postDeleteSelection,
      })
    }
  }

  return impacts
}

function projectLoadouts(
  loadouts: readonly LoadoutProjection[],
  presetId: string,
): AgentPresetDeleteImpactLoadout[] | undefined {
  const ids = new Set<string>()
  const impacts: AgentPresetDeleteImpactLoadout[] = []

  for (const loadout of loadouts) {
    const loadoutId = nonBlankString(loadout.id)
    if (!loadoutId || ids.has(loadoutId)) return undefined
    ids.add(loadoutId)
    if (loadout.agentPresetId !== undefined && typeof loadout.agentPresetId !== 'string') return undefined
    if (loadout.agentPresetId !== presetId) continue
    impacts.push({
      loadoutId,
      loadoutName: displayName(loadout.name, loadoutId),
      postDeleteSelection: { source: 'none' },
    })
  }

  return impacts
}

function uniqueNamedRows<T extends PresetProjection>(
  rows: readonly T[],
  idKey: 'id',
): Array<T & { id: string; name: string }> | undefined {
  const ids = new Set<string>()
  const result: Array<T & { id: string; name: string }> = []
  for (const row of rows) {
    const id = nonBlankString(row[idKey])
    const name = nonBlankString(row.name)
    if (!id || !name || ids.has(id)) return undefined
    ids.add(id)
    result.push({ ...row, id, name })
  }
  return result
}

function selectionForPreset(preset?: { id: string; name: string }): AgentPresetPostDeleteSelection {
  return preset ? { source: 'globalDefault', presetId: preset.id, presetName: preset.name } : { source: 'none' }
}

function unavailable(
  owner: AgentPresetDeleteImpactOwner,
  reason: AgentPresetDeleteImpactUnavailableReason,
): AgentPresetDeleteImpactUnavailable {
  return { status: 'unavailable', owner, reason }
}

function displayName(value: unknown, fallback: string): string {
  return nonBlankString(value) ?? fallback
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
