import { describe, expect, it } from 'vitest'

import type { OnnxModelFiles } from 'src/ts/process/transformers'

import {
  applyFreshCharacterGptSoVitsReferenceAudioUpload,
  applyFreshCharacterVitsModelRegistration,
  beginCharacterTtsAssetUpload,
  captureCharacterTtsAssetUploadTarget,
  clearCharacterTtsAssetUpload,
  type CharacterGptSoVitsRefAudioData,
  type CharacterTtsAssetUploadKind,
  type CharacterTtsAssetUploadOperation,
} from './characterTtsAssetUpload'
import {
  expectCanceledPickerKeepsOperationCurrent,
  expectNewerOperationWins,
} from '../__tests__/latestOperationTestAssertions'

const vitsModel = (id: string): OnnxModelFiles => ({
  id,
  name: `${id}.zip`,
  files: {
    'model.onnx': `${id}-model-asset`,
  },
})

const refAudio = (name: string, assetId = `${name}-asset`): CharacterGptSoVitsRefAudioData => ({
  fileName: `${name}.wav`,
  assetId,
})

function beginUpload(input: {
  kind: CharacterTtsAssetUploadKind
  characterId?: string
  characterIndex?: number
  draftCharacterId?: string | null
  ttsMode?: string
  vits?: OnnxModelFiles
  refAudioData?: CharacterGptSoVitsRefAudioData
}): CharacterTtsAssetUploadOperation {
  const target = captureCharacterTtsAssetUploadTarget({
    characterId: input.characterId ?? 'char-a',
    characterIndex: input.characterIndex ?? 0,
    draftCharacterId: input.draftCharacterId ?? input.characterId ?? 'char-a',
    kind: input.kind,
    ttsMode: input.ttsMode ?? (input.kind === 'vits-model' ? 'vits' : 'gptsovits'),
    vits: input.vits,
    refAudioData: input.refAudioData,
  })

  if (!target) {
    throw new Error('expected character TTS upload target')
  }

  return beginCharacterTtsAssetUpload(target)
}

function applyVitsUpload(
  operation: CharacterTtsAssetUploadOperation,
  freshness?: Partial<{
    currentCharacterId: string | null
    rowCharacterId: string | null
    draftCharacterId: string | null
    ttsMode: string
    vits: OnnxModelFiles | null
  }>,
): OnnxModelFiles | null {
  return applyFreshCharacterVitsModelRegistration({
    operation,
    freshness: {
      currentCharacterId: freshness?.currentCharacterId ?? operation.characterId,
      rowCharacterId: freshness?.rowCharacterId ?? operation.characterId,
      draftCharacterId: freshness?.draftCharacterId ?? operation.draftCharacterId,
      ttsMode: freshness?.ttsMode ?? operation.ttsMode,
      vits: Object.hasOwn(freshness ?? {}, 'vits') ? freshness?.vits : undefined,
    },
    model: vitsModel('uploaded'),
  })
}

function applyRefAudioUpload(
  operation: CharacterTtsAssetUploadOperation,
  freshness?: Partial<{
    currentCharacterId: string | null
    rowCharacterId: string | null
    draftCharacterId: string | null
    ttsMode: string
    refAudioData: CharacterGptSoVitsRefAudioData | null
    uploadedRefAudioData: CharacterGptSoVitsRefAudioData
  }>,
): CharacterGptSoVitsRefAudioData | null {
  return applyFreshCharacterGptSoVitsReferenceAudioUpload({
    operation,
    freshness: {
      currentCharacterId: freshness?.currentCharacterId ?? operation.characterId,
      rowCharacterId: freshness?.rowCharacterId ?? operation.characterId,
      draftCharacterId: freshness?.draftCharacterId ?? operation.draftCharacterId,
      ttsMode: freshness?.ttsMode ?? operation.ttsMode,
      refAudioData: Object.hasOwn(freshness ?? {}, 'refAudioData') ? freshness?.refAudioData : undefined,
    },
    refAudioData: freshness?.uploadedRefAudioData ?? refAudio('uploaded'),
  })
}

describe('character TTS asset upload freshness', () => {
  it('rejects VITS completion after character switch or changed vits snapshot', () => {
    const baseModel = vitsModel('base')
    const switchedCharacterUpload = beginUpload({
      kind: 'vits-model',
      characterId: 'char-switch',
      vits: baseModel,
    })
    const editedVitsUpload = beginUpload({
      kind: 'vits-model',
      characterId: 'char-edit',
      vits: baseModel,
    })

    try {
      expect(
        applyVitsUpload(switchedCharacterUpload, {
          currentCharacterId: 'char-b',
          rowCharacterId: 'char-switch',
          draftCharacterId: 'char-b',
          vits: baseModel,
        }),
      ).toBeNull()

      expect(
        applyVitsUpload(editedVitsUpload, {
          vits: vitsModel('newer-local-model'),
        }),
      ).toBeNull()
    } finally {
      clearCharacterTtsAssetUpload(switchedCharacterUpload)
      clearCharacterTtsAssetUpload(editedVitsUpload)
    }
  })

  it('rejects GPT-SoVITS completion after character switch, changed ttsMode, or changed ref audio snapshot', () => {
    const baseAudio = refAudio('base')
    const switchedCharacterUpload = beginUpload({
      kind: 'gptsovits-ref-audio',
      characterId: 'char-switch',
      refAudioData: baseAudio,
    })
    const changedModeUpload = beginUpload({
      kind: 'gptsovits-ref-audio',
      characterId: 'char-mode',
      refAudioData: baseAudio,
    })
    const editedAudioUpload = beginUpload({
      kind: 'gptsovits-ref-audio',
      characterId: 'char-edit',
      refAudioData: baseAudio,
    })

    try {
      expect(
        applyRefAudioUpload(switchedCharacterUpload, {
          currentCharacterId: 'char-b',
          rowCharacterId: 'char-switch',
          draftCharacterId: 'char-b',
          refAudioData: baseAudio,
        }),
      ).toBeNull()

      expect(
        applyRefAudioUpload(changedModeUpload, {
          refAudioData: baseAudio,
          ttsMode: 'vits',
        }),
      ).toBeNull()

      expect(
        applyRefAudioUpload(editedAudioUpload, {
          refAudioData: refAudio('newer-local-audio'),
        }),
      ).toBeNull()
    } finally {
      clearCharacterTtsAssetUpload(switchedCharacterUpload)
      clearCharacterTtsAssetUpload(changedModeUpload)
      clearCharacterTtsAssetUpload(editedAudioUpload)
    }
  })

  it('lets the newer same-target upload win over an older delayed upload', () => {
    expectNewerOperationWins({
      begin: () => beginUpload({ kind: 'vits-model', characterId: 'char-a' }),
      complete: (operation) => applyVitsUpload(operation),
      expectedNewer: vitsModel('uploaded'),
      clear: clearCharacterTtsAssetUpload,
    })
  })

  it('does not let a canceled newer picker invalidate an older in-flight upload', () => {
    const baseAudio = refAudio('base')

    expectCanceledPickerKeepsOperationCurrent({
      begin: () =>
        beginUpload({
          kind: 'gptsovits-ref-audio',
          characterId: 'char-a',
          refAudioData: baseAudio,
        }),
      captureCanceledTarget: () =>
        captureCharacterTtsAssetUploadTarget({
          characterId: 'char-a',
          draftCharacterId: 'char-a',
          kind: 'gptsovits-ref-audio',
          ttsMode: 'gptsovits',
          refAudioData: baseAudio,
        }),
      complete: (operation) =>
        applyRefAudioUpload(operation, {
          refAudioData: baseAudio,
          uploadedRefAudioData: refAudio('older-upload'),
        }),
      expected: refAudio('older-upload'),
      clear: clearCharacterTtsAssetUpload,
    })
  })
})
