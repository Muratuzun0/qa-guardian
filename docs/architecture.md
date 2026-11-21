# Architecture

QA Guardian runs a baseline check against a running web application. A single JSON file describes which routes and API endpoints matter. A run combines the checks into a common result format and provides an exit code the same way on a laptop and in CI.

## Technical assessment

| Tool | Where it fits | Decision |
| --- | --- | --- |
| [Playwright](https://playwright.dev/docs/intro) | Runs Chromium and exposes the rendered DOM and browser request controls. | Use its browser API wherever rendered state is required. |
| [axe-core](https://github.com/dequelabs/axe-core) | Evaluates accessibility rules against rendered content and provides rule guidance. | Use the existing engine and map findings to the common report. |
| [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) and [Unlighthouse](https://github.com/harlan-zw/unlighthouse) | Track Lighthouse scores, enforce budgets, or audit a site across many pages. | Leave performance metrics, historical comparisons, and site-wide discovery to these tools. |
| [Lychee](https://github.com/lycheeverse/lychee) and [Linkinator](https://github.com/JustinBeckwith/linkinator) | Find dead links across sites, files, or documentation. | Check direct links on configured routes under the same request policy as availability and API checks. General-purpose crawling and document scanning remain outside the first release. |
| [Pa11y CI](https://github.com/pa11y/pa11y-ci) | Runs accessibility checks over lists of URLs in CI. | Combine accessibility findings with availability, links, and API results while keeping accessibility rules in axe. |
| [Bruno CLI](https://docs.usebruno.com/bru-cli/run/options) and [Newman](https://learning.postman.com/docs/collections/using-newman-cli/newman-options) | Run API collections with environments, assertions, and reporting. | Implement declarative status and response assertions for smoke tests. Collection workflows and custom scripts remain outside the first release. |
| [GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use) | Runs checks in a reproducible CI job and gates deployment on the result. | Provide a regular CLI process with stable exit codes. Use read-only permissions and SHA-pinned actions in repository CI. |

The overlap is intentional. The project owns the configuration, request boundaries, execution order, reports, and exit policy. Teams can get a useful pre-deploy signal without authoring browser tests, maintaining a link crawler, or exporting an API collection. Specialist tools still make sense when a team needs deeper coverage in one area.

## Code organization

| File | Responsibility |
| --- | --- |
| `src/cli.ts` and `src/config.ts` | Command dispatch, configuration loading, argument validation, and environment-backed API headers. |
| `src/core.ts` | Page, link, accessibility, and API orchestration with check-specific result details. |
| `src/network.ts` and `src/browser.ts` | Scoped HTTP requests, timeouts, rendered link discovery, and axe evaluation. |
| `src/report.ts` and `src/baseline.ts` | Result normalization, terminal and JSON formats, exit policy, and baseline comparison. |
| `tests/` and `examples/` | Test fixtures and a preview app that developers can run locally. |

## Design tradeoffs

- A small list of configured routes keeps scope, runtime, and CI behavior predictable.
- Declarative JSON keeps configuration validation and review straightforward and avoids executing configuration scripts.
- Run against an already started server. This works across React, Next.js, static hosting, and other frameworks without adding process supervision or framework-specific code.
- Restrict browser and HTTP routing to the intended test scope. A web page needs to be trusted before it is rendered in a browser.
- Use local fixtures for required tests. Simulate timeouts, redirects, and broken pages through controlled HTTP responses so internet outages do not affect test results.
- Keep the CLI local. Report storage and any further sharing are controlled by the caller.

## Request boundaries

The application origin is explicitly trusted, including local and private network addresses. HTTP checks validate each redirect target before sending a request. External link checks require an exact configured origin and DNS results that resolve to public addresses. Connection setup uses the checked DNS answers, and external requests use no configured API headers.

Chromium runs in a fresh context per page. The browser only receives same-origin GET and HEAD responses via the Node HTTP transport. This limits what page code can reach and caps resource consumption, but the browser still executes the application's scripts. Run the CLI within normal OS or CI isolation and grant it access only to test environments you trust.

Browser inspection is bounded by a timeout, 300 resource requests, eight concurrent resource requests, a 4 MiB per-resource limit, and a 24 MiB page budget. Asset redirects and compressed responses are blocked. Configure the server to honor the `Accept-Encoding: identity` header for browser checks. The main navigation uses the final URL from the availability request so ordinary same-origin page redirects can still be checked.

## Regression Guard

Playwright documents how to compare fingerprints of axe violations in authored tests. This is a good fit when an application already has browser fixtures and scenarios. QA Guardian applies a baseline to findings from all four checks through a pair of CLI flags. It gates changes on new findings while reporting known debt and coverage gaps. [Playwright accessibility snapshots](https://playwright.dev/docs/accessibility-testing#using-snapshots-to-allow-specific-known-issues)

Lighthouse CI supports audit thresholds, resource budgets, and an optional history server for report comparisons. QA Guardian compares discrete finding identities from two runs with a local file. Teams can pair it with Lighthouse CI when they also need performance budgets or performance trends. [Lighthouse CI configuration](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md), [Lighthouse CI server](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/server.md)

Pa11y CI can tolerate a numerical threshold of accessibility findings. That works for an audit count, but exchanging one issue for a different issue at the same count can pass. Linkinator's skip patterns and status-code policies and Lychee's response cache solve other problems. A reviewed QA Guardian baseline keeps checks active and compares their identities across runs. [Pa11y CI](https://github.com/pa11y/pa11y-ci), [Linkinator](https://github.com/JustinBeckwith/linkinator), [Lychee cache](https://lychee.cli.rs/recipes/caching/)

Finding identity excludes elapsed times, message text, DOM selectors, and URL queries and fragments. That makes comparison stable across output wording, incidental DOM changes, and different credentials in URL parameters. The tradeoff is coarser grouping: different elements that fail the same axe rule on the same route share an identity. See [Regression Guard](regression-guard.md) for comparison semantics.

## Future directions

Consider clearer diagnostics for client-side rendering readiness and finer baseline granularity when it can be introduced without exposing sensitive data. Evaluate each addition against the cost of more configuration and less predictable runs.

## Defensive API response checks

`src/security-config.ts` validates explicit scenario scope and the request budget. `src/security.ts` sends only fixed GET requests and evaluates HTTP status, headers, configured fields, and optional JWT metadata. It reuses the shared transport but requires public DNS answers outside literal loopback and disables redirects. Security results contain fixed evidence messages and remediation for baseline comparison.
