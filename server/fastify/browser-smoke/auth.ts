import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { expect } from '@playwright/test'

const BROWSER_SMOKE_PASSWORD = 'risu-fastify-browser-smoke'

function passwordDigest(): string {
  return createHash('sha256').update(Buffer.from(BROWSER_SMOKE_PASSWORD, 'utf-8')).digest('hex')
}

export async function setupBrowserSmokeAuth(app: FastifyInstance): Promise<string> {
  // Harnesses can span several tests. Use the supported session credential
  // instead of keeping a single short-lived assertion for their entire run.
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: passwordDigest(), sessionAuth: true },
  })
  expect(setup.statusCode).toBe(200)
  const { authToken } = setup.json<{ authToken: string }>()
  expect(authToken).toEqual(expect.any(String))
  return authToken
}
