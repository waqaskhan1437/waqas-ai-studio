# Deployment

This repository now uses **one production deployment workflow** for pushes to `master` or `main`:

1. **Deploy Worker** - installs `worker`, runs `npm run check`, then deploys `waqas-ai-studio` with Wrangler.
2. **Deploy Frontend** - starts only after the Worker deploy succeeds, installs `frontend`, runs `npm run check`, builds Vercel output, then deploys the `frontend` project to Vercel production.

This keeps production deployment ordered as:

```text
GitHub push -> Cloudflare Worker -> Vercel Frontend
```

## GitHub Actions workflows

### Production deploy

`.github/workflows/deploy-production.yml` is the only workflow that deploys production on push.

It is intentionally limited to these push paths:

- `frontend/**`
- `worker/**`
- `vercel.json`
- `frontend/vercel.json`
- `.github/workflows/deploy-production.yml`

Changes to runner-only files no longer trigger a production deploy.

### Pull request validation

`.github/workflows/validate-deployments.yml` remains a pull-request/manual validation workflow only. It does not deploy production.

### Manual Worker fallback

`.github/workflows/deploy-worker.yml` remains manual-only through `workflow_dispatch`. It does not run on push.

## Required GitHub secrets

Add these secrets in GitHub repository settings:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `VERCEL_TOKEN`

The workflow currently has these Vercel IDs set:

- `VERCEL_ORG_ID=team_xQveLh5tkEuV829DuVHcbAWZ`
- `VERCEL_PROJECT_ID=prj_BVtIbisfUzhsuaE0iTzokA952icO`

## Important dashboard settings to prevent duplicate deploys

The repo disables Vercel Git auto-deploys in both `vercel.json` files with:

```json
"git": {
  "deploymentEnabled": false
}
```

That prevents normal Vercel Git deployments from running on every commit while still allowing the GitHub Action to deploy with Vercel CLI.

Cloudflare's Git integration cannot be fully disabled from this repo. In Cloudflare Dashboard, disconnect or disable Workers Builds/Git integration for `waqas-ai-studio` if it is connected to the same GitHub repo. Otherwise Cloudflare can deploy directly on push at the same time as GitHub Actions, creating duplicate Worker deployments.

If an old Vercel project such as `waqas-ai-studio` is still connected to this repo, delete it or disconnect its Git integration. Keeping only the `frontend` Vercel project avoids extra skipped/canceled Vercel checks.
