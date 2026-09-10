import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { parseChatMLRows } from './chatMLRows.js'

type OracleRole = 'system' | 'user' | 'assistant'

interface OracleRow {
  role: OracleRole
  content: string
  thoughts: string[]
}

const starter = '<|im_start|>'
const separator = '<|im_sep|>'
const ender = '<|im_end|>'
const thoughtsOpen = '<Thoughts>'
const thoughtsClose = '</Thoughts>'
const controlTokens = [starter, separator, ender, thoughtsOpen, thoughtsClose]
const plainField = fc
  .string({ unit: 'grapheme' })
  .filter((value) => controlTokens.every((token) => !value.includes(token)))
const nonEmptyPlainField = plainField.filter((value) => value.length > 0)
const role = fc.constantFrom('assistant', 'system', 'user')
const roleSeparator = fc.constantFrom(separator, '\n', ' ')
const unknownHeader = fc.tuple(nonEmptyPlainField, fc.constantFrom(separator, '\n')).filter(([prefix, suffix]) => {
  const header = `${prefix}${suffix}`
  return !(['assistant', 'system', 'user'] as const).some(
    (knownRole) =>
      header.startsWith(knownRole + separator) ||
      header.startsWith(knownRole + '\n') ||
      header.startsWith(knownRole + ' '),
  )
})

function parseBeforeExtraction(
  data: string,
  transformContent: (content: string) => string = (value) => value,
): OracleRow[] | null {
  const starter = '<|im_start|>'
  const separator = '<|im_sep|>'
  const ender = '<|im_end|>'
  const trimmedData = data.trim()
  if (!trimmedData.startsWith(starter)) return null

  return trimmedData
    .split(starter)
    .filter((value) => value !== '')
    .map((value) => {
      let role: OracleRole = 'user'
      if (value.startsWith('user' + separator)) {
        value = value.substring(4 + separator.length)
      } else if (value.startsWith('system' + separator)) {
        role = 'system'
        value = value.substring(6 + separator.length)
      } else if (value.startsWith('assistant' + separator)) {
        role = 'assistant'
        value = value.substring(9 + separator.length)
      } else if (value.startsWith('user ') || value.startsWith('user\n')) {
        value = value.substring(5)
      } else if (value.startsWith('system ') || value.startsWith('system\n')) {
        role = 'system'
        value = value.substring(7)
      } else if (value.startsWith('assistant ') || value.startsWith('assistant\n')) {
        role = 'assistant'
        value = value.substring(10)
      }
      value = value.trim()
      if (value.endsWith(ender)) value = value.substring(0, value.length - ender.length)
      const thoughts: string[] = []
      value = value.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (_match, body: string) => {
        thoughts.push(body)
        return ''
      })
      return { role, content: transformContent(value), thoughts }
    })
}

describe('ChatML row parsing', () => {
  it.each([
    '',
    'plain text',
    '  <|im_start|>user<|im_sep|>hello<|im_end|>  ',
    '<|im_start|>system<|im_sep|>rules<|im_end|>',
    '<|im_start|>assistant answer<|im_end|>',
    '<|im_start|>user\nquestion<|im_end|>',
    '<|im_start|>unknown<|im_sep|>content<|im_end|>',
    '<|im_start|><|im_start|>user<|im_sep|>content<|im_end|>',
    '<|im_start|>assistant<|im_sep|><Thoughts></Thoughts>visible<|im_end|>',
    '<|im_start|>assistant<|im_sep|><Thoughts>one\ntwo</Thoughts>visible<|im_end|>',
    '<|im_start|>assistant<|im_sep|><Thoughts>one</Thoughts>x<Thoughts>two</Thoughts>y<|im_end|>',
    '<|im_start|>user<|im_sep|>value<|im_end|><|im_end|>',
  ])('preserves historical parsing for %o', (input) => {
    expect(parseChatMLRows(input)).toEqual(parseBeforeExtraction(input))
  })

  it('preserves transform timing, callback order, and row-boundary isolation', () => {
    const input =
      '<|im_start|>user<|im_sep|><Thoughts>hidden</Thoughts>first<|im_end|>' +
      '<|im_start|>assistant<|im_sep|>second<|im_end|>'
    const actualTransform = vi.fn((content: string) => `${content}<|im_start|>system injected`)
    const oracleTransform = vi.fn((content: string) => `${content}<|im_start|>system injected`)

    expect(parseChatMLRows(input, actualTransform)).toEqual(parseBeforeExtraction(input, oracleTransform))
    expect(actualTransform.mock.calls).toEqual(oracleTransform.mock.calls)
    expect(actualTransform.mock.calls).toEqual([['first'], ['second']])
  })

  it('returns null for arbitrary input that does not trim to a ChatML starter', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme' }).filter((input) => !input.trim().startsWith(starter)),
        (input) => {
          expect(parseChatMLRows(input)).toBeNull()
        },
      ),
    )
  })

  it('parses arbitrary plain role rows without treating field data as syntax', () => {
    fc.assert(
      fc.property(role, role, plainField, roleSeparator, (role1, role2, content, rowSeparator) => {
        const input =
          `${starter}${role1}${rowSeparator}${content}${ender}` + `${starter}${role2}${rowSeparator}${content}${ender}`

        expect(parseChatMLRows(input)).toEqual([
          { role: role1, content: content.trimStart(), thoughts: [] },
          { role: role2, content: content.trimStart(), thoughts: [] },
        ])
      }),
    )
  })

  it('extracts arbitrary nonempty plain thoughts without changing adjacent content', () => {
    fc.assert(
      fc.property(nonEmptyPlainField, plainField, (thoughts, content) => {
        const input = `${starter}assistant${separator}${thoughtsOpen}${thoughts}${thoughtsClose}${content}${ender}`

        expect(parseChatMLRows(input)).toEqual([
          {
            role: 'assistant',
            content,
            thoughts: [thoughts],
          },
        ])
      }),
    )
  })

  it('keeps arbitrary unknown plain headers in user content', () => {
    fc.assert(
      fc.property(unknownHeader, plainField, ([prefix, headerSeparator], content) => {
        const input = `${starter}${prefix}${headerSeparator}${content}${ender}`

        expect(parseChatMLRows(input)).toEqual([
          {
            role: 'user',
            content: `${prefix}${headerSeparator}${content}`.trimStart(),
            thoughts: [],
          },
        ])
      }),
    )
  })
})
