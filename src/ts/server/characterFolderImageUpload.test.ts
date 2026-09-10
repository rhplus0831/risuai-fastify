import { describe, expect, it } from 'vitest'

import {
  beginCharacterFolderImageUpload,
  captureCharacterFolderImageUploadTarget,
  clearCharacterFolderImageUpload,
  resolveFreshCharacterFolderImageUploadPatch,
  type CharacterFolderImageOrderEntry,
  type CharacterFolderImageRecord,
  type CharacterFolderImageUploadOperation,
  type CharacterFolderImageUploadPatch,
} from './characterFolderImageUpload'
import {
  expectCanceledPickerKeepsOperationCurrent,
  expectNewerOperationWins,
} from '../__tests__/latestOperationTestAssertions'

function folder(input: Partial<CharacterFolderImageRecord> & { id?: string } = {}): CharacterFolderImageRecord {
  return {
    id: input.id ?? 'folder-a',
    name: input.name ?? 'Folder',
    color: input.color ?? 'blue',
    data: input.data ?? ['char-a'],
    imgFile: input.imgFile,
    img: input.img,
  }
}

function beginUpload(
  input: {
    characterOrder?: CharacterFolderImageOrderEntry[]
    folderId?: string
  } = {},
): CharacterFolderImageUploadOperation {
  const characterOrder = input.characterOrder ?? [folder({ id: input.folderId ?? 'folder-a', imgFile: 'asset-old' })]
  const target = captureCharacterFolderImageUploadTarget({
    characterOrder,
    folderId: input.folderId ?? 'folder-a',
  })

  if (!target) {
    throw new Error('expected character folder image upload target')
  }

  return beginCharacterFolderImageUpload(target)
}

function resolveUpload(
  operation: CharacterFolderImageUploadOperation,
  characterOrder: CharacterFolderImageOrderEntry[],
  patch: CharacterFolderImageUploadPatch = { imgFile: 'asset-new', img: '/api/v1/assets/asset-new' },
): CharacterFolderImageUploadPatch | null {
  return resolveFreshCharacterFolderImageUploadPatch({
    operation,
    characterOrder,
    patch,
  })
}

describe('character folder image upload freshness', () => {
  it('rejects stale completion after the same folder image is reset', () => {
    const operation = beginUpload({
      characterOrder: [folder({ id: 'folder-a', imgFile: 'asset-old', img: 'old-src' })],
    })

    try {
      expect(resolveUpload(operation, [folder({ id: 'folder-a', imgFile: null, img: '' })])).toBeNull()
    } finally {
      clearCharacterFolderImageUpload(operation)
    }
  })

  it('lets the newer upload for the same folder win over an older delayed upload', () => {
    const characterOrder = [folder({ id: 'folder-a', imgFile: 'asset-old', img: 'old-src' })]

    expectNewerOperationWins({
      begin: () => beginUpload({ characterOrder }),
      complete: (operation, attempt) =>
        resolveUpload(operation, characterOrder, {
          imgFile: `asset-${attempt}`,
          img: `${attempt}-src`,
        }),
      expectedNewer: {
        imgFile: 'asset-newer',
        img: 'newer-src',
      },
      clear: clearCharacterFolderImageUpload,
    })
  })

  it('does not let a canceled newer picker invalidate an older selected upload', () => {
    const characterOrder = [folder({ id: 'folder-a', imgFile: 'asset-old', img: 'old-src' })]

    expectCanceledPickerKeepsOperationCurrent({
      begin: () => beginUpload({ characterOrder }),
      captureCanceledTarget: () =>
        captureCharacterFolderImageUploadTarget({
          characterOrder,
          folderId: 'folder-a',
        }),
      complete: (operation) => resolveUpload(operation, characterOrder),
      expected: {
        imgFile: 'asset-new',
        img: '/api/v1/assets/asset-new',
      },
      clear: clearCharacterFolderImageUpload,
    })
  })

  it('allows folder reorder, rename, and color changes when image fields are unchanged', () => {
    const operation = beginUpload({
      characterOrder: [folder({ id: 'folder-a', imgFile: 'asset-old', img: 'old-src' }), 'char-b'],
    })

    try {
      expect(
        resolveUpload(operation, [
          'char-b',
          folder({
            id: 'folder-a',
            imgFile: 'asset-old',
            img: 'old-src',
            name: 'Renamed',
            color: 'purple',
          }),
        ]),
      ).toEqual({
        imgFile: 'asset-new',
        img: '/api/v1/assets/asset-new',
      })
    } finally {
      clearCharacterFolderImageUpload(operation)
    }
  })

  it('drops completion when the target folder is missing', () => {
    const operation = beginUpload({
      characterOrder: [folder({ id: 'folder-a', imgFile: 'asset-old' })],
    })

    try {
      expect(resolveUpload(operation, [folder({ id: 'folder-b', imgFile: 'asset-old' })])).toBeNull()
    } finally {
      clearCharacterFolderImageUpload(operation)
    }
  })
})
