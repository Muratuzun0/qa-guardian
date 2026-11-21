# Community workshop React demo

This demo renders React on the server and serves it locally with Node.js. The pinned `@muratuzun0/qa-guardian@0.1.0` dependency comes from npm. Use Node.js 22 or 24.

```sh
npm ci
npx playwright install chromium
npm run demo
```

The automated run uses a loopback port and a temporary baseline. It prints a summary from the JSON reports and checks the exact findings before cleaning up.

## Run each scenario manually

Start the first scenario in one terminal from this directory.

```sh
npm start -- before
```

In a second terminal in the same directory, save the baseline.

```sh
npx qa-guardian check --save-baseline
```

Expect exit 1 and a saved local baseline. The home page is available and its health endpoint passes. Axe flags the decorative workshop banner for its missing `alt` attribute. The recording link returns 404.

Stop the server with Ctrl+C, then run the revised scenario on the same port.

```sh
npm start -- after
```

Compare from the second terminal.

```sh
npx qa-guardian check --baseline
```

Expect exit 1 for the newly broken partner-guide link. The final lines of the terminal report are:

```text
Regression Guard found 1 new, 1 resolved, 1 unchanged and 0 unverified issues.
  New links http://127.0.0.1:4173/partner-guide Link returned HTTP 404.
4 passed, 2 failed, 0 skipped, 0 execution errors (exit 1)
```

Add `--json` to see the resolved `image-alt` finding and unchanged recording link. The two runs use the same route and origin so the comparison scope matches.

To repeat the manual exercise, move the demo's `.qa-guardian-baseline.json` aside before saving another baseline. The automated demo creates a fresh baseline on every run.
