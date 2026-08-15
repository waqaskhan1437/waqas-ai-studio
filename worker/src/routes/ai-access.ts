import { AuthContext, Env, Automation, GithubSettings } from "../types";
import { jsonResponse, safeRequestJson } from "../utils";
import { getScopedSettings, upsertScopedSettings } from "../services/user-settings";
import { runApiKeyMigration } from "../services/auth";
import type { GitHubFileUpdate } from "../services/ai-developer";
import {
  AI_DEVELOPER_SCOPES,
  commitRepositoryFiles,
  createBranchIfMissing,
  createRepositoryPullRequest,
  dispatchRepositoryWorkflow,
  getDefaultBranch,
  getGithubSettingsForUser,
  getRepositoryInfo,
  listRepositoryFiles,
  logAiChange,
  maskObjectSecrets,
  maskSecretValue,
  readRepositoryFile,
  requireAiScope,
  canUseAiScope,
  textByteLength,
} from "../services/ai-developer";

type FilePatchBody = {
  branch?: string;
  base_branch?: string;
  message?: string;
  path?: string;
  content?: string;
  files?: GitHubFileUpdate[];
  create_pull_request?: boolean;
  pull_request_title?: string;
  pull_request_body?: string;
};

type BranchBody = {
  branch?: string;
  base_branch?: string;
};

type PullRequestBody = {
  title?: string;
  head?: string;
  base?: string;
  body?: string;
};

type WorkflowBody = {
  workflow?: string;
  ref?: string;
  inputs?: Record<string, string>;
};

type SettingsPatchBody = {
  section?: "github" | "postforme" | "ai" | "video-sources";
  values?: Record<string, unknown>;
};

const PROJECT_NAME = "Automation System";
const SAFE_SETTINGS_FIELDS: Record<string, Set<string>> = {
  github: new Set(["pat_token", "repo_owner", "repo_name", "runner_labels", "workflow_dispatch_url"]),
  postforme: new Set(["api_key", "platforms", "saved_accounts", "default_schedule"]),
  ai: new Set(["gemini_key", "grok_key", "cohere_key", "openrouter_key", "openai_key", "groq_key", "elevenlabs_api_key", "default_provider"]),
  "video-sources": new Set(["bunny_api_key", "bunny_library_id", "youtube_cookies", "google_photos_cookies"]),
};

const SETTINGS_TABLE_BY_SECTION: Record<string, string> = {
  github: "settings_github",
  postforme: "settings_postforme",
  ai: "settings_ai",
  "video-sources": "settings_video_sources",
};

const SNAPSHOT_TIMEOUT_MS = 2500;
const SNAPSHOT_GITHUB_TIMEOUT_MS = 3000;

type SnapshotSection<T = unknown> = {
  ok: true;
  duration_ms: number;
  data: T;
} | {
  ok: false;
  duration_ms: number;
  error: string;
  timed_out: boolean;
};

function timeoutFallback(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, timeoutFallback(ms)]);
}

async function collectSnapshotSection<T>(name: string, factory: () => Promise<T>, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<SnapshotSection<T>> {
  const startedAt = Date.now();
  try {
    const data = await withTimeout(factory(), timeoutMs);
    return { ok: true, duration_ms: Date.now() - startedAt, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: `${name}: ${message}`,
      timed_out: /timed out/i.test(message),
    };
  }
}

function unwrapSnapshotSection<T>(section: SnapshotSection<T>): T | Record<string, unknown> {
  if (section.ok) {
    return section.data as T;
  }
  return {
    unavailable: true,
    error: section.error,
    timed_out: section.timed_out,
    duration_ms: section.duration_ms,
  };
}

function getBooleanQueryFlag(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  return value === "1" || value === "true" || value === "yes";
}

function notConfiguredGithubResponse(): Response {
  return jsonResponse({
    success: false,
    error: "GitHub settings are not configured. Add repo owner, repo name, and PAT token in Settings > GitHub Runner first.",
  }, 400);
}

function getApiBaseUrl(request: Request): string {
  const url = new URL(request.url);
  return url.origin;
}

function buildAiManifest(request: Request, auth: AuthContext): Record<string, unknown> {
  const baseUrl = getApiBaseUrl(request);
  return {
    name: PROJECT_NAME,
    version: "1.1.0-ai-access",
    purpose: "Developer API for AI-assisted project analysis, automation management, code changes through GitHub, settings updates, and audit review.",
    auth: {
      type: "bearer",
      header: "Authorization: Bearer <api_key>",
      browser_get_url_param: "?ai_token=<api_key> works only for GET /api/ai/* endpoints",
      browser_note: "Use this for ChatGPT/browser monitoring links when custom headers are not available. Mutating POST/PUT/PATCH/DELETE calls still require Authorization headers.",
      current_user_id: auth.userId,
      api_key_id: auth.apiKeyId || null,
      api_key_permissions: auth.apiKeyPermissions || null,
      api_key_scopes: auth.apiKeyScopes || [],
    },
    recommended_flow: [
      "GET /api/ai/manifest",
      "GET /api/ai/project-map",
      "GET /api/ai/files/tree",
      "GET /api/ai/files/read?path=<path>",
      "POST /api/ai/files/patch with full replacement file content on a new branch",
      "POST /api/ai/tests/run",
      "POST /api/ai/git/pr",
    ],
    endpoints: {
      manifest: `${baseUrl}/api/ai/manifest`,
      instructions: `${baseUrl}/api/ai/instructions`,
      openapi: `${baseUrl}/api/ai/openapi.json`,
      project_map: `${baseUrl}/api/ai/project-map`,
      file_tree: `${baseUrl}/api/ai/files/tree`,
      file_read: `${baseUrl}/api/ai/files/read?path=worker/src/index.ts`,
      file_patch: `${baseUrl}/api/ai/files/patch`,
      automations: `${baseUrl}/api/ai/automations`,
      settings: `${baseUrl}/api/ai/settings`,
      git_branch: `${baseUrl}/api/ai/git/branch`,
      git_pr: `${baseUrl}/api/ai/git/pr`,
      tests_run: `${baseUrl}/api/ai/tests/run`,
      audit: `${baseUrl}/api/ai/audit`,
      logs: `${baseUrl}/api/ai/logs`,
      monitor: `${baseUrl}/api/ai/monitor`,
      snapshot: `${baseUrl}/api/ai/snapshot`,
      browser_links: `${baseUrl}/api/ai/browser-links`,
    },
    scopes: AI_DEVELOPER_SCOPES,
    safety: {
      secrets_are_masked_on_read: true,
      query_token_is_get_only: true,
      recommended_code_flow: "branch -> commit -> test -> pull request -> deploy",
      direct_production_changes_should_use_admin_full: true,
    },
  };
}

function buildInstructions(): string {
  return [
    "Automation System AI Developer API instructions:",
    "1. Authenticate with Authorization: Bearer <API_KEY>.",
    "1a. Browser/ChatGPT tools that cannot send headers may use GET links with ?ai_token=<API_KEY>. This works only for read/monitoring GET endpoints.",
    "2. Start with /api/ai/manifest and /api/ai/project-map before editing anything.",
    "3. Use /api/ai/files/tree to discover files and /api/ai/files/read?path=... to inspect relevant files.",
    "4. Use /api/ai/files/patch with complete replacement file content. The endpoint creates or updates files through GitHub commits.",
    "5. Prefer creating a new branch such as ai/fix-short-title instead of editing master/main directly.",
    "6. Run /api/ai/tests/run after code changes when GitHub settings are configured.",
    "7. Create a PR with /api/ai/git/pr after successful checks.",
    "8. Secrets are masked on read. Secret updates are allowed only through settings write endpoints and are logged.",
    "9. Automation and settings changes should be small and auditable.",
    "10. Use /api/ai/audit and /api/ai/logs to review recent actions and errors.",
  ].join("\n");
}

function buildOpenApiSpec(request: Request): Record<string, unknown> {
  const baseUrl = getApiBaseUrl(request);
  return {
    openapi: "3.1.0",
    info: {
      title: "Automation System AI Developer API",
      version: "1.1.0",
      description: "AI-readable API for project inspection, GitHub-backed file changes, automation control, settings updates, and audit logs.",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    paths: {
      "/api/ai/manifest": { get: { summary: "Project manifest and AI workflow" } },
      "/api/ai/instructions": { get: { summary: "Plain text instructions for AI tools" } },
      "/api/ai/project-map": { get: { summary: "Project modules, important files, and capabilities" } },
      "/api/ai/files/tree": { get: { summary: "Repository file tree from GitHub" } },
      "/api/ai/files/read": { get: { summary: "Read a file from GitHub by path" } },
      "/api/ai/files/patch": { post: { summary: "Commit one or more full file replacements to GitHub" } },
      "/api/ai/automations": { get: { summary: "List automations" }, post: { summary: "Create automation" } },
      "/api/ai/automations/{id}": { get: { summary: "Read automation" }, put: { summary: "Update automation" }, delete: { summary: "Delete automation" } },
      "/api/ai/settings": { get: { summary: "Read masked settings" }, patch: { summary: "Update selected settings" } },
      "/api/ai/git/branch": { post: { summary: "Create branch if missing" } },
      "/api/ai/git/pr": { post: { summary: "Create GitHub pull request" } },
      "/api/ai/tests/run": { post: { summary: "Dispatch validation workflow" } },
      "/api/ai/audit": { get: { summary: "AI change audit" } },
      "/api/ai/logs": { get: { summary: "Recent API logs" } },
      "/api/ai/jobs/recent": { get: { summary: "Recent jobs with GitHub run ids and error messages" } },
      "/api/ai/jobs/{id}/diagnostics": { get: { summary: "Single job diagnostics with optional GitHub run/jobs/artifacts metadata" } },
      "/api/ai/monitor": { get: { summary: "One-call monitoring view for browser-based AI tools" } },
      "/api/ai/snapshot": { get: { summary: "Combined project, automation, settings, logs, and GitHub diagnostic bundle" } },
      "/api/ai/browser-links": { get: { summary: "Copyable GET links that work with ChatGPT/browser tools using ai_token query auth" } },
    },
  };
}


function hasDangerousAdminAccess(auth: AuthContext): boolean {
  return Boolean(
    (auth.isAdmin && !auth.apiKeyId) ||
    auth.apiKeyPermissions === "admin" ||
    auth.apiKeyPermissions === "full" ||
    auth.apiKeyScopes?.includes("admin.full")
  );
}

function buildProjectMap(): Record<string, unknown> {
  return {
    project: PROJECT_NAME,
    runtime: {
      backend: "Cloudflare Worker + D1",
      frontend: "Next.js on Vercel",
      automations: "GitHub Actions + local runner scripts",
    },
    key_directories: {
      worker: "Cloudflare Worker backend API, routes, services, D1 schema, migrations",
      frontend: "Next.js UI, settings pages, automation editor pages",
      "runner-scripts": "Video/image processing scripts run by GitHub Actions or runners",
      "local-runner": "Local PC runner and supervisor",
      ".github/workflows": "Deployments and automation workflows",
    },
    important_files: [
      "worker/src/index.ts",
      "worker/src/routes/ai-access.ts",
      "worker/src/routes/api-keys.ts",
      "worker/src/routes/automations.ts",
      "worker/src/routes/settings.ts",
      "worker/src/services/auth.ts",
      "worker/src/services/ai-developer.ts",
      "worker/src/db/schema.sql",
      "frontend/src/app/ai-access/page.tsx",
      "frontend/src/components/layout/Sidebar.tsx",
      "frontend/src/lib/api.ts",
      ".github/workflows/deploy-production.yml",
    ],
    safe_change_policy: {
      preferred: "Commit to a new branch through /api/ai/files/patch, run tests, then create a PR.",
      avoid: "Direct main/master file replacement unless you intentionally enabled broad admin.full access.",
      secret_policy: "Read endpoints mask secrets. Write endpoints can update secrets but every action is logged.",
    },
  };
}

function maskUrlToken(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return "********";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function buildBrowserAccessLinks(request: Request, auth: AuthContext): Record<string, unknown> {
  const baseUrl = getApiBaseUrl(request);
  const tokenPlaceholder = "<API_KEY>";
  const withToken = (endpoint: string) => `${baseUrl}${endpoint}${endpoint.includes("?") ? "&" : "?"}ai_token=${tokenPlaceholder}`;
  return {
    purpose: "Header-free GET links for ChatGPT/browser-based AI monitoring.",
    active_token_preview: maskUrlToken(auth.token || ""),
    important_warning: "Do not share real ai_token links publicly. Query tokens can appear in browser history/logs. Use short expiry keys and rotate/revoke after testing.",
    write_limitation: "Query-token auth is read-only by design. POST/PUT/PATCH/DELETE still need Authorization header or X-Access-Token.",
    links: {
      snapshot: withToken("/api/ai/snapshot"),
      monitor: withToken("/api/ai/monitor"),
      manifest: withToken("/api/ai/manifest"),
      instructions: withToken("/api/ai/instructions"),
      openapi: withToken("/api/ai/openapi.json"),
      project_map: withToken("/api/ai/project-map"),
      automations: withToken("/api/ai/automations"),
      settings_masked: withToken("/api/ai/settings"),
      audit: withToken("/api/ai/audit?limit=50"),
      logs: withToken("/api/ai/logs?limit=100"),
      recent_jobs: withToken("/api/ai/jobs/recent?limit=25"),
      job_diagnostics_example: withToken("/api/ai/jobs/906/diagnostics"),
      read_worker_index: withToken("/api/ai/files/read?path=worker/src/index.ts"),
      read_ai_access_route: withToken("/api/ai/files/read?path=worker/src/routes/ai-access.ts"),
      file_tree: withToken("/api/ai/files/tree"),
    },
    suggested_prompt_for_ai: "Open the snapshot URL first, inspect monitor/automations/logs, then ask for specific file read links when deeper code analysis is needed.",
  };
}

function parseStoredJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getJobFailureStage(row: Record<string, unknown>): string | null {
  const input = parseStoredJsonRecord(row.input_data);
  if (typeof input.failure_stage === "string" && input.failure_stage) {
    return input.failure_stage;
  }
  const logsRaw = row.logs;
  if (typeof logsRaw === "string" && logsRaw.trim()) {
    try {
      const logs = JSON.parse(logsRaw);
      const first = Array.isArray(logs) ? logs[0] : null;
      if (first && typeof first === "object" && typeof (first as { stage?: unknown }).stage === "string") {
        return (first as { stage: string }).stage;
      }
    } catch {}
  }
  if (row.status === "failed" && !row.github_run_id) {
    return "pre_dispatch_or_dispatch";
  }
  return null;
}

function normalizeJobForMonitor(row: Record<string, unknown>): Record<string, unknown> {
  const failureStage = getJobFailureStage(row);
  return {
    ...row,
    failure_stage: failureStage,
    reached_github_actions: Boolean(row.github_run_id || row.github_run_url),
    dispatch_state: row.github_run_id
      ? "github_run_attached"
      : (row.github_run_url && row.status === "running" ? "dispatched_run_id_pending" : (row.status === "failed" ? "not_dispatched_or_preflight_failed" : "no_github_run_yet")),
  };
}

async function getAutomationMonitor(env: Env, userId: number): Promise<Record<string, unknown>> {
  const [automationCounts, recentAutomations, jobCounts, recentJobs, recentFailedJobs, runningJobs, failedWithoutError] = await Promise.all([
    env.DB.prepare("SELECT status, type, COUNT(*) AS count FROM automations WHERE user_id = ? GROUP BY status, type ORDER BY status, type").bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT id, name, type, status, schedule, next_run, last_run, updated_at FROM automations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 25").bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM jobs WHERE user_id = ? GROUP BY status ORDER BY status").bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT j.id, j.automation_id, a.name AS automation_name, j.status, j.error_message, j.github_run_id, j.github_run_url, j.video_url, j.input_data, j.logs, j.created_at, j.started_at, j.completed_at, j.updated_at FROM jobs j LEFT JOIN automations a ON a.id = j.automation_id WHERE j.user_id = ? ORDER BY COALESCE(j.updated_at, j.created_at) DESC LIMIT 25").bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT j.id, j.automation_id, a.name AS automation_name, j.status, j.error_message, j.github_run_id, j.github_run_url, j.input_data, j.logs, j.created_at, j.started_at, j.completed_at, j.updated_at FROM jobs j LEFT JOIN automations a ON a.id = j.automation_id WHERE j.user_id = ? AND j.status = 'failed' ORDER BY COALESCE(j.updated_at, j.created_at) DESC LIMIT 20").bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT j.id, j.automation_id, a.name AS automation_name, j.status, j.github_run_id, j.github_run_url, j.logs, j.started_at, j.created_at, j.updated_at FROM jobs j LEFT JOIN automations a ON a.id = j.automation_id WHERE j.user_id = ? AND j.status IN ('queued','pending','running') ORDER BY COALESCE(j.updated_at, j.created_at) DESC LIMIT 20").bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT id, automation_id, status, github_run_id, github_run_url, created_at, updated_at FROM jobs WHERE user_id = ? AND status = 'failed' AND (error_message IS NULL OR TRIM(error_message) = '') ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 20").bind(userId).all<Record<string, unknown>>(),
  ]);

  const failedWithoutDetails = failedWithoutError.results || [];
  const normalizedRecentJobs = (recentJobs.results || []).map(normalizeJobForMonitor);
  const normalizedFailedJobs = (recentFailedJobs.results || []).map(normalizeJobForMonitor);
  const normalizedRunningJobs = (runningJobs.results || []).map(normalizeJobForMonitor);
  const notDispatchedFailures = normalizedFailedJobs.filter((job) => !job.github_run_id && !job.github_run_url);

  return {
    generated_at: new Date().toISOString(),
    automation_counts: automationCounts.results || [],
    recent_automations: recentAutomations.results || [],
    job_counts: jobCounts.results || [],
    recent_jobs: normalizedRecentJobs,
    recent_failed_jobs: normalizedFailedJobs,
    running_or_queued_jobs: normalizedRunningJobs,
    not_dispatched_failures: notDispatchedFailures,
    failed_without_error_message: failedWithoutDetails,
    warnings: [
      ...(failedWithoutDetails.length > 0
        ? ["Some failed jobs have no error_message. Open job diagnostics; new fixes save preflight/dispatch errors for future jobs."]
        : []),
      ...(notDispatchedFailures.length > 0
        ? ["Some failed jobs never reached GitHub Actions. Check failure_stage/error_message; these are preflight or GitHub dispatch failures, not runner failures."]
        : []),
    ],
  };
}

async function getRecentAiLogs(env: Env, userId: number): Promise<Record<string, unknown>> {
  const [audit, apiLogs] = await Promise.all([
    env.DB.prepare("SELECT id, api_key_id, action, target, status, request_payload, result_payload, created_at FROM ai_change_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT id, api_key_id, endpoint, method, status_code, ip_address, user_agent, duration_ms, error_message, created_at FROM api_audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(userId).all<Record<string, unknown>>(),
  ]);

  return {
    ai_changes: audit.results || [],
    api_requests: apiLogs.results || [],
  };
}



async function fetchSignedGithubTextUrl(location: string, timeoutMs = SNAPSHOT_GITHUB_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(location, {
      headers: {
        Accept: "text/plain, application/octet-stream, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub signed log URL ${response.status}: ${text.slice(0, 600) || response.statusText}`);
    }
    const maxChars = 120000;
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  } finally {
    clearTimeout(timeout);
  }
}

async function githubTextWithTimeout(settings: GithubSettings, endpoint: string, timeoutMs = SNAPSHOT_GITHUB_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.github.com/repos/${settings.repo_owner}/${settings.repo_name}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${settings.pat_token}`,
        Accept: "text/plain, application/vnd.github.v3+json",
        "User-Agent": "AutomationSystem/1.0",
      },
      signal: controller.signal,
      redirect: "manual",
    });

    const location = response.headers.get("Location") || response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      // GitHub's job-log endpoint returns a short-lived signed storage URL.
      // Fetch that URL without the GitHub Authorization header; otherwise
      // Azure/S3-style storage can reject it as malformed auth.
      return fetchSignedGithubTextUrl(location, timeoutMs);
    }

    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        message = parsed.message || text;
      } catch {}
      const missingLocation = response.status >= 300 && response.status < 400 && !location
        ? " Missing redirect Location header."
        : "";
      throw new Error(`GitHub API ${response.status}: ${message || response.statusText}${missingLocation}`);
    }
    const maxChars = 120000;
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  } finally {
    clearTimeout(timeout);
  }
}

function extractAiGithubLogSnippets(logText: string): string[] {
  const lines = logText.split(/\r?\n/);
  const patterns = [/::error/i, /\berror\b/i, /failed/i, /exit code/i, /traceback/i, /exception/i, /yt-dlp/i, /youtube/i, /cookies?/i, /sign in/i, /login/i, /private video/i, /age.?restricted/i, /ffmpeg/i, /playwright/i, /chromium/i, /InnerTube client/i, /attempt \d+\//i];
  const snippets: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!patterns.some((pattern) => pattern.test(lines[i] || ""))) continue;
    const snippet = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join("\n").trim();
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    snippets.push(snippet.length > 2500 ? snippet.slice(0, 2500) + "..." : snippet);
    if (snippets.length >= 10) break;
  }
  return snippets;
}

function analyzeAiGithubLog(logText: string): Record<string, unknown> {
  const lower = logText.toLowerCase();
  const hasCookieOrSigninSignal = /cookies?|sign in|login|not a bot|confirm.*not.*bot|private video|age.?restricted|members-only|bot check/.test(lower);
  const hasDownloadSignal = /yt-dlp|youtube|download|http error 403|http error 429|requested format|unable to extract|video unavailable/.test(lower);
  const hasFfmpegSignal = /ffmpeg|invalid data found|error while decoding|conversion failed|no such file|moov atom/.test(lower);
  const hasBrowserSignal = /playwright|chromium|browser|page\.goto|timeout.*navigation/.test(lower);
  const hasSourceMismatchSignal = /no valid google photos source urls found|google_photos_source_mismatch|requested_video_source|effective_video_source/.test(lower);
  const repeatedDownloadAttempts = (logText.match(/\[DOWNLOAD\].*(attempt|InnerTube client|Downloading)/gi) || []).length;
  const detected = [
    hasSourceMismatchSignal ? "source_type_mismatch" : null,
    hasCookieOrSigninSignal ? "cookie_or_signin_possible" : null,
    hasDownloadSignal ? "video_download_or_ytdlp" : null,
    hasFfmpegSignal ? "ffmpeg_or_video_processing" : null,
    hasBrowserSignal ? "browser_or_playwright" : null,
    repeatedDownloadAttempts >= 4 ? "repeated_download_attempts" : null,
  ].filter(Boolean);
  const snippets = extractAiGithubLogSnippets(logText);
  const summary = hasSourceMismatchSignal
    ? "Logs show a source-type mismatch: a YouTube/direct source was treated as Google Photos. Save the automation again after this fix or retry; the backend now recovers this mismatch automatically."
    : hasCookieOrSigninSignal
      ? "Logs contain cookie/sign-in style signals. Check YouTube cookies/video access first."
      : hasDownloadSignal
      ? "Logs point to video download/yt-dlp stage. Check source URL, cookies, and downloader output."
      : hasFfmpegSignal
        ? "Logs point to FFmpeg/video processing stage. Check downloaded file and segment timings."
        : hasBrowserSignal
          ? "Logs point to browser/Playwright stage. Check Chromium/login/rendering details."
          : snippets.length > 0
            ? "Logs contain error snippets, but no cookie/sign-in keyword was detected."
            : "No clear error keywords found in fetched GitHub logs.";
  return { detected, has_source_type_mismatch_signal: hasSourceMismatchSignal, has_cookie_or_signin_signal: hasCookieOrSigninSignal, has_video_download_signal: hasDownloadSignal, has_ffmpeg_signal: hasFfmpegSignal, has_browser_signal: hasBrowserSignal, repeated_download_attempts: repeatedDownloadAttempts, summary: repeatedDownloadAttempts >= 4 ? `${summary} Multiple downloader attempts were detected; the patched runner now uses yt-dlp-first for YouTube and fail-fast auth/download handling.` : summary, snippets };
}

function chooseGithubJobForLog(jobsPayload: unknown): { id: number; name?: string } | null {
  const jobs = jobsPayload && typeof jobsPayload === "object" && Array.isArray((jobsPayload as { jobs?: unknown }).jobs)
    ? (jobsPayload as { jobs: Array<Record<string, unknown>> }).jobs
    : [];
  const selected = jobs.find((job) => job.conclusion === "failure") || jobs.find((job) => job.status === "in_progress") || jobs[0];
  if (!selected || typeof selected.id !== "number") return null;
  return { id: selected.id, name: typeof selected.name === "string" ? selected.name : undefined };
}

async function githubJsonWithTimeout(settings: GithubSettings, endpoint: string, timeoutMs = SNAPSHOT_GITHUB_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.github.com/repos/${settings.repo_owner}/${settings.repo_name}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${settings.pat_token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "AutomationSystem/1.0",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok) {
      const message = typeof data === "object" && data && "message" in data
        ? String((data as { message?: unknown }).message)
        : text;
      throw new Error(`GitHub API ${response.status}: ${message || response.statusText}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function parseStoredJobOutput(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { raw_output: value };
  }
}

function sanitizeStoredJobText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return value == null ? null : String(value);
  }
  try {
    return JSON.stringify(maskSecretValue(JSON.parse(value)));
  } catch {
    const masked = maskSecretValue(value);
    return typeof masked === "string" ? masked : JSON.stringify(masked);
  }
}

function sanitizeJobRowForAi(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    input_data: sanitizeStoredJobText(row.input_data),
    output_data: sanitizeStoredJobText(row.output_data),
    logs: sanitizeStoredJobText(row.logs),
  };
}

async function getRecentJobs(env: Env, userId: number, limit: number): Promise<Record<string, unknown>> {
  const safeLimit = Math.min(Math.max(limit || 25, 1), 100);
  const rows = await env.DB.prepare(
    "SELECT j.id, j.automation_id, a.name AS automation_name, j.status, j.error_message, j.github_run_id, j.github_run_url, j.video_url, j.input_data, j.logs, j.created_at, j.started_at, j.completed_at, j.updated_at FROM jobs j LEFT JOIN automations a ON a.id = j.automation_id WHERE j.user_id = ? ORDER BY COALESCE(j.updated_at, j.created_at) DESC LIMIT ?"
  ).bind(userId, safeLimit).all<Record<string, unknown>>();
  return {
    generated_at: new Date().toISOString(),
    count: rows.results?.length || 0,
    jobs: (rows.results || []).map((row) => normalizeJobForMonitor(sanitizeJobRowForAi(row))),
  };
}

async function getJobDiagnostics(request: Request, env: Env, auth: AuthContext, jobId: number): Promise<Record<string, unknown>> {
  const url = new URL(request.url);
  const includeGithub = url.searchParams.get("include_github") !== "0";
  const job = await env.DB.prepare(
    "SELECT j.*, a.name AS automation_name, a.type AS automation_type FROM jobs j LEFT JOIN automations a ON a.id = j.automation_id WHERE j.id = ? AND j.user_id = ? LIMIT 1"
  ).bind(jobId, auth.userId).first<Record<string, unknown>>();

  if (!job) {
    return { found: false, error: "Job not found" };
  }

  const outputData = maskSecretValue(parseStoredJobOutput(typeof job.output_data === "string" ? job.output_data : null));
  const inputData = maskSecretValue(parseStoredJobOutput(typeof job.input_data === "string" ? job.input_data : null));
  const logsData = maskSecretValue(parseStoredJobOutput(typeof job.logs === "string" ? job.logs : null));
  const failureStage = getJobFailureStage(job);
  const diagnostics: Record<string, unknown> = {
    found: true,
    generated_at: new Date().toISOString(),
    job: {
      id: job.id,
      automation_id: job.automation_id,
      automation_name: job.automation_name,
      automation_type: job.automation_type,
      status: job.status,
      error_message: job.error_message,
      github_run_id: job.github_run_id,
      github_run_url: job.github_run_url,
      video_url: job.video_url,
      started_at: job.started_at,
      completed_at: job.completed_at,
      created_at: job.created_at,
      updated_at: job.updated_at,
    },
    input_data: inputData,
    output_data: outputData,
    logs: logsData,
    signals: {
      failed_without_error_message: job.status === "failed" && (!job.error_message || String(job.error_message).trim() === ""),
      has_github_run: Boolean(job.github_run_id),
      has_video_url: Boolean(job.video_url),
      failure_stage: failureStage,
      reached_github_actions: Boolean(job.github_run_id || job.github_run_url),
      dispatch_state: job.github_run_id
        ? "github_run_attached"
        : (job.github_run_url && job.status === "running" ? "dispatched_run_id_pending" : (job.status === "failed" ? "not_dispatched_or_preflight_failed" : "no_github_run_yet")),
    },
  };

  if (!includeGithub || !job.github_run_id) {
    diagnostics.github = job.github_run_id ? { skipped: true, reason: "include_github=0" } : { skipped: true, reason: "No GitHub run id" };
    diagnostics.analysis = {
      db_status: job.status,
      failure_stage: failureStage,
      not_reaching_action_runner: job.status === "failed" && !job.github_run_id && !job.github_run_url,
      recommendation: job.status === "failed" && !job.github_run_id && !job.github_run_url
        ? "This failed before GitHub Actions runner started. Check error_message and failure_stage; it is usually prompt/source validation, missing GitHub settings, payload size, PAT permission, or workflow dispatch API failure."
        : "No GitHub run id is attached yet. If github_run_url points to the workflow page and status is running, dispatch succeeded but run-id lookup is still pending.",
    };
    return diagnostics;
  }

  if (!canUseAiScope(auth, "logs.read")) {
    diagnostics.github = { skipped: true, reason: "Missing logs.read scope" };
    return diagnostics;
  }

  const settingsSection = await collectSnapshotSection("github_settings", () => getGithubSettingsForUser(env, auth.userId));
  if (!settingsSection.ok || !settingsSection.data) {
    diagnostics.github = unwrapSnapshotSection(settingsSection);
    return diagnostics;
  }

  const settings = settingsSection.data as GithubSettings;
  const runId = Number(job.github_run_id);
  const [runSection, jobsSection, artifactsSection] = await Promise.all([
    collectSnapshotSection("github_run", () => githubJsonWithTimeout(settings, `/actions/runs/${runId}`), SNAPSHOT_GITHUB_TIMEOUT_MS),
    collectSnapshotSection("github_run_jobs", () => githubJsonWithTimeout(settings, `/actions/runs/${runId}/jobs`), SNAPSHOT_GITHUB_TIMEOUT_MS),
    collectSnapshotSection("github_artifacts", () => githubJsonWithTimeout(settings, `/actions/runs/${runId}/artifacts`), SNAPSHOT_GITHUB_TIMEOUT_MS),
  ]);

  const runData = runSection.ok ? (runSection.data as Record<string, unknown>) : null;
  const githubConclusion = runData && typeof runData.conclusion === "string" ? runData.conclusion : null;
  const githubStatus = runData && typeof runData.status === "string" ? runData.status : null;
  const normalizedGithubStatus = githubStatus === "completed"
    ? (githubConclusion === "success" ? "success" : (githubConclusion === "cancelled" ? "cancelled" : "failed"))
    : (githubStatus === "in_progress" ? "running" : null);

  const jobsPayload = unwrapSnapshotSection(jobsSection);
  const selectedLogJob = jobsSection.ok ? chooseGithubJobForLog(jobsSection.data) : null;
  let githubLogAnalysis: Record<string, unknown> | null = null;
  if (selectedLogJob && url.searchParams.get("include_log_text") !== "0") {
    const logSection = await collectSnapshotSection("github_job_log", () => githubTextWithTimeout(settings, `/actions/jobs/${selectedLogJob.id}/logs`, SNAPSHOT_GITHUB_TIMEOUT_MS), SNAPSHOT_GITHUB_TIMEOUT_MS);
    if (logSection.ok) {
      githubLogAnalysis = {
        ok: true,
        github_job_id: selectedLogJob.id,
        github_job_name: selectedLogJob.name || null,
        analysis: analyzeAiGithubLog(String(logSection.data || "")),
      };
    } else {
      githubLogAnalysis = { ok: false, github_job_id: selectedLogJob.id, github_job_name: selectedLogJob.name || null, error: logSection.error };
    }
  }

  diagnostics.github = {
    run: unwrapSnapshotSection(runSection),
    jobs: jobsPayload,
    artifacts: unwrapSnapshotSection(artifactsSection),
    selected_log_job: selectedLogJob,
    log_analysis: githubLogAnalysis,
  };
  diagnostics.analysis = {
    normalized_github_status: normalizedGithubStatus,
    db_status: job.status,
    status_mismatch: Boolean(normalizedGithubStatus && normalizedGithubStatus !== job.status),
    blank_error_failure: job.status === "failed" && (!job.error_message || String(job.error_message).trim() === ""),
    likely_old_swallowed_workflow_failure: job.status === "failed" && githubConclusion === "success" && (!job.error_message || String(job.error_message).trim() === ""),
    recommendation: job.status === "failed" && githubConclusion === "success" && (!job.error_message || String(job.error_message).trim() === "")
      ? "This looks like an old runner/workflow mismatch. New fixes preserve runner exit codes and store error details; call /api/jobs/:id/status from the UI to reconcile this historical job or retry the automation."
      : "Use run/jobs/artifacts/log_analysis above to inspect the failure source. If log_analysis reports cookie_or_signin_possible, update YouTube cookies or use a source that does not require login.",
  };

  return diagnostics;
}

async function buildAiSnapshot(request: Request, env: Env, auth: AuthContext): Promise<Record<string, unknown>> {
  const url = new URL(request.url);
  const includeGithub = getBooleanQueryFlag(url, "include_github") || getBooleanQueryFlag(url, "include_tree");
  const diagnostics: Record<string, unknown> = {
    mode: "fail-safe",
    timeout_ms: SNAPSHOT_TIMEOUT_MS,
    github_timeout_ms: SNAPSHOT_GITHUB_TIMEOUT_MS,
    note: "Snapshot always returns partial data. Slow DB/GitHub sections are isolated and reported as unavailable instead of hanging the whole endpoint.",
  };

  const snapshot: Record<string, unknown> = {
    success: true,
    partial: false,
    generated_at: new Date().toISOString(),
    access_mode: url.searchParams.has("ai_token") || url.searchParams.has("access_token") || url.searchParams.has("token") ? "query-token-get" : "header-auth",
    token_preview: maskUrlToken(auth.token || ""),
    browser_access: buildBrowserAccessLinks(request, auth),
    manifest: buildAiManifest(request, auth),
    permissions: {
      scopes: auth.apiKeyScopes || [],
      permissions: auth.apiKeyPermissions || null,
      can_read_files: canUseAiScope(auth, "files.read"),
      can_write_files: canUseAiScope(auth, "files.write"),
      can_read_automations: canUseAiScope(auth, "automation.read"),
      can_write_automations: canUseAiScope(auth, "automation.write"),
      can_read_settings: canUseAiScope(auth, "settings.read"),
      can_read_logs: canUseAiScope(auth, "logs.read"),
    },
    diagnostics,
  };

  if (canUseAiScope(auth, "project.read")) {
    snapshot.project_map = buildProjectMap();
  }

  const sections: Record<string, SnapshotSection> = {};

  if (canUseAiScope(auth, "automation.read")) {
    sections.monitor = await collectSnapshotSection("monitor", () => getAutomationMonitor(env, auth.userId));
    snapshot.monitor = unwrapSnapshotSection(sections.monitor);
  } else {
    snapshot.monitor = { skipped: true, reason: "Missing automation.read scope" };
  }

  if (canUseAiScope(auth, "settings.read")) {
    sections.settings = await collectSnapshotSection("settings", () => loadMaskedSettings(env, auth.userId));
    snapshot.settings = unwrapSnapshotSection(sections.settings);
  } else {
    snapshot.settings = { skipped: true, reason: "Missing settings.read scope" };
  }

  if (canUseAiScope(auth, "logs.read")) {
    sections.recent_logs = await collectSnapshotSection("recent_logs", () => getRecentAiLogs(env, auth.userId));
    snapshot.recent_logs = unwrapSnapshotSection(sections.recent_logs);
  } else {
    snapshot.recent_logs = { skipped: true, reason: "Missing logs.read scope" };
  }

  if (canUseAiScope(auth, "files.read")) {
    const githubSettingsSection = await collectSnapshotSection("github_settings", () => getGithubSettingsForUser(env, auth.userId), SNAPSHOT_TIMEOUT_MS);
    sections.github_settings = githubSettingsSection as SnapshotSection;
    const githubSettings = githubSettingsSection.ok ? githubSettingsSection.data : null;

    if (!githubSettingsSection.ok) {
      snapshot.github = unwrapSnapshotSection(githubSettingsSection);
    } else if (githubSettings) {
      snapshot.github = {
        configured: true,
        owner: githubSettings.repo_owner,
        repo: githubSettings.repo_name,
        remote_fetch: includeGithub ? "enabled" : "skipped",
        note: includeGithub ? "Remote GitHub metadata requested." : "Remote GitHub fetch skipped for fast browser snapshots. Add include_github=1 or include_tree=1 when needed.",
      };

      if (includeGithub) {
        const repoSection = await collectSnapshotSection("github_repo", () => getRepositoryInfo(githubSettings), SNAPSHOT_GITHUB_TIMEOUT_MS);
        sections.github_repo = repoSection as SnapshotSection;
        if (repoSection.ok) {
          const repo = repoSection.data;
          snapshot.github = {
            ...(snapshot.github as Record<string, unknown>),
            full_name: repo.full_name || `${githubSettings.repo_owner}/${githubSettings.repo_name}`,
            default_branch: repo.default_branch || "master",
            html_url: repo.html_url || null,
          };
        } else {
          snapshot.github = {
            ...(snapshot.github as Record<string, unknown>),
            ...(unwrapSnapshotSection(repoSection) as Record<string, unknown>),
          };
        }

        if (getBooleanQueryFlag(url, "include_tree")) {
          const treeSection = await collectSnapshotSection("github_file_tree", () => listRepositoryFiles(githubSettings, url.searchParams.get("ref") || undefined), SNAPSHOT_GITHUB_TIMEOUT_MS);
          sections.file_tree = treeSection as SnapshotSection;
          if (treeSection.ok) {
            const tree = treeSection.data as any;
            const files = Array.isArray(tree.files) ? tree.files : [];
            snapshot.file_tree = { ...tree, files: files.slice(0, 500), note: files.length > 500 ? "Showing first 500 files. Use /api/ai/files/tree for full tree." : undefined };
          } else {
            snapshot.file_tree = unwrapSnapshotSection(treeSection);
          }
        }
      }
    } else {
      snapshot.github = { configured: false, message: "GitHub settings are not configured" };
    }
  } else {
    snapshot.github = { skipped: true, reason: "Missing files.read scope" };
  }

  snapshot.section_status = Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, {
    ok: value.ok,
    duration_ms: value.duration_ms,
    timed_out: value.ok ? false : value.timed_out,
    error: value.ok ? undefined : value.error,
  }]));
  snapshot.partial = Object.values(sections).some((section) => !section.ok);

  return snapshot;
}
function jsonTextResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function loadMaskedSettings(env: Env, userId: number): Promise<Record<string, unknown>> {
  const [github, postforme, ai, videoSources] = await Promise.all([
    getScopedSettings<GithubSettings>(env.DB, "github", userId),
    getScopedSettings<any>(env.DB, "postforme", userId),
    getScopedSettings<any>(env.DB, "ai", userId),
    getScopedSettings<any>(env.DB, "video-sources", userId),
  ]);

  return {
    github: maskObjectSecrets(github || {}),
    postforme: maskObjectSecrets(postforme || {}),
    ai: maskObjectSecrets(ai || {}),
    video_sources: maskObjectSecrets(videoSources || {}),
  };
}

function sanitizeSettingsPatch(section: string, values: Record<string, unknown>): Record<string, unknown> {
  const allowed = SAFE_SETTINGS_FIELDS[section];
  if (!allowed) {
    throw new Error(`Unsupported settings section: ${section}`);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key)) {
      sanitized[key] = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
    }
  }

  if (Object.keys(sanitized).length === 0) {
    throw new Error("No supported settings fields were provided");
  }

  return sanitized;
}

function normalizeAiAutomationConfig(config: unknown): string {
  let parsed: Record<string, unknown>;
  if (typeof config === "string") {
    try {
      parsed = JSON.parse(config || "{}");
    } catch {
      return config;
    }
  } else if (config && typeof config === "object" && !Array.isArray(config)) {
    parsed = config as Record<string, unknown>;
  } else {
    parsed = {};
  }

  const next = { ...parsed };
  if (next.short_generation_mode === "prompt") {
    const promptSourceType = typeof next.prompt_source_type === "string" ? next.prompt_source_type : "youtube";
    if (promptSourceType === "youtube" || promptSourceType === "direct") {
      next.video_source = promptSourceType;
      next.google_photos_links = "";
      next.google_photos_album_url = "";
    }
  }

  if (next.video_source === "google_photos") {
    const googleLinks = typeof next.google_photos_links === "string" ? next.google_photos_links.trim() : "";
    const googleAlbum = typeof next.google_photos_album_url === "string" ? next.google_photos_album_url.trim() : "";
    const promptUrl = typeof next.prompt_video_url === "string" ? next.prompt_video_url.trim() : "";
    const videoUrl = typeof next.video_url === "string" ? next.video_url.trim() : "";
    const candidate = promptUrl || videoUrl;
    if (!googleLinks && !googleAlbum && /^https?:\/\//i.test(candidate) && !/photos\.google\.com|photos\.app\.goo\.gl/i.test(candidate)) {
      next.video_source = /youtube\.com|youtu\.be/i.test(candidate) ? "youtube" : "direct";
    }
  }

  return JSON.stringify(next);
}

async function handleAutomationsAiRoutes(request: Request, env: Env, path: string, auth: AuthContext): Promise<Response> {
  const method = request.method;
  const segments = path.split("/").filter(Boolean);
  const id = segments[3] ? parseInt(segments[3], 10) : null;

  if (path === "/api/ai/automations" && method === "GET") {
    const denied = requireAiScope(auth, "automation.read");
    if (denied) return denied;

    const rows = await env.DB.prepare("SELECT * FROM automations WHERE user_id = ? ORDER BY created_at DESC").bind(auth.userId).all<Automation>();
    return jsonResponse({ success: true, data: rows.results || [] });
  }

  if (path === "/api/ai/automations" && method === "POST") {
    const denied = requireAiScope(auth, "automation.write");
    if (denied) return denied;

    const body = await safeRequestJson<Partial<Automation>>(request);
    if (!body || !body.name || !body.type) {
      return jsonResponse({ success: false, error: "name and type are required" }, 400);
    }
    if (!["video", "image"].includes(body.type)) {
      return jsonResponse({ success: false, error: "type must be video or image" }, 400);
    }

    const config = normalizeAiAutomationConfig(body.config || {});
    const result = await env.DB.prepare(
      "INSERT INTO automations (user_id, name, type, status, config, schedule, next_run) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(auth.userId, body.name, body.type, body.status || "active", config, body.schedule || null, body.next_run || null).run();

    const payload = { id: result.meta.last_row_id, name: body.name, type: body.type };
    await logAiChange(env, auth, "automation.create", String(result.meta.last_row_id), "success", body, payload);
    return jsonResponse({ success: true, data: payload, message: "Automation created" }, 201);
  }

  if (id && method === "GET") {
    const denied = requireAiScope(auth, "automation.read");
    if (denied) return denied;

    const automation = await env.DB.prepare("SELECT * FROM automations WHERE id = ? AND user_id = ? LIMIT 1").bind(id, auth.userId).first<Automation>();
    if (!automation) {
      return jsonResponse({ success: false, error: "Automation not found" }, 404);
    }
    return jsonResponse({ success: true, data: automation });
  }

  if (id && method === "PUT") {
    const denied = requireAiScope(auth, "automation.write");
    if (denied) return denied;

    const body = await safeRequestJson<Partial<Automation>>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    const existing = await env.DB.prepare("SELECT * FROM automations WHERE id = ? AND user_id = ? LIMIT 1").bind(id, auth.userId).first<Automation>();
    if (!existing) {
      return jsonResponse({ success: false, error: "Automation not found" }, 404);
    }

    const nextName = body.name || existing.name;
    const nextType = body.type || existing.type;
    const nextStatus = body.status || existing.status;
    const nextConfig = body.config !== undefined ? normalizeAiAutomationConfig(body.config) : existing.config;
    const nextSchedule = body.schedule !== undefined ? body.schedule : existing.schedule;
    const nextRun = body.next_run !== undefined ? body.next_run : existing.next_run;

    await env.DB.prepare(
      "UPDATE automations SET name = ?, type = ?, status = ?, config = ?, schedule = ?, next_run = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
    ).bind(nextName, nextType, nextStatus, nextConfig, nextSchedule, nextRun, id, auth.userId).run();

    await logAiChange(env, auth, "automation.update", String(id), "success", body, { id });
    return jsonResponse({ success: true, data: { id }, message: "Automation updated" });
  }

  if (id && method === "DELETE") {
    const denied = requireAiScope(auth, "automation.write");
    if (denied) return denied;

    await env.DB.prepare("DELETE FROM video_uploads WHERE job_id IN (SELECT id FROM jobs WHERE automation_id = ? AND user_id = ?) AND user_id = ?").bind(id, auth.userId, auth.userId).run();
    await env.DB.prepare("DELETE FROM jobs WHERE automation_id = ? AND user_id = ?").bind(id, auth.userId).run();
    await env.DB.prepare("DELETE FROM processed_videos WHERE automation_id = ? AND user_id = ?").bind(id, auth.userId).run().catch(() => undefined);
    const result = await env.DB.prepare("DELETE FROM automations WHERE id = ? AND user_id = ?").bind(id, auth.userId).run();
    await logAiChange(env, auth, "automation.delete", String(id), result.meta.changes > 0 ? "success" : "not_found", { id }, { deleted: result.meta.changes });
    return jsonResponse({ success: true, data: { deleted: result.meta.changes }, message: "Automation deleted" });
  }

  return jsonResponse({ success: false, error: "AI automation route not found" }, 404);
}

export async function handleAiAccessRoutes(request: Request, env: Env, path: string, auth: AuthContext): Promise<Response> {
  await withTimeout(runApiKeyMigration(env), 1500).catch(() => undefined);
  const method = request.method;
  const url = new URL(request.url);

  if (path === "/api/ai/manifest" && method === "GET") {
    const denied = requireAiScope(auth, "project.read");
    if (denied) return denied;
    return jsonResponse({ success: true, data: buildAiManifest(request, auth) });
  }

  if (path === "/api/ai/instructions" && method === "GET") {
    const denied = requireAiScope(auth, "project.read");
    if (denied) return denied;
    return jsonTextResponse(buildInstructions());
  }

  if (path === "/api/ai/openapi.json" && method === "GET") {
    const denied = requireAiScope(auth, "project.read");
    if (denied) return denied;
    return new Response(JSON.stringify(buildOpenApiSpec(request), null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (path === "/api/ai/browser-links" && method === "GET") {
    const denied = requireAiScope(auth, "project.read");
    if (denied) return denied;
    return jsonResponse({ success: true, data: buildBrowserAccessLinks(request, auth) });
  }

  if (path === "/api/ai/monitor" && method === "GET") {
    const denied = requireAiScope(auth, "automation.read");
    if (denied) return denied;
    const section = await collectSnapshotSection("monitor", () => getAutomationMonitor(env, auth.userId));
    return jsonResponse({
      success: section.ok,
      partial: !section.ok,
      data: unwrapSnapshotSection(section),
    }, section.ok ? 200 : 206);
  }


  if (path === "/api/ai/jobs/recent" && method === "GET") {
    const denied = requireAiScope(auth, "automation.read");
    if (denied) return denied;
    const limit = Number.parseInt(url.searchParams.get("limit") || "25", 10) || 25;
    const section = await collectSnapshotSection("recent_jobs", () => getRecentJobs(env, auth.userId, limit));
    return jsonResponse({
      success: section.ok,
      partial: !section.ok,
      data: unwrapSnapshotSection(section),
    }, section.ok ? 200 : 206);
  }

  if (path.startsWith("/api/ai/jobs/") && path.endsWith("/diagnostics") && method === "GET") {
    const denied = requireAiScope(auth, "automation.read");
    if (denied) return denied;
    const segments = path.split("/").filter(Boolean);
    const jobId = Number.parseInt(segments[3] || "", 10);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return jsonResponse({ success: false, error: "Valid job id is required" }, 400);
    }
    const section = await collectSnapshotSection("job_diagnostics", () => getJobDiagnostics(request, env, auth, jobId), SNAPSHOT_TIMEOUT_MS + SNAPSHOT_GITHUB_TIMEOUT_MS + 1000);
    const data = unwrapSnapshotSection(section);
    const status = section.ok && (data as Record<string, unknown>).found === false ? 404 : (section.ok ? 200 : 206);
    return jsonResponse({ success: section.ok && (data as Record<string, unknown>).found !== false, partial: !section.ok, data }, status);
  }
  if (path === "/api/ai/snapshot" && method === "GET") {
    const denied = requireAiScope(auth, "project.read");
    if (denied) return denied;
    const data = await buildAiSnapshot(request, env, auth);
    return jsonResponse({ success: true, data });
  }
  if (path === "/api/ai/project-map" && method === "GET") {
    const denied = requireAiScope(auth, "project.read");
    if (denied) return denied;

    const settings = await getGithubSettingsForUser(env, auth.userId);
    let github: Record<string, unknown> | null = null;
    if (settings) {
      try {
        const repo = await getRepositoryInfo(settings);
        github = {
          owner: settings.repo_owner,
          repo: settings.repo_name,
          default_branch: repo.default_branch || "master",
          html_url: repo.html_url || null,
          full_name: repo.full_name || `${settings.repo_owner}/${settings.repo_name}`,
        };
      } catch (error) {
        github = { error: error instanceof Error ? error.message : String(error) };
      }
    }

    return jsonResponse({ success: true, data: { ...buildProjectMap(), github } });
  }

  if (path === "/api/ai/files/tree" && method === "GET") {
    const denied = requireAiScope(auth, "files.read");
    if (denied) return denied;

    const settings = await getGithubSettingsForUser(env, auth.userId);
    if (!settings) return notConfiguredGithubResponse();
    const ref = url.searchParams.get("ref") || undefined;
    const tree = await listRepositoryFiles(settings, ref);
    return jsonResponse({ success: true, data: tree });
  }

  if (path === "/api/ai/files/read" && method === "GET") {
    const denied = requireAiScope(auth, "files.read");
    if (denied) return denied;

    const filePath = url.searchParams.get("path") || "";
    if (!filePath) {
      return jsonResponse({ success: false, error: "path query parameter is required" }, 400);
    }
    const settings = await getGithubSettingsForUser(env, auth.userId);
    if (!settings) return notConfiguredGithubResponse();
    const ref = url.searchParams.get("ref") || undefined;
    const file = await readRepositoryFile(settings, filePath, ref);
    return jsonResponse({ success: true, data: { ...file, bytes: textByteLength(file.content) } });
  }

  if (path === "/api/ai/files/patch" && method === "POST") {
    const denied = requireAiScope(auth, "files.write");
    if (denied) return denied;

    const body = await safeRequestJson<FilePatchBody>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    const files = Array.isArray(body.files)
      ? body.files
      : (body.path && body.content !== undefined ? [{ path: body.path, content: body.content }] : []);

    if (!files.length) {
      return jsonResponse({ success: false, error: "Provide files[] or path + content. Content must be full replacement file content." }, 400);
    }

    const settings = await getGithubSettingsForUser(env, auth.userId);
    if (!settings) return notConfiguredGithubResponse();

    const defaultBranch = await getDefaultBranch(settings);
    const branch = body.branch || `ai/changes-${Date.now()}`;
    if (branch === defaultBranch && !auth.apiKeyAllowDirectFileWrite && !hasDangerousAdminAccess(auth)) {
      return jsonResponse({ success: false, error: "Direct default-branch file writes are disabled for this API key. Use a new branch or enable the direct file write flag." }, 403);
    }

    const message = body.message || `AI update ${new Date().toISOString()}`;
    const result = await commitRepositoryFiles(settings, files, { branch, baseBranch: body.base_branch || defaultBranch, message });

    let pullRequest: Record<string, unknown> | null = null;
    if (body.create_pull_request) {
      pullRequest = await createRepositoryPullRequest(settings, {
        title: body.pull_request_title || message,
        head: branch,
        base: body.base_branch || defaultBranch,
        body: body.pull_request_body || "Created by Automation System AI Developer API.",
      });
    }

    const payload = { ...result, pull_request: pullRequest };
    await logAiChange(env, auth, "files.patch", branch, "success", { ...body, files: files.map((file) => ({ path: file.path, bytes: textByteLength(file.content || "") })) }, payload);
    return jsonResponse({ success: true, data: payload, message: "Files committed" });
  }

  if (path.startsWith("/api/ai/automations")) {
    return handleAutomationsAiRoutes(request, env, path, auth);
  }

  if (path === "/api/ai/settings" && method === "GET") {
    const denied = requireAiScope(auth, "settings.read");
    if (denied) return denied;
    const settings = await loadMaskedSettings(env, auth.userId);
    return jsonResponse({ success: true, data: settings });
  }

  if (path === "/api/ai/settings" && method === "PATCH") {
    const denied = requireAiScope(auth, "settings.write");
    if (denied) return denied;

    const body = await safeRequestJson<SettingsPatchBody>(request);
    if (!body?.section || !body.values) {
      return jsonResponse({ success: false, error: "section and values are required" }, 400);
    }

    const section = body.section;
    const table = SETTINGS_TABLE_BY_SECTION[section];
    if (!table) {
      return jsonResponse({ success: false, error: "Unsupported settings section" }, 400);
    }

    const sanitized = sanitizeSettingsPatch(section, body.values);
    await upsertScopedSettings(env.DB, table, auth.userId, sanitized);
    await logAiChange(env, auth, "settings.update", section, "success", { section, values: sanitized }, { updated_fields: Object.keys(sanitized) });
    return jsonResponse({ success: true, data: { section, updated_fields: Object.keys(sanitized) }, message: "Settings updated" });
  }

  if (path === "/api/ai/git/branch" && method === "POST") {
    const denied = requireAiScope(auth, "git.branch.create");
    if (denied) return denied;

    const body = await safeRequestJson<BranchBody>(request);
    const branch = body?.branch?.trim();
    if (!branch) {
      return jsonResponse({ success: false, error: "branch is required" }, 400);
    }
    const settings = await getGithubSettingsForUser(env, auth.userId);
    if (!settings) return notConfiguredGithubResponse();

    const result = await createBranchIfMissing(settings, branch, body?.base_branch);
    await logAiChange(env, auth, "git.branch", branch, "success", body, result);
    return jsonResponse({ success: true, data: result });
  }

  if (path === "/api/ai/git/pr" && method === "POST") {
    const denied = requireAiScope(auth, "git.pull_request.create");
    if (denied) return denied;

    const body = await safeRequestJson<PullRequestBody>(request);
    if (!body?.title || !body.head) {
      return jsonResponse({ success: false, error: "title and head branch are required" }, 400);
    }
    const settings = await getGithubSettingsForUser(env, auth.userId);
    if (!settings) return notConfiguredGithubResponse();

    const result = await createRepositoryPullRequest(settings, {
      title: body.title,
      head: body.head,
      base: body.base,
      body: body.body,
    });
    await logAiChange(env, auth, "git.pr", body.head, "success", body, result);
    return jsonResponse({ success: true, data: result });
  }

  if (path === "/api/ai/tests/run" && method === "POST") {
    const denied = requireAiScope(auth, "deploy.trigger");
    if (denied) return denied;

    const body = await safeRequestJson<WorkflowBody>(request) || {};
    const settings = await getGithubSettingsForUser(env, auth.userId);
    if (!settings) return notConfiguredGithubResponse();

    const workflow = body.workflow || "validate-deployments.yml";
    const result = await dispatchRepositoryWorkflow(settings, workflow, body.ref, body.inputs);
    await logAiChange(env, auth, "tests.run", workflow, "success", body, result);
    return jsonResponse({ success: true, data: result, message: "Workflow dispatched" });
  }

  if (path === "/api/ai/deploy" && method === "POST") {
    const denied = requireAiScope(auth, "deploy.trigger");
    if (denied) return denied;

    const body = await safeRequestJson<WorkflowBody>(request) || {};
    const settings = await getGithubSettingsForUser(env, auth.userId);
    if (!settings) return notConfiguredGithubResponse();

    if (!auth.apiKeyAllowProductionDeploy && !hasDangerousAdminAccess(auth)) {
      return jsonResponse({ success: false, error: "Production deploy trigger is disabled for this API key." }, 403);
    }

    const workflow = body.workflow || "deploy-production.yml";
    const result = await dispatchRepositoryWorkflow(settings, workflow, body.ref, body.inputs);
    await logAiChange(env, auth, "deploy.trigger", workflow, "success", body, result);
    return jsonResponse({ success: true, data: result, message: "Deploy workflow dispatched" });
  }

  if (path === "/api/ai/audit" && method === "GET") {
    const denied = requireAiScope(auth, "logs.read");
    if (denied) return denied;

    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    const rows = await env.DB.prepare(
      "SELECT * FROM ai_change_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(auth.userId, limit).all<Record<string, unknown>>();
    return jsonResponse({ success: true, data: rows.results || [] });
  }

  if (path === "/api/ai/logs" && method === "GET") {
    const denied = requireAiScope(auth, "logs.read");
    if (denied) return denied;

    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 300);
    const rows = await env.DB.prepare(
      "SELECT id, user_id, api_key_id, endpoint, method, status_code, ip_address, user_agent, duration_ms, error_message, created_at FROM api_audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(auth.userId, limit).all<Record<string, unknown>>();
    return jsonResponse({ success: true, data: rows.results || [] });
  }

  return jsonResponse({ success: false, error: "AI Developer API route not found" }, 404);
}
