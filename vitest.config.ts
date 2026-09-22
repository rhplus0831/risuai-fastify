import { defineConfig } from 'vitest/config'
import InterleavedProjectSequencer from './vitest.sequencer'

export default defineConfig({
  test: {
    allowOnly: false,
    projects: ['./vitest.node.config.ts', './vitest.svelte-node.config.ts', './vitest.dom.config.ts'],
    sequence: { sequencer: InterleavedProjectSequencer },
  },
})
