import type { KeyObject } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ConfigError } from './errors.js'
import { parseTarget, request, RequestError, safeUrl } from './network.js'
import { result, type Result } from './report.js'
import { isSecurityLoopback, type SecurityConfig, type SecurityEndpoint } from './security-config.js'

import { jwtKey, jwtPolicy } from './security-jwt.js'

type Response = Awaited<ReturnType<typeof request>>
type Finding = {
  id: string
  category: NonNullable<Result['category']>
  message: string
  remediation: string
  owasp: NonNullable<Result['owasp']>
  severity?: 'error'
  heuristic?: true
  coverageIncomplete?: true
}

function field(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function json(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

function* inspect(url: URL, endpoint: SecurityEndpoint, response: Response, key?: KeyObject): Generator<Finding> {
  const misconfiguration = 'API8:2023' as const
  const { headers, status } = response
  if (status !== endpoint.expectedStatus) yield {
    id: 'status', category: 'access-control', severity: 'error', owasp: 'API2:2023',
    message: `Expected HTTP ${endpoint.expectedStatus} for this scenario, received ${status}.`,
    remediation: 'Review the route access policy and verify the configured test identity.',
  }
  const retry = headers['retry-after']?.trim()
  if (status === 429 && !retry) yield {
    id: 'retry-after', category: 'rate-limit', owasp: 'API4:2023',
    message: 'The response returned HTTP 429 without Retry-After.',
    remediation: 'Consider sending Retry-After so clients can back off appropriately.',
  }
  if (retry && !/^\d+$/.test(retry) &&
      (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) || !Number.isFinite(Date.parse(retry)))) yield {
    id: 'retry-after-format', category: 'rate-limit', owasp: 'API4:2023',
    message: 'Retry-After did not use delay seconds or an IMF-fixdate.',
    remediation: 'Return an integer delay in seconds or a valid HTTP date.',
  }
  if (endpoint.expectRateLimitHeaders) {
    const limitHeader = headers['x-ratelimit-limit']
    const remainingHeader = headers['x-ratelimit-remaining']
    const limit = typeof limitHeader === 'string' ? limitHeader.trim() : ''
    const remaining = typeof remainingHeader === 'string' ? remainingHeader.trim() : ''
    if (!limit || !remaining || !/^\d{1,15}$/.test(limit) || !/^\d{1,15}$/.test(remaining) ||
        Number(limit) < 1 || Number(remaining) > Number(limit)) yield {
      id: 'rate-limit-budget', category: 'rate-limit', owasp: 'API4:2023',
      message: 'The configured X-RateLimit limit and remaining headers were missing or inconsistent.',
      remediation: 'Report a positive limit and a remaining count between zero and that limit.',
    }
  }

  const html = /^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(headers['content-type'] ?? '')
  for (const name of endpoint.expectHeaders) {
    if ((name === 'strict-transport-security' && url.protocol !== 'https:') ||
        (name === 'content-security-policy' && !html)) continue
    const header = headers[name]
    const value = typeof header === 'string' ? header.trim() : undefined
    const valid = name === 'x-content-type-options' ? value?.toLowerCase() === 'nosniff' :
      name === 'strict-transport-security' ? /(?:^|;)\s*max-age\s*=\s*(?:[1-9]\d*|"[1-9]\d*")\s*(?:;|$)/i.test(value ?? '') :
      name === 'referrer-policy' ? value?.split(',').some(policy => [
        'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin',
        'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url',
      ].includes(policy.trim().toLowerCase())) : Boolean(value)
    if (!valid) yield {
      id: name, category: 'headers', owasp: misconfiguration, message: `Expected a usable ${name} response header.`,
      remediation: 'Set the header on the application or reverse proxy and review its policy for this response.',
    }
  }

  const cache = headers['cache-control']?.split(',').map(value => value.trim().toLowerCase())
  if (endpoint.sensitive && status >= 200 && status < 300 && !cache?.includes('no-store')) yield {
    id: 'sensitive-cache', category: 'headers', owasp: misconfiguration,
    message: 'A configured sensitive response did not declare Cache-Control: no-store.',
    remediation: 'Prevent storage of sensitive responses at the application and proxy.',
  }
  const origin = headers['access-control-allow-origin']?.trim()
  const credentials = headers['access-control-allow-credentials']?.trim() === 'true'
  if ((credentials && (origin === '*' || origin === 'null')) ||
      (origin && endpoint.corsOrigins && !endpoint.corsOrigins.includes(origin))) yield {
    id: 'origin-policy', category: 'cors', owasp: misconfiguration,
    message: 'The observed CORS headers did not match a restricted origin policy.',
    remediation: 'Review allowed origins and use exact trusted origins for credentialed requests.',
  }

  for (const [name, expected] of [
    ['access-control-allow-methods', endpoint.corsMethods],
    ['access-control-allow-headers', endpoint.corsHeaders],
  ] as const) {
    if (!expected) continue
    const configured = new Set(expected.map(value => value.toLowerCase()))
    const advertised = headers[name]?.split(',').map(value => value.trim().toLowerCase()) ?? []
    if (advertised.some(value => !configured.has(value))) yield {
      id: name, category: 'cors', owasp: misconfiguration,
      message: `The observed ${name} values exceeded the configured allowlist.`,
      remediation: 'Limit this header to explicitly allowed values.',
    }
  }

  if (endpoint.cookies?.some(policy => {
    const matching = (headers['set-cookie'] ?? []).map(cookie => cookie.split(';')).filter(([pair]) =>
      pair?.startsWith(policy.name + '='))
    return matching.some(([, ...attributes]) => {
      const parts = new Map(attributes.map(attribute => {
        const [name, value] = attribute.toLowerCase().split('=', 2)
        return [name?.trim(), value?.trim()]
      }))
      return !parts.has('secure') || !parts.has('httponly') ||
        (policy.sameSite !== undefined && parts.get('samesite') !== policy.sameSite.toLowerCase())
    })
  })) yield {
    id: 'cookie-attributes', category: 'headers', owasp: misconfiguration,
    message: 'A configured session cookie was missing expected security attributes.',
    remediation: 'Review Secure, HttpOnly, and the configured SameSite value.',
  }

  if (endpoint.inspectCredentialMarkers &&
      /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(response.body)) yield {
    id: 'credential-marker', category: 'disclosure', owasp: misconfiguration, heuristic: true,
    message: 'The body contained a marker commonly associated with private key material.',
    remediation: 'Review the response privately. Remove the secret and rotate any exposed key.',
  }

  if (endpoint.inspectDiagnostics && /\b(?:SQLSTATE\[[0-9A-Z]{5}\]|PostgreSQL ERROR:|Traceback \(most recent call last\):)|^\s+at [^\r\n]{1,180}\((?:\/|[A-Z]:\\)[^\r\n]{1,180}:\d+:\d+\)/m.test(response.body)) yield {
    id: 'diagnostic-disclosure', category: 'disclosure', owasp: misconfiguration, heuristic: true,
    message: 'The response matched a server diagnostic pattern.',
    remediation: 'Review the response privately and return generic errors to clients.',
  }
  const expectsJson = Boolean(endpoint.jwt) || endpoint.sensitiveFields.length > 0
  const data = expectsJson ? json(response.body) : undefined
  if (expectsJson && data === undefined) {
    yield {
      id: 'inspection-format', category: 'disclosure', owasp: misconfiguration, coverageIncomplete: true,
      message: 'The response could not be inspected as JSON.',
      remediation: 'Verify the endpoint returns uncompressed JSON for this scenario.',
    }
    return
  }
  if (endpoint.sensitiveFields.some(path => field(data, path) !== undefined)) yield {
    id: 'sensitive-field', category: 'disclosure', owasp: misconfiguration,
    message: 'A configured forbidden response field was present.',
    remediation: 'Remove internal fields from the response serializer.',
  }
  if (endpoint.jwt) {
    const outcome = jwtPolicy(field(data, endpoint.jwt.path), endpoint.jwt, key)
    if (outcome) yield {
      id: 'jwt-metadata', category: 'jwt', owasp: 'API2:2023', message: outcome,
      remediation: 'Review token issuance policy. Verify signatures and claims independently on the server.',
    }
  }
}

export async function runSecurity(base: URL, config: SecurityConfig, results: Result[], secrets: string[]): Promise<void> {
  const endpoints = config.endpoints.map(endpoint => {
    const token = endpoint.bearerTokenEnv ? process.env[endpoint.bearerTokenEnv] : undefined
    if (endpoint.bearerTokenEnv && (!token || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(token))) {
      throw new ConfigError('A security identity environment variable is missing or invalid.')
    }
    if (token) secrets.push(token)
    return { endpoint, token, key: jwtKey(endpoint.jwt) }
  })
  let halt: string | undefined
  for (const [index, { endpoint, token, key }] of endpoints.entries()) {
    const start = performance.now()
    const url = parseTarget(endpoint.path, base)
    const display = safeUrl(url)
    if (halt) {
      results.push(result('security', 'skipped', start, halt, { url: display, coverageIncomplete: true }))
      continue
    }
    try {
      if (index > 0 && config.intervalMs) await delay(config.intervalMs)
      const headers: Record<string, string> = { 'accept-encoding': 'identity' }
      if (token) headers.authorization = `Bearer ${token}`
      const response = await request(url, {
        base, headers, timeoutMs: config.timeoutMs, followRedirects: false, requirePublicAddress: !isSecurityLoopback(url),
        readBody: endpoint.inspectDiagnostics || endpoint.inspectCredentialMarkers || Boolean(endpoint.jwt) || endpoint.sensitiveFields.length > 0,
        maxBodyBytes: 262_144,
      })
      if (response.status === 429) halt = 'A previous response returned HTTP 429. Remaining requests were cancelled.'
      const findings = [...inspect(url, endpoint, response, key)]
      for (const finding of findings) results.push(result('security', 'fail', start, finding.message, {
        url: display, issue: `${endpoint.id}:${finding.id}`, category: finding.category, confidence: finding.heuristic ? 'heuristic' : 'observed',
        severity: finding.severity ?? 'warning', suggestion: finding.remediation, owasp: finding.owasp,
        coverageIncomplete: finding.coverageIncomplete,
      }))
      if (!findings.length) results.push(result('security', 'pass', start, 'Configured response expectations passed.', { url: display }))
    } catch (error) {
      if (!(error instanceof RequestError)) throw error
      results.push(result('security', 'error', start, error.message, { url: display, coverageIncomplete: true }))
      // A response could have been rate limited before its body failed to read.
      halt = 'A previous request could not be completed. Remaining requests were cancelled.'
    }
  }
}
