import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { resolveCompatibilityBaselineRoot } from '../../util/compat-baseline'

const root = resolve(import.meta.dirname, '../..')
const baselineRoot = resolveCompatibilityBaselineRoot()

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      src: resolve(baselineRoot, 'src'),
    },
    conditions: ['browser'],
  },
  server: {
    fs: {
      allow: [root, baselineRoot],
    },
  },
  test: {
    allowOnly: false,
    environment: 'happy-dom',
    pool: 'threads',
    include: ['test/compat-harness/baseline.runner.ts'],
    setupFiles: ['vitest.setup.ts'],
    testTimeout: 120_000,
  },
})
