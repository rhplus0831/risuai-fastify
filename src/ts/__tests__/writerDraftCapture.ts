import { get } from 'svelte/store'
import { enterClientWriter } from './clientSession'
import { resetClientSessionForTests } from '../clientSession'
import { initializeDraftRecoveryScope, resetDraftRecoveryScopeForTests } from '../server/draftRecoveryScope'
import { resetWriterDraftRecoveryForTests, writerDraftRecoveryStore } from '../server/writerDraftRecovery'

export async function beginWriterDraftCaptureTest(): Promise<void> {
  await resetWriterDraftRecoveryForTests()
  resetClientSessionForTests()
  initializeDraftRecoveryScope({ databaseLineage: 'draft-test-lineage', writerSessionId: 'draft-test-session' })
  enterClientWriter()
}

export function capturedWriterDrafts() {
  return get(writerDraftRecoveryStore).drafts
}

/** Unmount the test editor first, while its revoked authority still blocks flushes. */
export async function endWriterDraftCaptureTest(): Promise<void> {
  await resetWriterDraftRecoveryForTests()
  resetDraftRecoveryScopeForTests()
  resetClientSessionForTests()
}
