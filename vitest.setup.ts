import { beforeEach } from 'vitest'
import { safeStructuredClone } from './src/ts/safeStructuredClone'
import {
  recordStartupMilestone,
  resetStartupReadinessForTests,
  settleStartupChatReadiness,
  settleStartupGenerationRecoveryReadiness,
} from './src/ts/startupReadiness'

globalThis.safeStructuredClone = safeStructuredClone

// Most unit tests exercise post-startup domain behavior. Default those tests
// to a fully ready coordinator; readiness-focused suites reset or establish
// narrower milestones in their own beforeEach hooks.
beforeEach(() => {
  resetStartupReadinessForTests()
  for (const milestone of [
    'entry',
    'shell-mounted',
    'reader-ready',
    'writer-ready',
    'plugins-ready',
    'chat-ready',
    'background-ready',
  ] as const) {
    recordStartupMilestone(milestone)
  }
  settleStartupChatReadiness(true)
  settleStartupGenerationRecoveryReadiness(true)
})
