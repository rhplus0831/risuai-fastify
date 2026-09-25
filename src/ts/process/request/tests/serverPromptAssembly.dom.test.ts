import { describe, expect, it } from 'vitest'

import type { character, Chat, Database } from '../../../storage/database.svelte'
import { resolveServerPromptAssembly, type ServerPromptAssemblyInput } from '../serverPromptAssembly'

const TAIL_REASON = 'Server prompt assembly for a send requires a text user or assistant tail message.'

function makeInput(overrides: Partial<ServerPromptAssemblyInput> = {}): ServerPromptAssemblyInput {
  return {
    database: { characters: [] } as unknown as Database,
    currentChar: { type: 'character', name: 'Tess', chaId: 'char-1', triggerscript: [] } as unknown as character,
    currentChat: { id: 'chat-1', message: [] } as unknown as Chat,
    ...overrides,
  }
}

describe('resolveServerPromptAssembly send-tail rejection', () => {
  it('names the caller and describes an empty transcript without message text', () => {
    const route = resolveServerPromptAssembly(
      makeInput({
        origin: 'send-chat',
        transcriptOwner: { messageCount: 12, sameMessageArray: false },
        generationOperationProtocol: false,
      }),
    )
    expect(route).toEqual({
      type: 'unsupported',
      reason: `${TAIL_REASON} [origin=send-chat mode=send count=0 tail=none pending=false shell=false owner=12/different protocol=false]`,
    })
  })

  it('reports the tail shape when the last message has no text data', () => {
    const route = resolveServerPromptAssembly(
      makeInput({
        origin: 'ui-send-preflight',
        pendingUserMessageSupplied: false,
        transcriptOwner: null,
        generationOperationProtocol: true,
        currentChat: {
          id: 'chat-1',
          message: [
            { role: 'char', data: 'secret greeting text', chatId: 'm1' },
            { role: 'user', data: undefined, chatId: 'm2', disabled: true },
          ],
        } as unknown as Chat,
      }),
    )
    expect(route.type).toBe('unsupported')
    if (route.type !== 'unsupported') throw new Error('expected an unsupported verdict')
    expect(route.reason).toBe(
      `${TAIL_REASON} [origin=ui-send-preflight mode=send count=2 tail=role:user,data:undefined,placeholder:false,chatId:true,disabled:true pending=false shell=false owner=none protocol=true]`,
    )
    expect(route.reason).not.toContain('secret greeting text')
  })

  it('keeps the bare reason shape for callers that pass no diagnostics', () => {
    const route = resolveServerPromptAssembly(makeInput())
    expect(route).toEqual({
      type: 'unsupported',
      reason: `${TAIL_REASON} [origin=unknown mode=send count=0 tail=none pending=false shell=false owner=unknown protocol=unknown]`,
    })
  })
})
