import { beforeEach, describe, expect, it, vi } from 'vitest'

const alertTestState = vi.hoisted(() => ({
  alertStoreValue: { type: 'none', msg: '' } as Record<string, unknown>,
  alertStoreSet: vi.fn(),
  alertStoreSubscribers: new Set<(value: Record<string, unknown>) => void>(),
  settings: { usePlainFetch: false } as Record<string, unknown>,
  characters: [] as Array<Record<string, unknown>>,
}))

vi.mock('./stores/coreStores.svelte', () => ({
  CurrentTriggerIdStore: {
    subscribe: vi.fn(),
  },
  alertStore: {
    set: (value: Record<string, unknown>) => {
      alertTestState.alertStoreValue = value
      alertTestState.alertStoreSet(value)
      for (const subscriber of alertTestState.alertStoreSubscribers) subscriber(value)
    },
    subscribe: (run: (value: Record<string, unknown>) => void) => {
      alertTestState.alertStoreSubscribers.add(run)
      run(alertTestState.alertStoreValue)
      return () => alertTestState.alertStoreSubscribers.delete(run)
    },
  },
  selIdState: {
    selId: -1,
  },
  selectedCharID: {
    subscribe: vi.fn(),
  },
}))

vi.mock('./storage/database.svelte', () => ({
  appVer: 'test',
  getCurrentCharacter: vi.fn(() => undefined),
}))

vi.mock('./server/resourceState.svelte', () => ({
  settingsResourceState: { value: alertTestState.settings },
  charactersResourceState: { characters: alertTestState.characters },
}))

vi.mock('../lang', () => ({
  language: {
    errors: {
      networkFetch: 'Network fetch help',
      networkFetchPlain: 'Plain fetch help',
    },
  },
}))

vi.mock('src/lang', () => ({
  language: {
    errors: {
      networkFetch: 'Network fetch help',
      networkFetchPlain: 'Plain fetch help',
    },
  },
}))

import {
  alertClear,
  alertAddCharacter,
  alertCardExport,
  alertChatOptions,
  alertConfirm,
  alertError,
  alertInput,
  alertLogin,
  alertMd,
  alertModuleSelect,
  alertNormal,
  alertPluginConfirm,
  alertProgress,
  alertRequiredSelect,
  alertSelect,
  alertSelectChar,
  alertToast,
  alertRealmTerms,
  alertWait,
  beginAlertWait,
  cardExportCancelMessage,
  clearAlertWait,
  parseCardExportResult,
  resolveAlertConfirmation,
  resolveAlertInput,
  resolveAlertSelection,
  resolveAlertWorkflow,
  alertStore,
  updateAlertWait,
} from './alert'
beforeEach(() => {
  vi.unstubAllEnvs()
  alertTestState.alertStoreValue = { type: 'none', msg: '' }
  for (const subscriber of alertTestState.alertStoreSubscribers) subscriber(alertTestState.alertStoreValue)
  alertTestState.alertStoreSet.mockClear()
  alertTestState.settings.usePlainFetch = false
  alertTestState.characters.length = 0
  localStorage.clear()
})

describe('confirmation queue', () => {
  it('shows concurrent confirmations in FIFO order and keeps their yes/no results separate', async () => {
    const firstResult = alertConfirm('First confirmation')
    const secondResult = alertConfirm('Second confirmation')

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'First confirmation' })
    const firstOwner = alertTestState.alertStoreValue.dialogOwner as symbol

    expect(resolveAlertConfirmation(firstOwner, true)).toBe(true)
    await expect(firstResult).resolves.toBe(true)

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'Second confirmation' })
    const secondOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(secondOwner).not.toBe(firstOwner)

    expect(resolveAlertConfirmation(secondOwner, false)).toBe(true)
    await expect(secondResult).resolves.toBe(false)
    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'none', msg: 'no' })
  })

  it('shares FIFO ownership between normal and plugin confirmations', async () => {
    const firstResult = alertPluginConfirm('Plugin permission')
    const secondResult = alertConfirm('Follow-up confirmation')

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'pluginconfirm', msg: 'Plugin permission' })
    const firstOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertConfirmation(firstOwner, false)
    await expect(firstResult).resolves.toBe(false)

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'Follow-up confirmation' })
    const secondOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertConfirmation(secondOwner, true)
    await expect(secondResult).resolves.toBe(true)
  })

  it('advances the queue after owner-scoped cancellation', async () => {
    const firstResult = alertConfirm('Close this confirmation')
    const secondResult = alertConfirm('Show this after close')
    const firstOwner = alertTestState.alertStoreValue.dialogOwner as symbol

    resolveAlertConfirmation(firstOwner, false)

    await expect(firstResult).resolves.toBe(false)
    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'Show this after close' })

    const secondOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertConfirmation(secondOwner, true)
    await expect(secondResult).resolves.toBe(true)
  })

  it('waits for an unrelated modal instead of overwriting it', async () => {
    alertNormal('Read this notice first')

    const result = alertConfirm('Confirmation after notice')

    expect(alertTestState.alertStoreValue).toEqual({ type: 'normal', msg: 'Read this notice first' })

    alertClear()
    await vi.waitFor(() =>
      expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'Confirmation after notice' }),
    )

    const owner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertConfirmation(owner, true)
    await expect(result).resolves.toBe(true)
  })

  it('keeps an unrelated notice behind the active confirmation', async () => {
    let settled = false
    const confirmationResult = alertConfirm('Confirmation being answered').then((result) => {
      settled = true
      return result
    })
    const owner = alertTestState.alertStoreValue.dialogOwner as symbol

    alertNormal('Unrelated urgent notice')

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(alertTestState.alertStoreValue).toMatchObject({
      type: 'ask',
      msg: 'Confirmation being answered',
      dialogOwner: owner,
    })

    expect(resolveAlertConfirmation(owner, true)).toBe(true)
    await expect(confirmationResult).resolves.toBe(true)
    await vi.waitFor(() =>
      expect(alertTestState.alertStoreValue).toEqual({ type: 'normal', msg: 'Unrelated urgent notice' }),
    )

    alertClear()
  })

  it('ignores a stale response without resolving or hiding the active confirmation', async () => {
    const firstResult = alertConfirm('Old confirmation')
    const secondResult = alertConfirm('Current confirmation')
    const firstOwner = alertTestState.alertStoreValue.dialogOwner as symbol

    resolveAlertConfirmation(firstOwner, true)
    await expect(firstResult).resolves.toBe(true)
    const secondOwner = alertTestState.alertStoreValue.dialogOwner as symbol

    expect(resolveAlertConfirmation(firstOwner, false)).toBe(false)
    expect(alertTestState.alertStoreValue).toMatchObject({
      type: 'ask',
      msg: 'Current confirmation',
      dialogOwner: secondOwner,
    })

    resolveAlertConfirmation(secondOwner, false)
    await expect(secondResult).resolves.toBe(false)
  })

  it('preserves an unrelated dialog result before displaying a queued confirmation', async () => {
    const inputResult = alertInput('Name')
    const confirmationResult = alertConfirm('Continue after input')
    const inputOwner = alertTestState.alertStoreValue.dialogOwner as symbol

    resolveAlertInput(inputOwner, 'Risu')

    await expect(inputResult).resolves.toBe('Risu')
    await vi.waitFor(() =>
      expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'Continue after input' }),
    )

    const owner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertConfirmation(owner, true)
    await expect(confirmationResult).resolves.toBe(true)
  })
})

describe('passive alerts around response dialogs', () => {
  it.each([
    {
      name: 'error',
      show: () => alertError('Deferred error'),
      expected: { type: 'error', msg: 'Deferred error' },
    },
    {
      name: 'notice',
      show: () => alertNormal('Deferred notice'),
      expected: { type: 'normal', msg: 'Deferred notice' },
    },
    {
      name: 'wait status',
      show: () => alertWait('Deferred wait'),
      expected: { type: 'wait', msg: 'Deferred wait' },
    },
    {
      name: 'toast',
      show: () => alertToast('Deferred toast'),
      expected: { type: 'toast', msg: 'Deferred toast' },
    },
  ])('does not let a background $name consume an input result', async ({ show, expected }) => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const inputResult = alertInput('Name', undefined, 'default name')

      show()

      expect(alertTestState.alertStoreValue).toMatchObject({
        type: 'input',
        msg: 'Name',
        defaultValue: 'default name',
      })

      const owner = alertTestState.alertStoreValue.dialogOwner as symbol
      resolveAlertInput(owner, 'Risu')
      await expect(inputResult).resolves.toBe('Risu')
      await vi.waitFor(() => expect(alertTestState.alertStoreValue).toMatchObject(expected))
    } finally {
      alertClear()
      consoleErrorSpy.mockRestore()
    }
  })

  it('preserves the latest background status transition until a select dialog returns', async () => {
    const selectResult = alertSelect(['First', 'Second'], 'Choose one')

    alertWait('Loading background result')
    alertNormal('Background result is ready')

    expect(alertTestState.alertStoreValue).toMatchObject({
      type: 'select',
      msg: '__DISPLAY__Choose one||First||Second',
    })

    const owner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertSelection(owner, 1)
    await expect(selectResult).resolves.toBe('1')
    await vi.waitFor(() =>
      expect(alertTestState.alertStoreValue).toEqual({ type: 'normal', msg: 'Background result is ready' }),
    )

    alertClear()
  })

  it('clears a deferred background status without dismissing the active input', async () => {
    const inputResult = alertInput('Keep editing')

    alertWait('Short background task')
    alertClear()

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'input', msg: 'Keep editing' })

    const owner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertInput(owner, 'finished input')
    await expect(inputResult).resolves.toBe('finished input')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'none', msg: 'finished input', dialogOwner: owner })
  })

  it('can clear a deferred status after the input result but before that status is displayed', async () => {
    const inputResult = alertInput('Finish before cleanup')

    alertWait('Nearly finished background task')
    const owner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertInput(owner, 'saved input')
    await expect(inputResult).resolves.toBe('saved input')

    alertClear()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'none', msg: 'saved input', dialogOwner: owner })
  })
})

describe('owned workflow dialogs', () => {
  it.each([
    {
      name: 'add character',
      open: () => alertAddCharacter(),
      type: 'addchar',
      response: 'importCharacter',
      expected: 'importCharacter',
    },
    {
      name: 'chat options',
      open: () => alertChatOptions(),
      type: 'chatOptions',
      response: '1',
      expected: 1,
    },
    { name: 'login', open: () => alertLogin(), type: 'login', response: 'login-result', expected: 'login-result' },
    {
      name: 'character selection',
      open: () => alertSelectChar(),
      type: 'selectChar',
      response: 'character-a',
      expected: 'character-a',
    },
    {
      name: 'card export',
      open: () => alertCardExport('module'),
      type: 'cardexport',
      response: '{"type":"","type2":"module"}',
      expected: { type: '', type2: 'module' },
    },
    {
      name: 'module selection',
      open: () => alertModuleSelect(),
      type: 'selectModule',
      response: 'module-a',
      expected: 'module-a',
    },
  ])(
    'keeps the $name workflow active while passive status changes arrive',
    async ({ open, type, response, expected }) => {
      let settled = false
      const result = open().then((value) => {
        settled = true
        return value
      })
      const owner = alertTestState.alertStoreValue.dialogOwner as symbol

      alertNormal('Deferred workflow notice')
      alertWait('Deferred workflow wait')
      alertProgress('Deferred workflow progress', 50)
      alertMd('Deferred workflow markdown')
      alertClear()
      alertStore.set({ type: 'progress', msg: 'Direct deferred progress', progress: 75 })
      alertStore.set({ type: 'none', msg: '' })
      alertClear()

      await Promise.resolve()
      expect(settled).toBe(false)
      expect(alertTestState.alertStoreValue).toMatchObject({ type, dialogOwner: owner })

      expect(resolveAlertWorkflow(owner, response)).toBe(true)
      await expect(result).resolves.toEqual(expected)
    },
  )

  it('queues workflow dialogs with inputs and rejects stale workflow owners', async () => {
    const workflow = alertAddCharacter()
    const input = alertInput('Name after character action')
    const workflowOwner = alertTestState.alertStoreValue.dialogOwner as symbol

    resolveAlertWorkflow(workflowOwner, 'createfromScratch')
    await expect(workflow).resolves.toBe('createfromScratch')

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'input', msg: 'Name after character action' })
    const inputOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(resolveAlertWorkflow(workflowOwner, 'cancel')).toBe(false)
    resolveAlertInput(inputOwner, 'Character name')
    await expect(input).resolves.toBe('Character name')
  })
})

describe('input results', () => {
  it('queues concurrent inputs in FIFO order and never shares a submission', async () => {
    let secondSettled = false
    const first = alertInput('First input')
    const second = alertInput('Second input').then((value) => {
      secondSettled = true
      return value
    })

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'input', msg: 'First input' })
    const firstOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(resolveAlertInput(firstOwner, 'first value')).toBe(true)
    await expect(first).resolves.toBe('first value')
    expect(secondSettled).toBe(false)

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'input', msg: 'Second input' })
    const secondOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(secondOwner).not.toBe(firstOwner)
    expect(resolveAlertInput(firstOwner, 'stale value')).toBe(false)
    expect(resolveAlertInput(secondOwner, 'second value')).toBe(true)
    await expect(second).resolves.toBe('second value')
  })

  it('shares one FIFO scheduler with confirmations and selections', async () => {
    const input = alertInput('Input first')
    const confirmation = alertConfirm('Confirm second')
    const selection = alertSelect(['Select third'])

    const inputOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertInput(inputOwner, 'input result')
    await expect(input).resolves.toBe('input result')

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'Confirm second' })
    const confirmationOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertConfirmation(confirmationOwner, true)
    await expect(confirmation).resolves.toBe(true)

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'select', msg: 'Select third' })
    const selectionOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertSelection(selectionOwner, 0)
    await expect(selection).resolves.toBe('0')
  })
})

describe('select results', () => {
  it('returns a selected option index and converts dismissal into typed cancellation', async () => {
    const selected = alertSelect(['First', 'Second'])
    const selectedOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertSelection(selectedOwner, 1)
    await expect(selected).resolves.toBe('1')

    const cancelled = alertSelect(['First', 'Second'])
    const cancelledOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    resolveAlertSelection(cancelledOwner, null)
    await expect(cancelled).resolves.toBeNull()
  })

  it('does not expose malformed or out-of-range modal results as selections', async () => {
    const malformed = alertSelect(['Only option'])
    const malformedOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    alertStore.set({ type: 'none', msg: 'not-an-index', dialogOwner: malformedOwner })
    await expect(malformed).resolves.toBeNull()

    const outOfRange = alertSelect(['Only option'])
    const outOfRangeOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    alertStore.set({ type: 'none', msg: '1', dialogOwner: outOfRangeOwner })
    await expect(outOfRange).resolves.toBeNull()
  })

  it('queues concurrent selectors and keeps responses bound to their owners', async () => {
    const first = alertSelect(['First A', 'First B'])
    const second = alertSelect(['Second A'])

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'select', msg: 'First A||First B' })
    const firstOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(resolveAlertSelection(firstOwner, 1)).toBe(true)
    await expect(first).resolves.toBe('1')

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'select', msg: 'Second A' })
    const secondOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(secondOwner).not.toBe(firstOwner)
    expect(resolveAlertSelection(firstOwner, 0)).toBe(false)
    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'select', dialogOwner: secondOwner })

    expect(resolveAlertSelection(secondOwner, null)).toBe(true)
    await expect(second).resolves.toBeNull()
  })
})

describe('cancellable required selections', () => {
  it('closes only its active selection on abort and advances the queue without answering the next prompt', async () => {
    const controller = new AbortController()
    const selection = alertRequiredSelect(['Use this device', 'Keep reading'], 'Switch write access?', 'Write access', {
      signal: controller.signal,
      purpose: 'client-session',
    })
    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'select', purpose: 'client-session' })
    const selectionOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    let nextSettled = false
    const next = alertConfirm('Unrelated confirmation').then((result) => {
      nextSettled = true
      return result
    })

    controller.abort()

    await expect(selection).resolves.toBe('')
    expect(nextSettled).toBe(false)
    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'Unrelated confirmation' })
    const nextOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(nextOwner).not.toBe(selectionOwner)
    expect(resolveAlertSelection(selectionOwner, 0)).toBe(false)
    expect(alertTestState.alertStoreValue.dialogOwner).toBe(nextOwner)
    expect(resolveAlertConfirmation(nextOwner, true)).toBe(true)
    await expect(next).resolves.toBe(true)
  })

  it('removes only its queued selection when aborted behind an unrelated prompt', async () => {
    const current = alertInput('Keep editing this input')
    const currentOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    const controller = new AbortController()
    const selection = alertRequiredSelect(['Switch', 'Stay'], 'Queued switch', 'Write access', {
      signal: controller.signal,
    })
    const next = alertSelect(['First option', 'Second option'], 'Continue after input')
    alertTestState.alertStoreSet.mockClear()

    controller.abort()

    await expect(selection).resolves.toBe('')
    expect(alertTestState.alertStoreSet).not.toHaveBeenCalled()
    expect(alertTestState.alertStoreValue).toMatchObject({
      type: 'input',
      msg: 'Keep editing this input',
      dialogOwner: currentOwner,
    })
    expect(resolveAlertInput(currentOwner, 'Preserved input')).toBe(true)
    await expect(current).resolves.toBe('Preserved input')
    expect(alertTestState.alertStoreValue).toMatchObject({
      type: 'select',
      msg: '__DISPLAY__Continue after input||First option||Second option',
    })
    const nextOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(resolveAlertSelection(nextOwner, 1)).toBe(true)
    await expect(next).resolves.toBe('1')
  })

  it('detaches cancellation on normal settlement before the next prompt can be affected', async () => {
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    try {
      const selection = alertRequiredSelect(['Switch', 'Stay'], 'Switch?', 'Write access', {
        signal: controller.signal,
      })
      const selectionOwner = alertTestState.alertStoreValue.dialogOwner as symbol
      const next = alertRequiredSelect(['Continue', 'Stop'], 'Later choice', 'Another task')
      const abortListener = addListener.mock.calls.find(([event]) => event === 'abort')?.[1]

      expect(resolveAlertSelection(selectionOwner, 1)).toBe(true)
      expect(removeListener).toHaveBeenCalledWith('abort', abortListener)
      const nextOwner = alertTestState.alertStoreValue.dialogOwner as symbol
      alertTestState.alertStoreSet.mockClear()
      controller.abort()

      await expect(selection).resolves.toBe('1')
      expect(alertTestState.alertStoreSet).not.toHaveBeenCalled()
      expect(alertTestState.alertStoreValue).toMatchObject({
        type: 'select',
        msg: '__DISPLAY__Later choice||Continue||Stop',
        dialogOwner: nextOwner,
        dismissible: false,
      })
      expect(resolveAlertSelection(nextOwner, 0)).toBe(true)
      await expect(next).resolves.toBe('0')
    } finally {
      addListener.mockRestore()
      removeListener.mockRestore()
    }
  })

  it('enqueues nothing for an already-aborted signal and preserves the active notice', async () => {
    alertNormal('Read this notice')
    const controller = new AbortController()
    controller.abort()
    alertTestState.alertStoreSet.mockClear()

    await expect(
      alertRequiredSelect(['Switch', 'Stay'], 'Obsolete switch', 'Write access', { signal: controller.signal }),
    ).resolves.toBe('')
    expect(alertTestState.alertStoreSet).not.toHaveBeenCalled()
    expect(alertTestState.alertStoreValue).toEqual({ type: 'normal', msg: 'Read this notice' })

    const next = alertConfirm('After the notice')
    alertClear()
    await vi.waitFor(() =>
      expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'After the notice' }),
    )
    expect(resolveAlertConfirmation(alertTestState.alertStoreValue.dialogOwner as symbol, true)).toBe(true)
    await expect(next).resolves.toBe(true)
  })

  it('preserves required-selection metadata, index validation, and shared FIFO order without a signal', async () => {
    const first = alertConfirm('First confirmation')
    const firstOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    const selection = alertRequiredSelect(['Switch', 'Stay'], 'Switch write access?', 'Write access')
    const last = alertInput('Last input')

    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'ask', msg: 'First confirmation' })
    expect(resolveAlertConfirmation(firstOwner, true)).toBe(true)
    await expect(first).resolves.toBe(true)
    expect(alertTestState.alertStoreValue).toMatchObject({
      type: 'select',
      msg: '__DISPLAY__Switch write access?||Switch||Stay',
      title: 'Write access',
      dismissible: false,
    })
    const selectionOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(resolveAlertSelection(selectionOwner, 2)).toBe(false)
    expect(alertTestState.alertStoreValue.dialogOwner).toBe(selectionOwner)
    expect(resolveAlertSelection(selectionOwner, 0)).toBe(true)
    await expect(selection).resolves.toBe('0')
    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'input', msg: 'Last input' })
    const lastOwner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(resolveAlertInput(lastOwner, 'Last result')).toBe(true)
    await expect(last).resolves.toBe('Last result')
  })
})

describe('client-session inputs', () => {
  it('preserves the purpose on the displayed input alert', async () => {
    const input = alertInput('Server password', undefined, undefined, { purpose: 'client-session' })

    expect(alertTestState.alertStoreValue).toMatchObject({
      type: 'input',
      msg: 'Server password',
      purpose: 'client-session',
    })

    const owner = alertTestState.alertStoreValue.dialogOwner as symbol
    expect(resolveAlertInput(owner, 'password')).toBe(true)
    await expect(input).resolves.toBe('password')
  })
})

describe('alertError', () => {
  it('accepts non-string payloads with String coercion after Error handling', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => alertError(undefined)).not.toThrow()
      expect(alertTestState.alertStoreSet).toHaveBeenLastCalledWith(expect.objectContaining({ msg: 'undefined' }))

      expect(() => alertError(null)).not.toThrow()
      expect(alertTestState.alertStoreSet).toHaveBeenLastCalledWith(expect.objectContaining({ msg: 'null' }))

      expect(() => alertError({ code: 'plain-object' })).not.toThrow()
      expect(alertTestState.alertStoreSet).toHaveBeenLastCalledWith(expect.objectContaining({ msg: '[object Object]' }))

      expect(() => alertError(Symbol('reason'))).not.toThrow()
      expect(alertTestState.alertStoreSet).toHaveBeenLastCalledWith(expect.objectContaining({ msg: 'Symbol(reason)' }))
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('keeps Error messages and stack traces intact', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const error = new Error('kept error')

      expect(() => alertError(error)).not.toThrow()

      expect(alertTestState.alertStoreSet).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'kept error',
          stackTrace: error.stack,
        }),
      )
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })
})

describe('card export results', () => {
  it('preserves valid selections', () => {
    expect(parseCardExportResult('{"type":"ccv2","type2":"png"}')).toEqual({ type: 'ccv2', type2: 'png' })
  })

  it('turns empty and malformed dismissal values into cancellation', () => {
    expect(parseCardExportResult('')).toEqual({ type: 'cancel', type2: '' })
    expect(parseCardExportResult('{"type":"ccv2"}')).toEqual({ type: 'cancel', type2: '' })
    expect(parseCardExportResult(cardExportCancelMessage('charx'))).toEqual({ type: 'cancel', type2: 'charx' })
  })
})

describe('alertProgress', () => {
  it('sets a progress alert with a clamped percentage', () => {
    alertProgress('Loading assets', 125, 'Saving embedded assets')

    expect(alertTestState.alertStoreSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'progress',
        msg: 'Loading assets',
        progress: 100,
        submsg: 'Saving embedded assets',
      }),
    )

    alertProgress('Loading assets', -10)
    expect(alertTestState.alertStoreSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'progress',
        msg: 'Loading assets',
        progress: 0,
      }),
    )
  })

  it('supports indeterminate progress alerts', () => {
    alertProgress('Working', null)

    expect(alertTestState.alertStoreSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'progress',
        msg: 'Working',
        progress: null,
      }),
    )
  })
})

describe('owned wait alerts', () => {
  it('updates and clears the wait opened by its handle', () => {
    const handle = beginAlertWait('Starting')

    expect(updateAlertWait(handle, 'Still working')).toBe(true)
    expect(alertTestState.alertStoreValue).toEqual({
      type: 'wait',
      msg: 'Still working',
      waitOwner: handle,
    })

    expect(clearAlertWait(handle)).toBe(true)
    expect(alertTestState.alertStoreValue).toEqual({ type: 'none', msg: '' })
  })

  it('does not update or clear an alert that replaced its wait', () => {
    const handle = beginAlertWait('Starting')
    alertNormal('Newer result')

    expect(updateAlertWait(handle, 'Stale progress')).toBe(false)
    expect(clearAlertWait(handle)).toBe(false)
    expect(alertTestState.alertStoreValue).toEqual({ type: 'normal', msg: 'Newer result' })
  })
})

describe('alertRealmTerms', () => {
  it('honors acceptance recorded by the original shared prompt', async () => {
    localStorage.setItem('tos4', 'true')

    await expect(alertRealmTerms()).resolves.toBe(true)

    expect(alertTestState.alertStoreSet).not.toHaveBeenCalled()
  })

  it('returns accepted without opening the modal in the agent dev browser environment', async () => {
    vi.stubEnv('VITE_RISU_AGENT_DEV_IGNORE_REALM_TERMS', 'TRUE')

    await expect(alertRealmTerms()).resolves.toBe(true)

    expect(alertTestState.alertStoreSet).not.toHaveBeenCalled()
    expect(localStorage.getItem('tos4')).toBeNull()
  })

  it('does not let an unrelated notice resolve the acceptance workflow', async () => {
    vi.stubEnv('VITE_RISU_AGENT_DEV_IGNORE_REALM_TERMS', 'FALSE')
    let settled = false
    const result = alertRealmTerms().then((accepted) => {
      settled = true
      return accepted
    })
    const owner = alertTestState.alertStoreValue.dialogOwner as symbol

    alertNormal('Deferred startup notice')
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(alertTestState.alertStoreValue).toMatchObject({ type: 'realmTerms', dialogOwner: owner })
    resolveAlertWorkflow(owner, 'yes')
    await expect(result).resolves.toBe(true)
    expect(localStorage.getItem('tos4')).toBe('true')
  })
})
