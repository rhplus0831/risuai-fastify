/** @module-tag core */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mirrors serverPromptAssembly.test.ts: the platform gate is a hoisted getter.
// The plugin/store import graph still initializes `../../modules`, so its eager
// effects are neutralized even though preflight resolves active modules from the
// explicit database snapshot.
vi.mock('../../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../../platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('../../modules', async (importActual) => {
  const actual = await importActual<typeof import('../../modules')>()
  return {
    ...actual,
    moduleUpdate: () => {},
    getModuleToggles: () => '',
    getModuleTriggers: () => [],
  }
})

import { setDatabase, type character, type Chat, type Database } from '../../../storage/database.svelte'
import { _setPluginRuntimePhaseForTesting, pluginV2 } from '../../../plugins/plugins.svelte'
import { resolveDurableGeneration, type DurableGenerationRoute } from '../durableGeneration'
import type { ServerPromptAssemblyInput } from '../serverPromptAssembly'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

function seedDb(overrides: Partial<Database> = {}): void {
  setDatabase({
    aiModel: 'echo_model',
    subModel: 'echo_model',
    characters: [],
    maxContext: 4000,
    botPresetsId: 0,
    statics: { messages: 0 } as unknown as Database['statics'],
    promptInfoInsideChat: false,
    echoMessage: 'Echo Message',
    echoDelay: 0,
    ...overrides,
  } as unknown as Database)
}

function makeChar(overrides: Partial<character> = {}): character {
  return {
    type: 'character',
    name: 'Tess',
    chaId: 'char-1',
    triggerscript: [],
    ...overrides,
  } as unknown as character
}

function makeChat(
  message: Array<{ role: string; data: string; [k: string]: unknown }> = [{ role: 'user', data: 'hi' }],
): Chat {
  return { message } as unknown as Chat
}

function makeInput(overrides: Partial<ServerPromptAssemblyInput> = {}): ServerPromptAssemblyInput {
  return { database: getDatabase(), currentChar: makeChar(), currentChat: makeChat(), ...overrides }
}

function expectNonDurable(route: DurableGenerationRoute): string {
  expect(route.type).toBe('non-durable')
  if (route.type !== 'non-durable') throw new Error('expected a non-durable verdict')
  expect(route.reason.length).toBeGreaterThan(0)
  return route.reason
}

beforeEach(() => {
  _setPluginRuntimePhaseForTesting('ready')
  seedDb()
})

afterEach(() => {
  _setPluginRuntimePhaseForTesting('idle')
  pluginV2.editinput.clear()
  pluginV2.editoutput.clear()
  pluginV2.editprocess.clear()
  pluginV2.editdisplay.clear()
  pluginV2.replacerbeforeRequest.clear()
  pluginV2.replacerafterRequest.clear()
})

/** An `'output'` trigger effect (`setvar` arm) — runs post-generation. */
function outputTriggerScript(): unknown[] {
  return [
    {
      comment: '',
      type: 'output',
      conditions: [],
      effect: [{ type: 'setvar', operator: '=', var: 'mood', value: 'happy' }],
    },
  ]
}

describe('resolveDurableGeneration', () => {
  describe('durable — server-assembled send subset', () => {
    it('routes a plain user-message send to durable', () => {
      expect(resolveDurableGeneration(makeInput())).toEqual({ type: 'durable' })
    })

    // Output triggers / editoutput are durable: the server runs the post-gen pass
    // and persists the derived state, so this gate does not screen them out.
    it('routes a char with an output triggerscript to durable (decision #2)', () => {
      const input = makeInput({
        currentChar: makeChar({ triggerscript: outputTriggerScript() as never }),
      })
      expect(resolveDurableGeneration(input)).toEqual({ type: 'durable' })
    })

    it('routes a send to durable when a module carries an output trigger (decision #2)', () => {
      seedDb({
        enabledModules: ['module-output'],
        modules: [{ id: 'module-output', name: 'Output module', trigger: outputTriggerScript() }] as never,
      })
      expect(resolveDurableGeneration(makeInput())).toEqual({ type: 'durable' })
    })

    it('routes a char with an editoutput customscript to durable (decision #2)', () => {
      const input = makeInput({
        currentChar: makeChar({
          customscript: [{ in: 'foo', out: 'bar', type: 'editoutput', flag: '', ableFlag: false }] as never,
        }),
      })
      expect(resolveDurableGeneration(input)).toEqual({ type: 'durable' })
    })

    it('routes a send to durable when a preset regex carries an editoutput script (decision #2)', () => {
      seedDb({
        presetRegex: [{ in: 'foo', out: 'bar', type: 'editoutput', flag: '', ableFlag: false }] as never,
      })
      expect(resolveDurableGeneration(makeInput())).toEqual({ type: 'durable' })
    })

    // Discriminating positive: a non-interactive Lua char is in-subset (the server
    // VM runs the editRequest hook); the interactive-dialog case is non-durable
    // (negative test below). The split is inherited from the assembly gate.
    it('routes a non-interactive Lua trigger character to durable generation', () => {
      const input = makeInput({
        currentChar: makeChar({
          triggerscript: [
            {
              effect: [
                {
                  type: 'triggerlua',
                  code: "listenEdit('editRequest', function(id, data) return data end)",
                },
              ],
            },
          ] as never,
        }),
      })
      expect(resolveDurableGeneration(input)).toEqual({ type: 'durable' })
    })

    // continue / regenerate are durable-eligible: the server finalizes them
    // mode-correctly (extend-in-place / replace-target). Both are in the
    // server-assembled subset, so they route durable like a send.
    it('routes a continue to durable', () => {
      const input = makeInput({
        continue: true,
        currentChat: makeChat([{ role: 'char', data: 'previous reply' }]),
      })
      expect(resolveDurableGeneration(input)).toEqual({ type: 'durable' })
    })

    it('routes a regenerate to durable', () => {
      const input = makeInput({
        regenerateMessageId: 'msg-char-1',
        currentChat: makeChat([{ role: 'char', data: 'previous reply' }]),
      })
      expect(resolveDurableGeneration(input)).toEqual({ type: 'durable' })
    })
  })

  describe('non-durable — mode restriction (this gate)', () => {
    it('rejects preview mode (never generates)', () => {
      expect(expectNonDurable(resolveDurableGeneration(makeInput({ preview: true })))).toMatch(
        /send, continue, and regenerate/,
      )
    })

    it('rejects preview_prompt mode (never generates)', () => {
      expect(expectNonDurable(resolveDurableGeneration(makeInput({ previewPrompt: true })))).toMatch(
        /send, continue, and regenerate/,
      )
    })
  })

  describe('non-durable — inherited from the assembly gate (never a hard fail)', () => {
    it('is non-durable for a non-text send and carries the assembly reason', () => {
      // A text char tail is a valid durable empty send since the NEW-H1 parity
      // restoration; only a genuinely non-text tail inherits the assembly gate.
      const input = makeInput({
        currentChat: makeChat([{ role: 'char', data: 42 as never }]),
      })
      expectNonDurable(resolveDurableGeneration(input))
    })

    it('is non-durable for a group character', () => {
      const input = makeInput({ currentChar: makeChar({ type: 'group' } as never) })
      expectNonDurable(resolveDurableGeneration(input))
    })

    it('is non-durable for a non-server-routable provider and surfaces its reason', () => {
      seedDb({ aiModel: 'novelai' })
      expect(expectNonDurable(resolveDurableGeneration(makeInput()))).toContain('novelai')
    })

    it('is non-durable for image/asset content on a non-vision model (caption fallback)', () => {
      const input = makeInput({
        currentChat: makeChat([{ role: 'user', data: 'see {{inlayed::img1}}' }]),
      })
      expect(expectNonDurable(resolveDurableGeneration(input))).toMatch(/image input/i)
    })

    it('is durable for a Lua trigger that references an interactive dialog API by default', () => {
      const input = makeInput({
        currentChar: makeChar({
          triggerscript: [
            {
              effect: [
                {
                  type: 'triggerlua',
                  code: "listenEdit('editRequest', function(id, data) alertInput(id, 'pick') return data end)",
                },
              ],
            },
          ] as never,
        }),
      })
      expect(resolveDurableGeneration(input)).toEqual({ type: 'durable' })
    })

    it('is non-durable for a Lua trigger that references an interactive dialog API when Strict Script Check is enabled', () => {
      seedDb({ strictScriptCheck: true } as never)
      const input = makeInput({
        currentChar: makeChar({
          triggerscript: [
            {
              effect: [
                {
                  type: 'triggerlua',
                  code: "listenEdit('editRequest', function(id, data) alertInput(id, 'pick') return data end)",
                },
              ],
            },
          ] as never,
        }),
      })
      expect(expectNonDurable(resolveDurableGeneration(input))).toMatch(/interactive|alertInput/i)
    })

    it('is non-durable for a non-empty pluginV2 edit set (permanent)', () => {
      pluginV2.editprocess.add((() => {}) as never)
      expect(expectNonDurable(resolveDurableGeneration(makeInput()))).toMatch(/plugin/i)
    })
  })
})
