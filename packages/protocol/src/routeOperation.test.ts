import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_ROUTE_OPERATION_CATALOG,
  findProtocolRouteOperationById,
  isProtocolRouteOperationDescriptor,
  protocolRouteOperationMatches,
} from '@risuai/protocol/route-operation'

describe('route-operation catalog', () => {
  it('publishes unique reviewed operation identifiers and exact descriptors', () => {
    expect(PROTOCOL_ROUTE_OPERATION_CATALOG).toHaveLength(110)
    expect(new Set(PROTOCOL_ROUTE_OPERATION_CATALOG.map(({ id }) => id)).size).toBe(110)

    for (const operation of PROTOCOL_ROUTE_OPERATION_CATALOG) {
      expect(isProtocolRouteOperationDescriptor(operation), operation.id).toBe(true)
      expect(findProtocolRouteOperationById(operation.id)).toBe(operation)
      expect(operation.path).toMatch(/^\/api\/v1\//)
      expect(operation).not.toHaveProperty('auth')
      expect(operation).not.toHaveProperty('activeWriter')
    }
  })

  it('keeps response classes coherent with stream classes', () => {
    const responseByStream = {
      none: 'structured',
      binary: 'binary',
      sse: 'sse',
      'sse-optional': 'structured-or-sse',
      websocket: 'websocket',
      proxy: 'proxy',
    } as const

    for (const operation of PROTOCOL_ROUTE_OPERATION_CATALOG) {
      expect(operation.response, operation.id).toBe(responseByStream[operation.streaming])
    }
  })

  it('freezes reviewed non-default cache behavior by operation id', () => {
    const actual = PROTOCOL_ROUTE_OPERATION_CATALOG.filter(({ cache }) => cache !== 'unspecified').map(
      ({ id, cache }) => `${id}:${cache}`,
    )
    expect(actual).toEqual([
      'diagnostics-read:no-store',
      'support-diagnostics-read:no-store',
      'browser-diagnostics-upload:no-store',
      'settings-cache-read:request-hash',
      'settings-group-cache-read:request-hash',
      'collections-cache-read:request-hash',
      'collection-cache-read:request-hash',
      'character-aggregate-cache-read:request-hash',
      'characters-cache-read:request-hash',
      'chat-lore-token-counts:no-store',
      'character-lorebook-cache-read:request-hash',
      'legacy-preset-cache-read:request-hash',
      'prompt-preset-template-cache-read:request-hash',
      'bardwiki-vault-export:no-store',
      'bardwiki-chat-read:conditional',
      'bardwiki-document-read:conditional',
      'bardwiki-document-versions-read:conditional',
      'bardwiki-receipts-read:conditional',
      'events:no-cache',
      'asset-read:immutable',
      'storage-usage:no-store',
      'request-history-list:no-store',
      'request-history-detail:no-store',
      'mcp-oauth-refresh:no-store',
      'embedding-operations:no-store',
      'provider-operations:no-store',
      'openai-transcription:no-store',
      'tts-synthesis:no-store',
      'image-generation:no-store',
      'generation-completion:no-store',
      'generation-operation-stream:no-cache',
      'generation-chat:no-cache',
      'generation-chat-reattach:no-cache',
      'generation-chat-terminal-snapshot:no-store',
      'memory-job-list:conditional',
    ])
  })

  it('freezes reviewed durable lifecycle tags by operation id', () => {
    const actual = PROTOCOL_ROUTE_OPERATION_CATALOG.filter(({ durability }) => durability !== 'none').map(
      ({ id, durability }) => `${id}:${durability}`,
    )
    expect(actual).toEqual([
      'command-mutation-receipt-ack:revisioned-command',
      'commands:revisioned-command',
      'bardwiki-job-retry:server-job',
      'bardwiki-job-cancel:server-job',
      'proxy-stream-job-create:server-job',
      'proxy-stream-job-cancel:server-job',
      'proxy-stream-job-websocket:server-job',
      'generation-operation-submit:durable-generation',
      'generation-operation-status:durable-generation',
      'generation-operation-stream:durable-generation',
      'generation-operation-cancel:durable-generation',
      'generation-operation-retry:durable-generation',
      'generation-effect-status:durable-generation',
      'generation-effect-claim:durable-generation',
      'generation-effect-lease:durable-generation',
      'generation-effect-receipt:durable-generation',
      'generation-chat:server-job',
      'generation-chat-reattach:server-job',
      'generation-chat-terminal-snapshot:server-job',
      'generation-chat-cancel:server-job',
      'memory-job-create:server-job',
      'memory-job-list:server-job',
      'memory-job-cancel:server-job',
    ])
  })

  it('matches exact, prefix, and parameterized path policies without granting authority', () => {
    const health = findProtocolRouteOperationById('health')!
    expect(protocolRouteOperationMatches(health, 'GET', '/api/v1/health')).toBe(true)
    expect(protocolRouteOperationMatches(health, 'POST', '/api/v1/health')).toBe(false)

    const commands = findProtocolRouteOperationById('commands')!
    expect(protocolRouteOperationMatches(commands, 'PATCH', '/api/v1/commands/settings/runtime')).toBe(true)
    expect(protocolRouteOperationMatches(commands, 'GET', '/api/v1/commands/settings/runtime')).toBe(false)

    const operation = findProtocolRouteOperationById('generation-operation-status')!
    expect(protocolRouteOperationMatches(operation, 'GET', '/api/v1/generation-operations/operation-a')).toBe(true)
    expect(protocolRouteOperationMatches(operation, 'GET', '/api/v1/generation-operations/operation-a/stream')).toBe(
      false,
    )
  })
})
