#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$QA_ACTION_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Provide an exact QA Guardian version.' >&2; exit 2; }
[[ "$QA_ACTION_INSTALL_CHROMIUM" == true || "$QA_ACTION_INSTALL_CHROMIUM" == false ]] || { echo 'install-chromium must be true or false.' >&2; exit 2; }
[[ -z "$QA_ACTION_FAIL_ON" || "$QA_ACTION_FAIL_ON" == warning || "$QA_ACTION_FAIL_ON" == error ]] || { echo 'fail-on must be warning or error.' >&2; exit 2; }
directory="$(mktemp -d "${RUNNER_TEMP:-/tmp}/qa-guardian-action.XXXXXX")"
trap 'rm -rf -- "$directory"' EXIT
npm install --prefix "$directory" --registry https://registry.npmjs.org/ --no-audit --no-fund --ignore-scripts --no-save "@muratuzun0/qa-guardian@$QA_ACTION_VERSION"
if [[ "$QA_ACTION_INSTALL_CHROMIUM" == true ]]; then
  if [[ "$RUNNER_OS" == Linux ]]; then
    "$directory/node_modules/.bin/playwright" install --with-deps chromium
  else
    "$directory/node_modules/.bin/playwright" install chromium
  fi
fi

args=(check)
if [[ -n "$QA_ACTION_FAIL_ON" || -n "$QA_ACTION_REPORT_DIR" ]]; then
  node --input-type=module - "$directory/config.json" <<'JS'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
const { QA_ACTION_CONFIG, QA_ACTION_REPORT_DIR, QA_ACTION_FAIL_ON, QA_ACTION_URL } = process.env
const path = QA_ACTION_CONFIG || 'qa-guardian.config.json'
let config
try {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > 262_144) throw new Error()
  config = JSON.parse(readFileSync(path, 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error()
} catch (error) {
  if (error.code !== 'ENOENT' || QA_ACTION_CONFIG) {
    console.error('Could not read the QA Guardian JSON config.')
    process.exit(2)
  }
  config = { baseUrl: QA_ACTION_URL || 'http://localhost:3000' }
}
if (QA_ACTION_FAIL_ON) config.failOn = QA_ACTION_FAIL_ON
if (QA_ACTION_REPORT_DIR) config.reportDir = QA_ACTION_REPORT_DIR
writeFileSync(process.argv[2], JSON.stringify(config), { flag: 'wx', mode: 0o600 })
JS
  args+=(--config "$directory/config.json")
elif [[ -n "$QA_ACTION_CONFIG" ]]; then
  args+=(--config "$QA_ACTION_CONFIG")
fi
if [[ -n "$QA_ACTION_URL" ]]; then
  args+=(--url "$QA_ACTION_URL")
fi
status=0
"$directory/node_modules/.bin/qa-guardian" "${args[@]}" || status=$?
printf 'exit-code=%s\n' "$status" >> "$GITHUB_OUTPUT"
exit "$status"
