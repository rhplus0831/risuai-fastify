import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { src: '/src' },
    conditions: ['browser'],
  },
  test: {
    allowOnly: false,
    fsModuleCache: true,
    pool: 'threads',
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
    include: ['test/compat-harness/current.runner.ts', 'test/compat-harness/cluster10.runner.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
