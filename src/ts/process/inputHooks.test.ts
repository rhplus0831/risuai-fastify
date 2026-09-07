import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputHook } from '../storage/database.svelte'

const testState = vi.hoisted(() => ({
  encodeWithTokenizer: vi.fn(),
  parseChatML: vi.fn(),
  requestChatData: vi.fn(),
}))

vi.mock('../parser/chatML', () => ({
  parseChatML: testState.parseChatML,
}))

vi.mock('../tokenizer', () => ({
  encodeWithTokenizer: testState.encodeWithTokenizer,
}))

vi.mock('./request/request', () => ({
  requestChatData: testState.requestChatData,
}))

import { runInputHook } from './inputHooks'

function hook(prompt: string): InputHook {
  return {
    id: 'hook-a',
    name: 'Hook A',
    type: 'draft',
    prompt,
  }
}

function requestMessages(): OpenAIChat[] {
  return testState.requestChatData.mock.calls[0][0].formated
}

describe('runInputHook', () => {
  beforeEach(() => {
    resetClientSessionForTests()
    testState.encodeWithTokenizer.mockReset()
    testState.encodeWithTokenizer.mockImplementation(async (text: string) => new Array(text.length).fill(0))
    testState.parseChatML.mockReset()
    testState.parseChatML.mockReturnValue(null)
    testState.requestChatData.mockReset()
    testState.requestChatData.mockResolvedValue({ type: 'success', result: '  hook result  ' })
  })

  it('rejects Reader hooks before parsing, tokenization, or provider calls', async () => {
    setManagedReaderForTest()
    await expect(runInputHook(hook('hello'), { content: 'text', draft: '' })).rejects.toThrow(
      'client_write_access_required',
    )
    expect(testState.parseChatML).not.toHaveBeenCalled()
    expect(testState.encodeWithTokenizer).not.toHaveBeenCalled()
    expect(testState.requestChatData).not.toHaveBeenCalled()
  })

  it('does not submit a provider request after delayed history tokenization crosses re-promotion', async () => {
    setManagedWriterForTest()
    let release!: (value: number[]) => void
    testState.encodeWithTokenizer.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = runInputHook(hook('{{slot::history::1}}'), { content: 'text', draft: '' }, null, {
      messages: [{ role: 'user', data: 'history' }],
      greeting: { source: '' },
      messageIndex: 1,
      maxTokens: 1000,
    })
    await vi.waitFor(() => expect(testState.encodeWithTokenizer).toHaveBeenCalled())
    demoteAndRepromoteForTest()
    release([1])
    await expect(pending).rejects.toThrow('client_write_operation_stale')
    expect(testState.requestChatData).not.toHaveBeenCalled()
  })

  it('aborts a pending hook request and rejects its old result after re-promotion', async () => {
    setManagedWriterForTest()
    let release!: (value: unknown) => void
    testState.requestChatData.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = runInputHook(hook('rewrite'), { content: 'text', draft: '' })
    const requestSignal = testState.requestChatData.mock.calls[0][2] as AbortSignal
    expect(requestSignal.aborted).toBe(false)
    demoteAndRepromoteForTest()
    expect(requestSignal.aborted).toBe(true)
    release({ type: 'success', result: 'stale text' })
    await expect(pending).rejects.toThrow('client_write_operation_stale')
  })

  it('substitutes both literal slots and uses the single-user fallback', async () => {
    const signal = new AbortController().signal

    await expect(
      runInputHook(
        hook('Content={{slot::content}}; Draft={{slot::draft}}'),
        { content: 'hello', draft: 'draft' },
        signal,
      ),
    ).resolves.toBe('hook result')

    expect(testState.parseChatML).toHaveBeenCalledWith('Content=hello; Draft=draft')
    expect(requestMessages()).toEqual([{ role: 'user', content: 'Content=hello; Draft=draft' }])
    expect(testState.requestChatData).toHaveBeenCalledWith(
      {
        formated: [{ role: 'user', content: 'Content=hello; Draft=draft' }],
        bias: {},
        useStreaming: false,
        noMultiGen: true,
      },
      'otherAx',
      signal,
    )
  })

  it('uses parsed ChatML messages after slot substitution', async () => {
    const parsed: OpenAIChat[] = [
      { role: 'system', content: 'System hello' },
      { role: 'user', content: 'Draft draft text' },
    ]
    testState.parseChatML.mockReturnValueOnce(parsed)

    await runInputHook(
      hook('<|im_start|>system {{slot::content}}<|im_end|><|im_start|>user {{slot::draft}}<|im_end|>'),
      { content: 'hello', draft: 'draft text' },
    )

    expect(testState.parseChatML).toHaveBeenCalledWith(
      '<|im_start|>system hello<|im_end|><|im_start|>user draft text<|im_end|>',
    )
    expect(requestMessages()).toBe(parsed)
  })

  it('uses a hook model profile override while retaining the Other Auxiliary role', async () => {
    const selectedHook: InputHook = {
      ...hook('Rewrite the content.'),
      model: { mode: 'modelProfile', profileId: '  hook-profile  ' },
    }

    await runInputHook(selectedHook, { content: 'composer text', draft: '' })

    expect(testState.requestChatData).toHaveBeenCalledWith(
      {
        formated: [
          { role: 'system', content: 'Rewrite the content.' },
          { role: 'user', content: 'composer text' },
        ],
        bias: {},
        useStreaming: false,
        noMultiGen: true,
        profileIdOverride: 'hook-profile',
      },
      'otherAx',
      null,
    )
  })

  it('falls back to system prompt plus content when no slot marker exists', async () => {
    await runInputHook(hook('Rewrite the content.'), { content: 'composer text', draft: 'ignored draft' })

    expect(requestMessages()).toEqual([
      { role: 'system', content: 'Rewrite the content.' },
      { role: 'user', content: 'composer text' },
    ])
  })

  it('does not recognize the legacy misspelled content marker', async () => {
    await runInputHook(hook('Legacy {{solt::content}}'), { content: 'composer text', draft: '' })

    expect(requestMessages()).toEqual([
      { role: 'system', content: 'Legacy {{solt::content}}' },
      { role: 'user', content: 'composer text' },
    ])
  })

  it('treats a draft-only marker as a slot fallback', async () => {
    await runInputHook(hook('Review this draft: {{slot::draft}}'), { content: 'composer text', draft: 'draft text' })

    expect(requestMessages()).toEqual([{ role: 'user', content: 'Review this draft: draft text' }])
  })

  it('substitutes an empty draft without leaving the marker behind', async () => {
    await runInputHook(hook('{{slot::content}}\n---\n{{slot::draft}}'), { content: 'composer text', draft: '' })

    expect(testState.parseChatML).toHaveBeenCalledWith('composer text\n---\n')
    expect(requestMessages()).toEqual([{ role: 'user', content: 'composer text\n---\n' }])
  })

  it('expands aligned source and persisted-translation history windows', async () => {
    await runInputHook(
      hook('History:\n{{slot::history::2}}Translations:\n{{slot::historytrans::2}}Source={{slot::content}}'),
      { content: 'composer text', draft: '' },
      undefined,
      {
        messages: [
          { role: 'user', data: 'old source', translation: { text: 'old translated' } },
          { role: 'char', data: 'comment', isComment: true },
          { role: 'user', data: 'disabled', disabled: true },
          { role: 'char', data: 'new source' },
        ],
        messageIndex: 4,
        greeting: { source: 'unused greeting' },
        maxTokens: 10_000,
      },
    )

    const oldSource = 'user: old source\n\n---\n\n'
    const newSource = 'char: new source\n\n---\n\n'
    const oldTranslation = 'user: old translated\n\n---\n\n'
    const missingTranslation = 'char: \n\n---\n\n'
    const expanded =
      `History:\n${oldSource}${newSource}` +
      `Translations:\n${oldTranslation}${missingTranslation}` +
      'Source=composer text'
    expect(testState.parseChatML).toHaveBeenCalledWith(expanded)
    expect(requestMessages()).toEqual([{ role: 'user', content: expanded }])
    expect(testState.encodeWithTokenizer).toHaveBeenCalled()
  })

  it('uses the selected greeting when the requested history window exceeds stored messages', async () => {
    await runInputHook(hook('{{slot::history::2}}'), { content: 'composer text', draft: '' }, undefined, {
      messages: [{ role: 'user', data: 'prior source' }],
      messageIndex: 1,
      greeting: { source: 'selected greeting', translated: 'translated greeting' },
      maxTokens: 10_000,
    })

    expect(requestMessages()).toEqual([
      {
        role: 'user',
        content: 'char: selected greeting\n\n---\n\nuser: prior source\n\n---\n\n',
      },
    ])
  })

  it('resolves valid history slots to empty strings when no history context is available', async () => {
    await runInputHook(hook('History={{slot::history::5}}'), { content: 'composer text', draft: '' })

    expect(testState.encodeWithTokenizer).not.toHaveBeenCalled()
    expect(requestMessages()).toEqual([{ role: 'user', content: 'History=' }])
  })

  it('drops whole oldest entries from both history slots under the shared token budget', async () => {
    const newestSource = 'char: new source\n\n---\n\n'
    const newestTranslation = 'char: new translated\n\n---\n\n'
    await runInputHook(hook('{{slot::history::2}}|{{slot::historytrans::2}}'), { content: '', draft: '' }, undefined, {
      messages: [
        { role: 'user', data: 'old source', translation: { text: 'old translated' } },
        { role: 'char', data: 'new source', translation: { text: 'new translated' } },
      ],
      messageIndex: 2,
      greeting: { source: '' },
      maxTokens: newestSource.length + newestTranslation.length,
    })

    expect(requestMessages()).toEqual([{ role: 'user', content: `${newestSource}|${newestTranslation}` }])
  })

  it('does not interpret slot-shaped text introduced through content or draft values', async () => {
    await runInputHook(
      hook('{{slot::history::1}}Content={{slot::content}} Draft={{slot::draft}}'),
      { content: '{{slot::history::50}}', draft: '{{slot::content}}' },
      undefined,
      {
        messages: [{ role: 'char', data: 'prior source' }],
        messageIndex: 1,
        greeting: { source: '' },
        maxTokens: 10_000,
      },
    )

    expect(requestMessages()).toEqual([
      {
        role: 'user',
        content: 'char: prior source\n\n---\n\nContent={{slot::history::50}} Draft={{slot::content}}',
      },
    ])
  })
})
