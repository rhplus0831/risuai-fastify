import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineProject } from 'vitest/config'
import {
  explicitDomTestFileGlobs,
  frontendTestFileGlob,
  isolatedCompatibilityTestFiles,
  legacyDomTestFiles,
  svelteNodeTestFileGlob,
} from './vitest.frontend-routing'
import { testTags } from './vitest.test-tags'

export default defineProject({
  // Related-test discovery transforms transitive dynamic imports even when a
  // Node-owned test mocks them, so its dependency graph must understand Svelte.
  plugins: [svelte()],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    name: 'frontend-node',
    allowOnly: false,
    fsModuleCache: true,
    pool: 'threads',
    environment: 'node',
    setupFiles: ['vitest.setup.ts'],
    tags: testTags,
    include: [frontendTestFileGlob],
    exclude: [
      '**/node_modules/**',
      'server/**',
      svelteNodeTestFileGlob,
      ...explicitDomTestFileGlobs,
      ...legacyDomTestFiles,
      ...isolatedCompatibilityTestFiles,
    ],
  },
})
