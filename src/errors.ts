export class ConfigError extends Error {}
export class BaselineError extends Error {}

export class BrowserError extends Error {
  constructor(readonly code: 'startup' | 'timeout' | 'navigation' | 'inspection', message: string) {
    super(message)
    this.name = 'BrowserError'
  }
}
