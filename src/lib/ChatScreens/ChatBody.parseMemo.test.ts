import { seedDb, setupParseMemoTests, translateHTMLMock, type SeedDbOverrides } from './chatBodyParseMemoTestFixtures'
import { mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { applySettingsResource, settingsResourceState } from '../../ts/server/resourceState.svelte'
import type { Database } from '../../ts/storage/database.svelte'
import { RegexDisplayReloadPointer, reloadRegexDisplay } from '../../ts/process/regexDisplayReload'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const explicitRetranslateCacheKey = '<p>explicit source body</p>'
const mounted = new Set<ReturnType<typeof mount>>()
async function dispose(component: ReturnType<typeof mount>) {
  mounted.delete(component)
  await unmount(component)
}
setupParseMemoTests(async () => {
  for (const component of mounted) await dispose(component)
  document.body.innerHTML = ''
})

async function settleRenderWork() {
  for (let i = 0; i < 8; i += 1) {
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function waitForText(target: HTMLElement, expectedText: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await settleRenderWork()
    if ((target.textContent ?? '').includes(expectedText)) {
      return
    }
  }
  throw new Error(`Expected rendered text "${expectedText}", got "${target.textContent ?? ''}"`)
}

async function waitForParagraphCount(target: HTMLElement, expectedCount: number) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await settleRenderWork()
    if (target.querySelectorAll('p').length === expectedCount) return
  }
  throw new Error(`Expected ${expectedCount} paragraphs, got ${target.querySelectorAll('p').length}`)
}

async function loadChatBodyWithParseSpy() {
  const parserModule = await import('../../ts/parser/parser.svelte')
  const parseSpy = vi.spyOn(parserModule, 'ParseMarkdown')
  const memoModule = await import('./ChatBodyParseMemo')
  memoModule.clearChatBodyParseMemo()
  const { default: ChatBody } = await import('./ChatBody.svelte')
  return { ChatBody, memoModule, parseSpy }
}

function mountChatBody(
  ChatBody: Awaited<ReturnType<typeof loadChatBodyWithParseSpy>>['ChatBody'],
  target: HTMLElement,
  props: {
    msgDisplay: string
    character: string
    translated?: boolean
    retranslate?: boolean
  },
) {
  const component = mount(ChatBody, {
    target,
    props: {
      character: props.character,
      firstMessage: false,
      idx: 0,
      msgDisplay: props.msgDisplay,
      name: 'Parse Memo Character',
      role: 'char',
      translated: props.translated ?? false,
      translating: false,
      retranslate: props.retranslate ?? false,
      modelShortName: '',
    },
  })
  mounted.add(component)
  return component
}

describe('ChatBody memoized rendering', () => {
  it.each([
    { autoTranslate: false, translatorType: 'llm', autoTranslateCachedOnly: true },
    { autoTranslate: false, translatorType: 'google', autoTranslateCachedOnly: false },
  ])(
    'renders without checking the translation cache when automatic translation is disabled ($translatorType)',
    async (settings) => {
      const char = seedDb(settings as SeedDbOverrides)
      const { ChatBody } = await loadChatBodyWithParseSpy()
      const translator = await import('../../ts/translator/translator')
      const cacheLookup = vi.spyOn(translator, 'getLLMCache')
      const target = document.createElement('div')
      document.body.appendChild(target)
      const component = mountChatBody(ChatBody, target, { character: char.chaId, msgDisplay: 'one display key' })
      try {
        await waitForText(target, 'one display key')
        expect(cacheLookup).not.toHaveBeenCalled()
        expect(translateHTMLMock.calls).toHaveLength(0)
      } finally {
        await dispose(component)
        target.remove()
      }
    },
  )

  it('unchanged ChatBody remount performs zero additional ParseMarkdown calls', async () => {
    const char = seedDb()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const { ChatBody, parseSpy } = await loadChatBodyWithParseSpy()

    let component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'unchanged remount memo body',
    })
    await waitForText(target, 'unchanged remount memo body')
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0)

    await dispose(component)
    target.innerHTML = ''
    const callsBeforeRemount = parseSpy.mock.calls.length
    component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'unchanged remount memo body',
    })
    await waitForText(target, 'unchanged remount memo body')

    expect(parseSpy.mock.calls.length - callsBeforeRemount).toBe(0)
    await dispose(component)
  })

  it('changed ChatBody content misses the parse memo and renders the new body', async () => {
    const char = seedDb()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const { ChatBody, parseSpy } = await loadChatBodyWithParseSpy()

    let component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'initial memo body',
    })
    await waitForText(target, 'initial memo body')
    await dispose(component)
    target.innerHTML = ''

    const callsBeforeChange = parseSpy.mock.calls.length
    component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'changed memo body',
    })
    await waitForText(target, 'changed memo body')

    expect(parseSpy.mock.calls.length - callsBeforeChange).toBe(1)
    expect(parseSpy.mock.calls.at(-1)?.[0]).toBe('changed memo body')
    await dispose(component)
  })

  it('defers projected regex edits until the display activation epoch advances', async () => {
    const char = seedDb()
    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].customscript = [
        {
          id: 'deferred-display-script',
          comment: 'Deferred display script',
          in: 'visible',
          out: 'initial',
          type: 'editdisplay',
          flag: 'g',
          ableFlag: true,
        },
      ]
    })
    const target = document.createElement('div')
    document.body.appendChild(target)
    const { ChatBody, parseSpy } = await loadChatBodyWithParseSpy()
    const component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'visible body',
    })
    await waitForText(target, 'initial body')
    parseSpy.mockClear()

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].customscript![0].out = 'activated'
    })
    await settleRenderWork()

    expect(parseSpy).not.toHaveBeenCalled()
    expect(target.textContent).toContain('initial body')

    RegexDisplayReloadPointer.update((value) => value + 1)
    await waitForText(target, 'activated body')

    expect(parseSpy).toHaveBeenCalledOnce()
    await dispose(component)
  })

  it('re-renders an open message when sentence paragraph display settings change', async () => {
    const char = seedDb({
      paragraphBreakBySentences: false,
      paragraphBreakSentenceCount: 2,
    })
    const target = document.createElement('div')
    document.body.appendChild(target)
    const { ChatBody, parseSpy } = await loadChatBodyWithParseSpy()
    const component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'First sentence. Second sentence. Third sentence.',
    })

    await waitForParagraphCount(target, 1)
    parseSpy.mockClear()
    expect(
      applySettingsResource({
        revision: (settingsResourceState.revision ?? 0) + 1,
        settings: { ...settingsResourceState.value, paragraphBreakBySentences: true },
      }),
    ).toBe(true)
    reloadRegexDisplay()
    await waitForParagraphCount(target, 2)

    expect(parseSpy).toHaveBeenCalledOnce()
    expect([...target.querySelectorAll('p')].map((paragraph) => paragraph.textContent)).toEqual([
      'First sentence. Second sentence.',
      'Third sentence.',
    ])
    await dispose(component)
  })

  it('explicit retranslate still calls translateHTML with regenerate enabled', async () => {
    const char = seedDb({
      autoTranslate: true,
      autoTranslateCachedOnly: true,
      translatorType: 'llm',
      translateBeforeHTMLFormatting: false,
      legacyTranslation: false,
      translator: 'ja',
    } as Partial<Database>)
    const parserModule = await import('../../ts/parser/parser.svelte')
    vi.spyOn(parserModule, 'ParseMarkdown').mockImplementation(async (data) => `<p>${data}</p>`)
    const translatorModule = await import('../../ts/translator/translator')
    await translatorModule.setLLMCache(explicitRetranslateCacheKey, 'cached hit')
    translateHTMLMock.implementation = async () => 'explicit translated body'
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const { default: ChatBody } = await import('./ChatBody.svelte')
    const target = document.createElement('div')
    document.body.appendChild(target)

    const component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'explicit source body',
      translated: true,
      retranslate: true,
    })
    await waitForText(target, 'explicit translated body')

    expect(translateHTMLMock.calls).toContainEqual(['<p>explicit source body</p>', false, char.chaId, 0, true])
    await dispose(component)
  })
})
