import type { FastifyInstance, FastifyReply } from 'fastify'
import { Buffer } from 'node:buffer'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthState } from '../auth.js'
import { PREFER_RETURN_MINIMAL, prefersMinimalResponse, requireAuth } from '../http.js'
import {
  deleteMemorySummary,
  getMemorySummary,
  listMemoryChunkPage,
  listMemorySummaryPage,
  type MemoryChunkPageCursor,
  type MemorySummaryPageCursor,
  updateMemorySummary,
} from '../memoryRepository.js'
import { ValidationError } from '../repository.js'
import {
  assertManualChatMutationAllowedInTransaction,
  runImmediateChatMutationTransaction,
  sendChatMutationError,
} from './chatOccupancyMutation.js'

interface MemoryReadParams {
  chatId: string
}

interface ListMemoryChunksQuery {
  limit?: unknown
  cursor?: unknown
}

interface ListMemorySummariesQuery extends ListMemoryChunksQuery {
  model?: unknown
}

interface UpdateMemorySummaryBody {
  text?: unknown
  isImportant?: unknown
  categoryId?: unknown
  tags?: unknown
}

const MEMORY_READ_DEFAULT_LIMIT = 200
const MEMORY_READ_MAX_LIMIT = MEMORY_READ_DEFAULT_LIMIT
const MEMORY_READ_LEGACY_MAX_ROWS = 1_000
const MEMORY_READ_CURSOR_MAX_LENGTH = 512

type MemoryReadCursor =
  | {
      version: 1
      kind: 'chunks'
      chatId: string
      model: null
      last: MemoryChunkPageCursor
    }
  | {
      version: 1
      kind: 'summaries'
      chatId: string
      model: string | null
      last: MemorySummaryPageCursor
    }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function badRequest(error: string): { error: string } {
  return { error }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function invalidPagination(reply: FastifyReply, reason: string): { error: string; reason: string } {
  reply.code(400)
  return { error: 'invalid_memory_read_pagination', reason }
}

function readPageLimit(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const limit = Number(value)
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MEMORY_READ_MAX_LIMIT ? limit : null
}

function encodeMemoryReadCursor(cursor: MemoryReadCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeMemoryReadCursor(encoded: unknown): MemoryReadCursor | null {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > MEMORY_READ_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return null
  }
  let parsed: unknown
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) return null
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.chatId !== 'string' || !isObject(parsed.last)) {
    return null
  }
  if (parsed.kind === 'chunks') {
    if (parsed.model !== null || !hasExactKeys(parsed, ['version', 'kind', 'chatId', 'model', 'last'])) return null
    if (!isChunkCursor(parsed.last)) return null
    return {
      version: 1,
      kind: 'chunks',
      chatId: parsed.chatId,
      model: null,
      last: parsed.last,
    }
  }
  if (parsed.kind === 'summaries') {
    if (
      (parsed.model !== null && typeof parsed.model !== 'string') ||
      !hasExactKeys(parsed, ['version', 'kind', 'chatId', 'model', 'last']) ||
      !isSummaryCursor(parsed.last)
    ) {
      return null
    }
    return {
      version: 1,
      kind: 'summaries',
      chatId: parsed.chatId,
      model: parsed.model as string | null,
      last: parsed.last,
    }
  }
  return null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => hasOwn(value, key))
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isChunkCursor(value: Record<string, unknown>): value is Record<string, unknown> & MemoryChunkPageCursor {
  return (
    hasExactKeys(value, ['rangeStartSeq', 'rangeEndSeq', 'createdAt', 'id']) &&
    isSafeNonNegativeInteger(value.rangeStartSeq) &&
    isSafeNonNegativeInteger(value.rangeEndSeq) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.id)
  )
}

function isSummaryCursor(value: Record<string, unknown>): value is Record<string, unknown> & MemorySummaryPageCursor {
  return (
    hasExactKeys(value, ['orphanSort', 'rangeStartSort', 'rangeEndSort', 'createdAt', 'id']) &&
    (value.orphanSort === 0 || value.orphanSort === 1) &&
    isSafeNonNegativeInteger(value.rangeStartSort) &&
    isSafeNonNegativeInteger(value.rangeEndSort) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.id)
  )
}

export function registerMemoryReadRoutes(app: FastifyInstance, db: DatabaseSync, authState: AuthState): void {
  app.get<{ Params: MemoryReadParams; Querystring: ListMemoryChunksQuery }>(
    '/api/v1/memory/chunks/:chatId',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      if (!isNonEmptyString(req.params.chatId)) {
        reply.code(400)
        return badRequest('chatId must be a non-empty string')
      }

      if (req.query.limit === undefined) {
        if (req.query.cursor !== undefined) {
          return invalidPagination(reply, 'cursor requires a limit')
        }
        const page = listMemoryChunkPage(db, {
          chatId: req.params.chatId,
          limit: MEMORY_READ_LEGACY_MAX_ROWS,
        })
        if (page.nextCursor) {
          reply.code(413)
          return { error: 'memory_read_requires_pagination', maxRows: MEMORY_READ_LEGACY_MAX_ROWS }
        }
        return { chunks: page.chunks }
      }

      const limit = readPageLimit(req.query.limit)
      if (limit === null) return invalidPagination(reply, `limit must be an integer from 1 to ${MEMORY_READ_MAX_LIMIT}`)
      const cursor = req.query.cursor === undefined ? null : decodeMemoryReadCursor(req.query.cursor)
      if (req.query.cursor !== undefined && cursor === null) {
        return invalidPagination(reply, 'cursor is invalid')
      }
      if (cursor && (cursor.kind !== 'chunks' || cursor.chatId !== req.params.chatId || cursor.model !== null)) {
        return invalidPagination(reply, 'cursor does not match this chunk read')
      }
      const page = listMemoryChunkPage(db, {
        chatId: req.params.chatId,
        limit,
        ...(cursor?.kind === 'chunks' ? { cursor: cursor.last } : {}),
      })
      return {
        chunks: page.chunks,
        nextCursor: page.nextCursor
          ? encodeMemoryReadCursor({
              version: 1,
              kind: 'chunks',
              chatId: req.params.chatId,
              model: null,
              last: page.nextCursor,
            })
          : null,
      }
    },
  )

  app.get<{ Params: MemoryReadParams; Querystring: ListMemorySummariesQuery }>(
    '/api/v1/memory/summaries/:chatId',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      if (!isNonEmptyString(req.params.chatId)) {
        reply.code(400)
        return badRequest('chatId must be a non-empty string')
      }
      if (req.query.model !== undefined && !isNonEmptyString(req.query.model)) {
        reply.code(400)
        return badRequest('model must be a non-empty string when provided')
      }

      const model = typeof req.query.model === 'string' ? req.query.model : undefined
      if (req.query.limit === undefined) {
        if (req.query.cursor !== undefined) {
          return invalidPagination(reply, 'cursor requires a limit')
        }
        const page = listMemorySummaryPage(db, {
          chatId: req.params.chatId,
          model,
          limit: MEMORY_READ_LEGACY_MAX_ROWS,
        })
        if (page.nextCursor) {
          reply.code(413)
          return { error: 'memory_read_requires_pagination', maxRows: MEMORY_READ_LEGACY_MAX_ROWS }
        }
        return { summaries: page.summaries }
      }

      const limit = readPageLimit(req.query.limit)
      if (limit === null) return invalidPagination(reply, `limit must be an integer from 1 to ${MEMORY_READ_MAX_LIMIT}`)
      const cursor = req.query.cursor === undefined ? null : decodeMemoryReadCursor(req.query.cursor)
      if (req.query.cursor !== undefined && cursor === null) {
        return invalidPagination(reply, 'cursor is invalid')
      }
      if (
        cursor &&
        (cursor.kind !== 'summaries' || cursor.chatId !== req.params.chatId || cursor.model !== (model ?? null))
      ) {
        return invalidPagination(reply, 'cursor does not match this summary read')
      }
      const page = listMemorySummaryPage(db, {
        chatId: req.params.chatId,
        model,
        limit,
        ...(cursor?.kind === 'summaries' ? { cursor: cursor.last } : {}),
      })
      return {
        summaries: page.summaries,
        nextCursor: page.nextCursor
          ? encodeMemoryReadCursor({
              version: 1,
              kind: 'summaries',
              chatId: req.params.chatId,
              model: model ?? null,
              last: page.nextCursor,
            })
          : null,
      }
    },
  )

  app.patch<{ Params: { summaryId: string }; Body: UpdateMemorySummaryBody }>(
    '/api/v1/memory/summaries/:summaryId',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      if (!isNonEmptyString(req.params.summaryId)) {
        reply.code(400)
        return badRequest('summaryId must be a non-empty string')
      }
      if (!isObject(req.body)) {
        reply.code(400)
        return badRequest('body must be an object')
      }

      const allowedKeys = new Set(['text', 'isImportant', 'categoryId', 'tags'])
      const unexpectedKey = Object.keys(req.body).find((key) => !allowedKeys.has(key))
      if (unexpectedKey) {
        reply.code(400)
        return badRequest(`unsupported memory summary field: ${unexpectedKey}`)
      }
      if (!Object.keys(req.body).some((key) => allowedKeys.has(key))) {
        reply.code(400)
        return badRequest('memory summary update must include at least one field')
      }
      if (hasOwn(req.body, 'text') && typeof req.body.text !== 'string') {
        reply.code(400)
        return badRequest('text must be a string when provided')
      }
      if (hasOwn(req.body, 'isImportant') && typeof req.body.isImportant !== 'boolean') {
        reply.code(400)
        return badRequest('isImportant must be a boolean when provided')
      }
      if (hasOwn(req.body, 'categoryId') && req.body.categoryId !== null && typeof req.body.categoryId !== 'string') {
        reply.code(400)
        return badRequest('categoryId must be a string or null when provided')
      }
      let normalizedTags: string[] | null | undefined
      if (hasOwn(req.body, 'tags')) {
        const tags = req.body.tags
        if (tags !== null && (!Array.isArray(tags) || !tags.every((tag: unknown) => typeof tag === 'string'))) {
          reply.code(400)
          return badRequest('tags must be an array of strings or null when provided')
        }
        normalizedTags =
          tags === null
            ? null
            : [...new Set((tags as string[]).map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
      }

      try {
        const summary = runImmediateChatMutationTransaction(db, () => {
          const existing = getMemorySummary(db, req.params.summaryId)
          if (!existing) return null
          assertManualChatMutationAllowedInTransaction(db, existing.chatId, req)

          const metadataPatchRequested = ['isImportant', 'categoryId', 'tags'].some((key) => hasOwn(req.body, key))
          const metadata = isObject(existing.metadata) ? { ...existing.metadata } : {}
          if (hasOwn(req.body, 'isImportant')) metadata.isImportant = req.body.isImportant
          if (hasOwn(req.body, 'categoryId')) {
            if (req.body.categoryId === null || req.body.categoryId === '') delete metadata.categoryId
            else metadata.categoryId = req.body.categoryId
          }
          if (hasOwn(req.body, 'tags')) {
            if (normalizedTags === null) {
              delete metadata.tags
            } else {
              metadata.tags = normalizedTags
            }
          }

          return updateMemorySummary(db, req.params.summaryId, {
            ...(typeof req.body.text === 'string' ? { text: req.body.text, tokens: 0 } : {}),
            ...(metadataPatchRequested ? { metadata } : {}),
          })
        })
        if (!summary) {
          reply.code(404)
          return badRequest('memory summary not found')
        }
        if (prefersMinimalResponse(req.headers.prefer)) {
          reply.header('preference-applied', PREFER_RETURN_MINIMAL)
          return { summaryId: req.params.summaryId }
        }
        return { summary }
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(400)
          return badRequest(error.message)
        }
        return sendChatMutationError(reply, error)
      }
    },
  )

  app.delete<{ Params: { summaryId: string } }>('/api/v1/memory/summaries/:summaryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    if (!isNonEmptyString(req.params.summaryId)) {
      reply.code(400)
      return badRequest('summaryId must be a non-empty string')
    }
    let summary
    try {
      summary = runImmediateChatMutationTransaction(db, () => {
        const existing = getMemorySummary(db, req.params.summaryId)
        if (!existing) return null
        assertManualChatMutationAllowedInTransaction(db, existing.chatId, req)
        return deleteMemorySummary(db, existing.id)
      })
    } catch (error) {
      return sendChatMutationError(reply, error)
    }
    if (!summary) {
      reply.code(404)
      return badRequest('memory summary not found')
    }
    if (prefersMinimalResponse(req.headers.prefer)) {
      reply.header('preference-applied', PREFER_RETURN_MINIMAL)
      return { summaryId: summary.id }
    }
    return { summary }
  })
}
