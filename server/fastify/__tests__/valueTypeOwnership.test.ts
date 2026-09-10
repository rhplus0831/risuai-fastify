import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  exportedInterfaceProperties,
  isInside,
  moduleSpecifiers,
  parseSource,
  resolveModule,
} from '../../../util/test-support/source-contract.js'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe('Fastify value type ownership', () => {
  it.each([
    [
      'server/fastify/src/generationFinalizationRetry.ts',
      'GenerationFinalizationMessage',
      {
        role: "'user' | 'char'",
        'generationInfo?.generationId?': 'string',
      },
    ],
    [
      'server/fastify/src/prompt/boundedRegex.ts',
      'BoundedRegexSettings',
      {
        'complexRegexCompatibilityMode?': "'strict' | 'worker'",
        'complexRegexInputTimeoutMs?': 'number',
        'complexRegexOutputTimeoutMs?': 'number',
        'complexRegexDisplayTimeoutMs?': 'number',
        'regexOutputSizeLimitMiB?': 'number',
      },
    ],
    [
      'server/fastify/src/prompt/triggerRunCache.ts',
      'TriggerTranscriptMessage',
      {
        data: 'string',
      },
    ],
    [
      'server/fastify/src/prompt/triggerRunCache.ts',
      'TriggerTranscriptChat',
      {
        message: 'TriggerTranscriptMessage[]',
      },
    ],
  ] as const)('keeps %s:%s behind its exported server-owned value interface', (file, name, properties) => {
    const owner = parseSource(file, fs.readFileSync(path.join(repoRoot, file), 'utf8'))
    expect(exportedInterfaceProperties(owner, name)).toMatchObject(properties)
    for (const specifier of moduleSpecifiers(owner)) {
      const target = resolveModule(repoRoot, file, specifier)
      expect(target && isInside(path.join(repoRoot, 'src'), target), specifier).not.toBe(true)
    }
  })

  it('does not accept interface-shaped comments or private declarations as exported contracts', () => {
    const source = parseSource(
      'fixture.ts',
      `
      // export interface GenerationFinalizationMessage
      // role: 'user' | 'char'
      // generationId?: string
      interface BoundedRegexSettings { regexOutputSizeLimitMiB: number }
    `,
    )
    expect(exportedInterfaceProperties(source, 'GenerationFinalizationMessage')).toBeUndefined()
    expect(exportedInterfaceProperties(source, 'BoundedRegexSettings')).toBeUndefined()
  })
})
