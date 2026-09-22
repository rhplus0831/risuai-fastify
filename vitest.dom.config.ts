import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineProject } from 'vitest/config'
import { explicitDomTestFileGlobs, legacyDomTestFiles } from './vitest.frontend-routing'
import { performanceTestFiles } from './vitest.performance-tests'
import { testTags } from './vitest.test-tags'

const includeExplicitPerformanceTests = process.env.RISU_TEST_INCLUDE_GATES === 'true'

export default defineProject({
  plugins: [svelte()],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    name: 'frontend-dom',
    allowOnly: false,
    fsModuleCache: true,
    pool: 'threads',
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts', 'vitest.dom.setup.ts'],
    tags: testTags,
    include: [...explicitDomTestFileGlobs, ...legacyDomTestFiles],
    exclude: ['**/node_modules/**', 'server/**', ...(includeExplicitPerformanceTests ? [] : performanceTestFiles)],
  },
})
