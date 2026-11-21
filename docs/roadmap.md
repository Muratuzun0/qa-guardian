# Roadmap

QA Guardian v0.1.0 offers a repeatable baseline for a running web app. The priorities below aim to make findings easier to act on and the first CI run easier to reproduce. They have no release dates.

| Priority | Work | Done when |
| --- | --- | --- |
| Regression reports | [Show resolved findings in the terminal comparison](https://github.com/Muratuzun0/qa-guardian/issues/1). | A developer can identify the resolved route and rule without opening JSON. Comparison identities and exit codes stay the same. |
| Link coverage | [Cover percent-encoded fragments with local browser fixtures](https://github.com/Muratuzun0/qa-guardian/issues/2). | A valid encoded fragment resolves to the correct element and an invalid escape produces the documented diagnostic. |
| CI onboarding | [Document a readiness check for slow preview servers](https://github.com/Muratuzun0/qa-guardian/issues/3). | The example waits for a known endpoint before invoking QA Guardian and fails clearly if the server never becomes ready. |

Use custom Playwright tests for sign-in flows and specific user journeys. QA Guardian will continue to focus on bounded checks that run against an existing preview without custom browser scripts.

See the [contributor guide](../CONTRIBUTING.md) to start a small change.

The API security checks are available from source. The next milestone is to validate the scenario configuration and CI workflow with a staging API before releasing the feature.
