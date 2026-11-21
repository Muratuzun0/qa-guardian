<p align="center">
  <img src="assets/qa-guardian-banner.png" alt="QA Guardian banner with illustrative terminal output">
</p>

<h1 align="center">QA Guardian</h1>

<p align="center">Check a running web app before deployment. Compare findings against a local baseline and gate CI on new regressions.</p>

<p align="center">
  <a href="https://github.com/Muratuzun0/qa-guardian/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Muratuzun0/qa-guardian/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@muratuzun0/qa-guardian"><img alt="npm version" src="https://img.shields.io/npm/v/@muratuzun0/qa-guardian"></a>
  <a href="#requirements"><img alt="Node.js 22 and 24" src="https://img.shields.io/badge/Node.js-22%20%7C%2024-375a3b"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

*The banner shows illustrative terminal output.*

## Requirements

- Node.js 22 or 24
- Chromium installed through Playwright for browser checks
- A running application or preview deployment

## Quick start

From your application directory, install the published package and Chromium.

```sh
npm install --save-dev @muratuzun0/qa-guardian
npx playwright install chromium
```

On Linux CI, use `npx playwright install --with-deps chromium` to install Chromium and its system dependencies. With your app running at `http://localhost:3000`, run a check without creating a configuration file. The CLI checks `/` by default. Use `--url` if your app is listening at a different address.

```sh
npx qa-guardian check
npx qa-guardian check --url http://localhost:3000
```

Run `init` in the application directory to create `qa-guardian.config.json`. Edit the routes to match your application. API checks run only for endpoints you configure.

```sh
npx qa-guardian init
npx qa-guardian check
```

## What it checks

| Check | What you get |
| --- | --- |
| Pages and links | Response status and rendered link findings from configured pages. |
| Accessibility | axe rules, affected selectors, and remediation guidance. |
| API smoke tests | Expected statuses and JSON value assertions for configured endpoints. |
| Regression Guard | New, resolved, unchanged, and unverified findings against a local baseline. |
| API security expectations | Opt-in status, header, disclosure, and JWT metadata checks. Available from source on this branch. |

Use Playwright directly when you need to sign in, script a specific user journey, or inspect a page after an interaction. QA Guardian combines bounded checks of a running preview into one terminal or JSON report.

## Try the React demo

This community workshop site starts with a missing image alternative and a broken recording link. The second scenario fixes the decorative image with `alt=""` and adds a new broken link to a partner guide. The recording link stays broken.

From a checkout of this repository, run the demo with the published CLI pinned to `0.1.0`.

```sh
cd examples/react-launch
npm ci
npx playwright install chromium
npm run demo
```

The demo saves a real baseline with `check --save-baseline`, then compares the revised site with `check --baseline`. It prints this summary from the CLI’s JSON reports.

```text
Baseline (exit 1)
  accessibility /: image-alt
  links /workshop-recording: Link returned HTTP 404.
Comparison (exit 1)
  new: links /partner-guide: Link returned HTTP 404.
  resolved: accessibility /: image-alt
  unchanged: links /workshop-recording: Link returned HTTP 404.
```

The CLI’s comparison exits 1 because the new link fails the threshold. The demo script exits 0 when the expected findings match. For a manual run and full terminal output, follow the [React demo walkthrough](examples/react-launch/README.md).

## API security checks

Add explicit authorization and exact-origin scenarios to check what authorized and anonymous test identities receive. Checks can review CORS response headers, cache policy, selected security headers, diagnostic disclosures, forbidden JSON fields, token metadata, and 429 backoff guidance. The currently published v0.1.0 package predates these checks.

The [local fixture](docs/security-checks.md#run-the-local-fixture) produced these lines from the terminal report:

```text
  debug:origin-policy (cors, observed)
  debug:diagnostic-disclosure (disclosure, heuristic)
  debug:sensitive-field (disclosure, observed)
2 passed, 3 failed, 0 skipped, 0 execution errors (exit 1)
```

The checks apply declared response policies. They do not establish exploitability or OWASP compliance. [Configuration and safety limits](docs/security-checks.md)

## Configure the checks

Save this example as `qa-guardian.config.json` and replace the routes and API assertion with ones your application serves.

```json
{
  "baseUrl": "http://localhost:3000",
  "routes": ["/", "/about"],
  "checks": {
    "pages": true,
    "links": true,
    "accessibility": true,
    "api": true
  },
  "timeoutMs": 10000,
  "links": {
    "externalOrigins": [],
    "concurrency": 4,
    "maxLinksPerPage": 100,
    "checkFragments": true
  },
  "browser": { "headless": true },
  "api": [
    {
      "path": "/api/health",
      "method": "GET",
      "expectedStatus": 200,
      "assertions": [{ "path": ["status"], "equals": "ok" }]
    }
  ],
  "allowUnsafeMethods": false,
  "reportDir": "qa-guardian-reports",
  "failOn": "error"
}
```

See the [configuration reference](docs/configuration.md) for target restrictions, API headers, and failure thresholds.

## Run checks and read results

```sh
npx qa-guardian check --config qa-guardian.config.json
npx qa-guardian check --json
npx qa-guardian --help
npx qa-guardian --version
```

The terminal report identifies the check, affected URL, result, and duration. Accessibility findings include the axe rule identifier, impact, affected selectors, and rule guidance. Use `--json` to send the structured report, including severity, to standard output. Set `reportDir` to also write `qa-guardian-report.json` locally.

| Exit code | Meaning |
| --- | --- |
| 0 | Results are below the configured failure threshold. |
| 1 | A check result meets the configured failure threshold. |
| 2 | An execution error occurred, such as invalid configuration, a missing browser, or a report write failure. |

## Catch new failures with Regression Guard

An existing app may already have failing checks. Record the current findings, review the baseline, and run the same checks with it on subsequent changes.

```sh
npx qa-guardian check --save-baseline
npx qa-guardian check --baseline
```

The first command creates `.qa-guardian-baseline.json` in the working directory. It can write a baseline and still exit 1 if the run finds failures at your threshold. The second command keeps known findings visible and exits 1 only for new findings at your threshold. Execution errors still exit 2. Review baseline changes like configuration changes, and use the reviewed file in CI.

See the [Regression Guard guide](docs/regression-guard.md) for comparison rules and limitations.

## Run in GitHub Actions

This workflow installs the published CLI into the consumer project and waits for the preview to answer before checking it. The example assumes your `start` script launches the preview on port 3000 after the build.

```yaml
name: Preview QA
on: [pull_request]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - uses: actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238 # v6.2.0
        with:
          node-version: 24
      - run: npm ci
      - run: npm install --no-save --package-lock=false @muratuzun0/qa-guardian@0.1.0
      - run: npx playwright install --with-deps chromium
      - run: npm run build
      - shell: bash
        run: |
          npm start &
          server=$!
          trap 'kill "$server" 2>/dev/null || true' EXIT
          curl --fail --silent --show-error --retry 20 --retry-connrefused \
            --retry-delay 1 --max-time 5 http://127.0.0.1:3000/ >/dev/null
          npx qa-guardian check --url http://127.0.0.1:3000
```

The repository also includes a [composite action](action.yml). Refer to a reviewed commit containing the action and set up Node.js first. The action installs the selected published package without requiring QA Guardian source files in the consumer checkout.

| Input | Behavior |
| --- | --- |
| `config` | Optional JSON configuration path. |
| `url` | Optional base URL override. |
| `fail-on` | Optional `warning` or `error` threshold override. |
| `report-dir` | Optional report directory relative to the checkout. |
| `install-chromium` | Install browser dependencies unless set to `false`. |
| `version` | Exact published version, default `0.1.0`. |

The `exit-code` output records the CLI status, and a nonzero status also fails the step. When you set `report-dir`, collect `<directory>/qa-guardian-report.json` in a subsequent step with `if: always()`.

## Troubleshooting

- **Connection failed.** Start the application, then check the URL and port from the same shell or CI runner.
- **Chromium could not start.** Run the Playwright installation command for your platform. To use an existing Chromium installation, set `QA_GUARDIAN_CHROMIUM_PATH` to its executable. To run without Chromium, set `checks.links` and `checks.accessibility` to `false`.
- **A route timed out.** Check that the server finished starting and serves the route directly. Increase `timeoutMs` for routes that legitimately take longer.
- **A report could not be written.** Set a writable relative `reportDir` under the working directory.
- **Configuration is invalid.** Fix the setting named in the error and verify that the file is JSON.

## Limitations

QA Guardian runs checks against configured routes. It does not exercise sign-in flows, clicks, form submissions, or other user journeys. Link checks are bounded and use explicit external origins. Browser checks inspect the initial loaded page. They block cross-origin resources, WebSockets, and service workers. A page that depends on those features may render differently during a check.

Automated accessibility results cover only the rules and page states that the engine can evaluate. WCAG conformance requires broader evaluation, including manual keyboard and assistive technology testing.

## Develop and contribute

Run the development checks from the checkout.

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run build
node dist/cli.js --help
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance, [SECURITY.md](SECURITY.md) for vulnerability reporting, and the [architecture notes](docs/architecture.md) for scope and design decisions. The [roadmap](docs/roadmap.md) lists small improvements that contributors can verify locally.

## License

[MIT](LICENSE)
