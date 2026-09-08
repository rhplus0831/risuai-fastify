import type { Database } from 'src/ts/storage/database.svelte'

type Rgb = [number, number, number]
export interface ReaderPanelAppearance {
  tone: 'light' | 'dark'
  background: Rgb
  style: string
}

function rgb(value: string | undefined): Rgb | undefined {
  if (!value || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return undefined
  const hex = value.length === 4 ? [...value.slice(1)].map((part) => part + part).join('') : value.slice(1)
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as Rgb
}

function luminance(color: Rgb): number {
  const linear = color.map((part) => {
    const value = part / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast(color: Rgb, background: Rgb): number {
  const values = [luminance(color), luminance(background)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}

function readable(color: string | undefined, background: Rgb, fallback: string): string {
  const parsed = rgb(color)
  if (parsed && contrast(parsed, background) >= 4.5) return color!
  return contrast(rgb(fallback)!, background) >= 4.5
    ? fallback
    : contrast([0, 0, 0], background) > contrast([255, 255, 255], background)
      ? '#000000'
      : '#ffffff'
}

function appearance(settings: Partial<Database>, background: Rgb, tone: 'light' | 'dark'): ReaderPanelAppearance {
  const dark = tone === 'dark'
  const text = readable(settings.colorScheme?.textcolor, background, dark ? '#f8fafc' : '#1f2937')
  const muted = readable(settings.colorScheme?.textcolor2, background, dark ? '#cbd5e1' : '#4b5563')
  const link = readable(undefined, background, dark ? '#93c5fd' : '#1d4ed8')
  const quote = readable(undefined, background, dark ? '#fcd34d' : '#92400e')
  const custom = settings.textTheme === 'custom' ? settings.customTextTheme : undefined
  const highContrast = settings.textTheme === 'highcontrast'
  const fonts = {
    FontColorStandard: readable(custom?.FontColorStandard, background, text),
    FontColorBold: readable(custom?.FontColorBold, background, highContrast ? link : text),
    FontColorItalic: readable(custom?.FontColorItalic, background, highContrast ? quote : muted),
    FontColorItalicBold: readable(custom?.FontColorItalicBold, background, highContrast ? quote : muted),
    FontColorQuote1: readable(custom?.FontColorQuote1, background, link),
    FontColorQuote2: readable(custom?.FontColorQuote2, background, quote),
  }
  return {
    tone,
    background,
    style:
      [
        `color:${text}`,
        `color-scheme:${tone}`,
        `--risu-theme-textcolor:${text}`,
        `--risu-theme-textcolor2:${muted}`,
        `--color-textcolor:${text}`,
        `--color-textcolor2:${muted}`,
        `--reader-body-color:${fonts.FontColorStandard}`,
        `--reader-link-color:${link}`,
        ...Object.entries(fonts).map(([key, value]) => `--${key}:${value}`),
      ].join(';') + ';',
  }
}

/** The frame adds its translucent panel for portrait themes or a loaded custom background. */
export function hasReaderChatPanel(settings: Partial<Database>, backgroundStyle: string): boolean {
  return settings.theme === 'waifu' || settings.theme === 'waifuMobile' || backgroundStyle.length > 2
}

/** Uses confirmed display settings only; it never reads the writer's global paint cache. */
export function getReaderPanelAppearance(settings: Partial<Database>, hasPanel: boolean): ReaderPanelAppearance {
  const schemeTone = settings.colorScheme?.type === 'light' ? 'light' : 'dark'
  const base = rgb(settings.colorScheme?.bgcolor) ?? (schemeTone === 'light' ? [255, 255, 255] : [40, 42, 54])
  if (!hasPanel) return appearance(settings, base as Rgb, schemeTone)
  const panel = rgb(settings.textScreenColor) ?? [0, 0, 0]
  // Match ChatScreenLayout: configured #RRGGBB80, otherwise black at 80% opacity.
  const alpha = settings.textScreenColor ? 128 / 255 : 0.8
  const background = panel.map((part, index) => part * alpha + base[index] * (1 - alpha)) as Rgb
  const tone = contrast([0, 0, 0], background) > contrast([255, 255, 255], background) ? 'light' : 'dark'
  return appearance(settings, background, tone)
}

export function getReaderMessageAppearance(
  settings: Partial<Database>,
  panel = getReaderPanelAppearance(settings, false),
): ReaderPanelAppearance {
  // Both message themes paint a light surface independently of the surrounding panel.
  return settings.theme === 'mobilechat' || settings.theme === 'cardboard'
    ? appearance(settings, [229, 231, 235], 'light')
    : panel
}
