import { describe, expect, it } from 'vitest'
import { languageEnglish } from './en'
import { languageKorean } from './ko'
import { languageGerman } from './de'
import { languageChinese } from './cn'
import { languageChineseTraditional } from './zh-Hant'
import { languageSpanish } from './es'
import { languageVietnamese } from './vi'

const packs = [
  { code: 'en', pack: languageEnglish },
  { code: 'ko', pack: languageKorean },
  { code: 'de', pack: languageGerman },
  { code: 'cn', pack: languageChinese },
  { code: 'zh-Hant', pack: languageChineseTraditional },
  { code: 'es', pack: languageSpanish },
  { code: 'vi', pack: languageVietnamese },
]

function leaves(value: unknown, prefix = ''): [string, unknown][] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, prefix ? `${prefix}.${key}` : key))
  }
  return [[prefix, value]]
}

function expectLabel(value: unknown, path: string) {
  expect(value, path).toEqual(expect.any(String))
  expect(value, path).toMatch(/\S/)
}

describe('language pack content contracts', () => {
  it('uses the requested chat-entry loading copy', () => {
    expect(languageEnglish.loadingChat).toBe('Loading chat…')
  })

  it('defines every English translation leaf directly in Korean with the same value type', () => {
    const korean = new Map(leaves(languageKorean))
    for (const [path, english] of leaves(languageEnglish)) {
      expect(korean.has(path), path).toBe(true)
      expect(typeof korean.get(path), path).toBe(typeof english)
      expect(Array.isArray(korean.get(path)), path).toBe(Array.isArray(english))
    }
  })

  describe.each(packs)('$code required labels', ({ pack }) => {
    it.each([
      'generationPersistenceQueued',
      'generationPersistenceStalled',
      'generationPersistenceTerminal',
      'generationPersistenceStalledLegacy',
    ] as const)('defines %s', (key) => {
      expectLabel(pack[key], key)
    })

    it.each(['stopping', 'failed', 'retry', 'savingStoppedPartial'] as const)('defines Stop label %s', (key) => {
      expectLabel(pack.generationStop[key], `generationStop.${key}`)
    })

    it.each(['failed', 'retry', 'retrying', 'discard', 'discarding'] as const)('defines recovery label %s', (key) => {
      expectLabel(pack.generationRecovery[key], `generationRecovery.${key}`)
    })

    it('defines every chat occupancy state, action, and feedback label', () => {
      const occupancy = pack.connectedReaders.chatOccupancy
      const englishKeys = Object.keys(languageEnglish.connectedReaders.chatOccupancy).sort()
      expect(Object.keys(occupancy).sort()).toEqual(englishKeys)
      for (const key of englishKeys) {
        expectLabel((occupancy as Record<string, unknown>)[key], `connectedReaders.chatOccupancy.${key}`)
      }
    })
  })

  it('describes retained chat-only submissions as uncertain rather than rejected', () => {
    const occupancy = languageEnglish.connectedReaders.chatOccupancy
    for (const text of [occupancy.sendQueued, occupancy.rerollRetained]) {
      expect(text).toContain('not yet confirmed')
      expect(text).not.toContain('has not been accepted')
    }
  })

  describe.each([
    { code: 'vi', pack: languageVietnamese },
    { code: 'ko', pack: languageKorean },
  ])('$code inlay count interpolation', ({ pack }) => {
    it.each(['inlayDeleteMultipleConfirm', 'inlayTotalAssets'] as const)(
      '%s renders the count without template syntax',
      (key) => {
        const raw = pack.playground[key]
        expect(raw.match(/\{count\}/g)).toHaveLength(1)
        expect(raw).not.toContain('${count}')
        for (const count of ['0', '3', '12']) {
          const rendered = raw.replace('{count}', count)
          expect(rendered).toContain(count)
          expect(rendered).not.toContain('{count}')
          expect(rendered).not.toContain(`$${count}`)
        }
      },
    )
  })
})
