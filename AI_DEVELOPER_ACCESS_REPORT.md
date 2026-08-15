# AI Developer Access / API Key Control System

This package adds a controlled API key system and an AI-readable developer API so trusted AI tools, Google Apps Script, or other third-party tools can inspect the project, manage automations/settings, create GitHub branches/commits/PRs, and trigger validation/deploy workflows.

## New UI

Open the frontend and go to:

```txt
/ai-access
```

The sidebar now includes **AI Access**.

From this page you can:

- Create API keys for AI/testing/third-party tools.
- Select permission level and granular scopes.
- Enable/disable dangerous flags such as direct default-branch writes and production deploy trigger.
- Copy the key once after creation.
- Rotate or revoke old keys.
- See manifest and patch curl examples.
- Review available AI API endpoints.

## New API key fields

The backend now supports these API key fields:

- `description`
- `scopes`
- `allowed_origins`
- `allow_production_deploy`
- `allow_direct_file_write`

Keys are stored as SHA-256 hashes. Plain API keys are only returned one time on create/rotate.

Compatibility note: AI keys are created as `access` type with rich scopes, so they also work with older D1 databases whose `api_keys.key_type` check constraint may not include `external`.

## AI Developer API endpoints

All endpoints use:

```txt
Authorization: Bearer <API_KEY>
```

Main endpoints:

```txt
GET    /api/ai/manifest
GET    /api/ai/instructions
GET    /api/ai/openapi.json
GET    /api/ai/project-map
GET    /api/ai/files/tree
GET    /api/ai/files/read?path=worker/src/index.ts
POST   /api/ai/files/patch
GET    /api/ai/automations
POST   /api/ai/automations
GET    /api/ai/automations/:id
PUT    /api/ai/automations/:id
DELETE /api/ai/automations/:id
GET    /api/ai/settings
PATCH  /api/ai/settings
POST   /api/ai/git/branch
POST   /api/ai/git/pr
POST   /api/ai/tests/run
POST   /api/ai/deploy
GET    /api/ai/audit
GET    /api/ai/logs
```

## Recommended AI workflow

1. Fetch manifest:

```bash
curl -H "Authorization: Bearer <API_KEY>" "https://waqas-ai-studio.waqaskhan1437.workers.dev/api/ai/manifest"
```

2. Fetch project map and file tree.
3. Read only the relevant files.
4. Patch files to a new branch using full replacement content.
5. Trigger tests with `/api/ai/tests/run`.
6. Create PR with `/api/ai/git/pr`.
7. Deploy only after approval or with a key that has production deploy enabled.

## Safety controls

- Secrets are masked when settings are read.
- Direct default-branch file writes are blocked unless the API key has `allow_direct_file_write` or `admin.full`/admin/full permission.
- Production deploy trigger is blocked unless the API key has `allow_production_deploy` or `admin.full`/admin/full permission.
- All AI changes are logged into `ai_change_requests`.
- API request logs remain available from `/api/ai/logs`.

## Database upgrade behavior

The backend now runs a safe API-key schema upgrade when `/api/keys` or `/api/ai/*` is used. It creates/updates these structures if missing:

- `api_keys` extra columns
- `api_audit_logs`
- `ai_change_requests`

A manual migration file is also included:

```txt
worker/migrations/012_ai_developer_access.sql
```

If you prefer manual DB migration, apply only after confirming the current D1 migration state.

## Important files changed/added

```txt
worker/src/services/ai-developer.ts
worker/src/routes/ai-access.ts
worker/src/routes/api-keys.ts
worker/src/services/auth.ts
worker/src/types.ts
worker/src/utils.ts
worker/src/index.ts
worker/src/db/schema.sql
worker/migrations/012_ai_developer_access.sql
frontend/src/app/ai-access/page.tsx
frontend/src/components/layout/Sidebar.tsx
frontend/src/lib/api.ts
AI_DEVELOPER_ACCESS_REPORT.md
```

## Deployment notes

- Worker remains deployed before Vercel through `deploy-production.yml`.
- The risky automatic D1 migration step was removed from deployment workflow to avoid duplicate-column failures on existing databases.
- Runtime schema upgrade handles this feature when API key/AI endpoints are used.

## ChatGPT / Browser-compatible monitoring access added

Some AI tools, including browser-based assistants, cannot send custom `Authorization` headers. This package now supports a safe read-only URL mode for AI monitoring:

```txt
GET /api/ai/snapshot?ai_token=<API_KEY>
GET /api/ai/monitor?ai_token=<API_KEY>
GET /api/ai/browser-links?ai_token=<API_KEY>
```

### What this enables

- ChatGPT/browser AI can open a single Snapshot URL and read project manifest, permissions, automation health, recent jobs, masked settings, recent logs, and GitHub configuration status.
- ChatGPT/browser AI can open Monitor URL to quickly see which automations/jobs are active, failed, queued, or running.
- Browser Links endpoint returns copyable GET links for manifest, project map, automations, logs, masked settings, file reads, and file tree.

### Safety behavior

- Query-token access works only for `GET /api/ai/*` endpoints.
- Mutating actions such as file patch, automation create/update/delete, settings update, Git branch/PR, tests, and deploy still require `Authorization: Bearer <API_KEY>` or `X-Access-Token` headers.
- Use short-expiry keys for ChatGPT/browser monitoring links and rotate/revoke the key after testing.
- Secrets remain masked on read.

### Recommended prompt for ChatGPT/browser AI

```txt
Open this snapshot URL first and analyze my automation system. Check active automations, failed jobs, recent logs, masked settings, GitHub repo status, and tell me what bugs or deployment issues you find. Then ask me for specific file read links only if deeper code analysis is needed.
```

