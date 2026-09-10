import { describe, expect, it } from 'vitest'

import {
  appendFreshCharacterEmotionImages,
  beginCharacterEmotionUpload,
  captureCharacterEmotionUploadTarget,
  clearCharacterEmotionUpload,
  type CharacterEmotionImageEntry,
  type CharacterEmotionUploadOperation,
} from './characterEmotionUpload'
import {
  expectCanceledPickerKeepsOperationCurrent,
  expectNewerOperationWins,
} from '../__tests__/latestOperationTestAssertions'

const emotion = (name: string, path = `emotion-${name}`): CharacterEmotionImageEntry => [name, path]

function beginUpload(input: {
  characterId?: string
  characterIndex?: number
  emotionImages?: CharacterEmotionImageEntry[]
}): CharacterEmotionUploadOperation {
  const target = captureCharacterEmotionUploadTarget({
    characterId: input.characterId ?? 'char-a',
    characterIndex: input.characterIndex,
    emotionImages: input.emotionImages ?? [],
  })

  if (!target) {
    throw new Error('expected upload target')
  }

  return beginCharacterEmotionUpload(target)
}

describe('character emotion image upload freshness', () => {
  it('rejects completion after character switch, row replacement, or newer emotion edits', () => {
    const baseImages = [emotion('base')]
    const switchedCharacterUpload = beginUpload({
      characterId: 'char-switch',
      characterIndex: 0,
      emotionImages: baseImages,
    })
    const replacedRowUpload = beginUpload({
      characterId: 'char-row',
      characterIndex: 0,
      emotionImages: baseImages,
    })
    const editedListUpload = beginUpload({
      characterId: 'char-edit',
      characterIndex: 0,
      emotionImages: baseImages,
    })

    try {
      expect(
        appendFreshCharacterEmotionImages({
          operation: switchedCharacterUpload,
          freshness: {
            currentCharacterId: 'char-b',
            rowCharacterId: 'char-switch',
            draftCharacterId: 'char-b',
            emotionImages: baseImages,
          },
          entries: [emotion('late')],
        }),
      ).toBeNull()

      expect(
        appendFreshCharacterEmotionImages({
          operation: replacedRowUpload,
          freshness: {
            currentCharacterId: 'char-row',
            rowCharacterId: 'char-replacement',
            draftCharacterId: 'char-row',
            emotionImages: baseImages,
          },
          entries: [emotion('late')],
        }),
      ).toBeNull()

      expect(
        appendFreshCharacterEmotionImages({
          operation: editedListUpload,
          freshness: {
            currentCharacterId: 'char-edit',
            rowCharacterId: 'char-edit',
            draftCharacterId: 'char-edit',
            emotionImages: [...baseImages, emotion('newer-local-edit')],
          },
          entries: [emotion('late')],
        }),
      ).toBeNull()
    } finally {
      clearCharacterEmotionUpload(switchedCharacterUpload)
      clearCharacterEmotionUpload(replacedRowUpload)
      clearCharacterEmotionUpload(editedListUpload)
    }
  })

  it('rejects quick-add completion instead of overwriting a newer live emotion list', () => {
    const baseImages = [emotion('base')]
    const operation = beginUpload({ characterId: 'char-a', emotionImages: baseImages })

    try {
      const appended = appendFreshCharacterEmotionImages({
        operation,
        freshness: {
          currentCharacterId: 'char-a',
          rowCharacterId: 'char-a',
          emotionImages: [...baseImages, emotion('newer-live')],
        },
        entries: [emotion('late')],
      })

      expect(appended).toBeNull()
    } finally {
      clearCharacterEmotionUpload(operation)
    }
  })

  it('lets the newer upload for the same character win over an older delayed upload', () => {
    expectNewerOperationWins({
      begin: () => beginUpload({ characterId: 'char-a', emotionImages: [] }),
      complete: (operation, attempt) =>
        appendFreshCharacterEmotionImages({
          operation,
          freshness: {
            currentCharacterId: 'char-a',
            rowCharacterId: 'char-a',
            emotionImages: [],
          },
          entries: [emotion(attempt)],
        }),
      expectedNewer: [emotion('newer')],
      clear: clearCharacterEmotionUpload,
    })
  })

  it('does not let a canceled newer picker invalidate an older pending upload', () => {
    const baseImages = [emotion('base')]

    expectCanceledPickerKeepsOperationCurrent({
      begin: () => beginUpload({ characterId: 'char-a', emotionImages: baseImages }),
      captureCanceledTarget: () =>
        captureCharacterEmotionUploadTarget({
          characterId: 'char-a',
          emotionImages: baseImages,
        }),
      complete: (operation) =>
        appendFreshCharacterEmotionImages({
          operation,
          freshness: {
            currentCharacterId: 'char-a',
            rowCharacterId: 'char-a',
            emotionImages: baseImages,
          },
          entries: [emotion('older')],
        }),
      expected: [...baseImages, emotion('older')],
      clear: clearCharacterEmotionUpload,
    })
  })

  it('appends only when the character and emotion snapshot still match', () => {
    const baseImages = [emotion('base')]
    const operation = beginUpload({ characterId: 'char-a', emotionImages: baseImages })

    try {
      expect(
        appendFreshCharacterEmotionImages({
          operation,
          freshness: {
            currentCharacterId: 'char-a',
            rowCharacterId: 'char-a',
            emotionImages: baseImages,
          },
          entries: [emotion('fresh')],
        }),
      ).toEqual([...baseImages, emotion('fresh')])
    } finally {
      clearCharacterEmotionUpload(operation)
    }
  })
})
