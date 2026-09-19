import type { TestTagDefinition } from 'vitest'

export const CORE_TEST_TAG = 'core'

export const testTags = [
  {
    name: CORE_TEST_TAG,
    description: 'Minimal protection for startup, data integrity, message sending, recovery, and security.',
  },
] satisfies TestTagDefinition[]
