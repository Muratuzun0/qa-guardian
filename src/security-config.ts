import { z } from 'zod'
import { ConfigError } from './errors.js'
import { parseTarget } from './network.js'

const fieldPath = z.array(z.string().min(1).max(128)).min(1).max(12)
const identity = z.string().regex(/^[A-Za-z_][A-Za-z_0-9]{0,63}$/)
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)

export const securitySchema = z.strictObject({
  authorized: z.literal(true),
  origin: z.string().max(512),
  timeoutMs: z.number().int().min(1).max(15_000).default(5000),
  requestBudget: z.number().int().min(1).max(20).default(10),
  endpoints: z.array(z.strictObject({
    id: identifier,
    path: z.string().max(512).regex(/^\/(?!\/)[^?#\\]*$/u),
    expectedStatus: z.number().int().min(200).max(599),
    bearerTokenEnv: identity.optional(),
    expectHeaders: z.array(z.enum([
      'content-security-policy', 'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'cache-control',
    ])).max(5).default([]),
    sensitive: z.boolean().default(false),
    corsOrigins: z.array(z.string().max(512)).max(10).optional(),
    sensitiveFields: z.array(fieldPath).max(10).default([]),
    inspectDiagnostics: z.boolean().default(false),
    jwt: z.strictObject({
      path: fieldPath,
      algorithms: z.array(z.enum(['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512',
        'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'EdDSA'])).min(1).optional(),
      requiredClaims: z.array(identifier).max(15).default(['exp']),
      maxLifetimeSeconds: z.number().int().positive().max(31_536_000).optional(),
    }).optional(),
  })).min(1).max(20),
})

export type SecurityConfig = z.infer<typeof securitySchema>
export type SecurityEndpoint = SecurityConfig['endpoints'][number]

export const isSecurityLoopback = (url: URL) => url.hostname === '127.0.0.1' || url.hostname === '[::1]'

export function validateSecurity(config: SecurityConfig, base: URL): void {
  if (config.origin !== base.origin || (base.protocol !== 'https:' && !isSecurityLoopback(base))) {
    throw new ConfigError('security.origin: Match the canonical base origin. HTTPS is required except on literal loopback.')
  }
  if (config.endpoints.length > config.requestBudget) throw new ConfigError('security endpoints exceed requestBudget.')
  if (new Set(config.endpoints.map(item => item.id)).size !== config.endpoints.length) throw new ConfigError('security endpoint IDs must be unique.')
  for (const item of config.endpoints) {
    try {
      if (parseTarget(item.path, base).origin !== base.origin) throw new Error()
    } catch {
      throw new ConfigError('security endpoint paths must stay on the configured origin.')
    }
    for (const value of item.corsOrigins ?? []) {
      try {
        if (parseTarget(value).origin !== value) throw new Error()
      } catch {
        throw new ConfigError('security.corsOrigins entries must be canonical HTTP(S) origins.')
      }
    }
  }
}
