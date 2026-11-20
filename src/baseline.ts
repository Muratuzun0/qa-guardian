import { createHash } from 'node:crypto'
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BaselineError } from './errors.js'
import { readLocalFile } from './local-files.js'
import type { Config } from './config.js'
import { parseTarget, safeUrl } from './network.js'
import type { Report } from './report.js'

const filename = '.qa-guardian-baseline.json'
const maxBytes = 32 * 1024 * 1024
const entrySchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  check: z.enum(['pages', 'links', 'accessibility', 'api']),
  url: z.string().max(512).optional(),
  sourceUrl: z.string().max(512).optional(),
  rule: z.string().max(100).optional(),
  message: z.string().max(1024),
})
const baselineSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  issues: z.array(entrySchema).max(65_000),
})
type Issue = z.infer<typeof entrySchema>
export interface Regression {
  new: Issue[]
  resolved: Issue[]
  unchanged: Issue[]
  unverified: Issue[]
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function baselineScope(config: Config): string {
  const base = parseTarget(config.baseUrl)
  const { pages, links, accessibility, api } = config.checks
  const route = (value: string) => safeUrl(parseTarget(value, base))
  return digest({
    origin: base.origin,
    checks: [pages, links, accessibility, api],
    routes: pages || links || accessibility ? [...new Set(config.routes.map(route))].sort() : [],
    links: links ? [config.links.checkFragments, config.links.maxLinksPerPage, [...config.links.externalOrigins].sort()] : [],
    api: api ? config.api.map(endpoint => JSON.stringify([
      route(endpoint.path), endpoint.method, endpoint.expectedStatus,
      endpoint.assertions.map(assertion => JSON.stringify(assertion.path)).sort(),
    ])).sort() : [],
  })
}

function issues(report: Report): Map<string, Issue> {
  const items = new Map<string, Issue>()
  for (const item of report.results) {
    if (!item.fingerprint || item.status !== 'fail' || item.check === 'execution') continue
    const { check, url, sourceUrl, rule, message } = item
    const id = item.fingerprint
    items.set(id, { fingerprint: id, check, url, sourceUrl, rule, message })
  }
  return items
}

export function hasIncompleteCoverage(report: Report): boolean {
  return report.results.some(item => item.coverageIncomplete)
}

export function compareBaseline(report: Report, previous: Issue[], failOn: 'error' | 'warning'): Report {
  const current = issues(report)
  const prior = new Map(previous.map(issue => [issue.fingerprint, issue]))
  const regression: Regression = { new: [], resolved: [], unchanged: [], unverified: [] }
  for (const [id, issue] of current) regression[prior.has(id) ? 'unchanged' : 'new'].push(issue)
  const incomplete = new Set(report.results.filter(item => item.coverageIncomplete)
    .map(item => JSON.stringify([item.check, item.url])))
  for (const [id, issue] of prior) {
    if (current.has(id)) continue
    const affected = report.exitCode === 2 || incomplete.has(JSON.stringify([issue.check, issue.sourceUrl ?? issue.url]))
    regression[affected ? 'unverified' : 'resolved'].push(issue)
  }
  const newIds = new Set(regression.new.map(issue => issue.fingerprint))
  const blocks = report.results.some(item => item.fingerprint && newIds.has(item.fingerprint) &&
    (item.severity === 'error' || failOn === 'warning'))
  return { ...report, regression, exitCode: report.exitCode === 2 ? 2 : blocks ? 1 : 0 }
}

export async function loadBaseline(cwd: string, scope: string): Promise<Issue[]> {
  try {
    const raw: unknown = JSON.parse(await readLocalFile(join(cwd, filename), maxBytes))
    const baseline = baselineSchema.parse(raw)
    if (baseline.scope !== scope) throw new BaselineError('The local baseline covers a different check configuration. Use the matching configuration or save a replacement baseline.')
    const entries = baseline.issues.map(entry => ({
      ...entry,
      url: entry.url?.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' '),
      sourceUrl: entry.sourceUrl?.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' '),
    }))
    return entries
  } catch (error) {
    if (error instanceof BaselineError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BaselineError('No local baseline found. Run qa-guardian check --save-baseline first.')
    }
    throw new BaselineError('Could not read the local baseline. Check its format, version, size and permissions.')
  }
}

export async function saveBaseline(cwd: string, scope: string, report: Report): Promise<void> {
  if (report.exitCode === 2 || hasIncompleteCoverage(report)) {
    throw new BaselineError('Could not save a baseline from an incomplete run. Review the reported errors or skipped coverage.')
  }
  const content = JSON.stringify({ version: 1, scope, issues: [...issues(report).values()] }) + '\n'
  if (Buffer.byteLength(content) > maxBytes) throw new BaselineError('The baseline exceeds 32 MiB.')
  try {
    const temporary = await mkdtemp(join(cwd, '.qa-guardian-baseline-'))
    try {
      const path = join(temporary, 'baseline.json')
      await writeFile(path, content, { flag: 'wx', mode: 0o600 })
      await link(path, join(cwd, filename))
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new BaselineError('The local baseline already exists. Move it before saving a replacement.')
    }
    throw new BaselineError('Could not write the local baseline. Check directory permissions and available disk space.')
  }
}
