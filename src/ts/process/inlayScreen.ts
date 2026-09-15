import { writeInlayImage } from './files/inlays'
import type { character } from '../storage/database.svelte'
import { generateAIImage } from './stableDiff'

const imggenRegex = [/<ImgGen="(.+?)">/gi, /{{ImgGen="(.+?)"}}/gi] as const

/** Pure preflight used to reserve the accepted-operation effect before an
 * image provider promise can start. */
export function inlayScreenRequiresFinalization(char: character, data: string): boolean {
  if (!char.inlayViewScreen) return false
  if (char.viewScreen === 'emotion') return /<Emotion="(.+?)">/i.test(data)
  if (char.viewScreen === 'imggen') return /<ImgGen="(.+?)">|{{ImgGen="(.+?)"}}/i.test(data)
  return false
}

/** Render the immediate inlay placeholder without starting an image provider.
 * TTS-only projections must use this path because they have no durable
 * preparation/settlement authority of their own. */
export function renderInlayScreenTextWithoutProviders(char: character, data: string): string {
  if (!char.inlayViewScreen) return data
  if (char.viewScreen === 'emotion') return data.replace(/<Emotion="(.+?)">/gi, '{{emotion::$1}}')
  if (char.viewScreen === 'imggen') {
    return data.replace(imggenRegex[0], '[Generating...]').replace(imggenRegex[1], '[Generating...]')
  }
  return data
}

export interface RunInlayScreenOptions {
  /** Provider lifetime is fenced only by exact operation supersession. */
  signal?: AbortSignal
  /** Gives each returned image an independent bounded encode/upload/catalog
   * continuation without sharing that deadline with sibling providers. */
  settlePostProvider?: <T>(settle: (signal?: AbortSignal) => Promise<T>) => Promise<T>
}

export function runInlayScreen(
  char: character,
  data: string,
  options: RunInlayScreenOptions = {},
): { text: string; promise?: Promise<string> } {
  if (char.inlayViewScreen) {
    if (char.viewScreen === 'emotion') {
      return { text: renderInlayScreenTextWithoutProviders(char, data) }
    }
    if (char.viewScreen === 'imggen') {
      return {
        text: renderInlayScreenTextWithoutProviders(char, data),
        promise: (async () => {
          for (const regex of imggenRegex) {
            const promises: Promise<string | false>[] = []
            const neg = char.newGenData.negative
            data.replace(regex, (match, p1) => {
              const prompt = char.newGenData.prompt.replaceAll('{{slot}}', p1)
              promises.push(
                (async () => {
                  const v = await generateAIImage(prompt, char, neg, 'inlay', { signal: options.signal })
                  if (!v) {
                    return false
                  }
                  const persistImage = async (signal = options.signal) => {
                    signal?.throwIfAborted()
                    const imgHTML = new Image()
                    imgHTML.src = v
                    const inlay = await writeInlayImage(imgHTML, { signal })
                    signal?.throwIfAborted()
                    return inlay
                  }
                  const inlay = options.settlePostProvider
                    ? await options.settlePostProvider(persistImage)
                    : await persistImage()
                  return `{{inlay::${inlay}}}`
                })(),
              )
              return match
            })
            const d = await Promise.all(promises)
            data = data.replace(regex, (match) => {
              const result = d.shift()
              if (result === false) {
                // Preserve the source obligation so the durable accepted-
                // operation path can abandon it instead of committing a
                // silently deleted tag. Legacy callers likewise keep a
                // retryable transcript when the provider is unavailable.
                return match
              }
              return result
            })
          }
          return data
        })(),
      }
    }
  }

  return { text: data }
}

export function updateInlayScreen(char: character): character {
  switch (char.viewScreen) {
    case 'emotion':
      if (char.inlayViewScreen) {
        char.newGenData = {
          prompt: '',
          negative: '',
          instructions: '',
          emotionInstructions: `You must always output the character's emotional image as a command at the end of a conversation. The command must be selected from a given list, and it's better to have variety than to repeat images used in previous chats. Use one image, depending on the character's emotion. See the list below. Form: <Emotion="<image command>"> Example: <Emotion="Agree"> List of commands: {{slot}}`,
        }
        return char
      }
      char.newGenData = {
        prompt: '',
        negative: '',
        instructions: '',
        emotionInstructions: `You must always output the character's emotional image as a command. The command must be selected from a given list, only output the command, depending on the character's emotion. List of commands: {{slot}}`,
      }
      return char
    case 'imggen':
      if (char.inlayViewScreen) {
        char.newGenData = {
          prompt: 'best quality, {{slot}}',
          negative: 'worse quality',
          instructions:
            'You must always output the character\'s image as a keyword-formatted prompts that can be used in stable diffusion  at the end of a conversation. Use one image, depending on character, place, situation, etc. keyword should be long enough. Form: <ImgGen="<keyword-formatted prompt>">',
          emotionInstructions: '',
        }
        return char
      }
      char.newGenData = {
        prompt: 'best quality, {{slot}}',
        negative: 'worse quality',
        instructions:
          "You must always output the character's image as a keyword-formatted prompts that can be used in stable diffusion. only output the that prompt, depending on character, place, situation, etc. keyword should be long enough.",
        emotionInstructions: '',
      }
      return char
    default:
      char.newGenData = {
        prompt: '',
        negative: '',
        instructions: '',
        emotionInstructions: '',
      }
      return char
  }
}
