import {
  setupChatTests,
  target,
  seedDatabase,
  settle,
  mountHarness,
  type ParserDependencyRow,
} from './Chat.testSupport'
import { describe, expect, it, vi } from 'vitest'

setupChatTests()

describe('Chat generation feedback', () => {
  it('announces the waiting phase without fabricated percentage progress', async () => {
    const rows: ParserDependencyRow[] = [
      {
        id: 'loading-row',
        data: 'previous response',
        generationStage: 3,
        isGenerationLoading: true,
        name: 'Parser Bot',
        role: 'char',
      },
    ]
    seedDatabase(rows)
    mountHarness(rows)
    await settle()

    const loading = target.querySelector<HTMLElement>('[role="status"][aria-busy="true"]')
    expect(loading).not.toBeNull()
    const track = loading?.querySelector('.chat-generation-loading-track')
    const fill = loading?.querySelector<HTMLElement>('.chat-generation-loading-fill')
    expect(track).toBeTruthy()
    expect(fill).not.toBeNull()
    expect(loading?.textContent).not.toMatch(/\d+%/)
    expect(loading?.querySelector('[aria-valuenow]')).toBeNull()
    expect(fill?.style.width).toBe('')
    expect(loading?.textContent).toContain('chatGenerationStageWaitingForModel')
    expect(target.textContent).not.toContain('previous response')
  })

  it('keeps a compact generating footer beside streamed projection text', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'))
    const rows: ParserDependencyRow[] = [
      {
        id: 'streaming-row',
        data: 'Partial streamed response',
        generationPhase: 'generating',
        generationStartedAt: Date.now() - 5_000,
        isGenerationLoading: true,
        isGenerationProjection: true,
        name: 'Parser Bot',
        role: 'char',
      },
    ]
    seedDatabase(rows)
    mountHarness(rows)
    await settle()

    expect(target.textContent).toContain('Partial streamed response')
    const footer = target.querySelector<HTMLElement>('[role="status"][aria-busy="true"]')
    expect(footer?.textContent).toContain('chatGenerationStageGenerating')
    expect(footer?.textContent).toContain('5s')
    expect(footer?.querySelector('.chat-generation-loading-track')).toBeNull()
  })
})
