# Regression Guard

Regression Guard gates a run on new findings so existing issues can stay visible while a team fixes them over time. It compares the current run with a reviewed local baseline and works with the terminal and JSON reports.

## Capture and compare

Start the application and run the same routes and checks that CI will run.

```sh
npx qa-guardian check --save-baseline
npx qa-guardian check --baseline --json
```

The first command creates `.qa-guardian-baseline.json` in the working directory. It refuses to overwrite an existing baseline. A complete run with findings can save a baseline and exit 1. Execution errors and known incomplete coverage prevent baseline capture. Review the file before sharing or committing it.

The second command reruns all configured checks, including previously failing URLs, endpoints, and rules. It reports findings that are new, resolved, unchanged, or unverified. An unverified finding is absent from the current run, but a known coverage gap prevented verification. Look for skipped checks or scope changes before treating a baseline finding as fixed.

| Exit code in comparison mode | Meaning |
| --- | --- |
| 0 | No new findings reached the configured threshold. |
| 1 | One or more new findings reached the configured threshold. |
| 2 | The CLI could not complete the requested operation, for example because the baseline was invalid or Chromium failed to start. |

Use either `--save-baseline` or `--baseline` in a single run. To replace a baseline intentionally, move it aside, capture a candidate with the same settings, and review the changes before adopting it. Run `check --baseline` in CI, with the baseline from a trusted branch or after reviewing any proposed baseline changes.

## Try a regression against the bundled preview

After [building the CLI and installing Chromium](../README.md#develop-and-contribute), start the bundled preview from the checkout.

```sh
node examples/preview.mjs
```

In a second terminal in the checkout, save the baseline.

```sh
node dist/cli.js check --config examples/qa-guardian.config.json --save-baseline
```

Stop the preview and restart it with a link to a missing page.

```sh
node examples/preview.mjs --broken-link
```

Compare this run. The report identifies the new failing link and the source route, and the CLI exits 1.

```sh
node dist/cli.js check --config examples/qa-guardian.config.json --baseline
```

This exercise creates the local baseline and JSON reports in the checkout. Keep them only if you want to repeat the comparison.

## What counts as the same finding

The comparison uses stable finding identities derived from the check, sanitized URLs and source route, and the axe rule or issue category where available. It ignores timing, severity, descriptions, and DOM selectors. The JSON report adds a `regression` object with `new`, `resolved`, `unchanged`, and `unverified` arrays.

Findings can share an identity. For example, several elements affected by the same axe rule on one route are grouped. Distinct links or endpoints can share an identity when they differ only by query or fragment. Different methods on the same API path can also group when they fail for the same reason. The comparison requires equivalent check scope. Use the same application origin, routes, enabled checks, link coverage settings, and endpoint definitions. The scope signature uses endpoint paths, methods, expected statuses, and JSON assertion paths. It excludes header values and assertions' expected values. A scope mismatch exits 2 and requires a matching configuration or a reviewed replacement baseline. Even with matching scope, a changed redirect or axe rule can affect identities independently of an application fix. Keep the CLI version consistent for comparable results. Inspect the full report before making decisions about individual elements or endpoints.

The reports include route and link-source information where available and axe selectors for accessibility violations. Use those details to locate the failing page or element in your application. The CLI has no mapping from rendered elements to source files. Baselines stay local unless you explicitly share them.
