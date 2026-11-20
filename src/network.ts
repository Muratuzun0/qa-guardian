import { lookup } from 'node:dns'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'

type RequestErrorCode =
  | 'invalid-url'
  | 'blocked-target'
  | 'invalid-request'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'redirect'
  | 'body-limit'

export class RequestError extends Error {
  constructor(readonly code: RequestErrorCode, message: string) {
    super(message)
    this.name = 'RequestError'
  }
}

export function parseTarget(value: string, base?: URL): URL {
  if (Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new RequestError('invalid-url', 'A URL contains an invalid control character.')
  }
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    throw new RequestError('invalid-url', 'Expected a valid HTTP or HTTPS URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new RequestError('invalid-url', 'Expected an HTTP or HTTPS URL without credentials.')
  }
  return url
}

export function safeUrl(url: URL): string {
  return url.origin + url.pathname
}

function publicAddress(address: string): boolean {
  const parsed = ipaddr.parse(address)
  if (parsed.range() !== 'unicast') return false
  if (parsed instanceof ipaddr.IPv4) return true
  return parsed.match(ipaddr.IPv6.parse('2000::'), 3)
}

// Returning only checked answers to the socket keeps address validation and connection tied together.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error) {
      callback(error, '', 0)
      return
    }
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      callback(new RequestError('blocked-target', 'An external host resolved to a non-public address.'), '', 0)
      return
    }
    if (options.all) {
      callback(null, addresses)
      return
    }
    const first = addresses[0]!
    callback(null, first.address, first.family)
  })
}

interface RequestOptions {
  base: URL
  externalOrigins?: string[]
  timeoutMs: number
  method?: string
  headers?: Record<string, string>
  readBody?: boolean
  followRedirects?: boolean
  binary?: boolean
  maxBodyBytes?: number
  signal?: AbortSignal
}

interface Response {
  status: number
  url: URL
  body: string
  bytes: Buffer
  headers: IncomingHttpHeaders
}

const redirectStatuses = new Set([301, 302, 303, 307, 308])
const forbiddenHeaders = new Set([
  'connection', 'content-length', 'expect', 'host', 'keep-alive', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function checkScope(url: URL, options: RequestOptions): boolean {
  if (url.origin === options.base.origin) return false
  if (!options.externalOrigins?.includes(url.origin)) {
    throw new RequestError('blocked-target', 'This target is outside the configured origins.')
  }
  const address = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(address) && !publicAddress(address)) {
    throw new RequestError('blocked-target', 'An external target has a non-public address.')
  }
  return true
}

function openResponse(
  url: URL,
  options: { method: string; headers: Record<string, string>; external: boolean; signal: AbortSignal },
): Promise<IncomingMessage> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const outgoing = send(url, {
      agent: false,
      method: options.method,
      headers: options.headers,
      lookup: options.external ? publicLookup : undefined,
      signal: options.signal,
    }, resolve)
    outgoing.on('error', reject)
    outgoing.end()
  })
}

async function readBytes(response: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    received += chunk.length
    if (received > maximum) {
      throw new RequestError('body-limit', 'The HTTP response exceeded the configured byte limit.')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, received)
}

export async function request(target: URL, options: RequestOptions): Promise<Response> {
  let url = parseTarget(target.href)
  url.hash = ''
  const deadline = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
  const method = options.method ?? 'GET'
  let headers = options.headers ?? {}
  if (Object.keys(headers).some(name => forbiddenHeaders.has(name.toLowerCase()))) {
    throw new RequestError('invalid-request', 'A request header is reserved for the HTTP transport.')
  }

  try {
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted()
      const external = checkScope(url, options)
      if (external) {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new RequestError('blocked-target', 'External requests support GET and HEAD only.')
        }
        headers = {}
      }
      const response = await openResponse(url, { method, headers, external, signal })
      try {
        const status = response.statusCode ?? 0
        if (options.followRedirects !== false && redirectStatuses.has(status)) {
          if (!response.headers.location || hop >= 5 || (method !== 'GET' && method !== 'HEAD')) {
            throw new RequestError('redirect', 'The HTTP redirect could not be followed safely.')
          }
          let next: URL
          try {
            next = parseTarget(response.headers.location, url)
          } catch {
            throw new RequestError('redirect', 'The server returned an invalid or unsupported redirect target.')
          }
          if (url.protocol === 'https:' && next.protocol === 'http:') {
            throw new RequestError('redirect', 'The HTTP redirect would downgrade HTTPS to HTTP.')
          }
          next.hash = ''
          url = next
          continue
        }
        const bytes = options.readBody
          ? await readBytes(response, options.maxBodyBytes ?? 1024 * 1024)
          : Buffer.alloc(0)
        return { status, url, body: options.binary ? '' : bytes.toString('utf8'), bytes, headers: response.headers }
      } finally {
        response.destroy()
      }
    }
  } catch (error) {
    if (deadline.aborted) throw new RequestError('timeout', 'The HTTP request timed out.')
    if (signal.aborted) throw new RequestError('cancelled', 'The HTTP request was cancelled.')
    if (error instanceof RequestError) throw error
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ECONNREFUSED') {
        throw new RequestError('network', 'The server refused the connection. Check that it is running.')
      }
      if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
        throw new RequestError('network', 'The server hostname could not be resolved.')
      }
      if (error.code === 'ERR_INVALID_HTTP_TOKEN' || error.code === 'ERR_INVALID_CHAR') {
        throw new RequestError('invalid-request', 'A request header or HTTP method is invalid.')
      }
    }
    throw new RequestError('network', 'The HTTP request failed before the response was complete.')
  }
}
