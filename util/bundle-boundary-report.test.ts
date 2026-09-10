import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attachHtmlPreloadValidation,
  createBundleBoundaryReport,
  formatBundleBoundaryReport,
  runBundleBoundaryReportCli,
  type BundleOutputInput,
} from './bundle-boundary-report.js'
import { phase1LazyBoundarySources } from './fast-bootstrap-boundaries.js'

let tempDir: string

function chunk(input: {
  code?: string
  dynamicImports?: string[]
  facadeModuleId?: string | null
  fileName: string
  imports?: string[]
  isDynamicEntry?: boolean
  isEntry?: boolean
  modules?: string[]
  name: string
}): BundleOutputInput[string] {
  return {
    type: 'chunk',
    code: input.code ?? `export const ${input.name.replaceAll('-', '_')} = true`,
    dynamicImports: input.dynamicImports ?? [],
    facadeModuleId: input.facadeModuleId ?? null,
    fileName: input.fileName,
    imports: input.imports ?? [],
    isDynamicEntry: input.isDynamicEntry ?? false,
    isEntry: input.isEntry ?? false,
    modules: Object.fromEntries((input.modules ?? []).map((moduleId) => [moduleId, { renderedLength: 10 }])),
    name: input.name,
  }
}

function baselineBundle(initialModules = ['/repo/src/main.ts']): BundleOutputInput {
  return {
    'assets/index.js': chunk({
      fileName: 'assets/index.js',
      name: 'index',
      facadeModuleId: '/repo/index.html',
      isEntry: true,
      imports: ['assets/shared.js'],
      dynamicImports: ['assets/appStartup.js'],
      modules: initialModules,
    }),
    'assets/shared.js': chunk({
      fileName: 'assets/shared.js',
      name: 'shared',
      modules: ['/repo/src/ts/coreStores.svelte.ts'],
    }),
    'assets/appStartup.js': chunk({
      fileName: 'assets/appStartup.js',
      name: 'appStartup',
      facadeModuleId: '/repo/src/appStartup.ts',
      isDynamicEntry: true,
      imports: ['assets/shared.js', 'assets/database.js'],
      modules: ['/repo/src/appStartup.ts', '/repo/src/App.svelte'],
    }),
    'assets/database.js': chunk({
      fileName: 'assets/database.js',
      name: 'database',
      modules: ['/repo/src/ts/storage/database.svelte.ts'],
    }),
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-bundle-boundary-report-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('bundle boundary report', () => {
  it('keeps explicitly emitted locale retry entries out of the HTML closure', () => {
    const bundle = baselineBundle()
    bundle['assets/ko.js'] = chunk({
      fileName: 'assets/ko.js',
      name: 'ko',
      facadeModuleId: '/repo/src/lang/ko.ts',
      isEntry: true,
      modules: ['/repo/src/lang/ko.ts'],
    })
    const report = createBundleBoundaryReport(bundle, '/repo')
    expect(report.initial.chunkFiles).toEqual(['assets/index.js', 'assets/shared.js'])
    expect(report.locales.passes).toBe(true)
    bundle['assets/unexpected.js'] = chunk({
      fileName: 'assets/unexpected.js',
      name: 'unexpected',
      facadeModuleId: '/repo/src/unexpected.ts',
      isEntry: true,
    })
    expect(() => createBundleBoundaryReport(bundle, '/repo')).toThrow('exactly one application entry')
  })

  it.each(['initial', 'immediateStartup'] as const)('rejects a non-English pack in the %s static closure', (scope) => {
    const bundle = baselineBundle(['/repo/src/main.ts', '/repo/src/lang/en.ts'])
    bundle['assets/ko.js'] = chunk({ fileName: 'assets/ko.js', name: 'ko', modules: ['/repo/src/lang/ko.ts'] })
    const owner = bundle[scope === 'initial' ? 'assets/index.js' : 'assets/appStartup.js']
    if (owner.type !== 'chunk') throw new Error('Expected chunk fixture')
    owner.imports.push('assets/ko.js')
    const report = createBundleBoundaryReport(bundle, '/repo')
    expect(report.locales.passes).toBe(false)
    expect(report.locales[scope]).toContain('src/lang/ko.ts')
    expect(formatBundleBoundaryReport(report)).toContain('Selected-locale boundaries: FAIL')
  })

  it('allows English fallback and leaves selection-triggered packs outside both static closures', () => {
    const bundle = baselineBundle(['/repo/src/main.ts', '/repo/src/lang/en.ts'])
    bundle['assets/ko.js'] = chunk({ fileName: 'assets/ko.js', name: 'ko', modules: ['/repo/src/lang/ko.ts'] })
    const owner = bundle['assets/appStartup.js']
    if (owner.type !== 'chunk') throw new Error('Expected chunk fixture')
    owner.dynamicImports.push('assets/ko.js')
    const report = createBundleBoundaryReport(bundle, '/repo')
    expect(report.locales).toEqual({ initial: ['src/lang/en.ts'], immediateStartup: [], passes: true })
  })

  it('keeps dynamic database work out of the initial closure while reporting immediate startup', () => {
    const report = createBundleBoundaryReport(baselineBundle(), '/repo')

    expect(report.initial.chunkFiles).toEqual(['assets/index.js', 'assets/shared.js'])
    expect(report.initial.passes).toBe(true)
    expect(report.initial.violations).toEqual([])
    expect(report.immediateStartup.chunkFiles).toEqual([
      'assets/appStartup.js',
      'assets/database.js',
      'assets/shared.js',
    ])
    expect(report.immediateStartup.moduleCount).toBe(4)
  })

  it.each([
    ['optional-surface', '/repo/src/lib/Others/GridCatalog.svelte'],
    ['database-implementation', '/repo/src/ts/storage/database.svelte.ts'],
    ['export-implementation', '/repo/src/ts/globalApi.svelte.ts'],
    ['export-implementation', '/repo/node_modules/.pnpm/streamsaver@2.0.6/node_modules/streamsaver/StreamSaver.js'],
  ] as const)('fails the %s boundary when a protected module enters the initial closure', (boundary, moduleId) => {
    const report = createBundleBoundaryReport(baselineBundle(['/repo/src/main.ts', moduleId]), '/repo')

    expect(report.initial.passes).toBe(false)
    expect(report.initial.violations).toEqual([
      {
        boundary,
        chunk: 'assets/index.js',
        module: moduleId.replace('/repo/', ''),
      },
    ])
  })

  it('requires generated HTML preloads to match the entry static closure', () => {
    const report = createBundleBoundaryReport(baselineBundle(), '/repo')

    expect(attachHtmlPreloadValidation(report, ['assets/shared.js', 'assets/index.js']).initial).toMatchObject({
      htmlMatchesEntryClosure: true,
      passes: true,
    })
    expect(attachHtmlPreloadValidation(report, ['assets/index.js']).initial).toMatchObject({
      htmlMatchesEntryClosure: false,
      passes: false,
    })
  })

  it('writes final artifacts before returning a failed CLI result', () => {
    const distDir = path.join(tempDir, 'dist')
    const resultDir = path.join(tempDir, 'results')
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
    fs.writeFileSync(
      path.join(distDir, 'index.html'),
      '<script type="module" src="/assets/index.js"></script><link rel="modulepreload" href="/assets/shared.js">',
    )
    for (const file of ['index.js', 'shared.js', 'appStartup.js', 'database.js']) {
      fs.writeFileSync(path.join(distDir, 'assets', file), `export const ${file.replaceAll('.', '_')} = true`)
    }
    const report = createBundleBoundaryReport(
      baselineBundle(['/repo/src/main.ts', '/repo/src/lib/Others/GridCatalog.svelte']),
      '/repo',
    )
    const input = path.join(distDir, 'bundle-boundary-report.json')
    fs.writeFileSync(input, JSON.stringify(report))

    const exitCode = runBundleBoundaryReportCli([
      '--dist',
      distDir,
      '--input',
      input,
      '--json',
      path.join(resultDir, 'report.json'),
      '--text',
      path.join(resultDir, 'report.txt'),
    ])

    expect(exitCode).toBe(1)
    expect(JSON.parse(fs.readFileSync(path.join(resultDir, 'report.json'), 'utf8')).initial).toMatchObject({
      htmlMatchesEntryClosure: true,
      passes: false,
    })
    expect(fs.readFileSync(path.join(resultDir, 'report.txt'), 'utf8')).toContain(
      'violation\toptional-surface\tsrc/lib/Others/GridCatalog.svelte',
    )
  })

  it('keeps the shared lazy inventory unique', () => {
    expect(new Set(phase1LazyBoundarySources).size).toBe(phase1LazyBoundarySources.length)
  })

  it('formats deterministic closure summaries', () => {
    const report = attachHtmlPreloadValidation(createBundleBoundaryReport(baselineBundle(), '/repo'), [
      'assets/index.js',
      'assets/shared.js',
    ])

    expect(formatBundleBoundaryReport(report)).toContain('HTML preload closure: PASS')
    expect(formatBundleBoundaryReport(report)).toContain('Protected initial boundaries: PASS')
  })
})
