export interface SideEffectCall {
  fn: 'runInlayScreen' | 'renderInlayScreenTextWithoutProviders' | 'sayTTS' | 'stableDiff' | 'addRerolls'
  args: unknown[]
}

const calls: SideEffectCall[] = []

export function recordSideEffect(fn: SideEffectCall['fn'], args: unknown[]): void {
  calls.push({ fn, args })
}

export function getSideEffectCalls(): SideEffectCall[] {
  return calls
}

export function resetSideEffectCalls(): void {
  calls.length = 0
}
