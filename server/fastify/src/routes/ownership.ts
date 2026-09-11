import { OWNERSHIP_ENDPOINT, OWNERSHIP_PROTOCOL_VERSION, type OwnershipResponse } from '@risuai/protocol/ownership'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthState } from '../auth.js'
import { getDatabaseOwnershipSnapshot } from '../databaseLineage.js'
import { requireAuth } from '../http.js'

export function registerOwnershipRoutes(app: FastifyInstance, db: DatabaseSync, authState: AuthState): void {
  app.get(OWNERSHIP_ENDPOINT, { exposeHeadRoute: false }, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    if (!(await requireAuth(authState, req, reply))) return
    const ownership = getDatabaseOwnershipSnapshot(db)
    return {
      version: OWNERSHIP_PROTOCOL_VERSION,
      ...ownership,
    } satisfies OwnershipResponse
  })
}
