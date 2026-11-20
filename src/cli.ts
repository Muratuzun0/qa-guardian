#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { BaselineError, ConfigError } from './errors.js'
import { formatJson, formatTerminal, report, result, writeReport, type Result } from './report.js'

const defaultConfigFile = 'qa-guardian.config.json'

const help = `QA Guardian

Usage:
  qa-guardian init
  qa-guardian check [--url URL] [--config FILE] [--json] [--baseline | --save-baseline]
  qa-guardian --help
  qa-guardian --version

Commands:
  init          Create qa-guardian.config.json in the working directory.
  check         Run the checks against the configured application.

Options for check:
  --url URL     Override the configured base URL.
  --config FILE Read a specific JSON configuration file.
  --json        Write a JSON report to stdout.
  --baseline    Compare with the local baseline and gate on new findings.
  --save-baseline  Save this run as a new local baseline.

Exit codes:
  0  No findings at the configured failure threshold.
  1  One or more findings reached the failure threshold.
  2  Configuration or execution error.
`

const checkHelp = `Usage: qa-guardian check [--url URL] [--config FILE] [--json] [--baseline | --save-baseline]
Run availability, link, accessibility and API checks for a web app.
The default configuration file is qa-guardian.config.json.
`

async function init(cwd: string): Promise<void> {
  try {
    await writeFile(join(cwd, defaultConfigFile), JSON.stringify({
      baseUrl: 'http://localhost:3000',
      routes: ['/'],
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ConfigError('qa-guardian.config.json already exists.')
    }
    throw new ConfigError('Could not create qa-guardian.config.json. Check directory permissions.')
  }
  process.stdout.write('Created qa-guardian.config.json. Start your server and run qa-guardian check.\n')
}

function checkOptions(args: string[]) {
  try {
    const parsed = parseArgs({
      args,
      tokens: true,
      options: {
        url: { type: 'string' },
        config: { type: 'string' },
        json: { type: 'boolean' },
        baseline: { type: 'boolean' },
        'save-baseline': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    const seen = new Set<string>()
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue
      if (seen.has(token.name)) throw new ConfigError('Specify each check option only once.')
      seen.add(token.name)
    }
    if (parsed.values.url === '' || parsed.values.config === '') {
      throw new ConfigError('--url and --config require nonempty values.')
    }
    if (parsed.values.baseline && parsed.values['save-baseline']) {
      throw new ConfigError('--baseline and --save-baseline are mutually exclusive.')
    }
    return parsed.values
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError('Invalid check arguments. Run qa-guardian check --help for usage.')
  }
}

async function main(args: string[]): Promise<number> {
  const [command, ...options] = args
  if (!command || (['--help', '-h'].includes(command) && options.length === 0)) {
    process.stdout.write(help)
    return 0
  }
  if (['--version', '-v'].includes(command) && options.length === 0) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    process.stdout.write(manifest.version + '\n')
    return 0
  }
  const cwd = process.cwd()
  if (command === 'init') {
    if (options.length === 1 && ['--help', '-h'].includes(options[0]!)) {
      process.stdout.write('Usage: qa-guardian init\nCreate qa-guardian.config.json in the working directory.\n')
      return 0
    }
    if (options.length) throw new ConfigError('The init command takes no arguments.')
    await init(cwd)
    return 0
  }
  if (command !== 'check') throw new ConfigError('Unknown command. Run qa-guardian --help for usage.')
  const results: Result[] = []
  const secrets: string[] = []
  const started = performance.now()
  let failOn: 'warning' | 'error' = 'error'
  let json = options.includes('--json')
  let output: ReturnType<typeof report> | undefined
  try {
    const flags = checkOptions(options)
    json = flags.json === true
    if (flags.help) {
      process.stdout.write(checkHelp)
      return 0
    }
    const { loadConfig } = await import('./config.js')
    const config = await loadConfig(cwd, flags.config, flags.url)
    failOn = config.failOn
    const { baselineScope, compareBaseline, loadBaseline, saveBaseline } = await import('./baseline.js')
    const scope = flags.baseline || flags['save-baseline'] ? baselineScope(config) : ''
    const previous = flags.baseline ? await loadBaseline(cwd, scope) : undefined
    try {
      const { runChecks } = await import('./core.js')
      await runChecks(config, results, secrets)
    } catch (error) {
      results.push(result('execution', 'error', started, executionMessage(error)))
    }
    const finalize = () => {
      const current = report(results, failOn, secrets)
      return previous ? compareBaseline(current, previous, failOn) : current
    }
    output = finalize()
    if (flags['save-baseline']) {
      try {
        await saveBaseline(cwd, scope, output)
        output.baselineSaved = true
      } catch (error) {
        results.push(result('execution', 'error', started, executionMessage(error)))
        output = finalize()
      }
    }
    if (config.reportDir) {
      try {
        await writeReport(cwd, config.reportDir, output)
      } catch {
        results.push(result('execution', 'error', started, 'Could not write the JSON report. Check reportDir, directory permissions and available disk space.'))
        const baselineSaved = output.baselineSaved
        output = finalize()
        if (baselineSaved) output.baselineSaved = baselineSaved
      }
    }
  } catch (error) {
    results.push(result('execution', 'error', started, executionMessage(error)))
  }
  output ??= report(results, failOn, secrets)
  process.stdout.write(json ? formatJson(output) : formatTerminal(output))
  return output.exitCode
}

function executionMessage(error: unknown): string {
  if (error instanceof ConfigError || error instanceof BaselineError) return error.message
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return 'A required dependency is unavailable. Reinstall QA Guardian and its dependencies, then try again.'
  }
  return 'QA Guardian could not complete the run due to an unexpected execution error.'
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(executionMessage(error) + '\n')
  process.exitCode = 2
}
