import { describe, expect, it } from 'vitest'

import {
  decodeProxyJobWsChunk,
  formatProxyStreamErrorMessage,
  parseProxyJobWsEvent,
  readProxyJobWsBinaryChunk,
} from './proxyJobWs'

describe('parseProxyJobWsEvent', () => {
  it('returns null for invalid input', () => {
    expect(parseProxyJobWsEvent('not-json')).toBeNull()
    expect(parseProxyJobWsEvent(JSON.stringify({ nope: 1 }))).toBeNull()
    expect(parseProxyJobWsEvent(JSON.stringify({ type: 'unknown' }))).toBeNull()
  })

  it.each([
    { type: 'job_accepted', jobId: '' },
    { type: 'upstream_headers', status: 99, headers: {} },
    { type: 'upstream_headers', status: 200, headers: { 'x-invalid': 1 } },
    { type: 'chunk', dataBase64: 'not base64' },
    { type: 'error', status: '500', message: 'failed' },
    { type: 'error', status: 500, message: { text: 'failed' } },
    { type: 'ping', ts: 'now' },
  ])('rejects malformed $type payloads', (event) => {
    expect(parseProxyJobWsEvent(JSON.stringify(event))).toBeNull()
  })

  it.each([
    {
      input: { type: 'job_accepted', jobId: 'job-a', ignored: true },
      expected: { type: 'job_accepted', jobId: 'job-a' },
    },
    {
      input: {
        type: 'upstream_headers',
        status: 206,
        headers: { 'content-type': 'text/plain' },
        ignored: true,
      },
      expected: { type: 'upstream_headers', status: 206, headers: { 'content-type': 'text/plain' } },
    },
    {
      input: { type: 'chunk', dataBase64: 'YWJj', ignored: true },
      expected: { type: 'chunk', dataBase64: 'YWJj' },
    },
    {
      input: { type: 'error', message: 'failed', ignored: true },
      expected: { type: 'error', message: 'failed' },
    },
    {
      input: { type: 'error', status: 502, message: 'failed', ignored: true },
      expected: { type: 'error', status: 502, message: 'failed' },
    },
    {
      input: { type: 'done', ignored: true },
      expected: { type: 'done' },
    },
    {
      input: { type: 'ping', ts: 1234, ignored: true },
      expected: { type: 'ping', ts: 1234 },
    },
  ])('normalizes a valid $input.type payload to its exact public keys', ({ input, expected }) => {
    expect(parseProxyJobWsEvent(JSON.stringify(input))).toEqual(expected)
  })
})

describe('decodeProxyJobWsChunk', () => {
  it('decodes base64 payload into bytes', () => {
    const bytes = decodeProxyJobWsChunk(Buffer.from('abc', 'utf-8').toString('base64'))
    expect(new TextDecoder().decode(bytes)).toBe('abc')
  })
})

describe('readProxyJobWsBinaryChunk', () => {
  it('reads ArrayBuffer websocket payloads directly', () => {
    const source = new Uint8Array([97, 98, 99])
    const bytes = readProxyJobWsBinaryChunk(source.buffer)
    expect(bytes).not.toBeNull()
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe('abc')
  })

  it('reads ArrayBufferView websocket payloads directly', () => {
    const source = new Uint8Array([0, 97, 98, 99, 0])
    const bytes = readProxyJobWsBinaryChunk(source.subarray(1, 4))
    expect(bytes).not.toBeNull()
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe('abc')
  })
})

describe('formatProxyStreamErrorMessage', () => {
  it('maps cloudflare/origin timeout errors to clear message', () => {
    const msg = formatProxyStreamErrorMessage(504, '<!DOCTYPE html><title>Gateway time-out</title>')
    expect(msg).toContain('Cloudflare/origin timeout')
  })

  it('passes through non-timeout messages', () => {
    expect(formatProxyStreamErrorMessage(400, 'bad request')).toBe('bad request')
  })
})
