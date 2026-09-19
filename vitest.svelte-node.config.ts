import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineProject } from 'vitest/config'
import { svelteNodeTestFileGlob } from './vitest.frontend-routing'
import { excludeUiCoverageTests, uiCoverageTestFiles } from './vitest.ui-coverage-tests'
import { testTags } from './vitest.test-tags'

export default defineProject({
  plugins: [svelte()],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    name: 'frontend-svelte-node',
    allowOnly: false,
    fsModuleCache: true,
    pool: 'threads',
    environment: './vitest.svelte-node.environment.ts',
    setupFiles: ['vitest.setup.ts'],
    tags: testTags,
    include: [svelteNodeTestFileGlob],
    exclude: ['**/node_modules/**', 'server/**', ...(excludeUiCoverageTests ? uiCoverageTestFiles : [])],
  },
})
