import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'

export type PendingSettingsProjectionOverlay = (
  target: Record<string, unknown>,
  allowedKeys?: ReadonlySet<string>,
) => void

const pendingSettingsProjectionOverlays = new Set<PendingSettingsProjectionOverlay>()

export function canProjectPendingSettings(generation: number): boolean {
  return canUseClientWriteAccess() && isClientSessionGenerationCurrent(generation)
}

export function registerPendingSettingsProjectionOverlay(overlay: PendingSettingsProjectionOverlay): () => void {
  pendingSettingsProjectionOverlays.add(overlay)
  return () => pendingSettingsProjectionOverlays.delete(overlay)
}

export function applyPendingSettingsProjectionOverlays(
  target: Record<string, unknown>,
  allowedKeys?: ReadonlySet<string>,
): void {
  const generation = captureClientSessionGeneration()
  for (const overlay of pendingSettingsProjectionOverlays) {
    if (!canProjectPendingSettings(generation)) return
    overlay(target, allowedKeys)
  }
}
