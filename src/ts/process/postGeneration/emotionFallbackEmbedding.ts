import { captureClientSessionGeneration } from '../../clientSession'
import { isClientWriteOperationCurrent } from '../../clientWriteOperation'
import type { character } from '../../storage/database.svelte'
import { HypaProcesser } from '../memory/hypamemory'
import { pushCharEmotionEntry, type CharEmotionEntry, type CharEmotionMap } from './charEmotionStore'

export interface RunEmotionEmbeddingFallbackOptions {
  isCurrent?: () => boolean
  result: string
  currentChar: character
  tempEmotion: CharEmotionEntry[]
  charemotions: CharEmotionMap
}

export async function runEmotionEmbeddingFallback(opts: RunEmotionEmbeddingFallbackOptions): Promise<void> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = opts.isCurrent ?? (() => isClientWriteOperationCurrent(sourceGeneration))
  if (!isCurrent()) return

  const currentEmotion = opts.currentChar.emotionImages
  const emotionList = currentEmotion.map((a) => a[0])

  const hypaProcesser = new HypaProcesser()
  await hypaProcesser.addText(emotionList.map((v) => 'emotion:' + v))
  if (!isCurrent()) return
  const similarities = await hypaProcesser.similaritySearchScored(opts.result)
  if (!isCurrent()) return
  const searched = similarities.map((v) => {
    v[0] = v[0].replace('emotion:', '')
    return v
  })

  // Recency penalty: most-recent tempEmotion entries (higher i) get the
  // smallest subtraction; the formula intentionally rewards older entries.
  for (let i = 0; i < opts.tempEmotion.length; i++) {
    const emo = opts.tempEmotion[i]
    const index = searched.findIndex((v) => v[0] === emo[0])
    const modifier = (5 - (opts.tempEmotion.length - (i + 1))) / 200
    if (index !== -1) {
      searched[index][1] -= modifier
    }
  }

  const emoresult = searched.sort((a, b) => b[1] - a[1]).map((v) => v[0])

  for (const emo of currentEmotion) {
    if (emo[0] === emoresult[0]) {
      pushCharEmotionEntry({
        emoTuple: emo,
        tempEmotion: opts.tempEmotion,
        charemotions: opts.charemotions,
        chaId: opts.currentChar.chaId,
      })
      break
    }
  }
}
