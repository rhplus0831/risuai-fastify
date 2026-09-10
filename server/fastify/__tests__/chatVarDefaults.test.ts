import { describe, expect, it } from 'vitest'
import { getChatDefaultVariables, readChatVariable } from '../src/prompt/chatVarDefaults.js'

describe('chat variable defaults', () => {
  it('keeps character rows before template rows and resolves the first duplicate', () => {
    const defaults = getChatDefaultVariables(
      { defaultVariables: 'shared=character\ncharacterOnly=one' },
      { templateDefaultVariables: 'shared=template\ntemplateOnly=two' },
    )

    expect(defaults).toEqual([
      ['shared', 'character'],
      ['characterOnly', 'one'],
      ['shared', 'template'],
      ['templateOnly', 'two'],
    ])
    expect(readChatVariable({}, 'shared', defaults)).toBe('character')
  })

  it('treats nullish defaults as empty and preserves stored-value precedence', () => {
    const defaults = getChatDefaultVariables({ defaultVariables: null }, { templateDefaultVariables: null })

    expect(defaults).toEqual([])
    expect(readChatVariable({ $value: '' }, 'value', [['value', 'default']])).toBe('')
    expect(readChatVariable({ $value: null }, 'value', [['value', 'default']])).toBe('default')
    expect(readChatVariable({}, 'missing', [])).toBeUndefined()
  })
})
