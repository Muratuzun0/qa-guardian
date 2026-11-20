import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Regression } from './baseline.js'

export type Check = 'pages' | 'links' | 'accessibility' | 'api' | 'execution'
export type Severity = 'info' | 'warning' | 'error'
export type Status = 'pass' | 'fail' | 'skipped' | 'error'

export interface Result {
  check: Check
  status: Status
  severity: Severity
  durationMs: number
  url?: string
  sourceUrl?: string
  message: string
  suggestion?: string
  rule?: string
  impact?: string | null
  targets?: string[]
  guidance?: string
  issue?: string
  fingerprint?: string
  coverageIncomplete?: boolean
}

export function result(check: Check, status: Status, started: number, message: string, details: Partial<Omit<Result,
  'check' | 'status' | 'durationMs' | 'message'>> = {}): Result {
  const severity = status === 'fail' || status === 'error' ? 'error' : 'info'
  return { check, status, severity, durationMs: Math.round(performance.now() - started), message, ...details }
}

export interface Report {
  schemaVersion: 1
  results: Result[]
  summary: Record<Status, number>
  exitCode: number
  regression?: Regression
  baselineSaved?: boolean
}

function fingerprint(item: Result): string {
  return createHash('sha256').update(JSON.stringify([
    item.check, item.url, item.sourceUrl, item.rule ?? item.issue,
  ])).digest('hex')
}

export function report(results: Result[], failOn: 'warning' | 'error', secrets: string[] = []): Report {
  const summary = { pass: 0, fail: 0, skipped: 0, error: 0 }
  let exitCode = 0
  for (const item of results) {
    summary[item.status]++
    if (item.status === 'error') exitCode = 2
    if (exitCode === 0 && item.status === 'fail' && (item.severity === 'error' || failOn === 'warning')) exitCode = 1
  }
  const redact = (value: string, limit = 1024) => {
    for (const secret of secrets) value = value.replaceAll(secret, '[redacted]')
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, limit)
  }
  return {
    schemaVersion: 1,
    results: results.map(item => {
      const sanitized = {
        ...item,
        message: redact(item.message),
        url: item.url === undefined ? undefined : redact(item.url, 512),
        sourceUrl: item.sourceUrl === undefined ? undefined : redact(item.sourceUrl, 512),
        suggestion: item.suggestion === undefined ? undefined : redact(item.suggestion),
        targets: item.targets?.map(value => redact(value)),
      }
      return item.status === 'fail' ? { ...sanitized, fingerprint: fingerprint(sanitized) } : sanitized
    }),
    summary,
    exitCode,
  }
}

export const formatJson = (output: Report): string => JSON.stringify(output, null, 2) + '\n'

export function formatTerminal(output: Report): string {
  const lines: string[] = []
  for (const item of output.results) {
    if (item.status === 'pass' && item.check === 'links') continue
    const url = item.url ? ` ${item.url}` : ''
    const source = item.sourceUrl ? ` (from ${item.sourceUrl})` : ''
    lines.push(`[${item.status.toUpperCase()}] ${item.check}${url}${source} (${item.durationMs} ms) ${item.message}`)
    if (item.status === 'fail' && item.severity === 'warning') lines.push('  Severity: warning')
    if (item.rule) lines.push(`  ${item.rule} (${item.impact ?? 'unrated'})`)
    for (const target of item.targets ?? []) lines.push(`  ${target}`)
    if (item.suggestion) lines.push(`  ${item.suggestion}`)
    if (item.guidance) lines.push(`  ${item.guidance}`)
  }
  if (output.regression) {
    const { new: added, resolved, unchanged, unverified } = output.regression
    lines.push(`Regression Guard found ${added.length} new, ${resolved.length} resolved, ${unchanged.length} unchanged and ${unverified.length} unverified issues.`)
    for (const item of added) lines.push(`  New ${item.check}${item.url ? ' ' + item.url : ''} ${item.rule ?? item.message}`)
  }
  if (output.baselineSaved) lines.push('Saved .qa-guardian-baseline.json.')
  const { pass, fail, skipped, error } = output.summary
  lines.push(`${pass} passed, ${fail} failed, ${skipped} skipped, ${error} execution errors (exit ${output.exitCode})`)
  return lines.join('\n') + '\n'
}

export async function writeReport(cwd: string, directory: string, output: Report): Promise<void> {
  let destination = cwd
  for (const part of directory.split('/').filter(part => part && part !== '.')) {
    destination = join(destination, part)
    await mkdir(destination, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    if (!(await lstat(destination)).isDirectory()) throw new Error('Report directories must not be symlinks')
  }
  const temporary = await mkdtemp(join(destination, '.qa-guardian-'))
  try {
    const file = join(temporary, 'report.json')
    await writeFile(file, formatJson(output), { flag: 'wx', mode: 0o600 })
    await rename(file, join(destination, 'qa-guardian-report.json'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
