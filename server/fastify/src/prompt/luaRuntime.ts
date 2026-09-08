import Ajv from 'ajv'
import { PromptChatRowSchema } from '@risuai/protocol/generation-sse'
import { LuaFactory, type LuaEngine } from 'wasmoon'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as Database,
  FastifyLoreBook as loreBook,
  FastifyMessage as Message,
} from './serverTypes.js'
import type { PromptMessage } from './promptMessage.js'
import type { ServerTriggerScript as triggerscript } from './triggerDescriptors.js'
import type { ModelRole } from '@risuai/shared-core/model-roles'
import {
  resolveModelProfile,
  resolveModelProfileByProfileId,
  resolveModelProfileWithLegacyCompatibility,
  type ResolvedModelProfile,
} from '@risuai/shared-core/model-profile-resolver'
import { normalizeModelRoleProfiles } from '@risuai/shared-core/model-profile-records'
import { scriptModelOverrideProfileId } from '@risuai/shared-core/script-model-overrides'
import type { TriggerVarEngine } from './triggerVars.js'
import { expandVariables } from './variables.js'
import { tokenize } from './tokens.js'
import { ensureTokenizerLoadedForDb, tokenizerEncodingFromDb } from './tokenizerConfig.js'
import { dispatchChatProvider } from './chatDispatch.js'
import { getActiveModules, getModuleLorebooks } from './modules.js'
import { activateLorebookAsync } from './lorebook.js'
import { embedTextGroups, embedTexts } from '../memoryEmbeddingAdapter.js'
import { resolveMemoryEmbeddingModel } from '../memoryEmbeddingModel.js'
import { armMemoryProviderFetchDeadline, resolveMemoryProviderFetchDeadlineMs } from '../memoryProviderDeadline.js'
import { selectedPersonaIndexFromStableId } from '@risuai/shared-core/persona-selection-identity'
import {
  executeImageGeneration,
  parseImageGenerationRequest,
  type GeneratedImage,
  type ImageGenerationExecutionOptions,
} from '../imageGeneration.js'
import { persistServerInlayAsset } from '../inlayAssetPersistence.js'
import type { ImageGenerationRequest } from '@risuai/protocol/image-generation-operation'
import type { CompletionStreamFrame } from '../generation/frames.js'
import { emitProtocolMetric, protocolMetricsEnabled } from '../protocolMetrics.js'
import {
  attachTriggerSource,
  getTriggerSource,
  triggerTypeAttribution,
  triggerSourceMetricFields,
  withTriggerEffectSource,
  type TriggerSourceAttribution,
} from './triggerSource.js'
import {
  summarizeLuaTraceMessage,
  summarizeLuaTraceValue,
  type PostGenerationLuaTraceCollector,
  type ServerLuaRuntimeTraceSink,
} from './luaPostGenerationTrace.js'
import type { PostGenerationLuaProgressTracker, ServerLuaRuntimeProgressSink } from './luaPostGenerationProgress.js'
import { beginLuaDiagnostics, type LuaDiagnosticsRun } from './scriptDiagnostics.js'

/**
 * The Lua runtime only needs the narrow character shape used by edit-trigger
 * ownership. Keep this structural type local so Fastify does not depend on the
 * browser markdown parser module for a type-only declaration.
 */
type SimpleCharacterArgument = {
  type: 'simple'
  chaId: string
  triggerscript?: triggerscript[]
}

/**
 * Server-side Lua runtime under the single-user self-host security model.
 *
 * Ports `src/ts/process/scriptings.ts` (`runScripted` + `runLuaEditTrigger`) to the
 * Fastify server while keeping per-call engine state isolated.
 *
 * Runtime notes:
 *
 * 1. **Exec limit:** wasmoon's built-in `lua_sethook` count hook.
 *    wasmoon 1.16.0 installs an instruction-count hook (every 1000 ops) that throws
 *    when wall-clock passes a deadline, exposed two ways: `createEngine({
 *    functionTimeout })` bounds every JS→Lua call (the dispatch: `callListenMain`,
 *    `onStart`, …) and `thread.run(argCount, { timeout })` bounds a loaded chunk. We
 *    use BOTH — `functionTimeout` for dispatch and {@link runStringWithTimeout} for
 *    the top-level user code — so a top-level `while true do end` is bounded too. No
 *    `worker_threads` fallback is needed. The timeout surfaces as a
 *    generic `Error` whose message contains "timeout" (the `LuaTimeoutError` class is
 *    lost across the Lua→JS error boundary), so we detect it by message.
 * 2. **`json.lua` is read from disk at boot**, path resolved relative to this module
 *    (`import.meta.url`) so it is deterministic under focused server Vitest regardless of
 *    cwd. Mounted once into a module-singleton {@link LuaFactory}.
 * 3. **Per-call engine isolation, pre-warmed.** The factory (wasm +
 *    mounted json.lua) is a singleton; each {@link runServerLua} call still gets an
 *    engine of its own and closes it in `finally`, so one chat's Lua globals never
 *    leak into another. To keep the per-send hot path from paying the engine boot +
 *    prelude compile every run, a small pool holds engines that are pre-booted with
 *    the host-fn surface declared (bound lazily via {@link declareHostFunctions}'s
 *    state binder) and the static prelude already executed. Pool engines have never
 *    run user code and are discarded after exactly one call — isolation is preserved
 *    by construction. The prelude and the user code now load as two chunks (the
 *    browser compiles them as one); the only observable deltas are error-message
 *    chunk names/line offsets and that user top-level code can no longer see the
 *    wrapper's internal locals (`editRequestFuncs` etc.), which scripts reach through
 *    `listenEdit` anyway. Access-control sets (`safeIds`/`lowLevelIds`/
 *    `editDisplayIds`) remain per-call closures rather than the browser's
 *    module-level sets.
 * 4. **Aggregate exec budget.** Callers may hand every run of one
 *    request the same {@link LuaExecBudget}; each run's wall clock is charged
 *    against it, a constrained run gets `min(execTimeoutMs, remaining)`, and an
 *    exhausted budget short-circuits before any engine boots — so a card stacking
 *    many runaway hooks is bounded by ~`totalMs` (+ at most one per-run limit for
 *    a dispatch already in flight), not `hooks × execTimeoutMs`.
 * 5. **`PromptMessage` round-trip** is byte-faithful for the text-send subset (proven by
 *    the editRequest unit test).
 */

// ── Limits (the self-host bar) ──────────────────────────────────────────────

/** Default per-run Lua execution deadline. Bounds runaway scripts. */
const DEFAULT_EXEC_TIMEOUT_MS = 3000
/** Max URL length accepted by `request()` (mirrors `scriptings.ts`). */
const MAX_URL_LENGTH = 120
/** `request()` calls allowed per rolling window. The browser allowed ~5-6/min
 * (`scriptings.ts`); the operator loosened this to 30/min for self-host. */
const MAX_REQUESTS_PER_WINDOW = 30
const REQUEST_WINDOW_MS = 60_000
/** Egress fetch wall-clock + response-size caps (the browser fetch has neither). */
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 2_000_000
/** `sleep()` caps: per-call and per-run (the browser caps neither). */
const MAX_SLEEP_MS = 2000
const MAX_TOTAL_SLEEP_MS = 6000
const SERVER_UNSUPPORTED_LUA_API_ERROR = 'Lua API is unsupported on the server'
const LUA_IMAGE_GENERATION_FAILURE = 'Error: Image generation failed'

/**
 * Default aggregate Lua wall-clock budget per request. Shared by
 * every hook phase (input/output triggers, editinput/editRequest/editoutput)
 * of one assembly+post-generation pass, so a card stacking many runaway
 * `triggerlua` hooks cannot stall the send for `hooks × per-run-limit`.
 * Generous: 10× the per-run default.
 */
export const DEFAULT_LUA_AGGREGATE_BUDGET_MS = 30_000

/**
 * Mutable aggregate budget threaded through {@link ServerLuaRuntimeContext}.
 * `usedMs` accumulates each run's wall clock (engine acquire + load +
 * dispatch, including host-fn waits).
 */
export interface LuaExecBudget {
  totalMs: number
  usedMs: number
}

export function createLuaExecBudget(totalMs: number = DEFAULT_LUA_AGGREGATE_BUDGET_MS): LuaExecBudget {
  return { totalMs, usedMs: 0 }
}

// Banned egress targets carried over from the browser (`scriptings.ts`).
const BANNED_URL_PREFIXES = ['https://realm.risuai.net', 'https://risuai.net', 'https://risuai.xyz']

// json.lua + factory singleton.

let luaFactoryPromise: Promise<LuaFactory> | null = null

/**
 * Resolve `public/lua/json.lua` from this module's location so the path holds
 * under any cwd (server Vitest runs with `root: server/fastify`). This file is
 * at `server/fastify/src/prompt/`, so the repo root is four levels up.
 */
function resolveJsonLuaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../../../public/lua/json.lua')
}

/** Build (once) a `LuaFactory` with `json.lua` mounted, mirroring the browser's
 * `makeLuaFactory` (`scriptings.ts`) but reading from disk. */
async function getLuaFactory(): Promise<LuaFactory> {
  if (!luaFactoryPromise) {
    luaFactoryPromise = (async () => {
      const factory = new LuaFactory()
      const json = await readFile(resolveJsonLuaPath(), 'utf8')
      await factory.mountFile('json.lua', json)
      return factory
    })().catch((error) => {
      // Reset so a transient FS error can be retried on the next call.
      luaFactoryPromise = null
      throw error
    })
  }
  return luaFactoryPromise
}

// ── request() egress guard (the SSRF gate) ──────────────────────────────────

/**
 * Dependency seams for the egress guard. Production uses Node's DNS + a pinned
 * `https.request`; tests inject `lookup`/`fetchImpl`/`now` so the guard is proven
 * deterministically with no real network.
 */
export interface EgressDeps {
  /** Resolve a hostname to all of its addresses. Defaults to `dns.lookup(host, {all:true})`. */
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>
  /** Perform the actual fetch against a pre-validated address set. Defaults to a
   * pinned `https.request`. Receives the originating request's abort signal so an
   * in-flight egress fetch dies with the request that spawned it. */
  fetchImpl?: (url: string, addresses: string[], signal?: AbortSignal) => Promise<{ status: number; data: string }>
  /** Clock seam for the rate limiter. Defaults to `Date.now`. */
  now?: () => number
}

/** Rolling-window rate state. A module singleton by default (single-user host →
 * one global budget), injectable per-call for tests. */
export interface RequestRateState {
  count: number
  resetAt: number
}

const sharedRateState: RequestRateState = { count: 0, resetAt: 0 }

export type EgressVerdict = { ok: true; addresses: string[] } | { ok: false; status: number; data: string }

/**
 * True for any address the server must not connect to: loopback, link-local
 * (incl. the cloud metadata IP `169.254.169.254`), private, CGNAT, unspecified,
 * multicast/reserved, IPv6 ULA/link-local. IPv4-mapped IPv6 is unwrapped first.
 * Unparseable input is blocked (deny-by-default).
 */
export function isBlockedAddress(addr: string): boolean {
  if (typeof addr !== 'string') return true
  let ip = addr.trim().toLowerCase()
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone) // strip IPv6 zone id (fe80::1%eth0)
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip)
  if (mapped) ip = mapped[1]
  const family = isIP(ip)
  if (family === 4) return isBlockedV4(ip)
  if (family === 6) return isBlockedV6(ip)
  return true
}

function isBlockedV4(ip: string): boolean {
  const octets = ip.split('.').map((n) => Number(n))
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = octets
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10/8 private
  if (a === 127) return true // 127/8 loopback
  if (a === 169 && b === 254) return true // 169.254/16 link-local (+ metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 private
  if (a === 192 && b === 168) return true // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 192 && b === 0 && octets[2] === 0) return true // 192.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 benchmarking
  if (a >= 224) return true // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return false
}

function isBlockedV6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return true // unspecified / loopback
  // fe80::/10 link-local spans fe80..febf.
  if (/^fe[89ab]/.test(ip)) return true
  // fc00::/7 unique-local (includes fd00::/8).
  if (/^f[cd]/.test(ip)) return true
  // Transition addresses embed an IPv4 target the connection ultimately
  // reaches; classify that embedded address too. Covers
  // IPv4-mapped in hex form (`::ffff:7f00:1`), IPv4-compatible (`::7f00:1`),
  // 6to4 (`2002:7f00:1::`), and NAT64 (`64:ff9b::7f00:1`).
  const embedded = embeddedV4InV6(ip)
  if (embedded !== null) return isBlockedV4(embedded)
  return false
}

/** Expand a valid IPv6 literal (lowercase, no zone) into its 8 16-bit groups.
 *  Returns null on anything that does not parse (callers treat that as "no
 *  embedded address"; `isBlockedAddress` already denies unparseable input). */
function parseV6Groups(ip: string): number[] | null {
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) return []
    const groups: number[] = []
    const parts = side.split(':')
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.includes('.')) {
        // Dotted-quad tail (`::ffff:127.0.0.1`) occupies the last two groups.
        if (i !== parts.length - 1) return null
        const octets = part.split('.').map((n) => Number(n))
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null
        }
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      groups.push(Number.parseInt(part, 16))
    }
    return groups
  }
  const head = parseSide(halves[0])
  const tail = halves.length === 2 ? parseSide(halves[1]) : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...(Array(fill).fill(0) as number[]), ...tail]
}

/** The IPv4 address embedded in an IPv6 transition form, or null. */
function embeddedV4InV6(ip: string): string | null {
  const groups = parseV6Groups(ip)
  if (!groups) return null
  const v4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  const allZero = (from: number, to: number): boolean => groups.slice(from, to).every((group) => group === 0)
  // IPv4-mapped ::ffff:0:0/96 (hex form; the dotted form is unwrapped by
  // `isBlockedAddress`) and IPv4-compatible ::/96.
  if (allZero(0, 5) && (groups[5] === 0xffff || groups[5] === 0)) {
    return v4(groups[6], groups[7])
  }
  // 6to4 2002::/16 carries the IPv4 address in bits 16-48.
  if (groups[0] === 0x2002) return v4(groups[1], groups[2])
  // NAT64 well-known prefix 64:ff9b::/96.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && allZero(2, 6)) {
    return v4(groups[6], groups[7])
  }
  return null
}

/**
 * Validate a `request()` URL before any socket opens: length, https-only, the
 * banned-host list, `localhost` by name, and — the SSRF guard the browser lacks —
 * DNS resolution with every resolved address classified against
 * {@link isBlockedAddress}. Returns the validated address set so the caller can
 * pin the connection to it (no DNS-rebinding window).
 */
export async function validateEgressUrl(url: string, deps: EgressDeps = {}): Promise<EgressVerdict> {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) {
    return { ok: false, status: 413, data: 'URL to large. max is 120 characters' }
  }
  if (!url.startsWith('https://')) {
    return { ok: false, status: 400, data: 'Only https requests are allowed' }
  }
  for (const banned of BANNED_URL_PREFIXES) {
    if (url.startsWith(banned)) {
      return { ok: false, status: 400, data: 'request to ' + url + ' is not allowed' }
    }
  }

  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return { ok: false, status: 400, data: 'Invalid URL' }
  }
  const host = hostname.replace(/^\[|\]$/g, '') // strip IPv6 literal brackets
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return { ok: false, status: 403, data: 'Requests to localhost are not allowed' }
  }

  // A literal IP needs no DNS — classify it directly.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      return {
        ok: false,
        status: 403,
        data: 'Requests to private or reserved addresses are not allowed',
      }
    }
    return { ok: true, addresses: [host] }
  }

  let resolved: Array<{ address: string; family: number }>
  try {
    resolved = deps.lookup ? await deps.lookup(host) : await dnsLookup(host, { all: true })
  } catch {
    return { ok: false, status: 400, data: 'DNS resolution failed' }
  }
  if (!resolved || resolved.length === 0) {
    return { ok: false, status: 400, data: 'DNS resolution failed' }
  }
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) {
      return {
        ok: false,
        status: 403,
        data: 'Requests to private or reserved addresses are not allowed',
      }
    }
  }
  return { ok: true, addresses: resolved.map((entry) => entry.address) }
}

/** Default egress fetch: an https GET whose DNS lookup is pinned to a
 * pre-validated address (so the socket cannot be rebound to a private IP between
 * validation and connect), with wall-clock and response-size caps. SNI/cert
 * validation still use the URL hostname. */
function pinnedHttpsFetch(
  url: string,
  addresses: string[],
  signal?: AbortSignal,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('request aborted'))
      return
    }
    const pinned = addresses[0]
    const pinnedLookup = (
      _hostname: string,
      options: unknown,
      callback?: (err: Error | null, address: string, family: number) => void,
    ) => {
      const cb = (typeof options === 'function' ? options : callback) as (
        err: Error | null,
        address: string,
        family: number,
      ) => void
      cb(null, pinned, isIP(pinned))
    }
    const req = httpsRequest(
      url,
      { method: 'GET', timeout: REQUEST_TIMEOUT_MS, lookup: pinnedLookup as never },
      (res) => {
        let body = ''
        let size = 0
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          size += Buffer.byteLength(chunk, 'utf8')
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('response too large'))
            return
          }
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: body }))
      },
    )
    // Abort propagation: when the originating request ends, the
    // in-flight egress socket is torn down instead of waiting out
    // REQUEST_TIMEOUT_MS. `destroy(err)` fires the 'error' handler → reject.
    const onAbort = (): void => {
      req.destroy(new Error('request aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => signal?.removeEventListener('abort', onAbort))
    req.on('timeout', () => req.destroy(new Error('request timeout')))
    req.on('error', (error) => reject(error))
    req.end()
  })
}

/**
 * The `request()` host-fn body: rate-limit → validate (SSRF guard) → pinned fetch.
 * Returns the same `{status, data}` JSON-string shape the browser returns
 * (`scriptings.ts`) so Lua callers are unchanged.
 */
export async function serverLuaRequest(
  url: string,
  deps: EgressDeps = {},
  rateState: RequestRateState = sharedRateState,
  signal?: AbortSignal,
  onBlocked?: () => void,
): Promise<string> {
  const now = deps.now ? deps.now() : Date.now()
  if (rateState.resetAt + REQUEST_WINDOW_MS < now) {
    rateState.count = 0
    rateState.resetAt = now
  }
  if (rateState.count >= MAX_REQUESTS_PER_WINDOW) {
    onBlocked?.()
    return JSON.stringify({
      status: 429,
      data: 'Too many requests. you can request 30 times per minute',
    })
  }

  const verdict = await validateEgressUrl(url, deps)
  if (!verdict.ok) {
    onBlocked?.()
    // Narrow explicitly: this file is also type-checked under the root tsconfig
    // (the browser suite imports the server app), whose `strictNullChecks: false`
    // does not narrow `!verdict.ok` on a discriminated union; the server's strict
    // config narrows it fine. The Extract keeps both paths valid.
    const failure = verdict as Extract<EgressVerdict, { ok: false }>
    return JSON.stringify({ status: failure.status, data: failure.data })
  }
  // An abort during DNS validation must not consume the egress budget or open
  // a socket: throw so the in-flight `:await()` terminates the run.
  if (signal?.aborted) throw new LuaAbortError('request aborted')
  // Count only validated requests: a blocked URL must not consume
  // the egress budget, or a single misbehaving script could starve legit calls.
  rateState.count++
  try {
    const fetchImpl = deps.fetchImpl ?? pinnedHttpsFetch
    const result = await fetchImpl(url, verdict.addresses, signal)
    if (Buffer.byteLength(result.data, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('response too large')
    }
    return JSON.stringify({ status: result.status, data: result.data })
  } catch (error) {
    // Abort is a cancellation, not a fetch failure: rethrow so the
    // Lua `:await()` raises and the surrounding pcall unwinds, instead of the
    // script continuing on a synthetic 400.
    if (signal?.aborted) throw new LuaAbortError('request aborted')
    if (error instanceof LuaAbortError) throw error
    return JSON.stringify({ status: 400, data: 'internal error' })
  }
}

// ── The Lua prelude (ported verbatim from `scriptings.ts`) ──────────────

/**
 * The browser's `luaCodeWrapper` body (`scriptings.ts`), copied
 * byte-for-byte minus the trailing `${code}` interpolation. It is pure Lua —
 * `require 'json'`, the `getChat`/`LLM`/`log` JSON wrappers, `listenEdit`,
 * `getState`/`setState`, `async`, and `callListenMain` — and is the contract
 * the edit-hook dispatch depends on, so it must stay identical for
 * `callListenMain` to round-trip. It is static, so prepared engines run it
 * once at warm-up and the user code loads as its own chunk; the
 * wrapper's top-level statements define globals/closures only and call no
 * host functions, which is what makes the pre-run safe.
 */
const LUA_PRELUDE = `
json = require 'json'

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function getRecentChats(id, count)
    return json.decode(getRecentChatsMain(id, count))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end


function loadLoreBooks(id)
    return json.decode(loadLoreBooksMain(id):await())
end

function LLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function axLLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function getCharacterImage(id)
    return getCharacterImageMain(id):await()
end

function getPersonaImage(id)
    return getPersonaImageMain(id):await()
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then
        editRequestFuncs[#editRequestFuncs + 1] = func
        return
    end

    if type == 'editDisplay' then
        editDisplayFuncs[#editDisplayFuncs + 1] = func
        return
    end

    if type == 'editInput' then
        editInputFuncs[#editInputFuncs + 1] = func
        return
    end

    if type == 'editOutput' then
        editOutputFuncs[#editOutputFuncs + 1] = func
        return
    end

    throw('Invalid type')
end

function getState(id, name)
    local escapedName = "__"..name
    return json.decode(getChatVar(id, escapedName))
end

function setState(id, name, value)
    local escapedName = "__"..name
    setChatVar(id, escapedName, json.encode(value))
end

function setStateChanged(id, name, value)
    local escapedName = "__"..name
    return setChatVarChanged(id, escapedName, json.encode(value))
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)

        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end

                safe, result = coroutine.resume(co)
                checkresult()
            end

            checkresult = function()
                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end

            checkresult()
        end)
    end
end

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)

    if type == 'editRequest' then
        for _, func in ipairs(editRequestFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editDisplay' then
        for _, func in ipairs(editDisplayFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editInput' then
        for _, func in ipairs(editInputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editOutput' then
        for _, func in ipairs(editOutputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    return json.encode(realValue)
end)
`

// ── Runtime context + state ─────────────────────────────────────────────────

/**
 * Everything the server must hand the VM in place of the browser's global stores
 * (`getCurrentChat`/`getCurrentCharacter`/`getDatabase`/`selectedCharID`).
 */
export interface ServerLuaRuntimeContext {
  /** Working chat whose `message[]` the chat host fns read and mutate. */
  chat: Chat
  /** Active database snapshot — `getGlobalVar` reads, `cbs` scope. */
  database: Database
  /** Index into `database.characters` (cbs scope + char fallbacks). */
  selectedCharID: number
  /** Index into the character's `chats` (cbs scope). */
  chatPage: number
  /**
   * The chat-var engine `getChatVar`/`setChatVar` (and thus `getState`/`setState`)
   * bind to. Pass the SAME `createTriggerVarEngine` the assembler mutates so Lua's
   * writes land in the scriptstate delta for free (README §Integration).
   */
  varEngine: TriggerVarEngine
  /** Working character (cbs `chara`, `getName`/`getDescription`, setters). */
  char?: character | SimpleCharacterArgument
  /** Active model id, for `getTokens` encoding selection. */
  model?: string
  /** Egress dependency overrides (tests inject fake DNS/fetch/clock). */
  egress?: EgressDeps
  /** Shared `request()` rate-limit state; defaults to the module singleton. */
  rateState?: RequestRateState
  /**
   * Originating-request abort signal. When it fires, in-flight
   * hook work is cancelled: the load thread's deadline is pulled to "now"
   * (cooperating with the exec-limit hook), every host-fn call throws, and
   * `sleep` wakes early. Pure-compute stretches between host calls remain
   * bounded by the exec limit.
   */
  signal?: AbortSignal
  /**
   * Aggregate exec budget shared by every Lua run of one request.
   * Each run charges its wall clock; a constrained run gets
   * `min(execTimeoutMs, remaining)` and an exhausted budget short-circuits
   * before any engine boots.
   */
  execBudget?: LuaExecBudget
  /** SQLite handle for durable LLM diagnostics and generated-inlay metadata. */
  requestHistoryDb?: DatabaseSync
  /** Server asset root used to persist Lua-generated inlays. */
  assetDataDir?: string
  /** Test/alternate adapter seam; production uses the shared embedding adapters. */
  luaSimilarity?: {
    embed?: typeof embedTexts
    embedGroups?: typeof embedTextGroups
    deadlineMs?: number
  }
  /** Test/alternate image execution/persistence seams. */
  luaImageGeneration?: {
    execute?: (
      request: ImageGenerationRequest,
      settings: Record<string, unknown>,
      options?: ImageGenerationExecutionOptions,
    ) => Promise<GeneratedImage>
    persist?: (image: GeneratedImage) => Promise<string> | string
  }
}

interface RuntimeState {
  ctx: ServerLuaRuntimeContext
  source?: TriggerSourceAttribution
  safeIds: Set<string>
  lowLevelIds: Set<string>
  editDisplayIds: Set<string>
  traceSink?: ServerLuaRuntimeTraceSink
  progressSink?: ServerLuaRuntimeProgressSink
  diagnostics?: LuaDiagnosticsRun
  stopSending: boolean
  /** Set true the moment an interactive host fn (`alert*Input/Select/Confirm`) is
   * invoked — surfaced so the caller can route the send `unsupported`. */
  interactiveInvoked: boolean
  sleptMs: number
}

export interface RunServerLuaOptions {
  code: string
  mode: string
  data?: string | PromptMessage[]
  meta?: object
  /** Grants the low-level host fns (`request`/`LLM`/`similarity`/…). Edit hooks run
   * with this `false` (browser parity, `scriptings.ts`). */
  lowLevelAccess?: boolean
  /** Per-run execution deadline (ms). Defaults to {@link DEFAULT_EXEC_TIMEOUT_MS}. */
  execTimeoutMs?: number
  /** Hidden trigger/effect owner metadata for diagnostics. */
  source?: TriggerSourceAttribution
  /** Optional post-generation trace sink for host API calls made during this run. */
  traceSink?: ServerLuaRuntimeTraceSink
  /** Optional live progress sink for post-generation Lua host API calls. */
  progressSink?: ServerLuaRuntimeProgressSink
}

export interface ServerLuaResult {
  /** A handler returned `false` or called `stopChat` — the send should stop. */
  stopSending: boolean
  /** The dispatch result (parsed object for edit modes; raw otherwise). */
  res: unknown
  /** The exec limit interrupted the script. */
  timedOut: boolean
  /** An interactive host fn was invoked (no server equivalent → `unsupported`). */
  interactiveInvoked: boolean
  /** Whether the requested mode had a callable Lua entrypoint after loading user code. */
  handlerRegistered?: boolean
  /** The originating request's abort signal fired during the run. */
  aborted?: boolean
  /** Captured load/dispatch error message, if any (the browser swallows these). */
  error?: string
  /** Metadata-only runtime fields safe for protocol metrics and fallback errors. */
  runtimeMetricFields?: LuaRuntimeMetricFields
  /** Trigger/effect owner metadata, when this run came from a trigger. */
  source?: TriggerSourceAttribution
}

export interface LuaRuntimeMetricFields {
  mode: string
  codeSha256: string
  codeBytes: number
  lowLevelAccess: boolean
  durationMs: number
  execTimeoutMs: number
  effectiveTimeoutMs: number
  timedOut: boolean
  interactiveInvoked: boolean
  handlerRegistered: boolean
  resultShape: string
  aborted: boolean
  errorKind?: string
  budgetTotalMs?: number
  budgetUsedMsBefore?: number
  budgetUsedMsAfter?: number
  budgetRemainingMsBefore?: number
  budgetRemainingMsAfter?: number
}

export class ServerLuaFailureError extends Error {
  readonly result: ServerLuaResult
  readonly runtimeMetricFields?: LuaRuntimeMetricFields
  readonly source?: TriggerSourceAttribution

  constructor(message: string, result: ServerLuaResult) {
    super(message)
    this.name = 'ServerLuaFailureError'
    this.result = result
    this.runtimeMetricFields = result.runtimeMetricFields
    this.source = result.source
  }
}

export function serverLuaFailureMessage(result: ServerLuaResult, context: string): string | null {
  if (result.aborted) return null
  if (result.error && result.error.length > 0) return `${context}: ${result.error}`
  if (result.timedOut) return `${context}: Lua execution timed out`
  if (result.interactiveInvoked) {
    return `${context}: interactive Lua APIs are not supported by server prompt assembly`
  }
  return null
}

export function throwServerLuaFailure(result: ServerLuaResult, context: string): void {
  const message = serverLuaFailureMessage(result, context)
  if (message) throw new ServerLuaFailureError(message, result)
}

function asCharacter(ctx: ServerLuaRuntimeContext): character | undefined {
  const char = ctx.char
  // Exclude edit-only owners before checking the nullable legacy character tag.
  // This narrowing also holds for browser test consumers without strictNullChecks.
  if (!char || char.type === 'simple') return undefined
  const { type, chaId } = char
  if (type === 'character') return char
  if ((type === undefined || type === null) && typeof chaId === 'string') {
    return char
  }
  return undefined
}

function selectedPersonaProfileField(database: Database, field: 'name' | 'personaPrompt'): string | undefined {
  const personas = Array.isArray(database.personas) ? database.personas : []
  const persona = personas[selectedPersonaIndexFromStableId(database)]
  if (!persona || typeof persona.id !== 'string') return undefined
  const value = persona[field]
  return typeof value === 'string' ? value : ''
}

/** Sleep that wakes early when `signal` fires, so an aborted request never
 *  waits out the remaining `sleep()` budget (the very next host-fn call then
 *  throws {@link LuaAbortError}). */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timeout/i.test(message)
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function roundDurationMs(ms: number): number {
  return Math.round(ms * 100) / 100
}

function classifyLuaRuntimeError(result: ServerLuaResult): string | undefined {
  if (result.aborted === true) return 'request_aborted'
  if (result.interactiveInvoked) return 'interactive_api'
  if (result.timedOut) {
    if (result.error === 'aggregate Lua execution budget exhausted') return 'aggregate_budget_exhausted'
    return 'timeout'
  }
  if (result.error) return 'lua_error'
  return undefined
}

function classifyLuaRuntimeResultShape(result: ServerLuaResult): string {
  if (result.error || result.timedOut || result.interactiveInvoked || result.aborted === true) return 'error'
  if (result.res === undefined) return 'undefined'
  if (result.res === null) return 'null'
  if (Array.isArray(result.res)) return 'array'
  return typeof result.res
}

function buildLuaRuntimeMetricFields(input: {
  opts: RunServerLuaOptions
  lowLevelAccess: boolean
  execTimeoutMs: number
  effectiveTimeoutMs: number
  durationMs: number
  result: ServerLuaResult
  budget?: LuaExecBudget
  budgetUsedMsBefore?: number
}): LuaRuntimeMetricFields {
  const budgetUsedMsAfter = input.budget?.usedMs
  const budgetRemainingMsBefore =
    input.budget && input.budgetUsedMsBefore !== undefined
      ? Math.max(0, input.budget.totalMs - input.budgetUsedMsBefore)
      : undefined
  const budgetRemainingMsAfter =
    input.budget && budgetUsedMsAfter !== undefined ? Math.max(0, input.budget.totalMs - budgetUsedMsAfter) : undefined
  const errorKind = classifyLuaRuntimeError(input.result)
  return {
    mode: input.opts.mode,
    codeSha256: sha256Hex(input.opts.code),
    codeBytes: Buffer.byteLength(input.opts.code, 'utf8'),
    lowLevelAccess: input.lowLevelAccess,
    durationMs: roundDurationMs(input.durationMs),
    execTimeoutMs: input.execTimeoutMs,
    effectiveTimeoutMs: input.effectiveTimeoutMs,
    timedOut: input.result.timedOut,
    interactiveInvoked: input.result.interactiveInvoked,
    handlerRegistered: input.result.handlerRegistered === true,
    resultShape: classifyLuaRuntimeResultShape(input.result),
    aborted: input.result.aborted === true,
    ...(errorKind ? { errorKind } : {}),
    ...(input.budget
      ? {
          budgetTotalMs: input.budget.totalMs,
          budgetUsedMsBefore: input.budgetUsedMsBefore ?? input.budget.usedMs,
          budgetUsedMsAfter: budgetUsedMsAfter ?? input.budget.usedMs,
          budgetRemainingMsBefore,
          budgetRemainingMsAfter,
        }
      : {}),
  }
}

function shouldEmitLuaRuntimeMetric(result: ServerLuaResult): boolean {
  return (
    protocolMetricsEnabled() ||
    !!result.error ||
    result.timedOut ||
    result.interactiveInvoked ||
    result.aborted === true
  )
}

function finalizeLuaRuntimeResult(
  opts: RunServerLuaOptions,
  result: ServerLuaResult,
  fields: LuaRuntimeMetricFields,
): ServerLuaResult {
  result.source = opts.source
  result.runtimeMetricFields = fields
  if (shouldEmitLuaRuntimeMetric(result)) {
    emitProtocolMetric('generation_lua_runtime', {
      ...fields,
      ...triggerSourceMetricFields(opts.source),
    })
  }
  return result
}

/** Error thrown by interactive host fns so the dispatch can tag the result. */
class InteractiveApiError extends Error {}

/** Error thrown by every host fn once the request signal has fired. */
class LuaAbortError extends Error {}

type LuaLlmResult = { success: true; result: string } | { success: false; result: string }

function luaLlmFailure(message: string): LuaLlmResult {
  return { success: false, result: message.startsWith('Error: ') ? message : `Error: ${message}` }
}

function normalizeLuaLlmRole(role: unknown): PromptMessage['role'] {
  if (role === 'system' || role === 'sys') return 'system'
  if (role === 'user') return 'user'
  return 'assistant'
}

function parseLuaLlmPrompt(promptStr: string, useMultimodal: boolean): PromptMessage[] | LuaLlmResult {
  if (useMultimodal) {
    throw new Error(`${SERVER_UNSUPPORTED_LUA_API_ERROR}: multimodal LLM`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(String(promptStr ?? '[]'))
  } catch (error) {
    return luaLlmFailure(error instanceof Error ? error.message : String(error))
  }

  if (!Array.isArray(parsed)) {
    return luaLlmFailure('Lua LLM prompt must be an array')
  }

  const rows: PromptMessage[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return luaLlmFailure('Lua LLM prompt entries must be objects')
    }
    const row = item as Record<string, unknown>
    if (row.content !== undefined && typeof row.content !== 'string') {
      return luaLlmFailure('Lua LLM prompt content must be text')
    }
    rows.push({
      role: normalizeLuaLlmRole(row.role),
      content: row.content ?? '',
    } as PromptMessage)
  }

  return rows
}

function parseLuaLlmOptions(optionsStr: string): { streaming?: boolean } {
  if (!optionsStr) return {}
  try {
    const parsed = JSON.parse(optionsStr) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function collectLuaLlmFrames(frames: AsyncIterable<CompletionStreamFrame>): Promise<LuaLlmResult> {
  let result = ''
  for await (const frame of frames) {
    if (frame.kind === 'token') {
      result += frame.content ?? ''
      continue
    }
    if (frame.kind === 'error') {
      return luaLlmFailure(frame.error ?? 'provider dispatch failed')
    }
  }
  return { success: true, result }
}

async function runLuaLlm(
  state: RuntimeState,
  role: ModelRole,
  prompt: PromptMessage[],
  options: { streaming?: boolean } = {},
): Promise<LuaLlmResult> {
  try {
    const profile = resolveLuaLlmProfile(state, role)
    const database: Database = {
      ...state.ctx.database,
      aiModel: profile.modelId,
      halfStreaming: false,
      useStreaming: options.streaming === true,
    }
    if (profile.runtimeOptions.maxResponse !== undefined) database.maxResponse = profile.runtimeOptions.maxResponse
    if (profile.runtimeOptions.rawTemperature !== undefined)
      database.temperature = profile.runtimeOptions.rawTemperature
    const frames = await dispatchChatProvider({
      database,
      formated: prompt,
      profile,
      signal: state.ctx.signal ?? new AbortController().signal,
      ...(state.ctx.requestHistoryDb
        ? {
            history: {
              db: state.ctx.requestHistoryDb,
              source: 'script',
              context: {
                ...(state.ctx.char && 'chaId' in state.ctx.char && typeof state.ctx.char.chaId === 'string'
                  ? { characterId: state.ctx.char.chaId }
                  : {}),
                ...(state.ctx.char && 'name' in state.ctx.char && typeof state.ctx.char.name === 'string'
                  ? { characterName: state.ctx.char.name }
                  : {}),
                ...(state.ctx.chat.id ? { chatId: state.ctx.chat.id } : {}),
                ...(state.ctx.chat.name ? { chatName: state.ctx.chat.name } : {}),
              },
              ...(state.ctx.chat.generationSettings?.sidebarToggles
                ? { toggles: { ...state.ctx.chat.generationSettings.sidebarToggles } }
                : {}),
              metadata: { modelRole: role },
            },
          }
        : {}),
    })
    return collectLuaLlmFrames(frames)
  } catch (error) {
    return luaLlmFailure(error instanceof Error ? error.message : String(error))
  }
}

function resolveLuaLlmProfile(state: RuntimeState, role: ModelRole): ResolvedModelProfile {
  const source = state.source
  const overrides =
    source?.ownerType === 'module'
      ? state.ctx.database.modules?.find((module) => module.id === source.ownerId)?.scriptModelOverrides
      : asCharacter(state.ctx)?.scriptModelOverrides
  const profileId =
    role === 'scriptMain' || role === 'scriptAux' ? scriptModelOverrideProfileId(overrides, role) : undefined
  if (!profileId) {
    const args = { database: state.ctx.database, role }
    return normalizeModelRoleProfiles(state.ctx.database.modelRoleProfiles)[role].mode === 'legacy'
      ? resolveModelProfileWithLegacyCompatibility(args)
      : resolveModelProfile(args)
  }

  const profile = resolveModelProfileByProfileId({
    database: state.ctx.database,
    role,
    profileId,
  })
  if (!profile) {
    const ownerLabel =
      source?.ownerType === 'module'
        ? `module ${source.ownerName ? `"${source.ownerName}"` : (source.ownerId ?? '')}`.trim()
        : `character ${state.ctx.char && 'name' in state.ctx.char ? `"${state.ctx.char.name}"` : ''}`.trim()
    throw new Error(`${ownerLabel} references missing script model profile "${profileId}"`)
  }
  return profile
}

async function runLuaLlmMain(
  state: RuntimeState,
  role: ModelRole,
  promptStr: string,
  useMultimodal: boolean = false,
  optionsStr: string = '',
  traceFn?: 'LLM' | 'axLLM',
): Promise<string | undefined> {
  const fn = traceFn ?? (role === 'scriptAux' ? 'axLLM' : 'LLM')
  const promptSummary = summarizeLuaTraceValue(promptStr)
  const prompt = parseLuaLlmPrompt(promptStr, useMultimodal)
  if (!Array.isArray(prompt)) {
    state.traceSink?.recordHostEvent({
      type: 'llm',
      fn,
      status: 'completed',
      promptSummary,
      success: false,
      error: prompt.result,
    })
    return JSON.stringify(prompt)
  }
  try {
    const result = await runLuaLlm(state, role, prompt, parseLuaLlmOptions(optionsStr))
    state.traceSink?.recordHostEvent({
      type: 'llm',
      fn,
      status: 'completed',
      promptSummary,
      success: result.success,
      ...(result.success ? {} : { error: result.result }),
    })
    return JSON.stringify(result)
  } catch (error) {
    state.traceSink?.recordHostEvent({
      type: 'llm',
      fn,
      status: 'failed',
      promptSummary,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function dotProduct(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length) return null
  let dot = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
  }
  return Number.isFinite(dot) ? dot : null
}

async function settleLuaProviderCall<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined
  return await new Promise<T | undefined>((resolve) => {
    let settled = false
    const finish = (value: T | undefined): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(value),
      () => finish(undefined),
    )
  })
}

async function runLuaSimilarity(state: RuntimeState, source: string, values: unknown): Promise<string[] | undefined> {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) return undefined
  if (values.length === 0) return []

  const model = resolveMemoryEmbeddingModel(state.ctx.database)
  if (model.ok === false) return undefined

  const deadlineController = new AbortController()
  const deadlineMs = resolveMemoryProviderFetchDeadlineMs(state.ctx.luaSimilarity?.deadlineMs)
  const signal = state.ctx.signal
    ? AbortSignal.any([deadlineController.signal, state.ctx.signal])
    : deadlineController.signal
  const clearDeadline = armMemoryProviderFetchDeadline(deadlineController, deadlineMs)

  try {
    const run = (async (): Promise<{ documents: Float32Array[]; query: Float32Array } | null> => {
      const documents: Float32Array[] = []
      const chunks: string[][] = []
      for (let index = 0; index < values.length; index += 50) {
        chunks.push((values as string[]).slice(index, index + 50))
      }

      if (model.request.provider === 'voyage-contextual') {
        const embedGroups = state.ctx.luaSimilarity?.embedGroups ?? embedTextGroups
        let expectedDim: number | undefined
        for (const chunk of chunks) {
          const result = await embedGroups({
            request: model.request,
            groups: chunk.map((value) => [value]),
            inputType: 'document',
            signal,
            ...(expectedDim === undefined ? {} : { expectedDim }),
          })
          if ('error' in result) return null
          expectedDim = result.dim
          documents.push(...result.groups.flatMap((group) => (group[0] ? [group[0]] : [])))
        }
        const query = await embedGroups({
          request: model.request,
          groups: [[String(source ?? '')]],
          inputType: 'query',
          signal,
          ...(expectedDim === undefined ? {} : { expectedDim }),
        })
        if ('error' in query || !query.groups[0]?.[0]) return null
        return { documents, query: query.groups[0][0] }
      }

      const embed = state.ctx.luaSimilarity?.embed ?? embedTexts
      let expectedDim: number | undefined
      for (const chunk of chunks) {
        const result = await embed({
          request: model.request,
          input: chunk,
          signal,
          ...(expectedDim === undefined ? {} : { expectedDim }),
        })
        if ('error' in result) return null
        expectedDim = result.dim
        documents.push(...result.vectors)
      }
      const query = await embed({
        request: model.request,
        input: [String(source ?? '')],
        signal,
        ...(expectedDim === undefined ? {} : { expectedDim }),
      })
      if ('error' in query || !query.vectors[0]) return null
      return { documents, query: query.vectors[0] }
    })()

    const embedded = await settleLuaProviderCall(run, signal)
    if (!embedded || embedded.documents.length !== values.length) return undefined

    const scored = (values as string[]).map((content, index) => ({
      content,
      similarity: dotProduct(embedded.query, embedded.documents[index]),
    }))
    if (scored.some((item) => item.similarity === null)) return undefined
    return scored
      .sort((a, b) => ((a.similarity as number) > (b.similarity as number) ? -1 : 0))
      .map((item) => item.content)
  } catch {
    return undefined
  } finally {
    clearDeadline()
  }
}

function randomImageSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000)
}

function requiredImageSetting<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`image generation setting ${field} is missing`)
  return value
}

function buildLuaImageGenerationRequest(
  database: Database,
  prompt: string,
  negativePrompt: string,
): ImageGenerationRequest {
  const credential = { source: 'stored' as const }
  switch (database.sdProvider) {
    case 'novelai': {
      const config = requiredImageSetting(database.NAIImgConfig, 'NAIImgConfig')
      const model = requiredImageSetting(database.NAIImgModel, 'NAIImgModel')
      const isV2OrV3 =
        model.includes('nai-diffusion-3') ||
        model.includes('nai-diffusion-furry-3') ||
        model.includes('nai-diffusion-2')
      const normalizedPrompt = prompt
        .replaceAll('\\(', '♧')
        .replaceAll('\\)', '♤')
        .replaceAll('(', '{')
        .replaceAll(')', '}')
        .replaceAll('♧', '(')
        .replaceAll('♤', ')')
      let skipCfgAboveSigma: number | null = null
      if (config.variety_plus) {
        if (
          model.includes('nai-diffusion-4-full') ||
          model.includes('nai-diffusion-4-curated') ||
          model.includes('nai-diffusion-3') ||
          model.includes('nai-diffusion-furry-3')
        ) {
          skipCfgAboveSigma =
            Math.sqrt(
              requiredImageSetting(config.width, 'NAIImgConfig.width') *
                requiredImageSetting(config.height, 'NAIImgConfig.height'),
            ) * 0.01889
        }
        if (model.includes('nai-diffusion-4-5-full') || model.includes('nai-diffusion-4-5-curated')) {
          skipCfgAboveSigma =
            Math.sqrt(
              requiredImageSetting(config.width, 'NAIImgConfig.width') *
                requiredImageSetting(config.height, 'NAIImgConfig.height'),
            ) * 0.05766
        }
      }
      const parameters: Record<string, unknown> = {
        params_version: 3,
        add_original_image: true,
        cfg_rescale: config.cfg_rescale,
        controlnet_strength: 1,
        dynamic_thresholding: isV2OrV3 ? config.decrisp : false,
        n_samples: 1,
        width: config.width,
        height: config.height,
        sampler: config.sampler,
        steps: config.steps,
        scale: config.scale,
        negative_prompt: negativePrompt,
        sm: isV2OrV3 ? config.sm : undefined,
        sm_dyn:
          model.includes('nai-diffusion-3') || model.includes('nai-diffusion-furry-3') ? config.sm_dyn : undefined,
        noise_schedule: config.noise_schedule,
        normalize_reference_strength_multiple: true,
        ucPreset: 3,
        uncond_scale: 1,
        qualityToggle: false,
        legacy_v3_extend: false,
        legacy: false,
        autoSmea: false,
        use_coords: false,
        legacy_uc: config.legacy_uc,
        v4_prompt: {
          caption: { base_caption: normalizedPrompt, char_captions: [] },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: { base_caption: negativePrompt, char_captions: [] },
          legacy_uc: config.legacy_uc,
        },
        reference_image_multiple: [],
        reference_strength_multiple: [],
        seed: randomImageSeed(),
        extra_noise_seed: randomImageSeed(),
        prefer_brownian: true,
        deliberate_euler_ancestral_bug: false,
        skip_cfg_above_sigma: skipCfgAboveSigma,
        director_reference_images: [],
        director_reference_descriptions: [],
        director_reference_information_extracted: [],
        director_reference_strength_values: [],
      }
      const inlineImage = typeof config.base64image === 'string' ? config.base64image : ''
      if (database.NAII2I && inlineImage) {
        parameters.image = inlineImage
        parameters.strength = config.strength || 0.7
        parameters.noise = config.noise || 0
      }
      return {
        provider: 'novelai',
        credential,
        payload: {
          input: normalizedPrompt,
          model,
          parameters,
          action: database.NAII2I && inlineImage ? 'img2img' : 'generate',
        },
      }
    }
    case 'dalle':
      return { provider: 'dalle', credential, prompt, quality: database.dallEQuality || 'standard' }
    case 'stability':
      return {
        provider: 'stability',
        credential,
        prompt,
        negativePrompt,
        model: requiredImageSetting(database.stabilityModel, 'stabilityModel'),
        style: database.stabllityStyle || '',
      }
    case 'fal':
      return {
        provider: 'fal',
        credential,
        prompt,
        model: requiredImageSetting(database.falModel, 'falModel'),
        width: requiredImageSetting(database.sdConfig, 'sdConfig').width,
        height: requiredImageSetting(database.sdConfig, 'sdConfig').height,
        ...(database.falModel === 'fal-ai/flux-lora' && database.falLora?.trim()
          ? { lora: { path: database.falLora, scale: requiredImageSetting(database.falLoraScale, 'falLoraScale') } }
          : {}),
      }
    case 'Imagen':
      return {
        provider: 'imagen',
        credential,
        prompt,
        model: requiredImageSetting(database.ImagenModel, 'ImagenModel'),
        imageSize: requiredImageSetting(database.ImagenImageSize, 'ImagenImageSize'),
        aspectRatio: requiredImageSetting(database.ImagenAspectRatio, 'ImagenAspectRatio'),
        personGeneration: requiredImageSetting(database.ImagenPersonGeneration, 'ImagenPersonGeneration'),
      }
    case 'openai-compat':
      return { provider: 'openai-compat', credential, prompt }
    case 'wavespeed': {
      const config = requiredImageSetting(database.wavespeedImage, 'wavespeedImage')
      const loras = Array.isArray(config.loras)
        ? config.loras
            .filter((lora) => lora?.path?.trim())
            .map((lora) => ({
              path: lora.path,
              scale: typeof lora.scale === 'number' ? lora.scale : 1,
            }))
        : undefined
      return {
        provider: 'wavespeed',
        credential,
        prompt,
        model: config.model,
        ...(config.reference_base64image ? { images: [config.reference_base64image] } : {}),
        ...(loras?.length ? { loras } : {}),
      }
    }
    case 'kei':
      return { provider: 'kei', credential, prompt }
    default:
      throw new Error('configured image provider is unsupported by the server')
  }
}

async function persistLuaGeneratedImage(state: RuntimeState, image: GeneratedImage): Promise<string> {
  if (state.ctx.luaImageGeneration?.persist) {
    return await state.ctx.luaImageGeneration.persist(image)
  }
  if (!state.ctx.requestHistoryDb || !state.ctx.assetDataDir) {
    throw new Error('server asset persistence is unavailable')
  }
  return persistServerInlayAsset(state.ctx.requestHistoryDb, state.ctx.assetDataDir, {
    bytes: image.bytes,
    contentType: image.contentType,
  })
}

async function runLuaImageGeneration(state: RuntimeState, prompt: string, negativePrompt: string): Promise<string> {
  try {
    const request = parseImageGenerationRequest(
      buildLuaImageGenerationRequest(state.ctx.database, String(prompt ?? ''), String(negativePrompt ?? '')),
    )
    const execute = state.ctx.luaImageGeneration?.execute ?? executeImageGeneration
    const image = await execute(request, state.ctx.database, {
      signal: state.ctx.signal,
    })
    const assetId = await persistLuaGeneratedImage(state, image)
    return assetId ? `{{inlay::${assetId}}}` : LUA_IMAGE_GENERATION_FAILURE
  } catch {
    return LUA_IMAGE_GENERATION_FAILURE
  }
}

// ── Host functions ─

/**
 * Sentinel state a prepared engine carries until {@link runServerLua} binds the
 * real per-call state. The prelude's top-level statements call no
 * host functions, so this is belt-and-braces: its pre-aborted signal makes any
 * unexpected pre-bind host call throw {@link LuaAbortError} instead of touching
 * a stale chat.
 */
const UNBOUND_RUNTIME_STATE: RuntimeState = (() => {
  const aborted = new AbortController()
  aborted.abort()
  return {
    ctx: {
      chat: { message: [], note: '', name: '', localLore: [] },
      database: { characters: [] },
      selectedCharID: 0,
      chatPage: 0,
      varEngine: null as unknown as TriggerVarEngine,
      signal: aborted.signal,
    },
    safeIds: new Set<string>(),
    lowLevelIds: new Set<string>(),
    editDisplayIds: new Set<string>(),
    stopSending: false,
    interactiveInvoked: false,
    sleptMs: 0,
  }
})()

/**
 * Declare the full browser host-fn surface on `engine`:
 *   - **Pure** fns operate on the server's in-memory chat / vars / char / db;
 *   - **Gated** fns (`request`) run behind the SSRF guard + low-level access;
 *   - **Unsupported** multimodal LLM/image getter APIs raise explicit
 *     script-facing server errors;
 *   - **Interactive** fns (`alert*Input/Select/Confirm`) throw and flag the run;
 *   - **Browser-only** fns (`alertError`/`alertNormal`/`reloadDisplay`/`reloadChat`)
 *     are no-ops.
 * Mirrors the `id`-gating from `scriptings.ts` (`safeIds` for safe writes,
 * `editDisplayIds` additionally for `setChatVar`, `lowLevelIds` for privileged).
 *
 * The per-call {@link RuntimeState} is bound through the returned setter rather
 * than a parameter: the host fns close over a mutable `state`, so
 * the (engine-boot-time) declaration can happen once at pool warm-up while each
 * call rebinds its own state before running user code.
 */
function declareHostFunctions(engine: LuaEngine): (next: RuntimeState) => void {
  let state: RuntimeState = UNBOUND_RUNTIME_STATE
  const declare = <Args extends unknown[]>(name: string, fn: (...args: Args) => unknown) => {
    // Every host fn is the abort checkpoint: once the request signal
    // fires, the next host call throws, terminating the surrounding pcall.
    engine.global.set(name, (...args: Args) => {
      state.diagnostics?.hostCall()
      if (state.ctx.signal?.aborted) {
        state.diagnostics?.blockHostCall()
        throw new LuaAbortError('request aborted')
      }
      return fn(...args)
    })
  }
  const checkedAccess = (allowed: boolean) => {
    if (!allowed) state.diagnostics?.blockHostCall()
    return allowed
  }
  const canWrite = (id: string) => checkedAccess(state.safeIds.has(id))
  const canWriteVar = (id: string) => checkedAccess(state.safeIds.has(id) || state.editDisplayIds.has(id))
  const canLowLevel = (id: string) => checkedAccess(state.lowLevelIds.has(id))
  const messageCount = () => state.ctx.chat.message?.length ?? 0

  // ── Pure: chat vars (bound to the assembler's var engine) ──
  declare('getChatVar', (_id: string, key: string) => state.ctx.varEngine.getVar(key))
  declare('setChatVar', (id: string, key: string, value: string) => {
    if (!canWriteVar(id)) return
    state.ctx.varEngine.setVar(key, value)
  })
  declare('setChatVarChanged', (id: string, key: string, value: string) => {
    if (!canWriteVar(id)) return
    if (state.ctx.varEngine.setVar(key, value) === true) return true
  })
  declare('getGlobalVar', (_id: string, key: string) => {
    const value = (state.ctx.database.globalChatVariables ?? {})[key]
    return value === undefined || value === null ? 'null' : String(value)
  })

  // ── Pure: run-control + logging ──
  declare('stopChat', (id: string) => {
    if (!canWrite(id)) return
    state.stopSending = true
  })
  declare('logMain', (value: string) => {
    let logged: unknown = value
    try {
      logged = JSON.parse(value)
      console.log(logged)
    } catch {
      console.log(value)
    }
    state.traceSink?.recordHostEvent({
      type: 'log',
      fn: 'log',
      value: logged,
      valueSummary: summarizeLuaTraceValue(logged),
    })
  })

  // ── Browser-only UI: no-op (gated, like the browser) ──
  declare('alertError', (id: string) => {
    if (!canWrite(id)) return
  })
  declare('alertNormal', (id: string) => {
    if (!canWrite(id)) return
  })
  declare('reloadDisplay', (id: string) => {
    if (!canWrite(id)) return
  })
  declare('reloadChat', (id: string) => {
    if (!canWrite(id)) return
  })

  // ── Interactive: no server equivalent — flag + fail explicitly ──
  const interactive = (id: string, label: string): never | undefined => {
    if (!canWrite(id)) return undefined
    state.interactiveInvoked = true
    throw new InteractiveApiError(
      `${label} requires browser interaction and is not supported by server prompt assembly`,
    )
  }
  declare('alertInput', (id: string) => interactive(id, 'alertInput'))
  declare('alertSelect', (id: string) => interactive(id, 'alertSelect'))
  declare('alertConfirm', (id: string) => interactive(id, 'alertConfirm'))

  // ── Pure: chat message array ──
  declare('getChatMain', (_id: string, index: number) => {
    const message = state.ctx.chat.message.at(index)
    if (!message) return JSON.stringify(null)
    return JSON.stringify({ role: message.role, data: message.data, time: message.time ?? 0 })
  })
  declare('getChatData', (_id: string, index: number) => state.ctx.chat.message.at(index)?.data ?? '')
  declare('getChatRole', (_id: string, index: number) => state.ctx.chat.message.at(index)?.role ?? '')
  declare('getRecentChatsMain', (_id: string, count: number) => {
    const chats = state.ctx.chat.message
    const safeCount = Math.max(0, Math.floor(count || 0))
    const start = Math.max(0, chats.length - safeCount)
    return JSON.stringify(
      chats.slice(start).map((message: Message) => ({
        role: message.role,
        data: message.data,
        time: message.time ?? 0,
      })),
    )
  })
  declare('setChat', (id: string, index: number, value: string) => {
    if (!canWrite(id)) {
      state.traceSink?.recordHostEvent({
        type: 'chat',
        fn: 'setChat',
        status: 'blocked',
        index,
        messageCountBefore: messageCount(),
        messageCountAfter: messageCount(),
        valueSummary: summarizeLuaTraceValue(value ?? ''),
      })
      return
    }
    const message = state.ctx.chat.message?.at(index)
    if (!message) {
      state.traceSink?.recordHostEvent({
        type: 'chat',
        fn: 'setChat',
        status: 'missing',
        index,
        messageCountBefore: messageCount(),
        messageCountAfter: messageCount(),
        valueSummary: summarizeLuaTraceValue(value ?? ''),
      })
      return
    }
    const before = summarizeLuaTraceMessage(message)
    state.diagnostics?.touchTranscript()
    message.data = value ?? ''
    const after = summarizeLuaTraceMessage(message)
    state.traceSink?.recordHostEvent({
      type: 'chat',
      fn: 'setChat',
      status: before?.dataSha256 === after?.dataSha256 ? 'unchanged' : 'changed',
      index,
      before,
      after,
      messageCountBefore: messageCount(),
      messageCountAfter: messageCount(),
      valueSummary: summarizeLuaTraceValue(value ?? ''),
    })
  })
  declare('setChatRole', (id: string, index: number, value: string) => {
    if (!canWrite(id)) {
      state.traceSink?.recordHostEvent({
        type: 'chat',
        fn: 'setChatRole',
        status: 'blocked',
        index,
        role: value,
        messageCountBefore: messageCount(),
        messageCountAfter: messageCount(),
      })
      return
    }
    const message = state.ctx.chat.message?.at(index)
    if (!message) {
      state.traceSink?.recordHostEvent({
        type: 'chat',
        fn: 'setChatRole',
        status: 'missing',
        index,
        role: value,
        messageCountBefore: messageCount(),
        messageCountAfter: messageCount(),
      })
      return
    }
    const before = summarizeLuaTraceMessage(message)
    state.diagnostics?.touchTranscript()
    message.role = value === 'user' ? 'user' : 'char'
    const after = summarizeLuaTraceMessage(message)
    state.traceSink?.recordHostEvent({
      type: 'chat',
      fn: 'setChatRole',
      status: before?.role === after?.role ? 'unchanged' : 'changed',
      index,
      role: value,
      before,
      after,
      messageCountBefore: messageCount(),
      messageCountAfter: messageCount(),
    })
  })
  declare('cutChat', (id: string, start: number, end: number) => {
    if (!canWrite(id)) {
      state.traceSink?.recordHostEvent({
        type: 'chat',
        fn: 'cutChat',
        status: 'blocked',
        start,
        end,
        messageCountBefore: messageCount(),
        messageCountAfter: messageCount(),
      })
      return
    }
    const beforeCount = messageCount()
    state.diagnostics?.touchTranscript()
    state.ctx.chat.message = state.ctx.chat.message.slice(start, end)
    const afterCount = messageCount()
    state.traceSink?.recordHostEvent({
      type: 'chat',
      fn: 'cutChat',
      status: beforeCount === afterCount ? 'unchanged' : 'changed',
      start,
      end,
      messageCountBefore: beforeCount,
      messageCountAfter: afterCount,
    })
  })
  declare('removeChat', (id: string, index: number) => {
    if (!canWrite(id)) {
      state.traceSink?.recordHostEvent({
        type: 'chat',
        fn: 'removeChat',
        status: 'blocked',
        index,
        messageCountBefore: messageCount(),
        messageCountAfter: messageCount(),
      })
      return
    }
    const beforeCount = messageCount()
    const before = summarizeLuaTraceMessage(state.ctx.chat.message?.at(index))
    state.diagnostics?.touchTranscript()
    state.ctx.chat.message.splice(index, 1)
    const afterCount = messageCount()
    state.traceSink?.recordHostEvent({
      type: 'chat',
      fn: 'removeChat',
      status: beforeCount === afterCount ? 'missing' : 'changed',
      index,
      before,
      messageCountBefore: beforeCount,
      messageCountAfter: afterCount,
    })
  })
  declare('addChat', (id: string, role: string, value: string) => {
    if (!canWrite(id)) {
      state.traceSink?.recordHostEvent({
        type: 'chat',
        fn: 'addChat',
        status: 'blocked',
        role,
        messageCountBefore: messageCount(),
        messageCountAfter: messageCount(),
        valueSummary: summarizeLuaTraceValue(value ?? ''),
      })
      return
    }
    const beforeCount = messageCount()
    state.diagnostics?.touchTranscript()
    state.ctx.chat.message.push({ role: role === 'user' ? 'user' : 'char', data: value ?? '' })
    state.traceSink?.recordHostEvent({
      type: 'chat',
      fn: 'addChat',
      status: 'changed',
      role,
      after: summarizeLuaTraceMessage(state.ctx.chat.message.at(-1)),
      messageCountBefore: beforeCount,
      messageCountAfter: messageCount(),
      valueSummary: summarizeLuaTraceValue(value ?? ''),
    })
  })
  declare('insertChat', (id: string, index: number, role: string, value: string) => {
    if (!canWrite(id)) return
    state.diagnostics?.touchTranscript()
    state.ctx.chat.message.splice(index, 0, {
      role: role === 'user' ? 'user' : 'char',
      data: value ?? '',
    })
  })
  declare('getChatLength', (_id: string) => state.ctx.chat.message.length)
  declare('getFullChatMain', (_id: string) =>
    JSON.stringify(state.ctx.chat.message.map((v: Message) => ({ role: v.role, data: v.data, time: v.time ?? 0 }))),
  )
  declare('setFullChatMain', (id: string, value: string) => {
    if (!canWrite(id)) return
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) throw new Error('setFullChat expects an array')
    state.diagnostics?.touchTranscript()
    state.ctx.chat.message = parsed.map((row: unknown): Message => {
      if (!row || typeof row !== 'object' || !('data' in row) || typeof row.data !== 'string') {
        throw new Error('setFullChat expects text message records')
      }
      return { role: 'role' in row && row.role === 'user' ? 'user' : 'char', data: row.data }
    })
  })
  declare('getCharacterLastMessage', (_id: string) => {
    const messages = state.ctx.chat.message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'char') return messages[i].data
    }
    return asCharacter(state.ctx)?.firstMessage ?? ''
  })
  declare('getUserLastMessage', (_id: string) => {
    const messages = state.ctx.chat.message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].data
    }
    return ''
  })

  // ── Pure: tokens / cbs / hash (server adapters) ──
  declare('getTokens', async (id: string, value: string) => {
    if (!canWrite(id)) return
    return tokenize(String(value ?? ''), tokenizerEncodingFromDb(state.ctx.database))
  })
  declare(
    'cbs',
    (value: string) =>
      expandVariables(String(value ?? ''), {
        database: state.ctx.database,
        selectedCharID: state.ctx.selectedCharID,
        chatPage: state.ctx.chatPage,
        chara: asCharacter(state.ctx),
      }).text,
  )
  declare('hash', async (_id: string, value: string) =>
    createHash('sha256')
      .update(new TextEncoder().encode(String(value ?? '')))
      .digest('hex'),
  )

  // ── Pure: character / persona getters + setters ──
  declare('getName', (_id: string) => asCharacter(state.ctx)?.name ?? '')
  declare('setName', (id: string, name: string) => {
    if (!canWrite(id)) return
    const char = asCharacter(state.ctx)
    if (char && typeof name === 'string') char.name = name
  })
  declare('getDescription', (id: string) => {
    if (!canWrite(id)) return
    return asCharacter(state.ctx)?.desc ?? ''
  })
  declare('setDescription', (id: string, desc: string) => {
    if (!canWrite(id)) return
    const char = asCharacter(state.ctx)
    if (char && typeof desc === 'string') char.desc = desc
  })
  declare('getCharacterFirstMessage', (_id: string) => asCharacter(state.ctx)?.firstMessage ?? '')
  declare('setCharacterFirstMessage', (id: string, data: string) => {
    if (!canWrite(id)) return false
    const char = asCharacter(state.ctx)
    if (!char || typeof data !== 'string') return false
    char.firstMessage = data
    return true
  })
  declare(
    'getPersonaName',
    (_id: string) => selectedPersonaProfileField(state.ctx.database, 'name') ?? state.ctx.database.username ?? '',
  )
  declare('getPersonaDescription', (_id: string) => {
    const personaPrompt =
      selectedPersonaProfileField(state.ctx.database, 'personaPrompt') ?? state.ctx.database.personaPrompt ?? ''
    return expandVariables(String(personaPrompt), {
      database: state.ctx.database,
      selectedCharID: state.ctx.selectedCharID,
      chatPage: state.ctx.chatPage,
      chara: asCharacter(state.ctx),
    }).text
  })
  declare('getAuthorsNote', (_id: string) => state.ctx.chat?.note ?? '')
  declare('getBackgroundEmbedding', (id: string) => {
    if (!canWrite(id)) return
    return asCharacter(state.ctx)?.backgroundHTML ?? ''
  })
  declare('setBackgroundEmbedding', (id: string, data: string) => {
    if (!canWrite(id)) return false
    const char = asCharacter(state.ctx)
    if (!char || typeof data !== 'string') return false
    char.backgroundHTML = data
    return true
  })

  // ── Lore books: pure write (upsert) + exact-comment reads ──
  declare(
    'upsertLocalLoreBook',
    (
      id: string,
      name: string,
      content: string,
      options: {
        alwaysActive?: boolean
        insertOrder?: number
        key?: string
        secondKey?: string
        regex?: boolean
      },
    ) => {
      if (!canWrite(id)) return
      const char = asCharacter(state.ctx)
      if (!char) return
      const { alwaysActive = false, insertOrder = 100, key = '', regex = false, secondKey = '' } = options ?? {}
      const chat = state.ctx.chat
      const previous = (chat.localLore ?? []).find((book: loreBook) => book.comment === name)
      const entryId = typeof previous?.id === 'string' && previous.id.trim().length > 0 ? previous.id : randomUUID()
      chat.localLore = (chat.localLore ?? []).filter((book: loreBook) => book.comment !== name)
      chat.localLore.push({
        id: entryId,
        alwaysActive,
        comment: name,
        content,
        insertorder: insertOrder,
        mode: 'normal',
        key,
        secondkey: secondKey,
        selective: !!secondKey,
        useRegex: regex,
      })
    },
  )
  declare('getLoreBooksMain', (_id: string, search: string) => {
    const char = asCharacter(state.ctx)
    if (!char) return

    const loreSources = [
      state.ctx.chat.localLore ?? [],
      char.globalLore ?? [],
      getModuleLorebooks(getActiveModules(state.ctx.database, char, state.ctx.chat)),
    ]
    const found = []
    for (const source of loreSources) {
      for (const book of source) {
        if (book.comment !== search) continue
        found.push({
          ...book,
          content: expandVariables(String(book.content ?? ''), {
            database: state.ctx.database,
            selectedCharID: state.ctx.selectedCharID,
            chatPage: state.ctx.chatPage,
            chara: char,
          }).text,
        })
      }
    }
    return JSON.stringify(found)
  })
  declare('loadLoreBooksMain', async (id: string) => {
    if (!canLowLevel(id)) return
    const char = asCharacter(state.ctx)
    if (!char) return
    const report = await activateLorebookAsync({
      database: state.ctx.database,
      currentChar: structuredClone(char),
      currentChat: structuredClone(state.ctx.chat),
      writeChatVar: (key, value) => state.ctx.varEngine.setVar(key, value),
    })
    const books = report.actives.flatMap((book) => {
      const data = expandVariables(book.prompt, {
        database: state.ctx.database,
        selectedCharID: state.ctx.selectedCharID,
        chatPage: state.ctx.chatPage,
        chara: char,
      }).text.trim()
      return data.length > 0 ? [{ data, role: book.role === 'assistant' ? ('char' as const) : book.role }] : []
    })
    return JSON.stringify(books)
  })

  // ── Gated: SSRF-guarded egress ──
  declare('request', async (id: string, url: string) => {
    if (!canLowLevel(id)) return
    return serverLuaRequest(
      String(url ?? ''),
      state.ctx.egress,
      state.ctx.rateState ?? sharedRateState,
      state.ctx.signal,
      () => state.diagnostics?.blockHostCall(),
    )
  })

  // ── Gated: sleep (capped per-call + per-run) ──
  declare('sleep', async (id: string, time: number) => {
    if (!canWrite(id)) return
    const requested = Math.max(0, Number(time) || 0)
    if (state.sleptMs >= MAX_TOTAL_SLEEP_MS) return false
    const ms = Math.min(requested, MAX_SLEEP_MS, MAX_TOTAL_SLEEP_MS - state.sleptMs)
    state.sleptMs += ms
    await delay(ms, state.ctx.signal)
    return true
  })

  declare('similarity', async (id: string, source: string, values: unknown) => {
    if (!canLowLevel(id)) return
    return runLuaSimilarity(state, String(source ?? ''), values)
  })
  declare('generateImage', async (id: string, prompt: string, negativePrompt: string = '') => {
    if (!canLowLevel(id)) return
    return runLuaImageGeneration(state, prompt, negativePrompt)
  })
  declare('getCharacterImageMain', async (_id: string) => {
    throw new Error(`${SERVER_UNSUPPORTED_LUA_API_ERROR}: getCharacterImage`)
  })
  declare('getPersonaImageMain', async (_id: string) => {
    throw new Error(`${SERVER_UNSUPPORTED_LUA_API_ERROR}: getPersonaImage`)
  })

  // Supported low-level LLM host fns.
  declare('LLMMain', async (id: string, promptStr: string, useMultimodal: boolean = false, optionsStr: string = '') => {
    const progressCall = state.progressSink?.beginLlmCall('LLM')
    if (!canLowLevel(id)) {
      progressCall?.finish()
      state.traceSink?.recordHostEvent({
        type: 'llm',
        fn: 'LLM',
        status: 'blocked',
        promptSummary: summarizeLuaTraceValue(promptStr),
      })
      return
    }
    try {
      return await runLuaLlmMain(state, 'scriptMain', promptStr, useMultimodal, optionsStr, 'LLM')
    } finally {
      progressCall?.finish()
    }
  })
  declare(
    'axLLMMain',
    async (id: string, promptStr: string, useMultimodal: boolean = false, optionsStr: string = '') => {
      const progressCall = state.progressSink?.beginLlmCall('axLLM')
      if (!canLowLevel(id)) {
        progressCall?.finish()
        state.traceSink?.recordHostEvent({
          type: 'llm',
          fn: 'axLLM',
          status: 'blocked',
          promptSummary: summarizeLuaTraceValue(promptStr),
        })
        return
      }
      try {
        return await runLuaLlmMain(state, 'scriptAux', promptStr, useMultimodal, optionsStr, 'axLLM')
      } finally {
        progressCall?.finish()
      }
    },
  )
  declare('simpleLLM', async (id: string, prompt: string) => {
    if (!canLowLevel(id)) return
    return runLuaLlm(state, 'scriptMain', [{ role: 'user', content: String(prompt ?? '') } as PromptMessage])
  })

  return (next) => {
    state = next
  }
}

// ── Prepared engines: warm pool + acquire ───────────────────────

/** An engine that is booted, host-fn-declared, and prelude-loaded, waiting for
 *  exactly one call's state bind. Never reused after a run. */
interface PreparedLuaEngine {
  engine: LuaEngine
  bindState: (state: RuntimeState) => void
}

/** Idle prepared engines kept warm for default-limit runs. Small: each holds a
 *  Lua state inside the shared wasm module. */
const LUA_ENGINE_POOL_TARGET = 2
const luaEnginePool: PreparedLuaEngine[] = []
/** Pending while any engine boot is in flight — a background pool refill or a
 *  run's fresh boot. Acquires await it before touching the pool, and no boot
 *  starts while it is held, so boots never overlap each other or a starting
 *  run. */
let luaEngineBootGate: Promise<void> | null = null
/**
 * Runs currently inside {@link runServerLua}. Engine boots mutate the shared
 * wasm module's function table; doing that while another engine has a pending
 * Lua continuation (an in-flight `:await()`) crashes wasmoon with "null
 * function or function signature mismatch". So *every* boot path — the
 * background pool refill and a run's fresh boot alike — starts only while this
 * is zero and holds {@link luaEngineBootGate} for its duration.
 *
 * Wasmoon continuations are also fragile when two engines are both suspended in
 * host-function `:await()` calls. A pooled engine does not boot, but it can
 * still resume through the same wasm function table, so acquire serializes whole
 * Lua runs: a second run waits for the active run to drain before it can claim a
 * prepared engine.
 */
let activeLuaRuns = 0
/** Fresh-boot acquires parked until the active runs drain (see
 *  {@link activeLuaRuns}); resolved by the last finishing run's `finally`. */
let luaRunsDrainedWaiters: Array<() => void> = []

function waitForLuaRunsDrained(): Promise<void> {
  return new Promise((resolve) => {
    luaRunsDrainedWaiters.push(resolve)
  })
}

function notifyLuaRunsDrained(): void {
  if (activeLuaRuns > 0 || luaRunsDrainedWaiters.length === 0) return
  const waiters = luaRunsDrainedWaiters
  luaRunsDrainedWaiters = []
  for (const resolve of waiters) resolve()
}

/** Acquire counters (test seam): proves the hot path served from the pool
 *  without booting, while refills happen off-path. */
export interface LuaEngineAcquireStats {
  engineBoots: number
  pooledAcquires: number
  freshAcquires: number
}

const luaEngineStats: LuaEngineAcquireStats = {
  engineBoots: 0,
  pooledAcquires: 0,
  freshAcquires: 0,
}

export function readLuaEngineAcquireStats(): LuaEngineAcquireStats {
  return { ...luaEngineStats }
}

/** Test seam: resolves once any in-flight boot (refill or fresh) settles. */
export async function settleLuaEnginePool(): Promise<void> {
  while (luaEngineBootGate) await luaEngineBootGate
}

/** Boot an engine, declare the host-fn surface (state unbound), and pre-run
 *  the static prelude. The prelude is trusted fixed code, so its load is
 *  bounded by the default limit regardless of the caller's. */
async function createPreparedEngine(functionTimeoutMs: number): Promise<PreparedLuaEngine> {
  const factory = await getLuaFactory()
  const engine = await factory.createEngine({
    injectObjects: true,
    functionTimeout: functionTimeoutMs,
  })
  luaEngineStats.engineBoots++
  try {
    const bindState = declareHostFunctions(engine)
    await runStringWithTimeout(engine, LUA_PRELUDE, DEFAULT_EXEC_TIMEOUT_MS)
    return { engine, bindState }
  } catch (error) {
    engine.global.close()
    throw error
  }
}

/** Refill the pool, but only while no run is in flight (see
 *  {@link activeLuaRuns}); the last finishing run kicks it again. */
function refillLuaEnginePoolWhenIdle(): void {
  if (activeLuaRuns > 0) return
  if (luaEngineBootGate || luaEnginePool.length >= LUA_ENGINE_POOL_TARGET) return
  luaEngineBootGate = (async () => {
    try {
      while (luaEnginePool.length < LUA_ENGINE_POOL_TARGET) {
        luaEnginePool.push(await createPreparedEngine(DEFAULT_EXEC_TIMEOUT_MS))
      }
    } catch {
      // Transient boot failure: the next acquire simply falls back to a
      // fresh inline boot, exactly the pre-pool behavior.
    } finally {
      luaEngineBootGate = null
    }
  })()
}

/**
 * Acquire an engine for one run, counting the run active before returning.
 *
 * Pops a pre-warmed engine when the run uses the default exec limit (pool
 * engines are created with the default `functionTimeout`, which is fixed at
 * engine creation); any custom/budget-tightened limit boots fresh with that
 * limit, exactly the pre-pool behavior. Every path serializes against engine
 * boots: an in-flight boot (refill or another run's fresh boot) is awaited
 * before the pool is touched, and a fresh boot of our own waits for all
 * active runs to drain before touching the pool. A pooled acquire is fast, but
 * it still must not overlap another run that may be suspended in a Lua
 * continuation. Fresh boots additionally hold the boot gate while creating the
 * engine.
 */
async function acquirePreparedEngine(execTimeoutMs: number): Promise<PreparedLuaEngine> {
  for (;;) {
    if (luaEngineBootGate) {
      await luaEngineBootGate
      continue
    }
    // Serialize whole Lua runs, not just engine boots. Two output hooks can both
    // suspend inside axLLM()/request():await(); letting a pooled engine run next
    // to that suspended continuation can corrupt wasmoon's shared call table.
    if (activeLuaRuns > 0) {
      await waitForLuaRunsDrained()
      continue
    }
    if (execTimeoutMs === DEFAULT_EXEC_TIMEOUT_MS) {
      const pooled = luaEnginePool.shift()
      if (pooled) {
        luaEngineStats.pooledAcquires++
        // Counted active before returning, so a following acquire waits until
        // this run has fully drained.
        activeLuaRuns++
        return pooled
      }
    }
    // Sole booter: hold the gate so no new run starts (and no refill begins)
    // while this engine boots.
    let releaseBootGate!: () => void
    luaEngineBootGate = new Promise((resolve) => {
      releaseBootGate = resolve
    })
    try {
      luaEngineStats.freshAcquires++
      const prepared = await createPreparedEngine(execTimeoutMs)
      // Counted active before the gate lifts, so a parked fresh-booter
      // re-parks behind this run instead of booting alongside it.
      activeLuaRuns++
      return prepared
    } finally {
      luaEngineBootGate = null
      releaseBootGate()
    }
  }
}

// Bounded load.

/**
 * `engine.doString` equivalent that bounds the load with a wall-clock timeout, so
 * a top-level `while true do end` in the user code is interrupted (the
 * `functionTimeout` engine option only bounds JS→Lua *calls*, not the initial
 * load). Mirrors wasmoon's own `callByteCode` (run a chunk on a child thread) but
 * passes `{ timeout }` to `thread.run`. Globals defined by the chunk persist on the
 * shared `_G`, exactly as `doString` does.
 */
async function runStringWithTimeout(
  engine: LuaEngine,
  code: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const global = engine.global
  const thread = global.newThread()
  const threadIndex = global.getTop()
  // Abort propagation: pulling the thread deadline to the epoch makes the
  // run loop's next yield-boundary check throw. A pure-compute chunk that never
  // yields stays bounded by `timeoutMs` itself (the count hook's own deadline).
  const onAbort = (): void => thread.setTimeout(1)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal?.aborted) throw new LuaAbortError('request aborted')
    thread.loadString(code)
    await thread.run(0, { timeout: timeoutMs })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    global.remove(threadIndex)
  }
}

// ── runScripted equivalent ──────────────────────────────────────────────────

/**
 * Server port of `runScripted` (`scriptings.ts`), Lua only. Acquires an
 * engine of its own (pre-warmed when possible), binds
 * the per-call state into the host-fn surface, runs the user code under the
 * exec limit, mints an access key, dispatches by `mode`, and returns a
 * structured result. Load/dispatch errors are captured (not thrown) the way the
 * browser swallows them — but a timeout or interactive-API invocation is surfaced
 * on the result so callers can act on it.
 */
export async function runServerLua(opts: RunServerLuaOptions, ctx: ServerLuaRuntimeContext): Promise<ServerLuaResult> {
  const diagnostics = beginLuaDiagnostics(opts.mode, ctx.chat, opts.data ?? '')
  let result: ServerLuaResult | undefined
  try {
    result = await executeServerLua(opts, ctx, diagnostics)
    return result
  } finally {
    // Edit wrappers reject mismatched concrete output types after this returns.
    // Count that failure here too without exporting the rejected value.
    const edit = ['editInput', 'editOutput', 'editRequest', 'editDisplay'].includes(opts.mode)
    const output = result?.res
    const invalidOutput =
      edit &&
      output !== undefined &&
      output !== null &&
      (Array.isArray(opts.data) ? !Array.isArray(output) : typeof output !== 'string')
    diagnostics?.finish({
      failed:
        !result ||
        !!result.error ||
        result.timedOut ||
        result.interactiveInvoked ||
        result.aborted === true ||
        invalidOutput,
      output: invalidOutput ? undefined : output,
    })
  }
}

async function executeServerLua(
  opts: RunServerLuaOptions,
  ctx: ServerLuaRuntimeContext,
  diagnostics?: LuaDiagnosticsRun,
): Promise<ServerLuaResult> {
  await ensureTokenizerLoadedForDb(ctx.database)
  const execTimeoutMs = opts.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const data = opts.data ?? ''
  const meta = opts.meta ?? {}
  const lowLevelAccess = opts.lowLevelAccess ?? false
  const signal = ctx.signal
  const runRequestedAt = Date.now()
  const budget = ctx.execBudget
  const budgetUsedMsBefore = budget?.usedMs

  // An already-cancelled request never boots an engine.
  if (signal?.aborted) {
    const result: ServerLuaResult = {
      stopSending: false,
      res: undefined,
      timedOut: false,
      interactiveInvoked: false,
      handlerRegistered: false,
      aborted: true,
      error: 'request aborted',
    }
    return finalizeLuaRuntimeResult(
      opts,
      result,
      buildLuaRuntimeMetricFields({
        opts,
        lowLevelAccess,
        execTimeoutMs,
        effectiveTimeoutMs: 0,
        durationMs: Date.now() - runRequestedAt,
        result,
        budget,
        budgetUsedMsBefore,
      }),
    )
  }

  // An exhausted aggregate budget never boots an engine either; the
  // caller's hook loop degrades to identity instead of stalling assembly.
  if (budget && budget.usedMs >= budget.totalMs) {
    const result: ServerLuaResult = {
      stopSending: false,
      res: undefined,
      timedOut: true,
      interactiveInvoked: false,
      handlerRegistered: false,
      error: 'aggregate Lua execution budget exhausted',
    }
    return finalizeLuaRuntimeResult(
      opts,
      result,
      buildLuaRuntimeMetricFields({
        opts,
        lowLevelAccess,
        execTimeoutMs,
        effectiveTimeoutMs: 0,
        durationMs: Date.now() - runRequestedAt,
        result,
        budget,
        budgetUsedMsBefore,
      }),
    )
  }
  // A constrained run gets only what is left of the budget. The dispatch's
  // engine-level `functionTimeout` stays at its creation value, so the worst
  // overshoot past the budget is one per-run limit.
  const effectiveTimeoutMs = budget
    ? Math.max(1, Math.min(execTimeoutMs, budget.totalMs - budget.usedMs))
    : execTimeoutMs

  const state: RuntimeState = {
    ctx,
    source: opts.source,
    safeIds: new Set<string>(),
    lowLevelIds: new Set<string>(),
    editDisplayIds: new Set<string>(),
    traceSink: opts.traceSink,
    progressSink: opts.progressSink,
    diagnostics,
    stopSending: false,
    interactiveInvoked: false,
    sleptMs: 0,
  }

  // The acquire itself counts this run active (so engine boots can never
  // interleave between acquire and run start); the finally below releases it.
  const prepared = await acquirePreparedEngine(effectiveTimeoutMs)
  const engine = prepared.engine
  // Charge script budget from the point where this run owns an engine. Queue
  // time behind another request is runtime scheduling, not this script's work.
  const runStartedAt = Date.now()

  const result: ServerLuaResult = {
    stopSending: false,
    res: undefined,
    timedOut: false,
    interactiveInvoked: false,
    handlerRegistered: false,
  }

  try {
    prepared.bindState(state)

    try {
      await runStringWithTimeout(engine, opts.code, effectiveTimeoutMs, signal)
    } catch (error) {
      // A load failure (syntax error or a top-level runaway loop) leaves nothing to
      // dispatch. Record it and return identity, mirroring the browser's
      // error-swallowing `runLuaEditTrigger`.
      result.error = error instanceof Error ? error.message : String(error)
      // An abort surfaces through the same deadline machinery; report it as a
      // cancellation, not an exec-limit timeout.
      result.timedOut = isTimeoutError(error) && !signal?.aborted
      return result
    }

    if (signal?.aborted) return result

    const accessKey = randomUUID()
    if (opts.mode === 'editDisplay') {
      state.editDisplayIds.add(accessKey)
    } else {
      state.safeIds.add(accessKey)
      if (lowLevelAccess) state.lowLevelIds.add(accessKey)
    }

    try {
      let res: unknown
      const get = (name: string) => engine.global.get(name) as ((...a: unknown[]) => unknown) | undefined
      switch (opts.mode) {
        case 'input': {
          const fn = get('onInput')
          result.handlerRegistered = typeof fn === 'function'
          if (fn) res = await fn(accessKey)
          break
        }
        case 'output': {
          const fn = get('onOutput')
          result.handlerRegistered = typeof fn === 'function'
          if (fn) res = await fn(accessKey)
          break
        }
        case 'start': {
          const fn = get('onStart')
          result.handlerRegistered = typeof fn === 'function'
          if (fn) res = await fn(accessKey)
          break
        }
        case 'onButtonClick': {
          const fn = get('onButtonClick')
          result.handlerRegistered = typeof fn === 'function'
          if (fn) res = await fn(accessKey, data)
          break
        }
        case 'editRequest':
        case 'editDisplay':
        case 'editInput':
        case 'editOutput': {
          const fn = get('callListenMain')
          result.handlerRegistered = typeof fn === 'function'
          if (fn) {
            const raw = await fn(opts.mode, accessKey, JSON.stringify(data), JSON.stringify(meta))
            res = JSON.parse(raw as string)
          }
          break
        }
        default: {
          const fn = get(opts.mode)
          result.handlerRegistered = typeof fn === 'function'
          if (fn) res = await fn(accessKey)
          break
        }
      }
      if (res === false) state.stopSending = true
      result.res = res
    } catch (error) {
      // Browser parity: the dispatch switch swallows errors (`scriptings.ts`).
      // We additionally record the cause so a timeout / interactive abort is visible.
      result.error = error instanceof Error ? error.message : String(error)
      result.timedOut = isTimeoutError(error) && !signal?.aborted
    }

    return result
  } finally {
    result.stopSending = state.stopSending
    result.interactiveInvoked = state.interactiveInvoked
    if (signal?.aborted) result.aborted = true
    // Charge the aggregate budget with this run's wall clock.
    if (budget) budget.usedMs += Date.now() - runStartedAt
    finalizeLuaRuntimeResult(
      opts,
      result,
      buildLuaRuntimeMetricFields({
        opts,
        lowLevelAccess,
        execTimeoutMs,
        effectiveTimeoutMs,
        durationMs: Date.now() - runStartedAt,
        result,
        budget,
        budgetUsedMsBefore,
      }),
    )
    try {
      // One call per engine: closing here (never returning to the pool) is what
      // preserves per-call isolation.
      engine.global.close()
    } catch (error) {
      emitProtocolMetric('generation_lua_runtime_engine_close_failed', {
        mode: opts.mode,
        codeSha256: sha256Hex(opts.code),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      activeLuaRuns--
      // Wake any acquire parked on the drain (it re-checks the gate and the run
      // count before claiming an engine), then replace what this run consumed —
      // off the hot path, and only once no other run is mid-flight.
      notifyLuaRunsDrained()
      refillLuaEnginePoolWhenIdle()
    }
  }
}

// ── runLuaEditTrigger ───────────────────────────────────────────────────────

/** Context for {@link runLuaEditTrigger}: the runtime context (minus `char`, which
 * is the first positional arg) plus the active modules' resolved triggers. */
export interface ServerLuaEditTriggerContext extends Omit<ServerLuaRuntimeContext, 'char'> {
  /** Active modules' trigger scripts (`getModuleTriggers(getActiveModules(...))`),
   * concatenated after the character's own, mirroring the browser. */
  moduleTriggers?: triggerscript[]
  /** Optional collector for post-generation editOutput diagnostics. */
  postGenerationTrace?: PostGenerationLuaTraceCollector
  /** Optional live progress tracker for post-generation editOutput diagnostics. */
  postGenerationProgress?: PostGenerationLuaProgressTracker
}

interface LuaEditTriggerOwner {
  type?: 'character' | 'simple'
  triggerscript?: triggerscript[]
  lowLevelAccess?: boolean
  chaId: string
  name?: string
}

interface LuaEditContentSummary {
  kind: string
  sha256: string
  bytes: number
  rowCount?: number
}

function summarizeLuaEditContent(value: unknown): LuaEditContentSummary {
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    json = '[unserializable]'
  }
  const summary: LuaEditContentSummary = {
    kind,
    sha256: sha256Hex(json),
    bytes: Buffer.byteLength(json, 'utf8'),
  }
  if (Array.isArray(value)) summary.rowCount = value.length
  return summary
}

type LuaEditContent = string | PromptMessage[]
const isLuaEditPromptRow = new Ajv({ strict: false, strictNumbers: true }).compile<PromptMessage>(PromptChatRowSchema)

/** Lua edit hooks may replace content, but cannot change its concrete channel. */
function checkedLuaEditContent(value: unknown, previous: LuaEditContent): { value: LuaEditContent; error?: string } {
  if (value === undefined || value === null) return { value: previous }
  if (typeof previous === 'string') {
    return typeof value === 'string' ? { value } : { value: previous, error: 'Lua edit hook expected text output' }
  }
  if (Array.isArray(value) && value.every((row: unknown): row is PromptMessage => isLuaEditPromptRow(row)))
    return { value }
  return { value: previous, error: 'Lua edit hook expected prompt row output' }
}

/**
 * Server port of `runLuaEditTrigger` (`scriptings.ts`). Remaps the edit-mode
 * casing, early-returns for `editprocess` (a browser no-op), then runs each
 * `triggerlua` effect on the character + active modules with `lowLevelAccess:
 * false`, matching the browser's `runLuaEditTrigger`, and threads the transformed
 * `data` forward.
 * Lua failures throw with context instead of returning the original `content`;
 * otherwise callers cannot distinguish a no-op hook from a broken hook.
 */
export function runLuaEditTrigger(
  char: character | SimpleCharacterArgument,
  mode: string,
  content: string,
  meta: object | undefined,
  ctx: ServerLuaEditTriggerContext,
): Promise<string>
export function runLuaEditTrigger(
  char: character | SimpleCharacterArgument,
  mode: string,
  content: PromptMessage[],
  meta: object | undefined,
  ctx: ServerLuaEditTriggerContext,
): Promise<PromptMessage[]>
export async function runLuaEditTrigger(
  char: character | SimpleCharacterArgument,
  mode: string,
  content: LuaEditContent,
  meta: object | undefined,
  ctx: ServerLuaEditTriggerContext,
): Promise<LuaEditContent> {
  switch (mode) {
    case 'editinput':
      mode = 'editInput'
      break
    case 'editoutput':
      mode = 'editOutput'
      break
    case 'editdisplay':
      mode = 'editDisplay'
      break
    case 'editprocess':
      return content
  }

  try {
    let data: LuaEditContent = content

    const owner: LuaEditTriggerOwner = char
    const ownTriggers: triggerscript[] = (owner.triggerscript ?? []).map((trigger, index) => {
      const lowLevelAccess = owner.type === 'simple' ? false : (owner.lowLevelAccess ?? false)
      return attachTriggerSource(
        { ...trigger, lowLevelAccess },
        {
          ownerType: 'character',
          ownerId: owner.chaId,
          ownerName: owner.name,
          triggerId: trigger.id,
          triggerIndex: index,
          triggerComment: trigger.comment,
          triggerType: triggerTypeAttribution(trigger),
          lowLevelAccess,
        },
      )
    })
    const triggers = ownTriggers.concat(ctx.moduleTriggers ?? [])

    for (const trigger of triggers) {
      if (trigger?.effect?.[0]?.type === 'triggerlua') {
        const effect = trigger.effect[0]
        const source = withTriggerEffectSource(getTriggerSource(trigger), 0, effect.type)
        const before = summarizeLuaEditContent(data)
        const traceRun =
          mode === 'editOutput'
            ? ctx.postGenerationTrace?.beginRun({
                phase: 'editOutput',
                mode,
                code: effect.code,
                source,
                chat: ctx.chat,
                editOutputTextBefore: typeof data === 'string' ? data : undefined,
              })
            : undefined
        const progressRun =
          mode === 'editOutput'
            ? ctx.postGenerationProgress?.beginRun({
                phase: 'editOutput',
                source,
              })
            : undefined
        let runResult: ServerLuaResult
        try {
          runResult = await runServerLua(
            {
              code: effect.code,
              mode,
              data,
              meta,
              lowLevelAccess: false,
              source,
              traceSink: traceRun?.sink,
              progressSink: progressRun?.sink,
            },
            { ...ctx, char },
          )
        } catch (error) {
          progressRun?.finish('error')
          traceRun?.finish({
            status: 'error',
            chat: ctx.chat,
            editOutputTextAfter: typeof data === 'string' ? data : undefined,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
        const checked = checkedLuaEditContent(runResult.res, data)
        if (checked.error && !runResult.error) runResult.error = checked.error
        const failure = serverLuaFailureMessage(runResult, `Lua ${mode} edit trigger failed`)
        const nextData = checked.value
        progressRun?.finish(failure ? 'error' : 'finished')
        traceRun?.finish({
          status: failure ? 'error' : 'ok',
          chat: ctx.chat,
          editOutputTextAfter: typeof nextData === 'string' ? nextData : undefined,
          runtimeMetricFields: runResult.runtimeMetricFields as unknown as Record<string, unknown> | undefined,
          ...(failure ? { error: failure } : {}),
        })
        throwServerLuaFailure(runResult, `Lua ${mode} edit trigger failed`)
        const after = summarizeLuaEditContent(nextData)
        emitProtocolMetric('generation_lua_edit_trigger_effect', () => ({
          status: 'ok',
          mode,
          codeSha256: sha256Hex(effect.code),
          codeBytes: Buffer.byteLength(effect.code, 'utf8'),
          contentKind: before.kind,
          contentBytesBefore: before.bytes,
          contentBytesAfter: after.bytes,
          contentSha256Before: before.sha256,
          contentSha256After: after.sha256,
          contentChanged: before.sha256 !== after.sha256,
          ...(before.rowCount !== undefined ? { rowCountBefore: before.rowCount } : {}),
          ...(after.rowCount !== undefined ? { rowCountAfter: after.rowCount } : {}),
          ...triggerSourceMetricFields(source),
        }))
        data = nextData
      }
    }

    return data
  } catch (error) {
    console.error(`Lua edit trigger failed in ${mode}:`, error)
    throw error
  }
}
