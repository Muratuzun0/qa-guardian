# Configuration reference

The default configuration filename is `qa-guardian.config.json` in the working directory. Use `check --config path/to/file.json` to select a different file. Use `--url` to override the base URL for a run. If the default file is absent, `check` targets `http://localhost:3000/`. An explicitly selected config file must exist.

## Routes and checks

| Setting | Default | Behavior |
| --- | --- | --- |
| `baseUrl` | `http://localhost:3000` for runs without a config file | Absolute HTTP or HTTPS URL for the application, such as `http://localhost:3000`. |
| `routes` | `["/"]` | Up to 100 URL paths or same-origin URLs. |
| `checks.pages` | `true` | Check response status and redirects for configured pages. |
| `checks.links` | `true` | Check links found on configured routes. |
| `checks.accessibility` | `true` | Run axe-core in Chromium. |
| `checks.api` | `true` | Run the configured API smoke tests. |
| `timeoutMs` | `10000` | Default timeout from 1 to 120,000 milliseconds. |
| `browser.headless` | `true` | Set to `false` to open Chromium visibly on a machine with a desktop. |

Only run checks against an application you trust and have permission to test. Local development servers are valid targets. The base URL accepts a path. Relative routes resolve against it using standard URL resolution, so a trailing slash matters. Credentials, query strings, and fragments are disallowed in the base URL. Browser requests are restricted to the configured origin.

## Links

| Setting | Default | Behavior |
| --- | --- | --- |
| `links.externalOrigins` | `[]` | Explicit HTTP or HTTPS origins whose outbound links can be checked. Include the scheme and any nondefault port. |
| `links.concurrency` | `4` | Maximum concurrent link checks, from 1 to 16. |
| `links.maxLinksPerPage` | `100` | Maximum link checks scheduled per page, from 1 to 500. |
| `links.checkFragments` | `true` | Check whether fragment targets exist when supported. |

A direct link can be checked without adding its destination to the list of pages to scan. Internal link rules use the configured origin. External link destinations must resolve to public addresses, and external fragments are checked only at the HTTP destination level.

## API endpoints

Set `api` to an array of endpoint definitions. It defaults to an empty array.

| Endpoint setting | Default | Behavior |
| --- | --- | --- |
| `path` | Required | API path on the configured origin. |
| `method` | `GET` | One of `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`, or `DELETE`. |
| `expectedStatus` | `200` | Exact expected HTTP response status. |
| `timeoutMs` | Top-level timeout | Endpoint-specific timeout in milliseconds. |
| `headers` | None | Request headers, specified as a JSON object of names and string values. |
| `assertions` | None | Exact equality checks against JSON response properties. |

Each assertion includes a `path` array of property names and an `equals` value of type string, number, boolean, or null. For example, a response of `{"service":{"ready":true}}` matches `{"path":["service","ready"],"equals":true}`.

Use an environment reference for a secret header value.

```json
{
  "path": "/api/health",
  "headers": { "Authorization": "${QA_GUARDIAN_AUTHORIZATION}" }
}
```

The reference must occupy the whole string. Set the variable to the complete header value, including any scheme such as `Bearer`. Keep credentials out of checked-in configuration. Reports omit query strings and fragments from displayed URLs. Check URL paths and affected-element selectors for sensitive data before sharing a report.

API requests use the configured URL directly and do not follow redirects. Assert a redirect status explicitly if it is expected. Responses with JSON assertions are limited to 1 MiB. `HEAD` responses have no body, so they cannot use JSON assertions. `POST`, `PUT`, `PATCH`, and `DELETE` require the top-level `allowUnsafeMethods` option, which defaults to `false`. The CLI sends no request body. Use modifying methods only in isolated environments where the expected requests are safe to run.

## Reports and thresholds

| Setting | Default | Behavior |
| --- | --- | --- |
| `reportDir` | No file output | Write a JSON report to a directory relative to the working directory. Directory components cannot be symbolic links. |
| `failOn` | `"error"` | Fail on error results. Use `"warning"` to also fail on warnings. |

The JSON report includes `schemaVersion`, `results`, `summary`, and `exitCode`. Serious and critical axe findings are errors. Other axe findings and link truncation are warnings. An execution error takes precedence over any result threshold. See the [README](../README.md#run-checks-and-read-results) for exit codes.

## API security expectations

Opt in with `security.authorized: true` and an exact `security.origin`. Each scenario describes one authorized GET with its expected status and optional response policies. See the [security reference](security-checks.md) for examples, defaults, and interpretation.
