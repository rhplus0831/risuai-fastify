import type { RateLimitOptions } from '@fastify/rate-limit'

const MINUTE = '1 minute'

export const supportDiagnosticsRateLimit: RateLimitOptions = {
  max: 30,
  timeWindow: MINUTE,
}

export const authSetupRateLimit: RateLimitOptions = {
  max: 5,
  timeWindow: MINUTE,
}

export const authLoginRateLimit: RateLimitOptions = {
  max: 10,
  timeWindow: MINUTE,
}

export const authCryptoRateLimit: RateLimitOptions = {
  max: 60,
  timeWindow: MINUTE,
}

export const proxyFetchRateLimit: RateLimitOptions = {
  max: 120,
  timeWindow: MINUTE,
}

export const providerOperationRateLimit: RateLimitOptions = {
  max: 60,
  timeWindow: MINUTE,
}

export const openAITranscriptionRateLimit: RateLimitOptions = {
  max: 10,
  timeWindow: MINUTE,
}

export const imageGenerationRateLimit: RateLimitOptions = {
  max: 10,
  timeWindow: MINUTE,
}

export const mcpOAuthRefreshRateLimit: RateLimitOptions = {
  max: 30,
  timeWindow: MINUTE,
}

export const ttsSynthesisRateLimit: RateLimitOptions = {
  max: 60,
  timeWindow: MINUTE,
}

export const proxyStreamCreateRateLimit: RateLimitOptions = {
  max: 30,
  timeWindow: MINUTE,
}

export const importRateLimit: RateLimitOptions = {
  max: 10,
  timeWindow: MINUTE,
}

export const assetExistsRateLimit: RateLimitOptions = {
  max: 180,
  timeWindow: MINUTE,
}

export const storageUsageRateLimit: RateLimitOptions = {
  max: 10,
  timeWindow: MINUTE,
}

export const generationSubmitRateLimit: RateLimitOptions = {
  max: 60,
  timeWindow: MINUTE,
}
