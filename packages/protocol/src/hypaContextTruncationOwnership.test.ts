import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleSpecifiers, parseSource, resolveModule } from '../../../util/test-support/source-contract.js'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

function source(relativePath: string) {
  return parseSource(relativePath, fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

describe('Hypa context truncation protocol ownership', () => {
  it('keeps the browser facade and Fastify route on the protocol contract', () => {
    const protocolImport = '@risuai/protocol/hypa-context-truncation'
    const browserFacade = 'src/ts/process/request/hypaContextTruncation.ts'
    const fastifyRoute = 'server/fastify/src/routes/generationChat.ts'
    const browserImports = moduleSpecifiers(source(browserFacade))
    const fastifyImports = moduleSpecifiers(source(fastifyRoute))
    const protocolTarget = resolveModule(repoRoot, browserFacade, protocolImport)

    expect(browserImports).toContain(protocolImport)
    expect(fastifyImports).toContain(protocolImport)
    expect(protocolTarget).toBeDefined()
    expect(resolveModule(repoRoot, fastifyRoute, protocolImport)).toBe(protocolTarget)
    expect(fastifyImports.map((specifier) => resolveModule(repoRoot, fastifyRoute, specifier))).not.toContain(
      fs.realpathSync(path.join(repoRoot, browserFacade)),
    )
  })
})
