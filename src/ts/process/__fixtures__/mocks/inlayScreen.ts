import { recordSideEffect } from '../sideEffects'

export function inlayScreenRequiresFinalization(char: unknown, text: unknown): boolean {
  if (!char || typeof char !== 'object' || typeof text !== 'string') return false
  const candidate = char as { inlayViewScreen?: unknown; viewScreen?: unknown }
  if (candidate.inlayViewScreen !== true) return false
  if (candidate.viewScreen === 'emotion') return /<Emotion="(.+?)">/i.test(text)
  if (candidate.viewScreen === 'imggen') return /<ImgGen="(.+?)">|{{ImgGen="(.+?)"}}/i.test(text)
  return false
}

export function runInlayScreen(char: unknown, text: unknown): { text: string; promise: null } {
  recordSideEffect('runInlayScreen', [summarizeChar(char), text])
  return { text: typeof text === 'string' ? text : '', promise: null }
}

export function renderInlayScreenTextWithoutProviders(char: unknown, text: unknown): string {
  recordSideEffect('renderInlayScreenTextWithoutProviders', [summarizeChar(char), text])
  if (typeof text !== 'string') return ''
  if (!char || typeof char !== 'object') return text
  const candidate = char as { inlayViewScreen?: unknown; viewScreen?: unknown }
  if (candidate.inlayViewScreen !== true) return text
  if (candidate.viewScreen === 'emotion') return text.replace(/<Emotion="(.+?)">/gi, '{{emotion::$1}}')
  if (candidate.viewScreen === 'imggen') {
    return text.replace(/<ImgGen="(.+?)">/gi, '[Generating...]').replace(/{{ImgGen="(.+?)"}}/gi, '[Generating...]')
  }
  return text
}

function summarizeChar(char: unknown): { chaId?: string; name?: string } {
  if (!char || typeof char !== 'object') return {}
  const c = char as { chaId?: string; name?: string }
  return { chaId: c.chaId, name: c.name }
}
