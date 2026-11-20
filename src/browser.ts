import AxeBuilder from '@axe-core/playwright'
import { chromium, type Browser, type Route } from 'playwright'
import { BrowserError } from './errors.js'
import { parseTarget, request } from './network.js'

const resourceLimit = 300
const resourceConcurrency = 8
const resourceBytes = 4 * 1024 * 1024
const pageBytes = 24 * 1024 * 1024
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const hopHeaders = new Set([
  'connection', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const acceptedRequestHeaders = [
  'accept', 'accept-language', 'cookie', 'referer', 'sec-fetch-dest',
  'sec-fetch-mode', 'sec-fetch-site', 'user-agent',
]

export { BrowserError } from './errors.js'

interface InspectOptions {
  base: URL
  accessibility: boolean
  links: boolean
  maxLinks: number
  timeoutMs: number
}

interface Violation {
  id: string
  impact: string | null
  description: string
  helpUrl: string
  targets: string[]
}

interface Inspection {
  links: { href: string }[]
  anchors: string[]
  truncated: boolean
  violations: Violation[]
}

function resourceRouter(base: URL, timeoutMs: number, signal: AbortSignal) {
  const active = new Set<Promise<void>>()
  let resources = 0
  let bytes = 0

  async function fulfill(route: Route): Promise<void> {
    const browserRequest = route.request()
    const url = parseTarget(browserRequest.url())
    const method = browserRequest.method()
    if (url.origin !== base.origin || (method !== 'GET' && method !== 'HEAD')) {
      await route.abort()
      return
    }

    const requestHeaders = await browserRequest.allHeaders()
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    for (const name of acceptedRequestHeaders) {
      const value = requestHeaders[name]
      if (value !== undefined) headers[name] = value
    }

    const response = await request(url, {
      base, method, headers, timeoutMs, signal,
      followRedirects: false, binary: true, readBody: true, maxBodyBytes: resourceBytes,
    })
    const body = response.bytes
    bytes += body.length

    // Chromium can follow a fulfilled redirect without invoking the route again.
    if (
      bytes > pageBytes ||
      redirectStatuses.has(response.status) ||
      (response.headers['content-encoding'] ?? 'identity') !== 'identity'
    ) {
      await route.abort()
      return
    }

    const outgoing: Record<string, string> = {}
    for (const [name, value] of Object.entries(response.headers)) {
      if (hopHeaders.has(name) || value === undefined) continue
      outgoing[name] = Array.isArray(value) ? value.join(name === 'set-cookie' ? '\n' : ', ') : value
    }
    await route.fulfill({ status: response.status, headers: outgoing, body })
  }

  return async (route: Route): Promise<void> => {
    try {
      if (++resources > resourceLimit || bytes >= pageBytes) {
        await route.abort()
        return
      }
      while (active.size >= resourceConcurrency) {
        await Promise.race(active)
      }
      signal.throwIfAborted()
      const task = fulfill(route).catch(async () => {
        await route.abort().catch(() => undefined)
      })
      active.add(task)
      try {
        await task
      } finally {
        active.delete(task)
      }
    } catch {
      await route.abort().catch(() => undefined)
    }
  }
}

async function inspectPage(browser: Browser, url: URL, options: InspectOptions): Promise<Inspection> {
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' })
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stage: 'navigation' | 'inspection' = 'navigation'

  const inspect = async (): Promise<Inspection> => {
    await context.route('**/*', resourceRouter(options.base, options.timeoutMs, controller.signal))
    await context.routeWebSocket('**/*', socket => socket.close())
    const page = await context.newPage()
    const response = await page.goto(url.href, { timeout: options.timeoutMs, waitUntil: 'load' })
    if (!response?.ok()) {
      throw new BrowserError('navigation', 'Chromium did not receive a successful response. Check the route and its redirects.')
    }
    const contentType = response.headers()['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      throw new BrowserError('navigation', 'Browser checks require an HTML response. Verify the route or disable browser checks for this run.')
    }

    stage = 'inspection'
    const discovered = options.links
      ? await page.evaluate((maxLinks) => {
        const links = new Set<string>()
        let truncated = false
        for (const element of document.querySelectorAll('a[href], area[href]')) {
          const raw = element.getAttribute('href')!.trim()
          let href = raw
          try {
            const url = new URL(raw, document.baseURI)
            if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
            href = url.href
          } catch {
            // Keep malformed links for the link checker to report.
          }
          if (links.has(href)) continue
          if (href.length > 4096 || links.size >= maxLinks) {
            truncated = true
            if (links.size >= maxLinks) break
            continue
          }
          links.add(href)
        }

        const anchors = new Set<string>()
        for (const element of document.querySelectorAll('[id], a[name]')) {
          for (const value of [element.id, element.matches('a[name]') ? element.getAttribute('name') : null]) {
            if (value && value.length <= 4096) anchors.add(value)
          }
        }
        return { links: Array.from(links, href => ({ href })), anchors: [...anchors], truncated }
      }, options.maxLinks)
      : { links: [], anchors: [], truncated: false }

    const violations: Violation[] = []
    if (options.accessibility) {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      for (const rule of results.violations) {
        violations.push({
          id: rule.id,
          impact: rule.impact ?? null,
          description: rule.description,
          helpUrl: rule.helpUrl,
          targets: rule.nodes.slice(0, 20).map(node => JSON.stringify(node.target).slice(0, 512)),
        })
      }
    }
    return { ...discovered, violations }
  }

  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new BrowserError('timeout', 'Browser inspection timed out. Check the server or increase timeoutMs.'))
      }, options.timeoutMs)
    })
    return await Promise.race([inspect(), deadline])
  } catch (error) {
    if (error instanceof BrowserError) throw error
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new BrowserError('timeout', 'Browser inspection timed out. Check the server or increase timeoutMs.')
    }
    throw new BrowserError(stage, stage === 'navigation'
      ? 'Chromium could not load this page. Check the server, redirects, and HTML response size.'
      : 'Chromium could not finish page inspection. Check for client-side navigation or reloads.')
  } finally {
    clearTimeout(timer)
    controller.abort()
    await context.close()
  }
}

export async function openBrowser(options: { headless: boolean; timeoutMs: number }) {
  const executablePath = process.env.QA_GUARDIAN_CHROMIUM_PATH || undefined
  try {
    const browser = await chromium.launch({
      executablePath,
      headless: options.headless,
      timeout: options.timeoutMs,
      // HTTP(S) resources are supplied by Node. Disable Chromium's ordinary network paths.
      args: [
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--proxy-server=http://qa-guardian-no-proxy.invalid:9',
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    })
    return {
      close: () => browser.close(),
      inspect: (url: URL, options: InspectOptions) => inspectPage(browser, url, options),
    }
  } catch (error) {
    const missing = error instanceof Error && error.message.includes("Executable doesn't exist")
    throw new BrowserError('startup', missing
      ? 'Chromium is missing. Run npx playwright install chromium, or set QA_GUARDIAN_CHROMIUM_PATH to an installed executable.'
      : 'Chromium could not start. Verify the executable and system dependencies, and ensure a display is available if headless mode is disabled.')
  }
}
