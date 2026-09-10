import { beforeEach, describe, expect, test, vi } from 'vitest'
import { compressImage } from '../compressImage'

const { database } = vi.hoisted(() => ({
  database: {
    imageCompression: false,
  },
}))

vi.mock(
  import('../../../server/resourceState.svelte'),
  () =>
    ({
      settingsResourceState: {
        value: database,
        groupStatuses: { media: 'ready' },
        status: 'ready',
      },
    }) as unknown as typeof import('../../../server/resourceState.svelte'),
)

const doLossyCompressionMock = vi.fn()
vi.mock(import('../lossyCompression'), () => ({
  doLossyCompression: (...args: any[]) => doLossyCompressionMock(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('imageCompression disabled', () => {
  beforeEach(() => {
    database.imageCompression = false
  })

  test('returns original data without compression', async () => {
    const originalData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG
    const result = await compressImage(originalData)
    expect(result).toBe(originalData)
  })
})

describe('imageCompression enabled', () => {
  beforeEach(() => {
    database.imageCompression = true
  })

  test.each<[string, Uint8Array]>([
    ['Unknown', new Uint8Array([0x00, 0x01, 0x02, 0x03])],
    ['WEBP', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])],
    ['AVIF', new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])],
  ])('returns original data for %s', async (_type, originalData) => {
    const result = await compressImage(originalData)
    expect(result).toBe(originalData)
  })

  test.each<[string, Uint8Array]>([
    ['PNG', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['JPEG', new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0xff, 0xd9])],
    ['GIF', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
    ['BMP', new Uint8Array([0x42, 0x4d, 0x00, 0x00])],
  ])('calls doLossyCompression for %s', async (_type, originalData) => {
    const mockCompressed = Buffer.from([0x01, 0x02, 0x03])
    doLossyCompressionMock.mockResolvedValue(mockCompressed)

    const result = await compressImage(originalData)

    expect(doLossyCompressionMock).toHaveBeenCalledWith(originalData)
    expect(result).toBe(mockCompressed)
  })
})
