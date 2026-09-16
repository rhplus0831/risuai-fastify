import { chatBodyMocks, setupChatBody, flushComponentPromises, deferred } from './ChatBody.testSupport'
import { CHAT_DISPLAY_SCHEDULER, createChatDisplayScheduler } from './chatDisplayScheduler'
import { CHAT_DISPLAY_COMMIT_COORDINATOR, createChatDisplayCommitCoordinator } from './chatDisplayCommitCoordinator'
import { flushSync } from 'svelte'
import { describe, expect, it, vi } from 'vitest'

describe('ChatBody display lifecycle', () => {
  const body = setupChatBody()

  it('reports the first display parse as pending until its rendered body settles', async () => {
    const parse = deferred<string>()
    const onInitialDisplayParseStart = vi.fn()
    const onInitialDisplayParseSettled = vi.fn()
    chatBodyMocks.ParseMarkdown.mockReturnValue(parse.promise)

    body.mount({
      msgDisplay: 'source message',
      allowClientTranslation: false,
      onInitialDisplayParseStart,
      onInitialDisplayParseSettled,
    })

    expect(onInitialDisplayParseStart).toHaveBeenCalledOnce()
    expect(onInitialDisplayParseSettled).not.toHaveBeenCalled()

    parse.resolve('parsed source message')
    await flushComponentPromises()

    expect(body.target.textContent).toContain('parsed source message')
    expect(onInitialDisplayParseSettled).toHaveBeenCalledOnce()
    expect(onInitialDisplayParseSettled).toHaveBeenCalledWith(onInitialDisplayParseStart.mock.calls[0][0])
  })

  it('settles on unmount and ignores a subsequent parse completion', async () => {
    const onInitialDisplayParseStart = vi.fn()
    const onInitialDisplayParseSettled = vi.fn()
    const parse = deferred<string>()
    chatBodyMocks.ParseMarkdown.mockReturnValue(parse.promise)
    const coordinator = createChatDisplayCommitCoordinator({
      applyBatch: (commits) => commits.forEach((commit) => commit()),
    })
    const commit = vi.spyOn(coordinator, 'commit')

    body.mount(
      {
        msgDisplay: 'source message',
        transcriptRowKey: 'unmounted-row',
        allowClientTranslation: false,
        onInitialDisplayParseStart,
        onInitialDisplayParseSettled,
      },
      new Map([[CHAT_DISPLAY_COMMIT_COORDINATOR, coordinator]]),
    )

    await body.unmount()
    expect(onInitialDisplayParseSettled).toHaveBeenCalledOnce()
    parse.resolve('obsolete rendered body')
    await flushComponentPromises()
    expect(body.target.textContent).toBe('')
    expect(commit).not.toHaveBeenCalled()
    coordinator.destroy()

    expect(onInitialDisplayParseStart).toHaveBeenCalledOnce()
    expect(onInitialDisplayParseSettled).toHaveBeenCalledOnce()
    expect(onInitialDisplayParseSettled).toHaveBeenCalledWith(onInitialDisplayParseStart.mock.calls[0][0])
  })

  it.each(['render', 'translate', 'unmount'] as const)(
    'registers a queued background body until %s',
    async (outcome) => {
      chatBodyMocks.ParseMarkdown.mockResolvedValue('queued message body')
      chatBodyMocks.translateHTML.mockResolvedValue('translated queued body')
      let runIdle: (() => void) | undefined
      const scheduler = createChatDisplayScheduler((run) => {
        runIdle = run
        return () => {
          runIdle = undefined
        }
      })
      scheduler.setScope('chat-a')
      const onInitialDisplayParseStart = vi.fn()
      const onInitialDisplayParseSettled = vi.fn()
      body.mount(
        {
          msgDisplay: 'queued message body',
          allowClientTranslation: outcome === 'translate',
          displayPriority: 'background',
          onInitialDisplayParseStart,
          onInitialDisplayParseSettled,
        },
        new Map([[CHAT_DISPLAY_SCHEDULER, scheduler]]),
      )
      expect(onInitialDisplayParseStart).toHaveBeenCalledOnce()
      expect(onInitialDisplayParseSettled).not.toHaveBeenCalled()
      expect(chatBodyMocks.ParseMarkdown).not.toHaveBeenCalled()
      expect(body.target.textContent).toBe('')

      if (outcome !== 'unmount') {
        scheduler.setPaused(false)
        runIdle!()
        await flushComponentPromises()
        if (outcome === 'translate') {
          expect(onInitialDisplayParseSettled).not.toHaveBeenCalled()
          expect(body.target.textContent).toBe('')
          // Automatic translation updates its bound flag before queuing the body.
          await vi.runOnlyPendingTimersAsync()
          await flushComponentPromises()
          runIdle!()
          await flushComponentPromises()
        }
        expect(body.target.textContent).toContain(
          outcome === 'translate' ? 'translated queued body' : 'queued message body',
        )
      } else {
        await body.unmount()
      }
      expect(onInitialDisplayParseStart).toHaveBeenCalledOnce()
      expect(onInitialDisplayParseSettled).toHaveBeenCalledOnce()
      expect(onInitialDisplayParseSettled).toHaveBeenCalledWith(onInitialDisplayParseStart.mock.calls[0][0])
      scheduler.destroy()
    },
  )

  it('keeps a completed off-screen background body uncommitted until it becomes visible', async () => {
    chatBodyMocks.ParseMarkdown.mockResolvedValue('held background body')
    let frame: (() => void) | undefined
    const coordinator = createChatDisplayCommitCoordinator({
      applyBatch: (commits) => commits.forEach((commit) => commit()),
      scheduleIdle: () => () => {},
      scheduleFrame(run) {
        frame = run
        return () => {
          if (frame === run) frame = undefined
        }
      },
    })
    coordinator.noteInteraction()
    const onInitialDisplayParseStart = vi.fn()
    const onInitialDisplayParseSettled = vi.fn()
    body.mount(
      {
        msgDisplay: 'held background body',
        allowClientTranslation: false,
        transcriptRowKey: 'row-a',
        onInitialDisplayParseStart,
        onInitialDisplayParseSettled,
      },
      new Map([[CHAT_DISPLAY_COMMIT_COORDINATOR, coordinator]]),
    )
    await flushComponentPromises()
    expect(body.target.textContent).toBe('')
    expect(onInitialDisplayParseSettled).not.toHaveBeenCalled()
    expect(coordinator.pending).toBe(1)

    coordinator.setVisible(['row-a'])
    frame?.()
    frame = undefined
    flushSync()
    expect(body.target.textContent).toContain('held background body')
    expect(onInitialDisplayParseSettled).toHaveBeenCalledOnce()
    coordinator.destroy()
  })

  it('requests anchor preservation for the first body finishing after the interaction grace', async () => {
    const parse = deferred<string>()
    chatBodyMocks.ParseMarkdown.mockReturnValue(parse.promise)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    let idle: (() => void) | undefined
    let frame: (() => void) | undefined
    const applyBatch = vi.fn((commits: readonly (() => void)[], _preserveAnchor: boolean) => {
      flushSync(() => commits.forEach((commit) => commit()))
    })
    const coordinator = createChatDisplayCommitCoordinator({
      applyBatch,
      scheduleIdle(run) {
        idle = run
        return () => {}
      },
      scheduleFrame(run) {
        frame = run
        return () => {}
      },
    })
    const settled = vi.fn()
    try {
      coordinator.noteInteraction()
      body.mount(
        {
          msgDisplay: 'late first body',
          allowClientTranslation: false,
          transcriptRowKey: 'late-row',
          onInitialDisplayParseSettled: settled,
        },
        new Map([[CHAT_DISPLAY_COMMIT_COORDINATOR, coordinator]]),
      )
      clock.mockReturnValue(12_000)
      idle!()
      parse.resolve('late rendered body')
      await flushComponentPromises()
      expect(body.target.textContent).toBe('')
      expect(settled).not.toHaveBeenCalled()

      frame!()
      expect(applyBatch).toHaveBeenCalledOnce()
      expect(applyBatch.mock.calls[0][1]).toBe(true)
      expect(body.target.textContent).toBe('late rendered body')
      expect(settled).toHaveBeenCalledOnce()
    } finally {
      coordinator.destroy()
      clock.mockRestore()
    }
  })
})
