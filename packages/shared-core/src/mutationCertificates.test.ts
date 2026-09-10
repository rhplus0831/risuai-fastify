import { describe, expect, it } from 'vitest'
import * as browserMutationCertificates from '../../../src/ts/personaMutationCertificate'
import * as sharedMutationCertificates from './mutationCertificates.js'

const {
  serializePersonaCollectionDigestInput,
  serializePersonaIdsDigestInput,
  serializePersonaProfileDigestInput,
  serializeScriptDefinitionCollectionDigestInput,
} = sharedMutationCertificates

describe('mutation certificate serialization', () => {
  it('keeps the browser compatibility facade exports identical', () => {
    for (const key of [
      'serializePersonaCollectionDigestInput',
      'serializePersonaIdsDigestInput',
      'serializePersonaProfileDigestInput',
    ] as const) {
      expect(browserMutationCertificates[key]).toBe(sharedMutationCertificates[key])
    }
  })

  it('preserves version prefixes and persona profile field order', () => {
    expect(serializePersonaIdsDigestInput(['persona-b', 'persona-a'])).toBe(
      'persona-mutation-ids-v1:["persona-b","persona-a"]',
    )
    expect(
      serializePersonaProfileDigestInput({
        note: 'Note',
        personaPrompt: 'Prompt',
        icon: 'icon.webp',
        name: 'Name',
      }),
    ).toBe('persona-mutation-profile-v1:{"name":"Name","icon":"icon.webp","personaPrompt":"Prompt","note":"Note"}')
  })

  it('canonicalizes object keys recursively without reordering arrays', () => {
    const left = [{ z: 1, nested: { z: 2, a: 3 }, list: [{ z: 4, a: 5 }, 'last'] }]
    const right = [{ list: [{ a: 5, z: 4 }, 'last'], nested: { a: 3, z: 2 }, z: 1 }]

    expect(serializePersonaCollectionDigestInput(left)).toBe(serializePersonaCollectionDigestInput(right))
    expect(serializeScriptDefinitionCollectionDigestInput(left)).toBe(
      serializeScriptDefinitionCollectionDigestInput(right),
    )
  })

  it.each([
    ['persona', serializePersonaCollectionDigestInput],
    ['script definition', serializeScriptDefinitionCollectionDigestInput],
  ] as const)('preserves own __proto__ keys for %s collections', (_label, serialize) => {
    const left = JSON.parse('[{"id":"a","__proto__":{"value":"left"}}]')
    const right = JSON.parse('[{"id":"a","__proto__":{"value":"right"}}]')

    expect(serialize(left)).not.toBe(serialize(right))
    expect(serialize(left)).toContain('"__proto__"')
  })
})
