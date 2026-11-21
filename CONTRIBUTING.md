# Contributing to QA Guardian

Develop with Node.js 22 or 24. Follow the README to install dependencies and Chromium, then run the test suite before making changes.

For bug reports, include the CLI version, Node.js version, operating system, configuration with secrets removed, and the expected and actual results. A small local fixture makes network and browser failures easier to reproduce. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.

Prepare changes for review using these steps.

1. Describe the user-visible problem and the expected behavior.
2. Add fixture-based coverage for new behavior and regressions.
3. Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
4. Update configuration or usage documentation when commands, defaults, or results change.

Keep fixtures local and deterministic. Check behavior with a clean installation if you change the package manifest, CLI entry point, or published files. See [Architecture](docs/architecture.md) for design boundaries and the [roadmap](docs/roadmap.md) for current priorities.

## First contributions

Pick one small change and include a before-and-after example in your pull request. Search open issues first so you can build on work already in progress.

| Task | Where to start | What to verify |
| --- | --- | --- |
| Show resolved findings in the terminal comparison | [Terminal formatter](src/report.ts) and [report tests](tests/core.test.mjs). The formatter prints each new finding but only counts resolved ones. | A fixture with a resolved axe rule prints its route and rule. JSON and exit codes stay the same. |
| Cover links to percent-encoded element IDs | [Fragment handling](src/core.ts), the [fixture server](tests/fixtures/web.mjs), and [CLI tests](tests/cli.test.mjs). Add a valid encoded fragment that resolves to an accented ID and a malformed escape. | The valid fragment passes and the malformed one gets the existing explanatory finding. Keep both cases on the local fixture. |
| Document a readiness check for preview servers | [README GitHub Actions example](README.md#run-in-github-actions) and [preview server](examples/preview.mjs). Explain why readiness is checked before QA Guardian runs and how to select an unauthenticated readiness endpoint. | Run the example with a delayed server start and confirm that the check begins only after the readiness request succeeds. |
