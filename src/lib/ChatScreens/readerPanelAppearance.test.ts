import { describe, expect, it } from 'vitest'
import type { Database } from 'src/ts/storage/database.svelte'
import { getReaderMessageAppearance, getReaderPanelAppearance, hasReaderChatPanel } from './readerPanelAppearance'

function settings(type: 'light' | 'dark'): Partial<Database> {
  return {
    textTheme: 'standard',
    colorScheme: {
      type,
      bgcolor: type === 'light' ? '#ffffff' : '#282a36',
      textcolor: type === 'light' ? '#0f172a' : '#f8f8f2',
      textcolor2: type === 'light' ? '#5b677a' : '#94a3b8',
      darkbg: '#21222c',
      borderc: '#6272a4',
      selected: '#44475a',
      draculared: '#ff5555',
      darkBorderc: '#4b5563',
      darkbutton: '#374151',
    },
  }
}

function styles(style: string): Record<string, string> {
  return Object.fromEntries(
    style
      .split(';')
      .filter(Boolean)
      .map((entry) => entry.split(':')),
  )
}

describe('reader panel appearance', () => {
  it.each(['light', 'dark'] as const)('uses the confirmed %s palette without a transcript overlay', (tone) => {
    const display = settings(tone)
    const panel = getReaderPanelAppearance(display, false)
    expect(panel.tone).toBe(tone)
    expect(styles(panel.style)['--risu-theme-textcolor']).toBe(display.colorScheme!.textcolor)
    expect(styles(panel.style)['--color-textcolor']).toBe(display.colorScheme!.textcolor)
  })

  it.each(['waifu', 'waifuMobile'] as const)('reads the default %s panel as dark even under a light app', (theme) => {
    const display = { ...settings('light'), theme }
    const panel = getReaderPanelAppearance(display, hasReaderChatPanel(display, ''))
    expect(panel.tone).toBe('dark')
    for (const channel of panel.background) expect(channel).toBeCloseTo(51)
    expect(styles(panel.style)['--FontColorStandard']).toBe('#f8fafc')
    expect(styles(panel.style)['--reader-link-color']).toBe('#93c5fd')
  })

  it('matches configured light and dark panel colors instead of inheriting the app tone', () => {
    const light = getReaderPanelAppearance({ ...settings('dark'), textScreenColor: '#fef3c7' }, true)
    const dark = getReaderPanelAppearance({ ...settings('light'), textScreenColor: '#102030' }, true)
    expect(light.tone).toBe('light')
    expect(dark.tone).toBe('light') // 50% tint over white remains a light surface.
    expect(styles(light.style)['--FontColorStandard']).toBe('#1f2937')
    expect(styles(dark.style)['--FontColorStandard']).toBe('#0f172a')
    const darkAppPanel = getReaderPanelAppearance({ ...settings('dark'), textScreenColor: '#102030' }, true)
    expect(darkAppPanel.tone).toBe('dark')
  })

  it('applies the loaded-background panel only when the frame actually paints it', () => {
    const display = { ...settings('light'), theme: 'fastify' }
    expect(hasReaderChatPanel(display, '')).toBe(false)
    expect(hasReaderChatPanel(display, 'background: url(asset)')).toBe(true)
    expect(getReaderPanelAppearance(display, true).tone).toBe('dark')
  })

  it.each(['mobilechat', 'cardboard'])('keeps the fixed light %s message surface readable on a dark panel', (theme) => {
    const display = { ...settings('dark'), theme }
    const panel = getReaderPanelAppearance(display, true)
    const body = getReaderMessageAppearance(display, panel)
    expect(panel.tone).toBe('dark')
    expect(body.tone).toBe('light')
    expect(styles(body.style)['--FontColorStandard']).toBe('#1f2937')
    expect(styles(body.style)['--reader-link-color']).toBe('#1d4ed8')
  })

  it('retains readable custom text colors and replaces only colors that disappear on the panel', () => {
    const panel = getReaderPanelAppearance(
      {
        ...settings('light'),
        textTheme: 'custom',
        customTextTheme: {
          FontColorStandard: '#164e63',
          FontColorBold: '#312e81',
          FontColorItalic: '#831843',
          FontColorItalicBold: '#064e3b',
          FontColorQuote1: '#fefefe',
          FontColorQuote2: '#713f12',
        },
      },
      false,
    )
    const actual = styles(panel.style)
    expect(actual['--FontColorStandard']).toBe('#164e63')
    expect(actual['--FontColorBold']).toBe('#312e81')
    expect(actual['--FontColorItalic']).toBe('#831843')
    expect(actual['--FontColorItalicBold']).toBe('#064e3b')
    expect(actual['--FontColorQuote1']).toBe('#1d4ed8')
    expect(actual['--FontColorQuote2']).toBe('#713f12')
  })
})
