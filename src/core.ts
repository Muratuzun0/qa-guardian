import type { openBrowser } from './browser.js'
import { BrowserError } from './errors.js'
import { resolveHeaders, type ApiCheck, type Config } from './config.js'
import { parseTarget, request, RequestError, safeUrl } from './network.js'
import { result, type Result } from './report.js'

type BrowserSession = Awaited<ReturnType<typeof openBrowser>>
type Inspection = Awaited<ReturnType<BrowserSession['inspect']>>
type LinkOutcome = { status: 'pass' | 'fail' | 'skipped'; message: string; url?: string; suggestion?: string; issue?: string; coverageIncomplete?: boolean }
const successful = (status: number) => status >= 200 && status < 300

function knownMessage(error: unknown): string {
  if (error instanceof RequestError || error instanceof BrowserError) return error.message
  throw error
}

function assertionFailure(body: string, assertions: ApiCheck['assertions']): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return 'The response body is not valid JSON.'
  }
  for (const [index, assertion] of assertions.entries()) {
    let at = value
    for (const key of assertion.path) {
      at = at !== null && typeof at === 'object' && Object.hasOwn(at, key)
        ? (at as Record<string, unknown>)[key]
        : undefined
    }
    if (at !== assertion.equals) return `JSON assertion ${index + 1} did not match.`
  }
  return undefined
}

async function runApi(base: URL, config: Config, endpoint: ApiCheck, headers: Record<string, string>): Promise<Result> {
  const start = performance.now()
  const target = parseTarget(endpoint.path, base)
  const url = safeUrl(target)
  const issue = `status-${endpoint.method}-${endpoint.expectedStatus}`
  let status: number
  try {
    const response = await request(target, {
      base, headers: { ...headers, 'accept-encoding': 'identity' }, method: endpoint.method,
      timeoutMs: endpoint.timeoutMs ?? config.timeoutMs, readBody: endpoint.assertions.length > 0,
      followRedirects: false,
    })
    status = response.status
    if (status === endpoint.expectedStatus && endpoint.assertions.length) {
      const failure = assertionFailure(response.body, endpoint.assertions)
      if (failure) return result('api', 'fail', start, failure, { url, issue: `assertion-${endpoint.method}-${endpoint.expectedStatus}`, suggestion: 'Check the endpoint response against the configured JSON property path and expected value.' })
    }
  } catch (error) {
    return result('api', 'fail', start, knownMessage(error), { url, issue, suggestion: 'Verify that the API is running and the method and timeout match the endpoint.' })
  }
  const matched = status === endpoint.expectedStatus
  return result('api', matched ? 'pass' : 'fail', start,
    `${endpoint.method} returned HTTP ${status}${matched ? '.' : `, expected ${endpoint.expectedStatus}.`}`, { url, issue: matched ? undefined : issue, suggestion: matched ? undefined : 'Verify the route, authentication and expected status.' })
}

class WebsiteChecks {
  private browser?: BrowserSession
  private browserFailed = false
  private readonly previews = new Map<string, Promise<Awaited<ReturnType<typeof request>>>>()

  constructor(private readonly config: Config, private readonly base: URL, private readonly results: Result[]) {}

  private inspect(url: URL, accessibility: boolean, links: boolean, maxLinks: number): Promise<Inspection> {
    if (!this.browser) throw new Error('Chromium session unavailable')
    return this.browser.inspect(url, { base: this.base, accessibility, links, maxLinks, timeoutMs: this.config.timeoutMs })
  }

  private preview(url: URL, externalOrigins: string[] = []) {
    const key = JSON.stringify([url.href, externalOrigins])
    const existing = this.previews.get(key)
    if (existing) return existing
    const pending = request(url, { base: this.base, timeoutMs: this.config.timeoutMs, externalOrigins })
    // Only share in-flight requests with the same scope. Page requests use a stricter policy.
    this.previews.set(key, pending)
    const cleanup = () => { this.previews.delete(key) }
    void pending.then(cleanup, cleanup)
    return pending
  }

  private async link(href: string, page: URL, anchors: Set<string>,
    fragmentPages: Map<string, Promise<Set<string>>>): Promise<LinkOutcome> {
    let url: URL
    try {
      url = parseTarget(href, page)
    } catch {
      return { status: 'fail', issue: 'invalid-url', message: 'A link has an invalid or credential-bearing HTTP URL.', suggestion: 'Inspect the rendered links on the source page.' }
    }
    const fragment = url.hash.slice(1)
    url.hash = ''
    const external = url.origin !== this.base.origin
    const allowed = this.config.links.externalOrigins
    const display = safeUrl(url)
    if (external && !allowed.includes(url.origin)) {
      return { status: 'skipped', message: 'External origin is outside the configured link scope.', url: display }
    }
    try {
      const response = url.href === page.href ? undefined : await this.preview(url, allowed)
      if (response && !successful(response.status)) {
        return { status: 'fail', issue: 'unreachable', message: `Link returned HTTP ${response.status}.`, url: display, suggestion: 'Update the link or restore the destination.' }
      }
      const redirected = response?.url ?? page
      if (fragment && this.config.links.checkFragments && redirected.origin === this.base.origin) {
        let decoded: string
        try {
          decoded = decodeURIComponent(fragment)
        } catch {
          return { status: 'fail', issue: 'fragment', message: 'Link fragment uses invalid percent encoding.', url: display }
        }
        if (decoded.toLowerCase() !== 'top' && !decoded.includes(':~:')) {
          if (redirected.href !== page.href && !fragmentPages.has(redirected.href)) {
            // Avoid an extra browser navigation for every link on a large page.
            if (fragmentPages.size >= 20) return { status: 'skipped', coverageIncomplete: true, message: 'Linked-page fragment inspection limit reached.', url: display }
            fragmentPages.set(redirected.href, this.inspect(redirected, false, true, 1).then(item => new Set(item.anchors)))
          }
          const available = redirected.href === page.href ? anchors : await fragmentPages.get(redirected.href)
          if (!available?.has(decoded)) return { status: 'fail', issue: 'fragment', message: 'Link fragment was not found.', url: display, suggestion: 'Check the target element ID.' }
        }
      }
      return { status: 'pass', message: 'Link is reachable.', url: display }
    } catch (error) {
      return { status: 'fail', issue: 'unreachable', message: knownMessage(error), url: display, suggestion: 'Verify the destination and redirect scope from the source page.' }
    }
  }

  private async scanLinks(page: URL, sourceUrl: string, inspection: Inspection): Promise<void> {
    const anchors = new Set(inspection.anchors)
    const fragmentPages = new Map<string, Promise<Set<string>>>()
    const outcomes: Result[] = []
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(this.config.links.concurrency, inspection.links.length) }, async () => {
      for (;;) {
        const index = cursor++
        const link = inspection.links[index]
        if (!link) return
        const start = performance.now()
        const { status, message, ...details } = await this.link(link.href, page, anchors, fragmentPages)
        outcomes[index] = result('links', status, start, message, { ...details, sourceUrl })
      }
    }))
    const checked = outcomes.filter(item => item.status !== 'skipped')
    this.results.push(...checked)
    const skipped = outcomes.length - checked.length
    if (skipped) this.results.push(result('links', 'skipped', performance.now(), `${skipped} links skipped due to scope or inspection limits.`, {
      url: sourceUrl, coverageIncomplete: outcomes.some(item => item.coverageIncomplete),
    }))
    if (!outcomes.length) this.results.push(result('links', 'pass', performance.now(), 'No HTTP links found.', { url: sourceUrl }))
    if (inspection.truncated) this.results.push(result('links', 'fail', performance.now(),
      'Link inspection was truncated.', { url: sourceUrl, issue: 'truncated', coverageIncomplete: true, severity: 'warning', suggestion: 'Increase links.maxLinksPerPage or narrow the route.' }))
  }

  private async runRoute(route: string): Promise<void> {
    const start = performance.now()
    const url = parseTarget(route, this.base)
    url.hash = ''
    const display = safeUrl(url)
    const { pages, links, accessibility } = this.config.checks
    const browserChecks = (['links', 'accessibility'] as const).filter(check => this.config.checks[check])
    let finalUrl: URL
    try {
      const response = await this.preview(url)
      if (!successful(response.status)) throw new RequestError('network', `Page returned HTTP ${response.status}.`)
      finalUrl = response.url
      if (pages) this.results.push(result('pages', 'pass', start, `Page returned HTTP ${response.status}.`, { url: display }))
    } catch (error) {
      const message = knownMessage(error)
      if (pages) this.results.push(result('pages', 'fail', start, message, {
        url: display, issue: 'availability', suggestion: 'Check the server logs, route and redirect destination.',
      }))
      for (const check of browserChecks) {
        this.results.push(result(check, pages ? 'skipped' : 'fail', start,
          pages ? 'Page unavailable. See the availability result.' : message, { url: display, coverageIncomplete: true }))
      }
      return
    }
    if (!browserChecks.length) return
    if (this.browserFailed) {
      for (const check of browserChecks) this.results.push(result(check, 'skipped', start, 'See the Chromium startup error.', { url: display, coverageIncomplete: true }))
      return
    }
    if (!this.browser) {
      try {
        const { openBrowser } = await import('./browser.js')
        this.browser = await openBrowser({ headless: this.config.browser.headless, timeoutMs: this.config.timeoutMs })
      } catch (error) {
        this.browserFailed = true
        this.results.push(result('execution', 'error', start, knownMessage(error)))
        for (const check of browserChecks) this.results.push(result(check, 'skipped', start, 'See the Chromium startup error.', { url: display, coverageIncomplete: true }))
        return
      }
    }

    const browserStart = performance.now()
    let inspection: Inspection
    try {
      inspection = await this.inspect(finalUrl, accessibility, links, this.config.links.maxLinksPerPage)
    } catch (error) {
      const message = knownMessage(error)
      const status = error instanceof BrowserError && error.code === 'inspection' ? 'error' : 'fail'
      for (const check of browserChecks) this.results.push(result(check, status, browserStart, message, { url: display, coverageIncomplete: true }))
      return
    }
    if (accessibility) {
      if (!inspection.violations.length) this.results.push(result('accessibility', 'pass', browserStart, 'No automated violations found.', { url: display }))
      for (const item of inspection.violations) {
        const severity = item.impact === 'critical' || item.impact === 'serious' ? 'error' : 'warning'
        this.results.push(result('accessibility', 'fail', browserStart, item.description, {
          url: display, severity, rule: item.id, impact: item.impact, targets: item.targets, guidance: item.helpUrl,
          suggestion: 'Locate the listed element in the rendered page and follow the rule guidance.'
        }))
      }
    }
    if (links) await this.scanLinks(finalUrl, display, inspection)
  }

  async run(): Promise<void> {
    try {
      for (const route of this.config.routes) await this.runRoute(route)
    } finally {
      await this.browser?.close()
    }
  }
}

export async function runChecks(config: Config, results: Result[], secrets: string[]): Promise<void> {
  const base = parseTarget(config.baseUrl)
  const api = config.checks.api ? config.api.map(endpoint => ({ endpoint, headers: resolveHeaders(endpoint.headers) })) : []
  const headerSecrets = new Set<string>()
  for (const { headers } of api) {
    for (const value of Object.values(headers)) {
      if (!value) continue
      headerSecrets.add(value)
      const token = /^(?:Basic|Bearer) (.+)$/i.exec(value)?.[1]
      if (token) headerSecrets.add(token)
    }
  }
  secrets.push(...[...headerSecrets].sort((a, b) => b.length - a.length))
  if (config.checks.pages || config.checks.links || config.checks.accessibility) {
    await new WebsiteChecks(config, base, results).run()
  }
  for (const { endpoint, headers } of api) results.push(await runApi(base, config, endpoint, headers))
  if (results.length === 0) results.push(result('execution', 'skipped', performance.now(), 'No checks are configured to run.'))
}
