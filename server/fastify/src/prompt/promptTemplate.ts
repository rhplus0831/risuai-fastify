/** Fastify-owned prompt-template card contract used during server assembly. */
export type PromptTemplateCard =
  | PromptItemPlain
  | PromptItemTyped
  | PromptItemChat
  | PromptItemAuthorNote
  | PromptItemChatML
  | PromptItemCache

/** Compatibility name retained for the existing prompt assembly helpers. */
export type PromptItem = PromptTemplateCard

export type PromptRole = 'user' | 'bot' | 'system'

export interface PromptItemPlain {
  id?: string
  type: 'plain' | 'jailbreak' | 'cot'
  type2?: 'normal' | 'globalNote' | 'main'
  text: string
  role: PromptRole
  name?: string
}

export interface PromptItemChatML {
  id?: string
  type: 'chatML'
  text: string
  name?: string
}

export interface PromptItemTyped {
  id?: string
  type: 'persona' | 'description' | 'lorebook' | 'postEverything' | 'memory'
  innerFormat?: string | null
  role2?: string | null
  name?: string
}

export interface PromptItemAuthorNote {
  id?: string
  type: 'authornote'
  innerFormat?: string | null
  defaultText?: string
  role2?: string | null
  name?: string
}

export interface PromptItemChat {
  id?: string
  type: 'chat'
  rangeStart: number
  rangeEnd: number | 'end'
  chatAsOriginalOnSystem?: boolean
  name?: string
}

export interface PromptItemCache {
  id?: string
  type: 'cache'
  name: string
  depth?: number
  role: 'user' | 'assistant' | 'system' | 'all'
}
