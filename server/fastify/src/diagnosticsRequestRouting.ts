import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDiagnosticTransportUrl } from '@risuai/protocol/remote-diagnostics'

/** Router decoding failures occur before onRequest, tracing, and normal error hooks. */
export function onDiagnosticBadUrl(pathname: string, request: IncomingMessage, response: ServerResponse): void {
  const diagnostic = isDiagnosticTransportUrl(request.url ?? pathname)
  const body = JSON.stringify(
    diagnostic
      ? { error: 'invalid-query' }
      : {
          error: 'Bad Request',
          code: 'FST_ERR_BAD_URL',
          message: `'${pathname}' is not a valid url component`,
          statusCode: 400,
        },
  )
  response.writeHead(400, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(diagnostic ? { 'Cache-Control': 'no-store' } : {}),
  })
  response.end(body)
}
