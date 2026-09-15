import { risuChatParser } from './parser.svelte'
import { parseChatMLRows } from '@risuai/shared-core/chatml-rows'

export function parseChatML(
  data: string,
  transformContent: (content: string) => string = risuChatParser,
): OpenAIChat[] | null {
  return parseChatMLRows(data, transformContent)
}
