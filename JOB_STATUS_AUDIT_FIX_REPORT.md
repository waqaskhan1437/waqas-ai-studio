# Job Status / Automation Monitor Audit Fix Report

## Goal
Make failed automation jobs diagnosable and prevent future cases where the app DB says a job failed while GitHub Actions looks successful and `error_message` is empty.

## Root causes found

1. **Video workflow swallowed runner failures**
   - `.github/workflows/video-automation.yml` ran `node main.js || { ... }` and did not exit with the original Node exit code.
   - Result: GitHub Actions could show **success** even when the runner marked the app job as **failed**.

2. **Failed jobs could be stored with blank `error_message`**
   - `runner-scripts/steps/webhook.js` did not send `error_message`.
   - `runner-scripts/update-job-status.js` did not send failure report / error log details.
   - `worker/src/index.ts` webhook route did not persist `error_message` from runner payloads.

3. **Debug data was not surfaced to AI monitor**
   - `/api/ai/monitor` showed failed jobs but not enough details for AI/browser diagnostics.
   - There was no single job diagnostics endpoint with DB status + GitHub run/jobs/artifacts metadata.

4. **Historical stale status mismatch could stay visible**
   - `/api/jobs/:id/logs` would not reconcile a blank failed DB job even if GitHub concluded success.
   - `/api/jobs/:id/status` reconciled status but did not clear stale error fields consistently.

## Fixes applied

### Workflow failure propagation
File: `.github/workflows/video-automation.yml`

- Captures `node main.js` exit code in `MAIN_EXIT`.
- Prints `output/error.log` and `output/failure-report.json` when the runner fails.
- Exits the workflow step with the original runner exit code.

Result: Future GitHub Action status should match the actual runner/app outcome.

### Runner webhook error reporting
Files:

- `runner-scripts/steps/webhook.js`
- `runner-scripts/update-job-status.js`
- `runner-scripts/image/main.js`

Changes:

- Reads `output/failure-report.json` and `output/error.log` tail.
- Sends `error_message` on failed jobs.
- Includes `runner_failure` and `error_log_tail` in `output_data`.
- Does not overwrite rich failure details with empty values during failure cleanup.
- Image runner failures now also send `error_message`.

### Worker webhook persistence
File: `worker/src/index.ts`

Changes:

- Accepts `error_message` from GitHub/local runner webhooks.
- Stores `error_message` in `jobs.error_message`.
- Adds error details into `output_data`.
- Clears `error_message` on success/running status.
- Fixes a duplicated `const mediaUrl` declaration in the upload-save block.

### AI monitoring and diagnostics
File: `worker/src/routes/ai-access.ts`

Changes:

- `/api/ai/monitor` now includes:
  - `recent_jobs`
  - `github_run_id`
  - `github_run_url`
  - `error_message`
  - `failed_without_error_message`
  - warnings when old blank failures exist

New read-only endpoints:

- `GET /api/ai/jobs/recent?limit=25&ai_token=...`
- `GET /api/ai/jobs/:id/diagnostics?ai_token=...`
- Optional: `include_github=0` to skip remote GitHub calls.

Diagnostics returns:

- DB job status/error/output summary
- GitHub run status/conclusion
- GitHub run jobs/steps
- GitHub artifacts metadata
- mismatch analysis and recommendation

### Job status reconciliation
File: `worker/src/routes/jobs.ts`

Changes:

- `/api/jobs/:id/logs` can correct old blank-failure mismatches when GitHub concluded success.
- `/api/jobs/:id/status` now clears `error_message` on success and stores useful failure text when GitHub concludes failure/cancelled.

## How to test after deploy

Replace `<TOKEN>` with a new/rotated AI API key.

```bash
BASE="https://waqas-ai-studio.waqaskhan1437.workers.dev"
TOKEN="<TOKEN>"

curl -sS "$BASE/api/ai/monitor?ai_token=$TOKEN" | jq
curl -sS "$BASE/api/ai/jobs/recent?limit=10&ai_token=$TOKEN" | jq
curl -sS "$BASE/api/ai/jobs/906/diagnostics?ai_token=$TOKEN" | jq
```

For fast DB-only diagnostics:

```bash
curl -sS "$BASE/api/ai/jobs/906/diagnostics?include_github=0&ai_token=$TOKEN" | jq
```

To reconcile the historical job from the normal authenticated app path:

```bash
curl -H "Authorization: Bearer <USER_OR_API_TOKEN>" \
  "$BASE/api/jobs/906/status"
```

## Validation run in sandbox

- YAML parse check: passed for all `.github/workflows/*.yml`.
- JS syntax check: passed for changed runner files.
- TypeScript parse check: passed for changed worker files.
- Full `tsc --noEmit` was attempted but timed out in the sandbox without returning diagnostics; targeted TypeScript parser checks were used instead.

## Files changed

- `.github/workflows/video-automation.yml`
- `runner-scripts/steps/webhook.js`
- `runner-scripts/update-job-status.js`
- `runner-scripts/image/main.js`
- `worker/src/index.ts`
- `worker/src/routes/ai-access.ts`
- `worker/src/routes/jobs.ts`
