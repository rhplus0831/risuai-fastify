import { getModules } from 'src/ts/process/modules'
import { sharedChatReadOwners } from './sharedChatReadOwners.svelte'
import { get } from 'svelte/store'
import { moduleRenderRevision } from 'src/ts/moduleRenderRevision'
import type { ChatReadOwners } from './chatReadOwners.svelte'

export function createChatBodyModuleReads(owners: ChatReadOwners) {
  const modules = $derived.by(() => {
    get(moduleRenderRevision)
    return getModules({ character: owners.character(), chat: owners.chat() })
  })
  return () => modules
}

export const readChatBodyModules = createChatBodyModuleReads(sharedChatReadOwners)
