import { captureClientSessionGeneration } from '../../clientSession'
import { isClientWriteOperationCurrent } from '../../clientWriteOperation'
import type { Database, character } from '../../storage/database.svelte'
import type { OpenAIChat } from '../index.svelte'
import { tokenizeNum } from '../../tokenizer'
import { requestChatData } from '../request/request'
import { language } from '../../../lang'
import { pushCharEmotionEntry, type CharEmotionEntry, type CharEmotionMap } from './charEmotionStore'

export interface RunEmotionLlmFallbackOptions {
  database: Database
  isCurrent?: () => boolean
  result: string
  currentChar: character
  abortSignal: AbortSignal
  throwError: (msg: string) => void
  emotionPrompt2?: string
  tempEmotion: CharEmotionEntry[]
  charemotions: CharEmotionMap
}

const DEFAULT_EMOTION_PROMPT =
  "From the list below, choose a word that best represents a character's outfit description, action, or emotion in their dialogue. Prioritize selecting words related to outfit first, then action, and lastly emotion. Print out the chosen word."

function shuffleArray(array: string[]): string[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

export async function runEmotionLlmFallback(opts: RunEmotionLlmFallbackOptions): Promise<void> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = opts.isCurrent ?? (() => isClientWriteOperationCurrent(sourceGeneration))
  if (!isCurrent()) return

  const currentEmotion = opts.currentChar.emotionImages
  let emotionList = currentEmotion.map((a) => a[0])

  const emobias: { [key: number]: number } = {}

  for (const emo of emotionList) {
    const tokens = await tokenizeNum(emo, opts.database)
    if (!isCurrent() || opts.abortSignal.aborted) return
    for (const token of tokens) {
      emobias[token] = 10
    }
  }

  for (let i = 0; i < opts.tempEmotion.length; i++) {
    const emo = opts.tempEmotion[i]

    const tokens = await tokenizeNum(emo[0], opts.database)
    if (!isCurrent() || opts.abortSignal.aborted) return
    const modifier = 20 - (opts.tempEmotion.length - (i + 1)) * (20 / 4)

    for (const token of tokens) {
      emobias[token] -= modifier
      if (emobias[token] < -100) {
        emobias[token] = -100
      }
    }
  }

  const promptbody: OpenAIChat[] = [
    {
      role: 'system',
      content: `${opts.emotionPrompt2 || DEFAULT_EMOTION_PROMPT}\n\n list: ${shuffleArray(emotionList).join(', ')} \noutput only one word.`,
    },
    {
      role: 'user',
      content: `"Good morning, Master! Is there anything I can do for you today?"`,
    },
    {
      role: 'assistant',
      content: 'happy',
    },
    {
      role: 'user',
      content: opts.result,
    },
  ]

  const rq = await requestChatData(
    {
      database: opts.database,
      formated: promptbody,
      bias: emobias,
      currentChar: opts.currentChar,
      maxTokens: 30,
    },
    'emotion',
    opts.abortSignal,
  )

  if (!isCurrent() || opts.abortSignal.aborted) return
  if (rq.type === 'fail') {
    if (opts.abortSignal.aborted) return
    opts.throwError(rq.result)
    return
  }
  if (rq.type === 'streaming' || rq.type === 'multiline') {
    if (opts.abortSignal.aborted) return
    opts.throwError('Unexpected response type')
    return
  }

  emotionList = currentEmotion.map((a) => a[0])
  try {
    const emotion: string = rq.result.replace(/ |\n/g, '').trim().toLocaleLowerCase()
    let emotionSelected = false
    for (const emo of currentEmotion) {
      if (emo[0] === emotion) {
        pushCharEmotionEntry({
          emoTuple: emo,
          tempEmotion: opts.tempEmotion,
          charemotions: opts.charemotions,
          chaId: opts.currentChar.chaId,
        })
        emotionSelected = true
        break
      }
    }
    if (!emotionSelected) {
      for (const emo of currentEmotion) {
        if (emotion.includes(emo[0])) {
          pushCharEmotionEntry({
            emoTuple: emo,
            tempEmotion: opts.tempEmotion,
            charemotions: opts.charemotions,
            chaId: opts.currentChar.chaId,
          })
          emotionSelected = true
          break
        }
      }
    }
    if (!emotionSelected && emotionList.includes('neutral')) {
      const emo = currentEmotion[emotionList.indexOf('neutral')]
      pushCharEmotionEntry({
        emoTuple: emo,
        tempEmotion: opts.tempEmotion,
        charemotions: opts.charemotions,
        chaId: opts.currentChar.chaId,
      })
      emotionSelected = true
    }
  } catch (error) {
    opts.throwError(language.errors.httpError + `${error}`)
  }
}
