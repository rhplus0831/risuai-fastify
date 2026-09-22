/** One entry corresponds to one call into `requestChatData`. */
export type ProviderScriptEntry =
  | {
      type: 'success'
      result: string
      model?: string
      special?: { emotion?: string }
    }
  | {
      type: 'fail'
      result: string
      model?: string
    }
  | {
      type: 'multiline'
      result: ['user' | 'char', string][]
      model?: string
      special?: { emotion?: string }
    }
  | {
      type: 'streaming'
      /** Each chunk is one frame the stream yields. */
      chunks: { [key: string]: string }[]
      model?: string
      special?: { emotion?: string }
    }

interface ProviderState {
  script: ProviderScriptEntry[]
  cursor: number
  calls: ProviderCall[]
}

export interface ProviderCall {
  arg: unknown
  model: unknown
}

const state: ProviderState = {
  script: [],
  cursor: 0,
  calls: [],
}

export function installProviderScript(script: ProviderScriptEntry[]): void {
  state.script = script
  state.cursor = 0
  state.calls = []
}

export function getProviderCalls(): ProviderCall[] {
  return state.calls
}

export function resetProviderState(): void {
  state.script = []
  state.cursor = 0
  state.calls = []
}

/** Drop-in replacement for `requestChatData`. */
export async function fakeRequestChatData(arg: unknown, model: unknown): Promise<unknown> {
  state.calls.push({ arg, model })

  const entry = state.script[state.cursor]
  if (!entry) {
    throw new Error(
      `providerFake: ran out of scripted responses at call #${state.cursor + 1}. ` +
        `Add another line to upstream/<fixture>.jsonl.`,
    )
  }
  state.cursor += 1

  if (entry.type === 'streaming') {
    const stream = new ReadableStream<{ [key: string]: string }>({
      start(controller) {
        for (const chunk of entry.chunks) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })
    return {
      type: 'streaming',
      result: stream,
      model: entry.model,
      special: entry.special,
    }
  }

  return entry
}
