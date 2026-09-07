import {
  beginClientSession,
  settleClientReader,
  resetClientSessionForTests,
  authorizeClientWriterRecovery,
  setClientConnectionState,
  setClientProjectionReady,
  completeClientWriterRecovery,
} from '../../clientSession'
import { writable } from 'svelte/store'
import DOMPurify from 'dompurify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { language } from '../../../lang'
import {
  ParseMarkdown,
  chatHtmlRenderPolicyKey,
  parseThoughtsAndTools,
  risuChatParser,
  trimMarkdown,
} from '../parser.svelte'
import { createChatBodyRenderMemo } from '../../../lib/ChatScreens/ChatBodyRenderMemo'
import { pruneEmptyBilingualPairs } from '../../translator/bilingualInterleave'
import { charactersResourceState, settingsResourceState } from '../../server/resourceState.svelte'
import { CurrentTriggerIdStore } from '../../stores.svelte'

const mocks = vi.hoisted(() => ({
  processScriptFull: vi.fn(async (_char, source) => ({ data: 'script: ' + source })),
  displaySource: vi.fn(async () => ({ status: 'fallback', reason: 'forced_failure' })),
  limited: vi.fn(),
  db: {
    paragraphBreakBySentences: false,
    paragraphBreakSentenceCount: 3,
  },
}))

vi.mock('../../process/scripts', () => ({ processScriptFull: mocks.processScriptFull }))
vi.mock('../../server/displaySources', () => ({
  requestServerDisplaySource: mocks.displaySource,
  markReaderDisplayLimited: mocks.limited,
}))

vi.mock(
  import('../../storage/database.svelte'),
  () =>
    ({
      appVer: '1234.5.67',
      getCurrentCharacter: () => ({}),
      getDatabase: () => mocks.db,
      reapplyPendingPresetProjections: () => {},
    }) as unknown as typeof import('../../storage/database.svelte'),
)

vi.mock(import('../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('../../stores.svelte'), () => {
  return {
    selIdState: {
      selId: 0,
    },
    selectedCharID: writable(0),
    CurrentTriggerIdStore: writable(null),
  } as typeof import('../../stores.svelte')
})

const thoughtsDetails = (content: string) => `<details><summary>${language.cot}</summary>${content}</details>`

const toolCallHtml = (payload: string) =>
  `<div class="x-risu-tool-call">\ud83d\udee0\ufe0f ${language.toolCalled.replace(
    '{{tool}}',
    payload.split('\uf100')?.[1] ?? 'unknown',
  )}</div>\n\n`

beforeEach(() => {
  resetClientSessionForTests()
  mocks.processScriptFull.mockClear()
  mocks.displaySource.mockClear()
  mocks.limited.mockClear()
  mocks.db.paragraphBreakBySentences = false
  mocks.db.paragraphBreakSentenceCount = 3
  settingsResourceState.value = mocks.db
  settingsResourceState.status = 'ready'
  settingsResourceState.groupStatuses = { display: 'ready' }
  settingsResourceState.standaloneStatuses = {}
})

afterEach(() => {
  resetClientSessionForTests()
  vi.restoreAllMocks()
})

describe('ParseMarkdown sentence paragraph mode gating', () => {
  it('renders display-delimited formulas through real KaTeX MathML', async () => {
    const output = await ParseMarkdown('before $$x^2 + y^2$$ after', null, 'notrim')
    const root = document.createElement('div')
    root.innerHTML = output

    expect(root.querySelector('math[xmlns="http://www.w3.org/1998/Math/MathML"]')).not.toBeNull()
    expect(root.querySelector('msup')).not.toBeNull()
    expect(output).not.toContain('$$x^2 + y^2$$')
  })

  it('applies paragraph breaks in notrim mode but not pretranslate or back mode', async () => {
    const input = 'First sentence. Second sentence. Third sentence.'
    mocks.db.paragraphBreakBySentences = true
    mocks.db.paragraphBreakSentenceCount = 2

    await expect(ParseMarkdown(input, null, 'notrim')).resolves.toContain(
      '<p>First sentence. Second sentence.</p>\n<p>Third sentence.</p>',
    )
    await expect(ParseMarkdown(input, null, 'pretranslate')).resolves.toBe(input)
    await expect(ParseMarkdown(input, null, 'back')).resolves.toBe(input)
  })

  it('uses ready display settings and never falls back after a settings error', async () => {
    const input = 'First sentence. Second sentence.'
    settingsResourceState.value = {
      paragraphBreakBySentences: true,
      paragraphBreakSentenceCount: 1,
    }
    settingsResourceState.status = 'ready'
    settingsResourceState.groupStatuses.display = 'ready'

    await expect(ParseMarkdown(input, null, 'notrim')).resolves.toContain(
      '<p>First sentence.</p>\n<p>Second sentence.</p>',
    )

    mocks.db.paragraphBreakBySentences = true
    settingsResourceState.groupStatuses.display = 'error'
    await expect(ParseMarkdown(input, null, 'notrim')).resolves.not.toContain('<p>First sentence.</p>\n<p>')
  })
})

describe('trimMarkdown decoded-style sanitization', () => {
  it('skips empty initial output while still sanitizing whitespace and nonempty markup', () => {
    const sanitize = vi.spyOn(DOMPurify, 'sanitize')
    expect(trimMarkdown('')).toBe('')
    expect(sanitize).not.toHaveBeenCalled()

    expect(trimMarkdown(' ')).toBe(' ')
    expect(sanitize).toHaveBeenCalledTimes(1)
    expect(trimMarkdown('<p onclick="alert(1)">safe</p><script>alert(1)</script>')).toBe('<p>safe</p>')
    expect(sanitize).toHaveBeenCalledTimes(2)
  })

  it('re-sanitizes markup introduced by decodeStyle', () => {
    const injectedCss = '</style><script data-security-marker>alert(1)</script>{color:red}'
    const payload = `<risu-style>${Buffer.from(injectedCss).toString('hex')}</risu-style>`

    const output = trimMarkdown(payload)
    const root = document.createElement('div')
    root.innerHTML = output

    expect(root.querySelector('script')).toBeNull()
    expect(output).not.toContain('<script')
  })

  it('reuses sanitized HTML without retaining stale image policy or decoded unsafe markup', () => {
    const sanitize = vi.spyOn(DOMPurify, 'sanitize')
    const render = createChatBodyRenderMemo((html) => pruneEmptyBilingualPairs(trimMarkdown(html)))
    const injected = Buffer.from('</style><script>alert(1)</script>{color:red}').toString('hex')
    const input = `<img src="https://example.test/image.png"><risu-style>${injected}</risu-style>`
    const visible = render(input, '', chatHtmlRenderPolicyKey())
    const calls = sanitize.mock.calls.length
    expect(visible).toContain('https://example.test/image.png')
    expect(visible).not.toContain('<script')
    expect(render(input, '', chatHtmlRenderPolicyKey())).toBe(visible)
    expect(sanitize).toHaveBeenCalledTimes(calls)
    settingsResourceState.value.hideAllImages = true
    const hidden = render(input, '', chatHtmlRenderPolicyKey())
    expect(hidden).toContain('/none.webp')
    expect(hidden).not.toContain('https://example.test/image.png')
    expect(hidden).not.toContain('<script')
    const hiddenCalls = sanitize.mock.calls.length
    // Loading/error policies use the same effective value as the sanitizer.
    settingsResourceState.groupStatuses.display = 'error'
    expect(render(input, '', chatHtmlRenderPolicyKey())).toBe(visible)
    expect(sanitize).toHaveBeenCalledTimes(hiddenCalls)
  })
})

describe('parseThoughtsAndTools render fast paths', () => {
  it('marker-free thoughts/tools parsing returns unchanged without slicing', () => {
    const input = 'plain markdown with a stray </Thoughts> close marker only'
    const sliceSpy = vi.spyOn(String.prototype, 'slice')

    const output = parseThoughtsAndTools(input)
    const sliceCalls = sliceSpy.mock.calls.length
    sliceSpy.mockRestore()

    expect(output).toBe(input)
    expect(sliceCalls).toBe(0)
  })

  it('renders a single thoughts block', () => {
    expect(parseThoughtsAndTools('before <Thoughts>secret</Thoughts> after')).toBe(
      `before ${thoughtsDetails('secret')} after`,
    )
  })

  it('preserves nested thoughts while matching the outer block', () => {
    const input = 'A <Thoughts>outer <Thoughts>inner</Thoughts> tail</Thoughts> Z'

    expect(parseThoughtsAndTools(input)).toBe(`A ${thoughtsDetails('outer <Thoughts>inner</Thoughts> tail')} Z`)
  })

  it('preserves malformed unclosed thoughts and still converts later nested thoughts', () => {
    expect(parseThoughtsAndTools('<Thoughts>open ended')).toBe('<Thoughts>open ended')
    expect(parseThoughtsAndTools('<Thoughts>outer <Thoughts>inner</Thoughts> tail')).toBe(
      `<Thoughts>outer ${thoughtsDetails('inner')} tail`,
    )
  })

  it('replaces tool calls and preserves the unknown-tool fallback', () => {
    const knownPayload = 'request\uf100weather'

    expect(parseThoughtsAndTools(`<tool_call>${knownPayload}</tool_call>`)).toBe(toolCallHtml(knownPayload))
    expect(parseThoughtsAndTools('<tool_call>opaque</tool_call>')).toBe(toolCallHtml('opaque'))
  })

  it('replaces tool calls inside and outside thoughts after thoughts conversion', () => {
    const innerPayload = 'request\uf100lookup'
    const outerPayload = 'request\uf100done'

    expect(
      parseThoughtsAndTools(
        `A <Thoughts>plan <tool_call>${innerPayload}</tool_call></Thoughts> B <tool_call>${outerPayload}</tool_call>`,
      ),
    ).toBe(`A ${thoughtsDetails(`plan ${toolCallHtml(innerPayload)}`)} B ${toolCallHtml(outerPayload)}`)
  })
})

describe('risuChatParser function render path logging', () => {
  it('function definition and call parsing writes nothing to console.log', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const output = risuChatParser('before {{#function greet}}Hello {{arg::1}}{{/}}{{call::greet::Ada}} after')
    const logCalls = logSpy.mock.calls.length
    logSpy.mockRestore()

    expect(output).toBe('before Hello Ada after')
    expect(logCalls).toBe(0)
  })
})

describe('connected reader ParseMarkdown fallback', () => {
  const character = {
    chaId: 'reader-character',
    name: 'Reader character',
    type: 'character' as const,
    chatPage: 0,
    chats: [{ id: 'reader-chat', message: [] }],
  }
  beforeEach(() => {
    charactersResourceState.characters = [character as any]
    charactersResourceState.currentChar = 0
    charactersResourceState.status = 'ready'
  })
  it('keeps sanitized source readable on isolated display failure without invoking scripts', async () => {
    const operation = beginClientSession('reader')
    settleClientReader(operation, { databaseLineage: 'lineage', writer: { sessionId: 'other', epoch: 1 } })
    const html = await ParseMarkdown(
      '**readable** <script>unsafe()</script>',
      character as any,
      'normal',
      0,
      {},
      { chatId: 'reader-chat' },
    )
    expect(html).toContain('<strong>readable</strong>')
    expect(html).not.toContain('<script>')
    expect(mocks.displaySource).toHaveBeenCalledOnce()
    expect(mocks.processScriptFull).not.toHaveBeenCalled()
    expect(mocks.limited).toHaveBeenCalledOnce()
  })
  it('does not turn a reader parse into general script work if authority changes while awaiting display', async () => {
    const operation = beginClientSession('reader')
    settleClientReader(operation, { databaseLineage: 'lineage', writer: { sessionId: 'other', epoch: 1 } })
    let resolveDisplay!: (result: { status: string; reason: string }) => void
    mocks.displaySource.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDisplay = resolve
      }),
    )
    const rendered = ParseMarkdown('readable', character as any, 'normal', 0, {}, { chatId: 'reader-chat' })
    await vi.waitFor(() => expect(mocks.displaySource).toHaveBeenCalled())
    const writing = beginClientSession('writer')
    authorizeClientWriterRecovery(writing, { databaseLineage: 'lineage', writer: { sessionId: 'writer', epoch: 2 } })
    setClientConnectionState('live')
    setClientProjectionReady(true)
    completeClientWriterRecovery(writing)
    resolveDisplay({ status: 'fallback', reason: 'forced_failure' })
    expect(await rendered).toContain('readable')
    expect(mocks.processScriptFull).not.toHaveBeenCalled()
  })
  it('honors an explicit read-only display even when the client otherwise has writer access', async () => {
    const html = await ParseMarkdown(
      '**readable**',
      character as any,
      'normal',
      0,
      {},
      { chatId: 'reader-chat', readOnly: true },
    )
    expect(html).toContain('<strong>readable</strong>')
    expect(mocks.processScriptFull).not.toHaveBeenCalled()
  })
  it('does not borrow an active writer trigger when requesting reader display', async () => {
    CurrentTriggerIdStore.set('writer-trigger')
    try {
      const html = await ParseMarkdown(
        'reader source',
        character as any,
        'normal',
        0,
        {},
        {
          chatId: 'reader-chat',
          readOnly: true,
        },
      )
      expect(html).toContain('reader source')
      expect(mocks.displaySource).toHaveBeenCalledOnce()
      expect(mocks.processScriptFull).not.toHaveBeenCalled()
    } finally {
      CurrentTriggerIdStore.set(null)
    }
  })
  it('preserves the normal writer script fallback', async () => {
    const html = await ParseMarkdown('readable', character as any, 'normal', 0, {}, { chatId: 'reader-chat' })
    expect(html).toContain('script: readable')
    expect(mocks.processScriptFull).toHaveBeenCalledOnce()
    expect(mocks.limited).not.toHaveBeenCalled()
  })
})
