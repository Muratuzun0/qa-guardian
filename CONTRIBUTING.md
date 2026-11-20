# Contributing to QA Guardian

Develop with Node.js 22 or 24. Follow the README to install dependencies and Chromium, then run the test suite before making changes.

For bug reports, include the CLI version, Node.js version, operating system, configuration with secrets removed, and the expected and actual results. A small local fixture makes network and browser failures easier to reproduce. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.

Prepare changes for review using these steps.

1. Describe the user-visible problem and the expected behavior.
2. Add fixture-based coverage for new behavior and regressions.
3. Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
4. Update configuration or usage documentation when commands, defaults, or results change.

Keep fixtures local and deterministic. Check behavior with a clean installation if you change the package manifest, CLI entry point, or published files. See [Architecture](docs/architecture.md) for the design boundaries and roadmap.
