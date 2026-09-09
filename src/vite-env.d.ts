/// <reference types="svelte" />
/// <reference types="vite/client" />

declare var Buffer: BufferConstructor
declare var safeStructuredClone: <T>(data: T) => T
declare var userScriptFetch: (url: string, arg: RequestInit) => Promise<Response>

interface ImportMetaEnv {
  readonly VITE_RISU_BUILD_ID?: string
  readonly VITE_FASTIFY_BROWSER_SMOKE?: string
  readonly VITE_RISU_AGENT_DEV_IGNORE_REALM_TERMS?: string
}
