# API security checks

QA Guardian can check configured API responses for policy mismatches and signs of accidental disclosure. This feature is available from source on this branch. The published v0.1.0 package supports the existing page and API smoke checks.

## Configure authorized scenarios

Add a `security` section to the existing configuration and set `authorized` to `true` only for endpoints you have permission to test. Set `origin` to the exact origin of `baseUrl`. A separate scenario can describe each explicitly supplied test identity and resource. For example, set an anonymous scenario to expect 401, a member scenario to expect 200, and a viewer scenario to expect 403. Supply each bearer credential through a dedicated environment variable. Use short-lived test credentials.

```json
{
  "baseUrl": "https://preview.example.test",
  "failOn": "warning",
  "security": {
    "authorized": true,
    "origin": "https://preview.example.test",
    "requestBudget": 3,
    "endpoints": [
      { "id": "anonymous", "path": "/api/account", "expectedStatus": 401 },
      {
        "id": "member",
        "path": "/api/account",
        "expectedStatus": 200,
        "bearerTokenEnv": "QAG_MEMBER_TOKEN",
        "sensitive": true,
        "expectHeaders": ["x-content-type-options"]
      }
    ]
  }
}
```

Run `qa-guardian check --config qa-guardian.config.json`. The normal website and API checks still run according to `checks`. Set all four existing switches to `false` for a security-only run.

| Setting | Behavior |
| --- | --- |
| `security.timeoutMs` | Per-request deadline including body reads, 1–15,000 ms. Default is 5,000 ms. |
| `security.requestBudget` | Upper bound on configured scenarios, 1–20. Default is 10. |
| `id`, `path`, `expectedStatus` | Unique scenario ID, fixed same-origin path without query or fragment, and the expected HTTP status. |
| `bearerTokenEnv` | Name of an environment variable containing the complete bearer token value without the `Bearer` prefix. Omit it for anonymous requests. |
| `expectHeaders` | Select supported headers from CSP, HSTS, X-Content-Type-Options, Referrer-Policy and Cache-Control. CSP is checked on HTML, HSTS on HTTPS and `nosniff` on responses explicitly configured to require it. The other policies are checked for presence. |
| `sensitive` | Require `Cache-Control: no-store` on a successful response. |
| `corsOrigins` | Restrict an observed allow-origin header to these exact origins. Absence is allowed. Credentialed wildcard or null origins produce a warning. |
| `inspectDiagnostics` | Match a small set of known database-error and stack-trace shapes in returned text. No request mutation is used. |
| `sensitiveFields` | Treat the presence of any listed JSON property path as a finding. Enter paths as arrays of property names. |
| `jwt` | Inspect compact token metadata found at `path`. Set `algorithms`, `requiredClaims` or `maxLifetimeSeconds` to apply your issuance policy. Lifetime checks need both `iat` and `exp`. |

## Safety and interpretation

Each scenario sends one sequential GET to its configured path. Requests use HTTPS unless the origin is exactly a literal loopback address (`127.0.0.1` or `[::1]`). Other origins must resolve exclusively to public IPs. Validated DNS answers are used directly for the connection. Redirects, retries, and discovery are disabled. Inspection reads at most 256 KiB per response. Any HTTP 429 halts the remaining scenarios in the security run. A 429 without Retry-After yields a client-backoff advisory.

Status mismatches are errors. Header, disclosure, JWT, and rate-limit advisories are warnings. Set `failOn` to `warning` to gate on them. Reports include a scenario/check ID, category, confidence, remediation, and relevant OWASP API reference. Observed means the policy mismatch appeared in the response. Heuristic findings, such as an error-shaped body, require review. Tokens, response values, and diagnostic text are excluded from findings. Review endpoint paths before sharing reports.

JWT metadata is unverified input. Signature validation, token acceptance, audience validation, and claim semantics belong in the application. Passive CORS checks observe supplied responses without injecting origins. SQL diagnostics indicate a possible error disclosure. The checks do not establish injection or reflected XSS exploitability, and the 429 advisory does not measure a rate limiter's threshold. [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)

Regression Guard can track security findings using the scenario and check ID. Changing the selected security scenarios changes the baseline scope. If transport fails, configured JSON cannot be read, or rate limiting prevents a scenario from running, affected prior findings are unverified.

## Run the local fixture

In one terminal from this checkout:

```sh
node examples/api-security/server.mjs
```

In another terminal:

```sh
npm ci
npm run build
QAG_DEMO_MEMBER=demo-member node dist/cli.js check --config examples/api-security/qa-guardian.config.json
```

The anonymous and member expectations pass. The debug response produces warnings for its CORS policy, synthetic diagnostic, and forbidden JSON field. The demo uses a synthetic token and never sends requests beyond loopback.
