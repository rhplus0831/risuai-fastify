import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { observeFirstComposerLabel, selectedLocaleAssets } from './selectedLocaleFixture.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

// Run this exact spec in isolation for before/after startup timing. Build closure
// membership is recorded separately by build:initial-preload; browser transfer
// below includes the selected chat route and smoke instrumentation.
test('selected locale is usable on cold startup and refresh', async ({ browser }, testInfo) => {
  test.setTimeout(180_000)
  const localeAssets = selectedLocaleAssets()
  const results: Array<{
    scripts: Array<{ path: string; transferBytes: number; encodedBodyBytes: number }>
    [key: string]: unknown
  }> = []
  for (const locale of ['en', 'ko'] as const) {
    const label = locale === 'ko' ? '메시지 입력' : 'Message input'
    for (let repetition = 0; repetition < 3; repetition++) {
      // Each cold/warm pair owns its durable writer; later fresh contexts must
      // not inherit an earlier repetition's owner or add a takeover to timing.
      const database = smallFastBootstrapFixture()
      database.language = locale
      const harness = await startFastBootstrapHarness(database)
      try {
        const context = await browser.newContext()
        try {
          const page = await context.newPage()
          const errors: string[] = []
          page.on('pageerror', (error) => errors.push(error.message))
          await observeFirstComposerLabel(page)
          for (const cache of ['cold', 'warm'] as const) {
            if (cache === 'cold') {
              await page.goto(`${harness.baseUrl}/character/fast-bootstrap-small-character/fast-bootstrap-small-chat`)
            } else await page.reload()
            await expect(page.getByTestId('default-chat-composer')).toHaveAttribute('aria-label', label)
            await page.evaluate(() =>
              window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
            )
            const snapshot = await page.evaluate(() => ({
              startup: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupSnapshot(),
              firstComposerLabel: (
                window as unknown as { __localeStartupObservation: { firstComposerLabel: string | null } }
              ).__localeStartupObservation.firstComposerLabel,
              scripts: performance
                .getEntriesByType('resource')
                .filter((entry) => new URL(entry.name).pathname.endsWith('.js'))
                .map((entry) => {
                  const resource = entry as PerformanceResourceTiming
                  return {
                    path: new URL(entry.name).pathname.slice(1),
                    transferBytes: resource.transferSize,
                    encodedBodyBytes: resource.encodedBodySize,
                  }
                }),
            }))
            expect(snapshot.firstComposerLabel).toBe(label)
            expect(snapshot.startup.phase).toBe('background-ready')
            const distinctPaths = [...new Set(snapshot.scripts.map((script) => script.path))]
            const gzipBytes = distinctPaths.reduce(
              (total, file) => total + gzipSync(fs.readFileSync(path.resolve('dist', file))).byteLength,
              0,
            )
            const loadedNonEnglishLocales = [...localeAssets]
              .filter(([, file]) => distinctPaths.includes(file))
              .map(([code]) => code)
            expect(loadedNonEnglishLocales).toEqual(locale === 'en' ? [] : [locale])
            expect(gzipBytes).toBeLessThan(1_393_734)
            results.push({ locale, cache, repetition, ...snapshot, gzipBytes, loadedNonEnglishLocales })
            expect(errors).toEqual([])
          }
        } finally {
          await context.close()
        }
      } finally {
        await closeFastBootstrapHarness(harness)
      }
    }
  }
  // Keep every readiness/transfer sample while storing identical script paths
  // once, so retained before/after evidence stays small and reviewable.
  const closures: string[][] = []
  const samples = results.map(({ scripts, ...sample }) => {
    const paths = [...new Set(scripts.map((script) => script.path))].sort()
    let closure = closures.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(paths))
    if (closure < 0) closure = closures.push(paths) - 1
    return {
      ...sample,
      scripts: {
        closure,
        fileCount: paths.length,
        transferBytes: scripts.reduce((total, script) => total + script.transferBytes, 0),
        encodedBodyBytes: scripts.reduce((total, script) => total + script.encodedBodyBytes, 0),
      },
    }
  })
  const artifact = JSON.stringify(
    { browserVersion: browser.version(), cpuThrottle: 1, closures, results: samples },
    null,
    2,
  )
  const outputDir = path.resolve('fast-bootstrap-results/maintainability')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'locale-startup.json'), `${artifact}\n`)
  await testInfo.attach('locale-startup', { body: artifact, contentType: 'application/json' })
})
