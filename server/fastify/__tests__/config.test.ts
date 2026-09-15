import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTOMATIC_BACKUP_RETENTION,
  DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES,
  loadConfig,
} from '../src/config.js'
import { DEFAULT_GENERATION_TRACE_MAX_GZIP_BYTES } from '../src/generation/generationTraceSidecar.js'

const BASE_ENV = { RISU_API_DATA_DIR: '/tmp/risu-config-test' }

describe('loadConfig agent auth bypass', () => {
  it('accepts the bypass only on loopback binds', () => {
    for (const host of ['localhost', 'agent.localhost', '127.0.0.1', '127.42.0.9', '::1', '0:0:0:0:0:0:0:1']) {
      expect(
        loadConfig({ ...BASE_ENV, RISU_API_HOST: host, RISU_AGENT_DEV_AUTH_BYPASS: 'true' }).agentDevAuthBypass,
      ).toBe(true)
    }
  })

  it('rejects the bypass on the default or an explicit non-loopback bind', () => {
    expect(() => loadConfig({ ...BASE_ENV, RISU_AGENT_DEV_AUTH_BYPASS: 'true' })).toThrow(/requires a loopback/)
    for (const host of ['0.0.0.0', '::', '192.0.2.1', 'example.test']) {
      expect(() => loadConfig({ ...BASE_ENV, RISU_API_HOST: host, RISU_AGENT_DEV_AUTH_BYPASS: 'true' })).toThrow(
        /requires a loopback/,
      )
    }
  })
})

describe('loadConfig missing database override', () => {
  it('requires an explicit truthy value', () => {
    expect(loadConfig({ ...BASE_ENV }).allowMissingDatabase).toBe(false)
    expect(loadConfig({ ...BASE_ENV, RISU_API_ALLOW_MISSING_DATABASE: '1' }).allowMissingDatabase).toBe(true)
    expect(loadConfig({ ...BASE_ENV, RISU_API_ALLOW_MISSING_DATABASE: 'true' }).allowMissingDatabase).toBe(true)
    expect(loadConfig({ ...BASE_ENV, RISU_API_ALLOW_MISSING_DATABASE: '0' }).allowMissingDatabase).toBe(false)
  })
})

describe('loadConfig chat occupancy rollout', () => {
  it('enables the coherent chat occupancy protocol by default', () => {
    expect(loadConfig({ ...BASE_ENV }).chatOccupancyEnabled).toBe(true)
  })

  it('accepts explicit enabled and rollback values', () => {
    for (const raw of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      expect(loadConfig({ ...BASE_ENV, RISU_API_CHAT_OCCUPANCY_ENABLED: raw }).chatOccupancyEnabled).toBe(true)
    }
    for (const raw of ['0', 'false', 'no', 'off', ' OFF ']) {
      expect(loadConfig({ ...BASE_ENV, RISU_API_CHAT_OCCUPANCY_ENABLED: raw }).chatOccupancyEnabled).toBe(false)
    }
  })

  it('rejects invalid explicit values instead of silently disabling the protocol', () => {
    for (const raw of ['', 'enabled', 'disable', 'tru']) {
      expect(() => loadConfig({ ...BASE_ENV, RISU_API_CHAT_OCCUPANCY_ENABLED: raw })).toThrow(
        /Invalid RISU_API_CHAT_OCCUPANCY_ENABLED/,
      )
    }
  })
})

describe('loadConfig importMaxBytes', () => {
  it('defaults to unlimited so large backups import without per-deployment tuning', () => {
    expect(loadConfig({ ...BASE_ENV }).importMaxBytes).toBe(Number.POSITIVE_INFINITY)
  })

  it('treats 0 / unlimited / none / infinity as an explicit no-ceiling opt-out', () => {
    for (const raw of ['0', 'unlimited', 'UNLIMITED', 'none', ' Infinity ']) {
      expect(loadConfig({ ...BASE_ENV, RISU_API_IMPORT_MAX_BYTES: raw }).importMaxBytes).toBe(Number.POSITIVE_INFINITY)
    }
  })

  it('accepts a finite positive byte ceiling', () => {
    expect(loadConfig({ ...BASE_ENV, RISU_API_IMPORT_MAX_BYTES: '8000000000' }).importMaxBytes).toBe(8000000000)
  })

  it('rejects non-positive or non-numeric ceilings', () => {
    for (const raw of ['abc', '-1']) {
      expect(() => loadConfig({ ...BASE_ENV, RISU_API_IMPORT_MAX_BYTES: raw })).toThrow(
        /Invalid RISU_API_IMPORT_MAX_BYTES/,
      )
    }
  })
})

describe('loadConfig Realm import max expanded bytes', () => {
  it('defaults above the JSON body limit for streamed Realm charx packages', () => {
    expect(loadConfig({ ...BASE_ENV }).realmImportMaxExpandedBytes).toBe(DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES)
    expect(loadConfig({ ...BASE_ENV }).realmImportMaxExpandedBytes).toBeGreaterThan(
      loadConfig({ ...BASE_ENV }).bodyLimit,
    )
  })

  it('accepts a finite positive byte ceiling', () => {
    expect(
      loadConfig({ ...BASE_ENV, RISU_REALM_IMPORT_MAX_EXPANDED_BYTES: '536870912' }).realmImportMaxExpandedBytes,
    ).toBe(536870912)
  })

  it('rejects invalid ceilings', () => {
    for (const raw of ['0', '-1', '1.5', 'abc']) {
      expect(() => loadConfig({ ...BASE_ENV, RISU_REALM_IMPORT_MAX_EXPANDED_BYTES: raw })).toThrow(
        /Invalid RISU_REALM_IMPORT_MAX_EXPANDED_BYTES/,
      )
    }
  })
})

describe('loadConfig automatic backup retention', () => {
  it('defaults to three automatic safety snapshots', () => {
    expect(loadConfig({ ...BASE_ENV }).automaticBackupRetention).toBe(DEFAULT_AUTOMATIC_BACKUP_RETENTION)
    expect(DEFAULT_AUTOMATIC_BACKUP_RETENTION).toBe(3)
  })

  it('accepts a positive integer override', () => {
    expect(loadConfig({ ...BASE_ENV, RISU_API_AUTOMATIC_BACKUP_RETENTION: '5' }).automaticBackupRetention).toBe(5)
  })

  it('rejects invalid retention caps', () => {
    for (const raw of ['0', '-1', '1.5', 'abc']) {
      expect(() => loadConfig({ ...BASE_ENV, RISU_API_AUTOMATIC_BACKUP_RETENTION: raw })).toThrow(
        /Invalid RISU_API_AUTOMATIC_BACKUP_RETENTION/,
      )
    }
  })
})

describe('loadConfig request trace', () => {
  it('leaves request tracing disabled by default', () => {
    expect(loadConfig({ ...BASE_ENV }).requestTrace).toBeUndefined()
  })

  it('enables agent and human request trace modes', () => {
    expect(loadConfig({ ...BASE_ENV, RISU_API_TRACE_MODE: 'agent' }).requestTrace).toEqual({ mode: 'agent' })
    expect(loadConfig({ ...BASE_ENV, RISU_API_TRACE_MODE: 'human' }).requestTrace).toEqual({ mode: 'human' })
  })

  it('accepts explicit off values', () => {
    for (const raw of ['0', 'false', 'off', 'none']) {
      expect(loadConfig({ ...BASE_ENV, RISU_API_TRACE_MODE: raw }).requestTrace).toBeUndefined()
    }
  })

  it('rejects unknown request trace modes', () => {
    expect(() => loadConfig({ ...BASE_ENV, RISU_API_TRACE_MODE: 'debug' })).toThrow(/Invalid RISU_API_TRACE_MODE/)
  })
})

describe('loadConfig generation trace', () => {
  it('leaves full prompt sidecars disabled by default with the default cap', () => {
    expect(loadConfig({ ...BASE_ENV }).generationTrace).toEqual({
      fullPrompt: false,
      maxGzipBytes: DEFAULT_GENERATION_TRACE_MAX_GZIP_BYTES,
    })
  })

  it('enables full prompt sidecars only with the explicit flag', () => {
    expect(loadConfig({ ...BASE_ENV, RISU_GENERATION_TRACE_FULL_PROMPT: '1' }).generationTrace).toEqual({
      fullPrompt: true,
      maxGzipBytes: DEFAULT_GENERATION_TRACE_MAX_GZIP_BYTES,
    })
  })

  it('accepts a custom gzip cap', () => {
    expect(
      loadConfig({
        ...BASE_ENV,
        RISU_GENERATION_TRACE_FULL_PROMPT: '1',
        RISU_GENERATION_TRACE_FULL_PROMPT_MAX_GZIP_BYTES: '4096',
      }).generationTrace,
    ).toEqual({ fullPrompt: true, maxGzipBytes: 4096 })
  })

  it('rejects invalid gzip caps', () => {
    for (const raw of ['0', '-1', '1.5', 'abc']) {
      expect(() => loadConfig({ ...BASE_ENV, RISU_GENERATION_TRACE_FULL_PROMPT_MAX_GZIP_BYTES: raw })).toThrow(
        /Invalid RISU_GENERATION_TRACE_FULL_PROMPT_MAX_GZIP_BYTES/,
      )
    }
  })
})
