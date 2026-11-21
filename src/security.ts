import { ConfigError } from './errors.js'
import { parseTarget, request, RequestError, safeUrl } from './network.js'
import { result, type Result } from './report.js'
import { isSecurityLoopback, type SecurityConfig, type SecurityEndpoint } from './security-config.js'

type Response = Awaited<ReturnType<typeof request>>
type Finding = {
  id: string
  category: NonNullable<Result['category']>
  message: string
  remediation: string
  owasp: NonNullable<Result['owasp']>
  severity?: 'error'
  heuristic?: true
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

function jwtPolicy(token: unknown, policy: NonNullable<SecurityEndpoint['jwt']>): string | undefined {
  if (typeof token !== 'string' || token.length > 8192) return 'The configured field did not contain bounded JWT metadata.'
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
    return 'The configured field did not contain a compact JWT.'
  }
  const [metadata, claims] = parts.slice(0, 2).map(part => json(Buffer.from(part, 'base64url').toString('utf8')))
  const algorithm = field(metadata, ['alg'])
  if (typeof algorithm !== 'string' || !algorithm || algorithm.toLowerCase() === 'none' ||
      (policy.algorithms && !policy.algorithms.some(value => value === algorithm))) {
    return 'The token algorithm or signature metadata did not match policy.'
  }
  if (policy.requiredClaims.some(claim => field(claims, [claim]) === undefined)) return 'Required token claims were absent.'
  const exp = field(claims, ['exp'])
  const nbf = field(claims, ['nbf'])
  const iat = field(claims, ['iat'])
  const now = Date.now() / 1000
  if (exp !== undefined && (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now)) return 'Token expiration metadata was invalid or expired.'
  if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf) || nbf > now)) return 'Token not-before metadata was invalid or in the future.'
  if (policy.maxLifetimeSeconds !== undefined &&
      (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || iat > now ||
       exp <= iat || exp - iat > policy.maxLifetimeSeconds)) return 'The token lifetime could not be established or exceeded policy.'
  return undefined
}

function* inspect(url: URL, endpoint: SecurityEndpoint, response: Response): Generator<Finding> {
  const misconfiguration = 'API8:2023' as const
  const { headers, status } = response
  if (status !== endpoint.expectedStatus) yield {
    id: 'status', category: 'access-control', severity: 'error', owasp: 'API2:2023',
    message: `Expected HTTP ${endpoint.expectedStatus} for this scenario, received ${status}.`,
    remediation: 'Review the route access policy and verify the configured test identity.',
  }
  if (status === 429 && !headers['retry-after']) yield {
    id: 'retry-after', category: 'rate-limit', owasp: 'API4:2023',
    message: 'The response returned HTTP 429 without Retry-After.',
    remediation: 'Consider sending Retry-After so clients can back off appropriately.',
  }

  const html = /^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(headers['content-type'] ?? '')
  for (const name of endpoint.expectHeaders) {
    if ((name === 'strict-transport-security' && url.protocol !== 'https:') ||
        (name === 'content-security-policy' && !html)) continue
    const header = headers[name]
    const value = typeof header === 'string' ? header.trim() : undefined
    const valid = name === 'x-content-type-options' ? value?.toLowerCase() === 'nosniff' :
      name === 'strict-transport-security' ? /(?:^|;)\s*max-age\s*=\s*[1-9][0-9]*\s*(?:;|$)/i.test(value ?? '') : Boolean(value)
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

  if (endpoint.inspectDiagnostics && /\b(?:SQLSTATE\[[0-9A-Z]{5}\]|PostgreSQL ERROR:|Traceback \(most recent call last\):)|^\s+at [^\r\n]{1,180}\((?:\/|[A-Z]:\\)[^\r\n]{1,180}:\d+:\d+\)/m.test(response.body)) yield {
    id: 'diagnostic-disclosure', category: 'disclosure', owasp: misconfiguration, heuristic: true,
    message: 'The response matched a server diagnostic pattern.',
    remediation: 'Review the response privately and return generic errors to clients.',
  }
  const expectsJson = Boolean(endpoint.jwt) || endpoint.sensitiveFields.length > 0
  const data = expectsJson ? json(response.body) : undefined
  if (expectsJson && data === undefined) {
    yield {
      id: 'inspection-format', category: 'disclosure', owasp: misconfiguration,
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
    const outcome = jwtPolicy(field(data, endpoint.jwt.path), endpoint.jwt)
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
    return { endpoint, token }
  })
  let rateLimited = false
  for (const { endpoint, token } of endpoints) {
    const start = performance.now()
    const url = parseTarget(endpoint.path, base)
    const display = safeUrl(url)
    if (rateLimited) {
      results.push(result('security', 'skipped', start, 'A previous response returned HTTP 429. Remaining requests were cancelled.', { url: display, coverageIncomplete: true }))
      continue
    }
    try {
      const headers: Record<string, string> = { 'accept-encoding': 'identity' }
      if (token) headers.authorization = `Bearer ${token}`
      const response = await request(url, {
        base, headers, timeoutMs: config.timeoutMs, followRedirects: false, requirePublicAddress: !isSecurityLoopback(url),
        readBody: endpoint.inspectDiagnostics || Boolean(endpoint.jwt) || endpoint.sensitiveFields.length > 0,
        maxBodyBytes: 262_144,
      })
      rateLimited = response.status === 429
      const findings = [...inspect(url, endpoint, response)]
      for (const finding of findings) results.push(result('security', 'fail', start, finding.message, {
        url: display, issue: `${endpoint.id}:${finding.id}`, category: finding.category, confidence: finding.heuristic ? 'heuristic' : 'observed',
        severity: finding.severity ?? 'warning', suggestion: finding.remediation, owasp: finding.owasp,
      }))
      if (!findings.length) results.push(result('security', 'pass', start, 'Configured response expectations passed.', { url: display }))
    } catch (error) {
      if (!(error instanceof RequestError)) throw error
      results.push(result('security', 'error', start, error.message, { url: display, coverageIncomplete: true }))
      // A response could have been rate limited before its body failed to read.
      rateLimited = true
    }
  }
}
