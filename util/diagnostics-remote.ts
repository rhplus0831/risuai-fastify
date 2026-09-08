import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { request } from 'node:https'
import { isAbsolute, resolve } from 'node:path'
import { Transform, Writable, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import {
  REMOTE_DIAGNOSTICS_ERRORS,
  REMOTE_DIAGNOSTICS_MAX_BYTES,
  SUPPORT_DIAGNOSTICS_ENDPOINT,
  isRemoteDiagnosticsResponse,
  parseRemoteDiagnosticsQuery,
  type RemoteDiagnosticsError,
  type RemoteDiagnosticsResponse,
} from '@risuai/protocol/remote-diagnostics'

const MAX_CONFIG_BYTES = 4 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const QUERY_KEYS = new Set(['version', 'from', 'to', 'limit', 'requestUid', 'operationRef', 'category', 'cursor'])
const TLS_ERRORS = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

export interface RemoteDiagnosticsConfig {
  version: 1
  origin: string
  token: string
}

export type RemoteDiagnosticsHelperCategory =
  | RemoteDiagnosticsError
  | 'config-error'
  | 'server-unavailable'
  | 'tls-error'
  | 'timeout'
  | 'redirect-rejected'
  | 'bad-response'
  | 'response-too-large'

/** The only error information allowed to cross the helper's output boundary. */
export class RemoteDiagnosticsHelperError extends Error {
  constructor(readonly category: RemoteDiagnosticsHelperCategory) {
    super(category)
    this.name = 'RemoteDiagnosticsHelperError'
  }
}

function failure(category: RemoteDiagnosticsHelperCategory): RemoteDiagnosticsHelperError {
  return new RemoteDiagnosticsHelperError(category)
}

function validateConfig(value: unknown): RemoteDiagnosticsConfig {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('config-error')
    const config = value as Record<string, unknown>
    if (
      Object.keys(config).length !== 3 ||
      config.version !== 1 ||
      typeof config.origin !== 'string' ||
      config.origin.length > 2048 ||
      typeof config.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(config.token)
    )
      throw failure('config-error')
    const origin = new URL(config.origin)
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/' ||
      ![origin.origin, `${origin.origin}/`].includes(config.origin)
    )
      throw failure('config-error')
    return { version: 1, origin: origin.origin, token: config.token }
  } catch {
    throw failure('config-error')
  }
}

/** Reads one private, bounded, ordinary file; symlinked path components are rejected. */
export function readRemoteDiagnosticsConfig(configPath: string | undefined): RemoteDiagnosticsConfig {
  let descriptor: number | undefined
  try {
    if (!configPath || configPath.length > 4096 || !isAbsolute(configPath)) throw failure('config-error')
    const path = resolve(configPath)
    if (realpathSync(path) !== path) throw failure('config-error')
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      stat.size < 1 ||
      stat.size > MAX_CONFIG_BYTES
    )
      throw failure('config-error')
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null)
      if (count === 0) break
      bytes += count
    }
    if (bytes > MAX_CONFIG_BYTES) throw failure('config-error')
    return validateConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))))
  } catch {
    throw failure('config-error')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** No destination, output file, custom header, or arbitrary transport options exist. */
export function parseRemoteDiagnosticsArguments(args: readonly string[]): Record<string, string> {
  const input: Record<string, string> = Object.create(null)
  for (let index = args[0] === '--' ? 1 : 0; index < args.length; index++) {
    const match = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(args[index])
    if (!match || !QUERY_KEYS.has(match[1]) || Object.hasOwn(input, match[1])) throw failure('invalid-query')
    const value = match[2] ?? args[++index]
    if (value === undefined || value.startsWith('--')) throw failure('invalid-query')
    input[match[1]] = value
  }
  if (!parseRemoteDiagnosticsQuery(input)) throw failure('invalid-query')
  return input
}

function byteLimit(): Transform {
  let bytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytes += chunk.length
      callback(bytes > REMOTE_DIAGNOSTICS_MAX_BYTES ? failure('response-too-large') : null, chunk)
    },
  })
}

function responseError(value: unknown): RemoteDiagnosticsError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return null
  const error = (value as { error?: unknown }).error
  return REMOTE_DIAGNOSTICS_ERRORS.find((category) => category === error) ?? null
}

/** Fetches only the fixed support route, with verified TLS and bounded wire/expanded bytes. */
export async function fetchRemoteDiagnostics(
  config: RemoteDiagnosticsConfig,
  input: Record<string, string> = {},
): Promise<RemoteDiagnosticsResponse> {
  const trustedConfig = validateConfig(config)
  const query = parseRemoteDiagnosticsQuery(input)
  if (!query) throw failure('invalid-query')
  // Fail closed before Node emits its insecure-TLS environment warning or opens a socket.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw failure('tls-error')
  const url = new URL(SUPPORT_DIAGNOSTICS_ENDPOINT, trustedConfig.origin)
  for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value)

  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false
    const finish = (error?: RemoteDiagnosticsHelperError, response?: RemoteDiagnosticsResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) {
        transport.destroy()
        rejectResponse(error)
      } else resolveResponse(response!)
    }
    const transport = request(
      url,
      {
        method: 'GET',
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 8192,
        headers: {
          Authorization: `Bearer ${trustedConfig.token}`,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          response.destroy()
          finish(failure('redirect-rejected'))
          return
        }
        const type = response.headers['content-type'] ?? ''
        const encoding = response.headers['content-encoding']?.toLowerCase() ?? 'identity'
        const length = response.headers['content-length']
        if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > REMOTE_DIAGNOSTICS_MAX_BYTES)) {
          response.destroy()
          finish(failure('response-too-large'))
          return
        }
        if (
          !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(type) ||
          !['identity', 'gzip', 'deflate', 'br'].includes(encoding)
        ) {
          response.destroy()
          finish(failure('bad-response'))
          return
        }
        const chunks: Buffer[] = []
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk)
            callback()
          },
        })
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'deflate'
              ? createInflate()
              : encoding === 'br'
                ? createBrotliDecompress()
                : new Transform({
                    transform(chunk, _encoding, callback) {
                      callback(null, chunk)
                    },
                  })
        void pipeline(response, byteLimit(), decoder, byteLimit(), sink).then(
          () => {
            try {
              const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
              if (status !== 200) {
                finish(
                  failure(status >= 400 && status <= 599 ? (responseError(value) ?? 'bad-response') : 'bad-response'),
                )
              } else if (!isRemoteDiagnosticsResponse(value) || value.version !== query.version) {
                finish(failure('bad-response'))
              } else finish(undefined, value)
            } catch {
              finish(failure('bad-response'))
            }
          },
          (error: unknown) => {
            finish(error instanceof RemoteDiagnosticsHelperError ? error : failure('bad-response'))
          },
        )
      },
    )
    const deadline = setTimeout(() => finish(failure('timeout')), REQUEST_TIMEOUT_MS)
    transport.on('error', (error: NodeJS.ErrnoException) => {
      finish(failure(TLS_ERRORS.has(error.code ?? '') ? 'tls-error' : 'server-unavailable'))
    })
    transport.end()
  })
}

async function run(): Promise<void> {
  try {
    const query = parseRemoteDiagnosticsArguments(process.argv.slice(2))
    const config = readRemoteDiagnosticsConfig(process.env.RISU_DIAGNOSTICS_REMOTE_CONFIG)
    const response = await fetchRemoteDiagnostics(config, query)
    process.stdout.write(`${JSON.stringify(response)}\n`)
  } catch (error) {
    const category = error instanceof RemoteDiagnosticsHelperError ? error.category : 'bad-response'
    process.stderr.write(`${category}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void run()
