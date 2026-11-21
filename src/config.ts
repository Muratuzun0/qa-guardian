import { validateHeaderName, validateHeaderValue } from 'node:http'
import { resolve } from 'node:path'
import { z } from 'zod'
import { ConfigError } from './errors.js'
import { readLocalFile } from './local-files.js'
import { parseTarget } from './network.js'
import { securitySchema, validateSecurity } from './security-config.js'

export const defaultConfigFile = 'qa-guardian.config.json'
const timeout = z.number().int().min(1).max(120_000)
const target = z.string().min(1).max(4096)
const origin = target.refine(value => {
  try {
    const url = parseTarget(value)
    return url.href === url.origin + '/'
  } catch {
    return false
  }
}, 'Use an HTTP(S) origin with no path, credentials, query or fragment')
const headerName = z.string().min(1).max(128).refine(name => {
  try {
    validateHeaderName(name)
    return !['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'expect',
      'proxy-authorization', 'proxy-connection', 'trailer', 'te', 'accept-encoding', 'keep-alive'].includes(name.toLowerCase())
  } catch {
    return false
  }
}, 'Unsupported header name')
const headerValue = z.string().max(8192).refine(value => {
  try {
    validateHeaderValue('header', value)
    return true
  } catch {
    return false
  }
}, 'Invalid header value')
const environmentReference = /^\$\{([A-Za-z_][A-Za-z_0-9]*)\}$/

const schema = z.strictObject({
  baseUrl: target,
  routes: z.array(target).max(100).default(['/']),
  checks: z.strictObject({
    pages: z.boolean().default(true),
    links: z.boolean().default(true),
    accessibility: z.boolean().default(true),
    api: z.boolean().default(true),
  }).prefault({}),
  timeoutMs: timeout.default(10_000),
  links: z.strictObject({
    externalOrigins: z.array(origin).max(30).default([]),
    concurrency: z.number().int().min(1).max(16).default(4),
    maxLinksPerPage: z.number().int().min(1).max(500).default(100),
    checkFragments: z.boolean().default(true),
  }).prefault({}),
  browser: z.strictObject({ headless: z.boolean().default(true) }).prefault({}),
  api: z.array(z.strictObject({
    path: target,
    method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    expectedStatus: z.number().int().min(200).max(599).default(200),
    timeoutMs: timeout.optional(),
    headers: z.record(headerName, headerValue).optional(),
    assertions: z.array(z.strictObject({
      path: z.array(z.string().max(255)).max(20),
      equals: z.union([z.string().max(8192), z.number(), z.boolean(), z.null()]),
    })).max(50).default([]),
  })).max(100).default([]),
  security: securitySchema.optional(),
  allowUnsafeMethods: z.boolean().default(false),
  reportDir: z.string().min(1).max(255).refine(value =>
    !/[\\:\x00-\x1f\x7f]/u.test(value) && !value.startsWith('/') &&
    !value.split('/').includes('..') && !value.split('/').includes('.git'),
  'Use a directory within the working directory').optional(),
  failOn: z.enum(['error', 'warning']).default('error'),
})

export type Config = z.infer<typeof schema>
export type ApiCheck = Config['api'][number]

export function validateConfig(input: unknown): Config {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const messages = parsed.error.issues.slice(0, 10).map(issue => {
      const path = issue.path.slice(0, 4).map(key =>
        typeof key === 'number' || /^[A-Za-z][A-Za-z0-9]{0,35}$/.test(String(key)) ? String(key) : '(key)').join('.')
      const message = issue.code === 'unrecognized_keys' ? 'Unknown setting' : issue.message
      return `${path || 'configuration'}: ${message}`
    })
    throw new ConfigError(messages.join('\n'))
  }
  const config = parsed.data
  let base: URL
  try {
    base = parseTarget(config.baseUrl)
  } catch {
    throw new ConfigError('baseUrl: Use an absolute HTTP(S) URL without embedded credentials')
  }
  if (base.search || base.hash) throw new ConfigError('baseUrl: Remove the query and fragment')
  config.baseUrl = base.href
  config.links.externalOrigins = [...new Set(config.links.externalOrigins.map(value => parseTarget(value).origin))]
  const sameOrigin = (value: string, field: string) => {
    try {
      if (parseTarget(value, base).origin === base.origin) return
    } catch {
      // Report the field location without echoing the configured target.
    }
    throw new ConfigError(`${field}: Use an HTTP(S) URL on the base origin`)
  }
  config.routes.forEach((value, index) => sameOrigin(value, `routes.${index}`))
  config.api.forEach((endpoint, index) => {
    sameOrigin(endpoint.path, `api.${index}.path`)
    if (!config.allowUnsafeMethods && !['GET', 'HEAD', 'OPTIONS'].includes(endpoint.method)) {
      throw new ConfigError(`api.${index}.method: Enable allowUnsafeMethods to use a modifying method`)
    }
    if (endpoint.method === 'HEAD' && endpoint.assertions.length > 0) {
      throw new ConfigError(`api.${index}.assertions: HEAD responses have no body`)
    }
  })
  if (config.security) validateSecurity(config.security, base)
  return config
}

export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = Object.create(null)
  for (const [name, value] of Object.entries(headers ?? {})) {
    const variable = environmentReference.exec(value)?.[1]
    const result = variable ? process.env[variable] : value
    if (result === undefined || (variable && result.length === 0)) {
      throw new ConfigError('An environment variable referenced by an API header is missing or empty')
    }
    if (!headerValue.safeParse(result).success) throw new ConfigError('An API header value is invalid')
    resolved[name] = result
  }
  return resolved
}

export async function loadConfig(cwd: string, filename?: string, url?: string): Promise<Config> {
  const path = resolve(cwd, filename ?? defaultConfigFile)
  let data: unknown
  try {
    const content = await readLocalFile(path, 262_144)
    try {
      data = JSON.parse(content)
    } catch {
      throw new ConfigError('The configuration file contains invalid JSON')
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !filename) {
      data = { baseUrl: 'http://localhost:3000' }
    } else {
      throw new ConfigError('Could not read the configuration file. Check its path and permissions. Use a regular file of 256 KiB or less.')
    }
  }
  if (url && data && typeof data === 'object' && !Array.isArray(data)) {
    data = { ...data, baseUrl: url }
  }
  return validateConfig(data)
}
