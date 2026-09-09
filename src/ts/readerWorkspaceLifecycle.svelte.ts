import { writable } from 'svelte/store'

export type ReaderWorkspaceLifecycleMode =
  | 'waiting'
  | 'takeover-denied'
  | 'unavailable'
  | 'writer-lost'
  | 'offline'
  | 'auth-lost'
  | 'promoted'

export type ReaderProjectionDiscardReason = 'auth-loss' | 'database-replacement' | 'lineage-change'

export interface ReaderWorkspaceLifecycleState {
  mode: ReaderWorkspaceLifecycleMode
  lastDiscardReason: ReaderProjectionDiscardReason | null
}

const initialState: ReaderWorkspaceLifecycleState = {
  mode: 'waiting',
  lastDiscardReason: null,
}

export const readerWorkspaceLifecycleStore = writable<ReaderWorkspaceLifecycleState>(initialState)

export function setReaderWorkspaceLifecycleMode(mode: ReaderWorkspaceLifecycleMode): void {
  readerWorkspaceLifecycleStore.update((state) => (state.mode === mode ? state : { ...state, mode }))
}

export function resetReaderWorkspaceLifecycleForTests(): void {
  readerWorkspaceLifecycleStore.set(initialState)
}
