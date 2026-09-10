import { describe, expect, it, vi } from 'vitest'

import { readBrowserClientContext } from './clientContext'

describe('reported browser client context', () => {
  it('captures the current browser snapshot without throwing on guarded host getters', () => {
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('vi-VN')
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(640)
    const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(480)
    try {
      expect(readBrowserClientContext()).toEqual({ browserLanguage: 'vi-VN', screenWidth: 640, screenHeight: 480 })
    } finally {
      language.mockRestore()
      width.mockRestore()
      height.mockRestore()
    }
  })

  it('does not throw when a screen-dimension getter throws', () => {
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('ko-KR')
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800)
    const height = vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      expect(readBrowserClientContext()).toEqual({ browserLanguage: 'ko-KR', screenWidth: 800 })
    } finally {
      language.mockRestore()
      width.mockRestore()
      height.mockRestore()
    }
  })
})
