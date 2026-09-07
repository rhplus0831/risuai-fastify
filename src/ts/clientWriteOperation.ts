import {
  assertClientWriteAccess,
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from './clientSession'

/** Capture admission once; promotion must never revive an older continuation. */
export function captureClientWriteOperation(): number {
  assertClientWriteAccess()
  return captureClientSessionGeneration()
}

export function isClientWriteOperationCurrent(generation: number): boolean {
  return canUseClientWriteAccess() && isClientSessionGenerationCurrent(generation)
}

export function assertClientWriteOperation(generation: number): void {
  assertClientWriteAccess()
  if (!isClientSessionGenerationCurrent(generation)) throw new Error('client_write_operation_stale')
}

/** Fence asynchronous results before a retained continuation can perform more work. */
export async function awaitClientWriteOperation<T>(generation: number, pending: T | PromiseLike<T>): Promise<T> {
  try {
    return await pending
  } finally {
    assertClientWriteOperation(generation)
  }
}
