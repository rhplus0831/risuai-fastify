import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/lib/Setting/Pages/OtherBotSettings.svelte'), 'utf8')

describe('OtherBotSettings direct slider names', () => {
  it('keeps every direct slider named for its adjacent setting', () => {
    const sliderTags: string[] = source.match(/<SliderInput\b[\s\S]*?\/>/g) ?? []

    expect(sliderTags.length).toBeGreaterThan(0)
    expect(sliderTags.every((tag) => tag.includes('ariaLabel='))).toBe(true)
    expect(source).toContain('{@const loraScaleLabel = language.loraScaleLabel(index + 1)}')
    expect(source).toContain('<span class="text-textcolor">{loraScaleLabel}</span>')
    expect(source).toContain('ariaLabel={loraScaleLabel}')
  })
})
