import { describe, expect, it } from 'vitest'
import { isPromptChatEvent } from '@risuai/protocol/generation-sse'
import { isStartupTelemetryConfiguration } from '@risuai/protocol/startup-telemetry'
import { formatPromptChatFrame } from '../src/prompt/sseEvents.js'

describe('shared protocol package server integration', () => {
  it('loads shared runtime validators in the strict Fastify project', () => {
    expect(isStartupTelemetryConfiguration({ version: 2, sampleRate: 1 })).toBe(true)
    expect(isPromptChatEvent({ type: 'token', content: 'hello' })).toBe(true)
  })

  it('keeps Fastify-specific SSE encoding around the shared event type', () => {
    expect(formatPromptChatFrame({ type: 'token', content: 'hello' })).toBe(
      'event: token\ndata: {"content":"hello"}\n\n',
    )
  })
})
