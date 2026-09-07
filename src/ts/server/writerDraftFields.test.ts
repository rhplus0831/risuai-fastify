import { describe, expect, it } from 'vitest'
import { writerDraftValueFields } from './writerDraftFields'

describe('readable recovery fields', () => {
  it('omits unchanged values and marks a nested credential without losing readable draft text', () => {
    expect(
      writerDraftValueFields(
        { name: 'unchanged', desc: 'new draft', oaiTTSConfig: { model: 'tts', apiKey: 'draft-secret' } },
        { name: 'unchanged', desc: 'old draft', oaiTTSConfig: {} },
        { desc: 'Description' },
      ),
    ).toEqual([
      { label: 'Description', value: 'new draft' },
      { label: 'oaiTTSConfig', value: JSON.stringify({ model: 'tts', apiKey: 'draft-secret' }, null, 2), secret: true },
    ])
  })
})
