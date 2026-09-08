import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generate } from 'astring'
import { parse } from 'svelte/compiler'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/lib/Setting/Pages/BotSettings.svelte'), 'utf8')
const ast = parse(source, { filename: 'src/lib/Setting/Pages/BotSettings.svelte', modern: true })

type AstNode = {
  attributes?: AstNode[]
  data?: string
  expression?: AstNode
  fragment?: AstNode
  name?: string
  type?: string
  value?: unknown
  [key: string]: unknown
}

function walkAst(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== 'object') return
  const astNode = node as AstNode
  visit(astNode)
  for (const [key, value] of Object.entries(astNode)) {
    if (key === 'attributes' || key === 'metadata' || key === 'parent') continue
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit)
    } else {
      walkAst(value, visit)
    }
  }
}

function attributeExpression(node: AstNode, name: string): string | undefined {
  const attribute = node.attributes?.find((candidate) => candidate.type === 'Attribute' && candidate.name === name)
  if (!attribute) return undefined
  const value = (Array.isArray(attribute.value) ? attribute.value[0] : attribute.value) as AstNode | undefined
  if (!value) return undefined
  if (value.type === 'Text') return value.data
  if (value.type !== 'ExpressionTag' || !value.expression) return undefined
  return generate(value.expression as Parameters<typeof generate>[0])
}

function containsVisualComponent(node: AstNode): boolean {
  let found = false
  walkAst(node.fragment, (candidate) => {
    if (candidate.type === 'Component' && candidate.name?.endsWith('Icon')) found = true
  })
  return found
}

function sliders(node: unknown): AstNode[] {
  const result: AstNode[] = []
  walkAst(node, (candidate) => {
    if (candidate.type === 'Component' && candidate.name === 'SliderInput') result.push(candidate)
  })
  return result
}

const iconButtons: AstNode[] = []
walkAst(ast.fragment, (node) => {
  if (node.type === 'RegularElement' && node.name === 'button' && containsVisualComponent(node)) {
    iconButtons.push(node)
  }
})

describe('BotSettings icon action names', () => {
  it.each([
    '`${language.add}: ${language.customStopWords}`',
    '`${language.remove}: ${language.customStopWords} ${i + 1}`',
    '`${language.add}: Bias`',
    '`${language.remove}: Bias ${i + 1}`',
    '`${language.export}: Bias`',
    '`${language.import}: Bias`',
    '`${language.add}: ${language.additionalParams}`',
    '`${language.remove}: ${language.additionalParams} ${i + 1}`',
    '`${language.import}: ${language.icon}`',
  ])('keeps %s on its icon action', (label) => {
    expect(iconButtons.filter((button) => attributeExpression(button, 'aria-label') === label)).toHaveLength(1)
  })
})

describe('BotSettings additional parameters visibility', () => {
  it('shows the table for all model controls and checks its own row count for the empty state', () => {
    expect(source).toContain('{#if showModelOthersControls}')
    expect(source).not.toContain('{#if showModelOthersControls && usesReverseProxyModel}')
    expect(source).toContain('{#if activeAdditionalParamsDraft.value.length === 0}')
  })
})

describe('BotSettings direct slider names', () => {
  it('keeps every direct slider named for its parameter in each mutually exclusive model section', () => {
    const controls = sliders(ast.fragment)
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) expect(attributeExpression(control, 'ariaLabel')).toBeTruthy()

    const sections: AstNode[] = []
    walkAst(ast.fragment, (node) => {
      if (node.type === 'IfBlock' && node.test) {
        const condition = generate(node.test as Parameters<typeof generate>[0])
        if (['textgen_webui', 'LLMFormat.NovelAI', 'LLMFormat.NovelList'].some((name) => condition.includes(name))) {
          sections.push(node)
        }
      }
    })
    expect(sections.length).toBeGreaterThan(0)
    for (const section of sections) {
      const labels = sliders(section.consequent).map((control) => attributeExpression(control, 'ariaLabel'))
      expect(labels.length).toBeGreaterThan(0)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})

describe('BotSettings direct form control names', () => {
  it.each(['TextInput', 'TextAreaInput', 'NumberInput', 'SelectInput', 'SecretInput'])(
    'keeps every direct %s named for its visible setting',
    (componentName) => {
      const tags: string[] =
        source.match(new RegExp(`<${componentName}\\b[\\s\\S]*?(?:\\/>|</${componentName}>)`, 'g')) ?? []

      expect(tags.length).toBeGreaterThan(0)
      expect(tags.filter((tag) => !tag.includes('ariaLabel='))).toEqual([])
    },
  )
})

describe('BotSettings pending prompt persistence', () => {
  it('registers its 250ms prompt draft with the lifecycle flusher and forwards keepalive transport options', () => {
    expect(source).toContain('registerPendingOwnerMutationFlusher(')
    expect(source).toContain('flushPendingPromptFieldPatch(options: ServerCommandTransportOptions = {})')
    expect(source).toContain('options.keepalive,')
    expect(source).toContain('unregisterPendingPromptFieldFlush()')
  })

  it('flushes prompt rows before staging and durably dispatching the owner enable toggle', () => {
    const toggleStart = source.indexOf('async function setSelectedPromptTemplateEnabled')
    const toggleEnd = source.indexOf('function currentPromptPresetIconUploadTarget', toggleStart)
    const toggleSource = source.slice(toggleStart, toggleEnd)

    expect(toggleSource).toContain('commitPendingPromptTemplateMutations()')
    expect(toggleSource).toContain("path: '/prompt-items/enable'")
    expect(toggleSource).toContain('promptTemplateOwnerMutationKey(ownerId)')
    expect(toggleSource).toContain('dispatchPromptTemplateStructuralMutation({')
    expect(toggleSource).toContain('outbox,')
    expect(toggleSource).toContain('intent,')
    expect(toggleSource.indexOf('commitPendingPromptTemplateMutations()')).toBeLessThan(
      toggleSource.indexOf('setSelectedPromptPresetTemplateProjection(enabled)'),
    )
  })
})

describe('BotSettings custom model flags', () => {
  it('exposes the Claude xhigh adaptive-effort capability flag', () => {
    expect(source).toContain("{@render CustomFlagButton('claudeXHighEffort', 23)}")
  })
})

describe('BotSettings preset regex ownership', () => {
  it('passes the selected prompt preset identity to RegexList', () => {
    expect(source).toContain(
      '<RegexList bind:value={presetRegexDraft.value} ownerKey={promptFieldOwnerSignature()} buttons />',
    )
  })
})
