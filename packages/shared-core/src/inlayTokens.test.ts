import { describe, expect, it } from 'vitest'
import { inlayTokenRegex } from './inlayTokens.js'

const INLAY_TOKEN_REGEX_BEFORE_EXTRACTION = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g
const CASE_VARIANT_INLAY_TOKEN_NEGATIVES = ['{{INLAY::asset}}', '{{Inlayed::asset}}']

describe('inlay token matching', () => {
  it.each([
    '{{inlay::asset-1}}',
    '{{inlayed::asset-2}}',
    '{{inlayeddata::asset-3}}',
    '{{inlay::a}}/{{inlay::b}}',
    '{{inlay::}}',
    '{{inlay ::asset}}',
    ...CASE_VARIANT_INLAY_TOKEN_NEGATIVES,
    '{{other::asset}}',
    '{{inlay::line\nbreak}}',
    '{{inlay::unterminated',
  ])('preserves replacement behavior for %o', (input) => {
    expect(input.replace(inlayTokenRegex, '[Image]')).toBe(
      input.replace(INLAY_TOKEN_REGEX_BEFORE_EXTRACTION, '[Image]'),
    )
  })

  it('remains reusable after matching and non-matching replacements', () => {
    expect(
      [...'{{inlayed::asset-2}}'.matchAll(inlayTokenRegex)].map((match) => [match[0], match[1], match[2]]),
    ).toEqual([['{{inlayed::asset-2}}', 'inlayed', 'asset-2']])
    expect('{{inlay::a}}'.replace(inlayTokenRegex, '[Image]')).toBe('[Image]')
    expect('no token'.replace(inlayTokenRegex, '[Image]')).toBe('no token')
    expect('{{inlayed::b}}'.replace(inlayTokenRegex, '[Image]')).toBe('[Image]')
    expect(inlayTokenRegex.lastIndex).toBe(0)
  })
})
