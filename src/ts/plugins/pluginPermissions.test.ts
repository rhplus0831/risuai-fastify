/** @module-tag core */
// @vitest-environment happy-dom

import 'fake-indexeddb/auto'
import localforage from 'localforage'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAlertConfirmation, type AlertDialogHandle } from '../alert'
import { replacePluginCollectionOwner } from '../pluginCommands'
import { alertStore as alertPresentationStore } from '../stores/coreStores.svelte'
import { clearInMemoryPluginPermissions, getPluginPermission } from './pluginPermissions'
import type { RisuPlugin } from './plugins.svelte'

const permissionStore = localforage.createInstance({
  name: 'plugin_permissions',
  storeName: 'plugin_permissions',
})

function plugin(name: string, script: string): RisuPlugin {
  return {
    name,
    script,
    arguments: {},
    realArg: {},
    version: '3.0',
    customLink: [],
    argMeta: {},
    enabled: true,
  }
}

async function promptOrDecision(
  decision: Promise<boolean>,
): Promise<{ kind: 'prompt'; owner: AlertDialogHandle } | { kind: 'decision'; value: boolean }> {
  const prompt = new Promise<{ kind: 'prompt'; owner: AlertDialogHandle }>((resolve) => {
    let unsubscribe = () => {}
    unsubscribe = alertPresentationStore.subscribe((value) => {
      if (value.type !== 'ask' || !value.dialogOwner) return
      unsubscribe()
      resolve({ kind: 'prompt', owner: value.dialogOwner })
    })
  })
  return Promise.race([prompt, decision.then((value) => ({ kind: 'decision' as const, value }))])
}

async function answerPermission(decision: Promise<boolean>, answer: boolean): Promise<boolean> {
  const outcome = await promptOrDecision(decision)
  expect(outcome).toMatchObject({ kind: 'prompt' })
  if (outcome.kind !== 'prompt') throw new Error(`Permission resolved before prompting: ${String(outcome.value)}`)
  expect(resolveAlertConfirmation(outcome.owner, answer)).toBe(true)
  return decision
}

beforeEach(async () => {
  await permissionStore.clear()
  clearInMemoryPluginPermissions()
  replacePluginCollectionOwner([])
  alertPresentationStore.set({ type: 'none', msg: '' })
})

afterEach(async () => {
  clearInMemoryPluginPermissions()
  replacePluginCollectionOwner([])
  alertPresentationStore.set({ type: 'none', msg: '' })
  await permissionStore.clear()
})

describe('plugin permission identity', () => {
  it('binds persisted runtime grants to the exact installed script hash', async () => {
    const pluginName = 'permission-hash-plugin'
    const scriptA = 'Risuai.log("script-a-sentinel")'
    const scriptB = 'Risuai.log("script-b-sentinel")'

    replacePluginCollectionOwner([plugin(pluginName, scriptA)])
    await expect(answerPermission(getPluginPermission(pluginName, 'db', false, scriptA), true)).resolves.toBe(true)

    clearInMemoryPluginPermissions()
    expect(get(alertPresentationStore)).toMatchObject({ type: 'none' })
    await expect(getPluginPermission(pluginName, 'db', false, scriptA)).resolves.toBe(true)
    expect(get(alertPresentationStore)).toMatchObject({ type: 'none' })

    replacePluginCollectionOwner([plugin(pluginName, scriptB)])
    await expect(answerPermission(getPluginPermission(pluginName, 'db', false, scriptB), false)).resolves.toBe(false)

    clearInMemoryPluginPermissions()
    await expect(answerPermission(getPluginPermission(pluginName, 'db', false, scriptB), true)).resolves.toBe(true)

    clearInMemoryPluginPermissions()
    replacePluginCollectionOwner([plugin(pluginName, scriptA)])
    await expect(getPluginPermission(pluginName, 'db', false, scriptB)).resolves.toBe(false)
    expect(get(alertPresentationStore)).toMatchObject({ type: 'none' })
  })
})
