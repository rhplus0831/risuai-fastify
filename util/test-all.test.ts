import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { uiCoverageSupportFiles, uiCoverageTestFiles } from '../vitest.ui-coverage-tests.js'
import { performanceTestFiles } from '../vitest.performance-tests.js'
import {
  agentQualityLanes,
  createQualityRunReport,
  parseTestAllCli,
  parseTestAllJobs,
  qualityLanes,
  runLanePool,
  validateQualityLanePhases,
  type QualityLane,
  type QualityLaneResult,
} from './test-all.js'

describe('test:all orchestration', () => {
  it('uses bounded concurrency and validates the jobs override', () => {
    expect(parseTestAllJobs(undefined)).toBe(2)
    expect(parseTestAllJobs('4')).toBe(4)
    expect(() => parseTestAllJobs('0')).toThrow('positive integer')
    expect(parseTestAllCli(['--timings=json'])).toMatchObject({ timingsJson: true })
    expect(parseTestAllCli([])).toMatchObject({ timingsJson: false })
  })

  it('keeps the agent final profile focused on core tests, checks, and the smoke build', () => {
    expect(agentQualityLanes.map((lane) => lane.id)).toEqual([
      'server-check',
      'test-topology',
      'docs',
      'frontend-tests',
      'frontend-check',
      'server-tests',
      'browser-smoke-build',
    ])

    const byId = new Map(agentQualityLanes.map((lane) => [lane.id, lane]))
    expect(byId.get('frontend-tests')?.env).toEqual({
      RISU_TEST_EXCLUDE_UI_MAP: 'false',
      RISU_TEST_INCLUDE_GATES: 'false',
    })
    expect(byId.get('server-tests')?.isolated).toBe(true)
    expect(byId.get('browser-smoke-build')).toMatchObject({
      args: ['build:smoke'],
      after: ['server-check'],
    })
    expect(byId.get('browser-smoke-build')?.isolated).toBeUndefined()
    expect(() => validateQualityLanePhases(agentQualityLanes)).not.toThrow()
  })

  it('keeps browser verification and duplicate-test owners ordered and performance gates isolated', () => {
    const byId = new Map(qualityLanes.map((lane) => [lane.id, lane]))

    expect(byId.get('browser-smoke-build')).toMatchObject({ args: ['build:smoke'], after: ['server-check'] })
    expect(byId.get('browser-smoke-build')?.isolated).toBeUndefined()
    expect(byId.get('browser-smoke')).toMatchObject({
      after: ['browser-smoke-build'],
      isolated: true,
      args: ['exec', 'playwright', 'test', '-c', 'playwright.fastify-smoke.config.ts'],
      env: { VITE_FASTIFY_BROWSER_SMOKE: 'TRUE', RISU_FAST_BOOTSTRAP_ARTIFACT_REQUIRED: 'true' },
    })
    expect(byId.get('test-topology')).toMatchObject({ args: ['exec', 'tsx', 'util/test-topology.ts'] })
    expect(byId.get('frontend-tests')).toMatchObject({
      after: ['test-topology'],
      args: ['exec', 'vitest', 'run'],
    })
    expect(byId.get('frontend-tests')?.env).toEqual({ RISU_TEST_EXCLUDE_UI_MAP: 'true' })
    expect(byId.get('compat-registers')?.args).toEqual(['validate:compat-registers'])
    expect(byId.get('compat-registers')?.isolated).toBeUndefined()
    expect(byId.get('compat-current')).toMatchObject({
      args: ['exec', 'tsx', 'test/compat-harness/run.ts', '--current-only'],
      after: ['compat-registers'],
      isolated: true,
    })
    expect(byId.get('ui-coverage')?.after).toContain('frontend-tests')
    expect(byId.get('server-tests')?.isolated).toBe(true)
    expect(byId.get('realm-scale')).toMatchObject({
      isolated: true,
      after: ['server-tests'],
    })
    expect(byId.get('realm-scale')?.args).toContain('server/fastify/__tests__/realmImport.test.ts')
    expect(byId.has('audit-gates')).toBe(false)
    expect(byId.get('performance-gates')).toMatchObject({
      isolated: true,
      env: { RISU_TEST_INCLUDE_GATES: 'true' },
    })
    expect(byId.get('performance-gates')?.args).toEqual([
      'exec',
      'vitest',
      'run',
      ...performanceTestFiles,
      '--no-file-parallelism',
      '--maxWorkers=1',
    ])

    const packageScripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>
    expect(packageScripts['coverage:ui-map'].match(/src\/\S+\.test\.ts/g)).toEqual([...uiCoverageTestFiles])
    expect(packageScripts['check:docs']).toBe('tsx util/current-documentation-validator.ts')
    expect(packageScripts['test:agent']).toBe('tsx util/test-agent.ts')
    expect(packageScripts['test:all']).toBe('tsx util/test-all.ts')
    expect(Object.keys(packageScripts).filter((script) => script.startsWith('test'))).toEqual([
      'test',
      'test:compat-harness',
      'test:agent',
      'test:all',
    ])
  })

  it('starts dependents after completion even when a prerequisite fails', async () => {
    const lanes: QualityLane[] = [
      { id: 'first', label: 'first', args: [] },
      { id: 'independent', label: 'independent', args: [] },
      { id: 'dependent', label: 'dependent', args: [], after: ['first'] },
    ]
    const events: string[] = []
    let active = 0
    let peakActive = 0

    const results = await runLanePool(lanes, 2, async (lane): Promise<QualityLaneResult> => {
      events.push(`start:${lane.id}`)
      active += 1
      peakActive = Math.max(peakActive, active)
      await Promise.resolve()
      active -= 1
      events.push(`finish:${lane.id}`)
      return {
        id: lane.id,
        exitCode: lane.id === 'first' ? 1 : 0,
        elapsedMs: 0,
        finishedOffsetMs: 0,
        startedOffsetMs: 0,
      }
    })

    expect(peakActive).toBe(2)
    expect(events.indexOf('start:dependent')).toBeGreaterThan(events.indexOf('finish:first'))
    expect(results.map((result) => result.exitCode)).toEqual([1, 0, 0])
  })

  it('rejects dependency cycles', async () => {
    const lanes: QualityLane[] = [
      { id: 'first', label: 'first', args: [], after: ['second'] },
      { id: 'second', label: 'second', args: [], after: ['first'] },
    ]

    await expect(
      runLanePool(lanes, 2, async (lane) => ({
        id: lane.id,
        exitCode: 0,
        elapsedMs: 0,
        finishedOffsetMs: 0,
        startedOffsetMs: 0,
      })),
    ).rejects.toThrow('dependency cycle')
  })

  it('creates a stable machine-readable timing record in lane declaration order', () => {
    const lanes: QualityLane[] = [
      { id: 'first', label: 'First', args: [] },
      { id: 'second', label: 'Second', args: [], after: ['first'], isolated: true },
    ]
    const report = createQualityRunReport(
      lanes,
      [
        { id: 'second', exitCode: 1, elapsedMs: 20, finishedOffsetMs: 35, startedOffsetMs: 15 },
        { id: 'first', exitCode: 0, elapsedMs: 10, finishedOffsetMs: 10, startedOffsetMs: 0 },
      ],
      3,
      35,
    )

    expect(report).toEqual({
      aggregateElapsedMs: 35,
      jobs: 3,
      lanes: [
        {
          after: undefined,
          elapsedMs: 10,
          exitCode: 0,
          finishedOffsetMs: 10,
          id: 'first',
          isolated: undefined,
          label: 'First',
          startedOffsetMs: 0,
        },
        {
          after: ['first'],
          elapsedMs: 20,
          exitCode: 1,
          finishedOffsetMs: 35,
          id: 'second',
          isolated: true,
          label: 'Second',
          startedOffsetMs: 15,
        },
      ],
      schemaVersion: 1,
    })
  })

  it('validates the regular-to-isolated phase barrier and isolated order', () => {
    expect(() => validateQualityLanePhases(qualityLanes)).not.toThrow()
    expect(() =>
      validateQualityLanePhases([
        { id: 'isolated', label: 'isolated', args: [], isolated: true },
        { id: 'regular', label: 'regular', args: [], after: ['isolated'] },
      ]),
    ).toThrow('regular quality lane regular cannot depend on isolated')
    expect(() =>
      validateQualityLanePhases([
        { id: 'later', label: 'later', args: [], isolated: true, after: ['earlier'] },
        { id: 'earlier', label: 'earlier', args: [], isolated: true },
      ]),
    ).toThrow('must appear after its isolated dependency')
  })

  it('keeps every local aggregate owner required by CI', () => {
    const workflow = readFileSync('.github/workflows/quality.yml', 'utf8')
    const ciOwners = new Map([
      ['server-check', ['check-server', 'pnpm check:server']],
      ['test-topology', ['check', 'pnpm exec tsx util/test-topology.ts']],
      ['docs', ['docs', 'pnpm check:docs']],
      ['frontend-tests', ['frontend', 'pnpm exec vitest run']],
      ['compat-registers', ['compat-registers', 'pnpm validate:compat-registers']],
      ['compat-current', ['compat-current', 'pnpm exec tsx test/compat-harness/run.ts --current-only']],
      ['server-tests', ['server', 'pnpm exec vitest run --config server/fastify/vitest.config.ts']],
      [
        'realm-scale',
        [
          'realm-scale',
          "pnpm exec vitest run --config server/fastify/vitest.config.ts server/fastify/__tests__/realmImport.test.ts -t 'imports Realm charx packages with thousands of display assets' --no-file-parallelism --maxWorkers=1",
        ],
      ],
      ['browser-smoke', ['smoke', 'pnpm smoke:fastify-browser']],
      ['browser-smoke-build', ['smoke', 'pnpm smoke:fastify-browser']],
      ['frontend-check', ['check', 'pnpm check']],
      ['ui-coverage', ['ui-coverage', 'pnpm coverage:ui-map']],
      ['format', ['format', 'pnpm format:check']],
      [
        'performance-gates',
        [
          'gates-perf',
          'pnpm exec vitest run src/ts/__tests__/renderCostHarness.test.ts src/ts/__tests__/sendCloneCountProbe.test.ts --no-file-parallelism --maxWorkers=1',
        ],
      ],
    ] as const)
    const verifySection = workflow.slice(workflow.indexOf('\n  verify:'))

    expect(new Set(ciOwners.keys())).toEqual(new Set(qualityLanes.map((lane) => lane.id)))
    for (const [lane, [job, command]] of ciOwners) {
      expect(workflow, `${lane} command`).toContain(`- run: ${command}`)
      expect(verifySection, `${job} verify dependency`).toContain(`- ${job}`)
    }
    expect(verifySection).toContain('- initial-preload')
    expect(verifySection).toContain('DOCS_RESULT: ${{ needs.docs.result }}')
    expect(verifySection).toContain('test "$DOCS_RESULT" = success')
    const smokeUpload = workflow.slice(
      workflow.indexOf('name: playwright-test-results'),
      workflow.indexOf('\n\n  verify:'),
    )
    expect(smokeUpload).toContain('fast-bootstrap-results/fast-bootstrap-integration.*')
    expect(smokeUpload).toContain('if-no-files-found: error')
    const uiUpload = workflow.slice(workflow.indexOf('name: ui-coverage'), workflow.indexOf('\n\n  server:'))
    expect(uiUpload).toContain('if-no-files-found: error')
  })

  it('keeps compatibility history and baseline setup in their owning CI lanes', () => {
    const qualityWorkflow = readFileSync('.github/workflows/quality.yml', 'utf8')
    const frontendJob = qualityWorkflow.slice(
      qualityWorkflow.indexOf('\n  frontend:'),
      qualityWorkflow.indexOf('\n  initial-preload:'),
    )
    const registersJob = qualityWorkflow.slice(
      qualityWorkflow.indexOf('\n  compat-registers:'),
      qualityWorkflow.indexOf('\n  compat-current:'),
    )

    expect(frontendJob).toContain('fetch-depth: 0')
    expect(registersJob).toContain('fetch-depth: 0')

    const differentialWorkflow = readFileSync('.github/workflows/compatibility-differential.yml', 'utf8')
    expect(differentialWorkflow).toContain(
      'RISU_COMPAT_BASELINE_ROOT: ${{ github.workspace }}/../risu-baseline-71c476e9c',
    )
    expect(differentialWorkflow).not.toContain('${{ runner.temp }}')
  })

  it('keeps configured UI coverage support exclusions unique and present', () => {
    expect(new Set(uiCoverageSupportFiles).size).toBe(uiCoverageSupportFiles.length)
    for (const file of uiCoverageSupportFiles) expect(existsSync(file), file).toBe(true)
  })
})
