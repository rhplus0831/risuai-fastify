import type { ScriptModelOverrides } from '@risuai/shared-core/script-model-overrides'
import type { ServerTriggerScript as triggerscript } from './triggerDescriptors.js'

export interface customscript {
  id?: string
  comment?: string
  in: string
  out: string
  type: string
  flag?: string
  ableFlag?: boolean
}

export interface loreBook {
  key: string
  secondkey: string
  insertorder: number
  comment: string
  content: string
  mode: string
  alwaysActive: boolean
  selective: boolean
  extentions?: {
    risu_case_sensitive: boolean
    risu_agent_only?: boolean
  }
  /** Excludes this entry from normal prompt activation and reserves it for Agent input resolution. */
  agentOnly?: boolean
  activationPercent?: number | string | null
  loreCache?: {
    key: string
    data: readonly string[]
  } | null
  useRegex?: boolean
  bookVersion?: number
  id?: string
  folder?: string
}

export interface MCPModule {
  url: string
}

export interface RisuModule {
  name: string
  description: string
  lorebook?: loreBook[]
  regex?: customscript[]
  cjs?: string
  trigger?: triggerscript[]
  id: string
  lowLevelAccess?: boolean
  /** Local-only model-profile selections for module-owned script LLM calls. */
  scriptModelOverrides?: ScriptModelOverrides
  hideIcon?: boolean
  backgroundEmbedding?: string
  assets?: [string, string, string][]
  namespace?: string
  customModuleToggle?: string
  mcp?: MCPModule
  folderId?: string
}

/** Fastify-owned aliases for the exact persisted module descriptor mirror. */
export type ServerModuleRegexScript = customscript
export type ServerModuleLorebook = loreBook
export type ServerModule = RisuModule
