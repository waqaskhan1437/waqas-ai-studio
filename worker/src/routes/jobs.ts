import { AuthContext, Env, Job, GithubSettings, Automation } from "../types";
import { jsonResponse, githubHeaders, safeRequestJson } from "../utils";
import { getScopedSettings } from "../services/user-settings";
import { triggerAutomationRun, markAutomationRunCompleted } from "../services/automation-scheduler";
import { maskSecretValue } from "../services/ai-developer";


type GithubWorkflowStep = { name: string; status: string; conclusion: string | null; number: number };
type GithubWorkflowJob = { id: number; name: string; status: string; conclusion: string | null; html_url?: string; steps?: GithubWorkflowStep[] };
type GithubRunData = { status: string; conclusion: string | null; html_url: string };
type GithubJobsData = { jobs?: GithubWorkflowJob[] };
type GithubArtifactsData = { artifacts?: Array<{ id?: number; name: string; archive_download_url: string; size_in_bytes: number }> };

const GITHUB_FETCH_TIMEOUT_MS = 12000;
const MAX_GITHUB_LOG_CHARS = 180000;

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function sanitizeStoredJobFieldForApiKey(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  const parsed = safeJsonParse<unknown>(value);
  if (parsed !== null) {
    return JSON.stringify(maskSecretValue(parsed));
  }
  const masked = maskSecretValue(value);
  return typeof masked === "string" ? masked : JSON.stringify(masked);
}

function sanitizeJobForApiKey<T extends Job | null>(job: T): T {
  if (!job) return job;
  return {
    ...job,
    input_data: sanitizeStoredJobFieldForApiKey(job.input_data),
    output_data: sanitizeStoredJobFieldForApiKey(job.output_data),
    logs: sanitizeStoredJobFieldForApiKey(job.logs),
  } as T;
}

async function githubFetchWithTimeout(url: string, init: RequestInit, timeoutMs = GITHUB_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timeout);
  }
}

async function githubJson<T>(settings: GithubSettings, endpoint: string): Promise<T> {
  const response = await githubFetchWithTimeout(
    `https://api.github.com/repos/${settings.repo_owner}/${settings.repo_name}${endpoint}`,
    { headers: githubHeaders(settings.pat_token) }
  );
  const text = await response.text();
  const parsed = safeJsonParse<T>(text);
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String((parsed as { message?: unknown }).message)
      : (text || response.statusText);
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }
  return (parsed ?? (text as unknown as T));
}

async function fetchSignedGithubLogUrl(location: string, timeoutMs = GITHUB_FETCH_TIMEOUT_MS): Promise<string> {
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
    return text.length > MAX_GITHUB_LOG_CHARS ? text.slice(text.length - MAX_GITHUB_LOG_CHARS) : text;
  } finally {
    clearTimeout(timeout);
  }
}

async function githubJobLogText(settings: GithubSettings, githubJobId: number): Promise<string> {
  const response = await githubFetchWithTimeout(
    `https://api.github.com/repos/${settings.repo_owner}/${settings.repo_name}/actions/jobs/${githubJobId}/logs`,
    {
      headers: {
        ...githubHeaders(settings.pat_token),
        Accept: "text/plain, application/vnd.github.v3+json",
      },
      redirect: "manual",
    },
    GITHUB_FETCH_TIMEOUT_MS
  );

  const location = response.headers.get("Location") || response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    // GitHub returns a short-lived signed storage URL for logs. Do not forward the
    // GitHub Bearer token to that URL; Azure/S3-style storage treats it as a
    // malformed storage auth header and returns InvalidAuthenticationInfo.
    return fetchSignedGithubLogUrl(location, GITHUB_FETCH_TIMEOUT_MS);
  }

  const text = await response.text();
  if (!response.ok) {
    const parsed = safeJsonParse<{ message?: string }>(text);
    const missingLocation = response.status >= 300 && response.status < 400 && !location
      ? " Missing redirect Location header."
      : "";
    throw new Error(`GitHub job logs ${response.status}: ${parsed?.message || text || response.statusText}${missingLocation}`);
  }
  return text.length > MAX_GITHUB_LOG_CHARS ? text.slice(text.length - MAX_GITHUB_LOG_CHARS) : text;
}

function extractGithubLogSnippets(logText: string): string[] {
  const lines = logText.split(/\r?\n/);
  const patterns = [
    /::error/i,
    /\berror\b/i,
    /failed/i,
    /exit code/i,
    /traceback/i,
    /exception/i,
    /yt-dlp/i,
    /youtube/i,
    /cookies?/i,
    /sign in/i,
    /login/i,
    /private video/i,
    /age.?restricted/i,
    /ffmpeg/i,
    /playwright/i,
    /chromium/i,
    /innerTube client/i,
    /attempt \d+\//i,
  ];
  const snippets: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length, i + 3);
    const snippet = lines.slice(start, end).join("\n").trim();
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    snippets.push(snippet.length > 2500 ? snippet.slice(0, 2500) + "..." : snippet);
    if (snippets.length >= 10) break;
  }
  return snippets;
}

function analyzeGithubLog(logText: string): Record<string, unknown> {
  const lower = logText.toLowerCase();
  const detected: string[] = [];
  const hasCookieOrSigninSignal = /cookies?|sign in|login|not a bot|confirm.*not.*bot|private video|age.?restricted|members-only|bot check/.test(lower);
  const hasDownloadSignal = /yt-dlp|youtube|download|http error 403|http error 429|requested format|unable to extract|video unavailable/.test(lower);
  const hasFfmpegSignal = /ffmpeg|invalid data found|error while decoding|conversion failed|no such file|moov atom/.test(lower);
  const hasBrowserSignal = /playwright|chromium|browser|page\.goto|timeout.*navigation/.test(lower);
  const repeatedDownloadAttempts = (logText.match(/\[DOWNLOAD\].*(attempt|InnerTube client|Downloading)/gi) || []).length;

  if (hasCookieOrSigninSignal) detected.push("cookie_or_signin_possible");
  if (hasDownloadSignal) detected.push("video_download_or_ytdlp");
  if (hasFfmpegSignal) detected.push("ffmpeg_or_video_processing");
  if (hasBrowserSignal) detected.push("browser_or_playwright");
  if (/postforme|upload|scheduled post|api key/.test(lower)) detected.push("postforme_or_upload");
  if (/gemini|openai|grok|cohere|openrouter|ai provider|api key/.test(lower)) detected.push("ai_provider_or_key");
  if (repeatedDownloadAttempts >= 4) detected.push("repeated_download_attempts");

  const snippets = extractGithubLogSnippets(logText);
  const summary = hasCookieOrSigninSignal
    ? "Logs contain cookie/sign-in style signals. Check YouTube cookies/video access first."
    : hasDownloadSignal
      ? "Logs point to video download/yt-dlp stage. Check source URL, cookies, and downloader output."
      : hasFfmpegSignal
        ? "Logs point to FFmpeg/video processing stage. Check downloaded file and segment timings."
        : hasBrowserSignal
          ? "Logs point to browser/Playwright stage. Check Chromium/login/rendering details."
          : snippets.length > 0
            ? "Logs contain error snippets, but no cookie/sign-in keyword was detected."
            : "No clear error keywords found in the fetched GitHub job log excerpt.";

  return {
    detected,
    has_cookie_or_signin_signal: hasCookieOrSigninSignal,
    has_video_download_signal: hasDownloadSignal,
    has_ffmpeg_signal: hasFfmpegSignal,
    has_browser_signal: hasBrowserSignal,
    repeated_download_attempts: repeatedDownloadAttempts,
    summary: repeatedDownloadAttempts >= 4
      ? `${summary} Multiple downloader attempts were detected; the patched runner now uses yt-dlp-first for YouTube and fail-fast auth/download handling.`
      : summary,
    snippets,
  };
}

function selectMostRelevantGithubJob(jobs: GithubWorkflowJob[]): GithubWorkflowJob | null {
  if (!jobs.length) return null;
  return jobs.find((job) => job.conclusion === "failure") || jobs.find((job) => job.status === "in_progress") || jobs[0];
}

async function buildGithubRunDiagnostics(settings: GithubSettings, runId: number, includeLogText: boolean): Promise<Record<string, unknown>> {
  const [runData, jobsData, artifactsData] = await Promise.all([
    githubJson<GithubRunData>(settings, `/actions/runs/${runId}`),
    githubJson<GithubJobsData>(settings, `/actions/runs/${runId}/jobs`),
    githubJson<GithubArtifactsData>(settings, `/actions/runs/${runId}/artifacts`).catch((error) => ({ artifacts: [], artifact_error: error instanceof Error ? error.message : String(error) } as GithubArtifactsData & { artifact_error?: string })),
  ]);

  const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
  const selectedJob = selectMostRelevantGithubJob(jobs);
  let githubLog: Record<string, unknown> | null = null;

  if (includeLogText && selectedJob?.id) {
    try {
      const text = await githubJobLogText(settings, selectedJob.id);
      githubLog = {
        ok: true,
        github_job_id: selectedJob.id,
        github_job_name: selectedJob.name,
        truncated: text.length >= MAX_GITHUB_LOG_CHARS,
        analysis: analyzeGithubLog(text),
      };
    } catch (error) {
      githubLog = {
        ok: false,
        github_job_id: selectedJob.id,
        github_job_name: selectedJob.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    run: runData,
    jobs,
    selected_job: selectedJob,
    artifacts: Array.isArray(artifactsData.artifacts) ? artifactsData.artifacts : [],
    artifact_error: "artifact_error" in artifactsData ? (artifactsData as { artifact_error?: string }).artifact_error : null,
    github_log: githubLog,
  };
}

export async function handleJobsRoutes(
  request: Request,
  env: Env,
  path: string,
  auth: AuthContext
): Promise<Response> {
  const method = request.method;
  const userId = auth.userId;
  const segments = path.split("/").filter(Boolean);
  const id = segments[2] ? parseInt(segments[2]) : null;
  const action = segments[3];

  // GET /api/jobs - List all
  if (path === "/api/jobs" && method === "GET") {
    const url = new URL(request.url);
    const automationId = url.searchParams.get("automation_id");
    const status = url.searchParams.get("status");
    const limit = parseInt(url.searchParams.get("limit") || "50");

    let query = "SELECT j.*, a.name AS automation_name FROM jobs j LEFT JOIN automations a ON a.id = j.automation_id WHERE j.user_id = ?";
    const params: (string | number)[] = [userId];

    if (automationId) {
      query += " AND automation_id = ?";
      params.push(parseInt(automationId));
    }
    if (status) {
      query += " AND status = ?";
      params.push(status);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const result = await env.DB.prepare(query).bind(...params).all<Job>();
    const jobs = auth.apiKeyId ? (result.results || []).map((job) => sanitizeJobForApiKey(job)) : result.results;
    return jsonResponse({ success: true, data: jobs });
  }

  // GET /api/jobs/stats - Database usage statistics
  if (path === "/api/jobs/stats" && method === "GET") {
    const jobStats = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total_jobs,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_jobs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_jobs,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_jobs,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_jobs,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_jobs,
        SUM(CASE WHEN status NOT IN ('success','failed','running','queued','cancelled') THEN 1 ELSE 0 END) AS other_jobs,
        MIN(created_at) AS oldest_job_date,
        SUM(CASE WHEN status IN ('success','failed','cancelled') AND completed_at IS NOT NULL AND completed_at < datetime('now', '-7 days') THEN 1 ELSE 0 END) AS completed_before_7d,
        SUM(CASE WHEN status IN ('success','failed','cancelled') AND completed_at IS NOT NULL AND completed_at < datetime('now', '-30 days') THEN 1 ELSE 0 END) AS completed_before_30d
      FROM jobs WHERE user_id = ?
    `).bind(userId).first();

    const processedVideosCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM processed_videos WHERE user_id = ?"
    ).bind(userId).first<{count: number}>();

    const videoUploadsCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM video_uploads WHERE user_id = ?"
    ).bind(userId).first<{count: number}>();

    return jsonResponse({
      success: true,
      data: {
        ...jobStats,
        total_processed_videos: processedVideosCount?.count || 0,
        total_video_uploads: videoUploadsCount?.count || 0,
      },
    });
  }

  // Single job routes
  if (id && !action) {
    // GET /api/jobs/:id
    if (method === "GET") {
      const result = await env.DB.prepare("SELECT j.*, a.name AS automation_name FROM jobs j LEFT JOIN automations a ON a.id = j.automation_id WHERE j.id = ? AND j.user_id = ?").bind(id, userId).first<Job>();
      if (!result) {
        return jsonResponse({ success: false, error: "Job not found" }, 404);
      }
      return jsonResponse({ success: true, data: auth.apiKeyId ? sanitizeJobForApiKey(result) : result });
    }
  }

  // POST /api/jobs/:id/retry
  if (id && action === "retry" && method === "POST") {
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();
    if (!job) {
      return jsonResponse({ success: false, error: "Job not found" }, 404);
    }

    if (!job.automation_id) {
      return jsonResponse({ success: false, error: "This job has no automation attached, so it cannot be retried." }, 400);
    }

    const automation = await env.DB.prepare("SELECT * FROM automations WHERE id = ? AND user_id = ? LIMIT 1")
      .bind(job.automation_id, userId)
      .first<Automation>();

    if (!automation) {
      return jsonResponse({ success: false, error: "Automation not found for this job." }, 404);
    }

    const runResult = await triggerAutomationRun(env, automation, userId, { replaceExistingLocalRun: true });

    if (!runResult.success) {
      return jsonResponse({
        success: false,
        error: runResult.error || "Retry failed before dispatch",
        data: {
          original_job_id: id,
          retry_job_id: runResult.jobId || null,
          execution_mode: runResult.executionMode || null,
        },
      }, runResult.inProgress ? 409 : 400);
    }

    await env.DB.prepare(
      "UPDATE jobs SET logs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
    ).bind(JSON.stringify([{ at: new Date().toISOString(), stage: "retry", level: "info", message: `Retried as job ${runResult.jobId}` }]), id, userId).run();

    return jsonResponse({
      success: true,
      message: runResult.executionMode === "github" ? "Retry dispatched to GitHub Actions" : "Retry queued for local runner",
      data: {
        original_job_id: id,
        retry_job_id: runResult.jobId,
        github_run_id: runResult.githubRunId ?? null,
        execution_mode: runResult.executionMode || null,
      },
    });
  }

  // GET /api/jobs/:id/artifacts - Get GitHub Actions artifacts
  if (id && action === "artifacts" && method === "GET") {
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();
    if (!job) {
      return jsonResponse({ success: false, error: "Job not found" }, 404);
    }

    const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
    if (!githubSettings) {
      return jsonResponse({ success: false, error: "GitHub settings not configured" }, 400);
    }

    if (!job.github_run_id) {
      return jsonResponse({ success: false, error: "No GitHub run associated with this job" }, 400);
    }

    try {
      const res = await fetch(
        `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/runs/${job.github_run_id}/artifacts`,
        {
          headers: githubHeaders(githubSettings.pat_token),
        }
      );

      if (res.ok) {
        const data = await res.json() as { artifacts?: Array<{ name: string; archive_download_url: string; size_in_bytes: number }> };
        return jsonResponse({ success: true, data: data.artifacts || [] });
      }
      return jsonResponse({ success: false, error: "Failed to fetch artifacts" });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      return jsonResponse({ success: false, error: errorMsg });
    }
  }

  // GET /api/jobs/:id/logs - Get GitHub Actions run logs
  if (id && action === "logs" && method === "GET") {
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();
    if (!job) {
      return jsonResponse({ success: false, error: "Job not found" }, 404);
    }

    if (!job.github_run_id) {
      const isActuallyGithub = (() => {
        try {
          const inputData = JSON.parse(job.input_data || '{}');
          return inputData.execution_mode === "github";
        } catch { return false; }
      })();

      if (isActuallyGithub) {
        const pendingLabel = job.status === "running" || job.status === "queued"
          ? "GitHub Actions run pending — detecting run ID..."
          : "GitHub Actions run — no run ID synced yet";
        return jsonResponse({
          success: true,
          data: {
            run_id: null,
            run_status: job.status,
            run_conclusion: null,
            run_url: job.github_run_url || null,
            steps: [{ name: pendingLabel, status: "in_progress", conclusion: null, number: 1 }],
            log_url: null,
          },
        });
      }

      const localSteps = (() => {
        if (job.status === "queued") {
          return [
            { name: "Queued on local runner", status: "completed", conclusion: "success", number: 1 },
            { name: "Waiting for runner pickup", status: "in_progress", conclusion: null, number: 2 },
          ];
        }
        if (job.status === "running") {
          return [
            { name: "Queued on local runner", status: "completed", conclusion: "success", number: 1 },
            { name: "Runner picked up job", status: "completed", conclusion: "success", number: 2 },
            { name: "Processing local video", status: "in_progress", conclusion: null, number: 3 },
          ];
        }
        if (job.status === "success") {
          return [
            { name: "Queued on local runner", status: "completed", conclusion: "success", number: 1 },
            { name: "Runner picked up job", status: "completed", conclusion: "success", number: 2 },
            { name: "Processing local video", status: "completed", conclusion: "success", number: 3 },
            { name: "Upload complete", status: "completed", conclusion: "success", number: 4 },
          ];
        }
        if (job.status === "failed") {
          const errorText = job.error_message || "Failed before a GitHub/local runner could attach. Check job diagnostics for failure_stage.";
          return [
            { name: "Job created", status: "completed", conclusion: "success", number: 1 },
            { name: errorText, status: "completed", conclusion: "failure", number: 2 },
          ];
        }
        if (job.status === "cancelled") {
          return [
            { name: "Queued on local runner", status: "completed", conclusion: "success", number: 1 },
            { name: "Superseded by a newer local run", status: "completed", conclusion: "cancelled", number: 2 },
          ];
        }
        return [];
      })();

      return jsonResponse({
        success: true,
        data: {
          run_id: null,
          run_status: job.status,
          run_conclusion: job.status === "success"
            ? "success"
            : (job.status === "failed" ? "failure" : (job.status === "cancelled" ? "cancelled" : null)),
          run_url: null,
          steps: localSteps,
          log_url: null,
        },
      });
    }

    const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
    if (!githubSettings) {
      return jsonResponse({ success: false, error: "GitHub settings not configured" }, 400);
    }

    if (!job.github_run_id) {
      return jsonResponse({ success: false, error: "No GitHub run associated with this job" }, 400);
    }

    try {
      const url = new URL(request.url);
      const includeLogText = url.searchParams.get("include_log_text") !== "0";
      const github = await buildGithubRunDiagnostics(githubSettings, Number(job.github_run_id), includeLogText);
      const runData = github.run as GithubRunData;
      const jobs = Array.isArray(github.jobs) ? github.jobs as GithubWorkflowJob[] : [];
      const selectedJob = github.selected_job as GithubWorkflowJob | null;
      const steps = selectedJob?.steps || jobs[0]?.steps || [];
      const runStatus = runData.status || "unknown";
      const runConclusion = runData.conclusion || null;
      const runUrl = runData.html_url || job.github_run_url || "";

      if (runData.status === "completed") {
        const dbStatus = runData.conclusion === "success" ? "success" : (runData.conclusion === "cancelled" ? "cancelled" : "failed");
        const logAnalysis = github.github_log && typeof github.github_log === "object" && "analysis" in github.github_log
          ? ((github.github_log as { analysis?: { summary?: string } }).analysis?.summary || null)
          : null;
        const failureMessage = dbStatus === "success" ? null : (logAnalysis || "GitHub Actions concluded " + (runData.conclusion || "failure"));
        const canCorrectBlankFailure = job.status === "failed" && dbStatus === "success" && (!job.error_message || !job.error_message.trim());
        if (job.status !== dbStatus && (job.status !== "failed" || canCorrectBlankFailure)) {
          await env.DB.prepare("UPDATE jobs SET status = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
            .bind(dbStatus, failureMessage, id, userId)
            .run();
        }
      } else if (runData.status === "in_progress" && job.status === "queued") {
        await env.DB.prepare("UPDATE jobs SET status = 'running' WHERE id = ? AND user_id = ?").bind(id, userId).run();
      }

      const logUrl = selectedJob?.id
        ? `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/jobs/${selectedJob.id}/logs`
        : null;

      return jsonResponse({
        success: true,
        data: {
          run_id: job.github_run_id,
          run_status: runStatus,
          run_conclusion: runConclusion,
          run_url: runUrl,
          steps,
          log_url: logUrl,
          selected_github_job: selectedJob,
          artifacts: github.artifacts || [],
          github_log: github.github_log,
          diagnostics: {
            source: "github_actions",
            cookie_or_signin_possible: Boolean((github.github_log as { analysis?: { has_cookie_or_signin_signal?: boolean } } | null)?.analysis?.has_cookie_or_signin_signal),
            summary: (github.github_log as { analysis?: { summary?: string } } | null)?.analysis?.summary || null,
          },
        },
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      return jsonResponse({ success: false, error: errorMsg });
    }

  }

  // GET /api/jobs/:id/status - Get real-time job status
  if (id && action === "status" && method === "GET") {
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();
    if (!job) {
      return jsonResponse({ success: false, error: "Job not found" }, 404);
    }

    const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
    if (!githubSettings || !job.github_run_id) {
      return jsonResponse({ success: true, data: { status: job.status, error: job.error_message } });
    }

    try {
      const runRes = await fetch(
        `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/runs/${job.github_run_id}`,
        {
          headers: githubHeaders(githubSettings.pat_token),
        }
      );

      if (runRes.ok) {
        const runData = await runRes.json() as { status: string; conclusion: string | null; html_url: string };
        
        // Update job status in DB based on GitHub run status
        let dbStatus = job.status;
        if (runData.status === "completed") {
          dbStatus = runData.conclusion === "success" ? "success" : (runData.conclusion === "cancelled" ? "cancelled" : "failed");
          await env.DB.prepare(
            "UPDATE jobs SET status = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
          ).bind(dbStatus, dbStatus === "success" ? null : "GitHub Actions concluded " + (runData.conclusion || "failure"), id, userId).run();
        } else if (runData.status === "in_progress") {
          dbStatus = "running";
          await env.DB.prepare("UPDATE jobs SET status = 'running' WHERE id = ? AND user_id = ?").bind(id, userId).run();
        }

        return jsonResponse({
          success: true,
          data: {
            status: dbStatus,
            github_status: runData.status,
            github_conclusion: runData.conclusion,
            run_url: runData.html_url,
            error: job.error_message,
          },
        });
      }
    } catch {}

    return jsonResponse({ success: true, data: { status: job.status, error: job.error_message } });
  }

  // DELETE /api/jobs - Delete all jobs
  if (path === "/api/jobs" && method === "DELETE") {
    await env.DB.prepare("DELETE FROM processed_videos WHERE user_id = ?").bind(userId).run();
    await env.DB.prepare("DELETE FROM video_uploads WHERE user_id = ?").bind(userId).run();
    await env.DB.prepare("DELETE FROM jobs WHERE user_id = ?").bind(userId).run();
    return jsonResponse({ success: true, message: "All jobs deleted" });
  }

  // DELETE /api/jobs/completed - Delete all completed/failed/cancelled jobs
  if (path === "/api/jobs/completed" && method === "DELETE") {
    const completedRows = await env.DB.prepare(
      "SELECT id FROM jobs WHERE user_id = ? AND status IN ('success', 'failed', 'cancelled')"
    ).bind(userId).all<{id: number}>();
    const ids = (completedRows.results || []).map(r => r.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM processed_videos WHERE job_id IN (${placeholders}) AND user_id = ?`).bind(...ids, userId).run();
      await env.DB.prepare(`DELETE FROM video_uploads WHERE job_id IN (${placeholders}) AND user_id = ?`).bind(...ids, userId).run();
      await env.DB.prepare(`DELETE FROM jobs WHERE id IN (${placeholders}) AND user_id = ?`).bind(...ids, userId).run();
    }
    return jsonResponse({ success: true, message: `${ids.length} completed job(s) deleted`, data: { deleted: ids.length } });
  }

  // DELETE /api/jobs/old - Delete jobs completed before a date (ISO date string)
  if (path === "/api/jobs/old" && method === "DELETE") {
    const url = new URL(request.url);
    const before = url.searchParams.get("before");
    if (!before) {
      return jsonResponse({ success: false, error: "Query parameter 'before' (ISO date, e.g. 2026-01-01) is required" }, 400);
    }
    const oldRows = await env.DB.prepare(
      "SELECT id FROM jobs WHERE user_id = ? AND completed_at IS NOT NULL AND completed_at < ?"
    ).bind(userId, before).all<{id: number}>();
    const ids = (oldRows.results || []).map(r => r.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM processed_videos WHERE job_id IN (${placeholders}) AND user_id = ?`).bind(...ids, userId).run();
      await env.DB.prepare(`DELETE FROM video_uploads WHERE job_id IN (${placeholders}) AND user_id = ?`).bind(...ids, userId).run();
      await env.DB.prepare(`DELETE FROM jobs WHERE id IN (${placeholders}) AND user_id = ?`).bind(...ids, userId).run();
    }
    return jsonResponse({ success: true, message: `${ids.length} old job(s) deleted`, data: { deleted: ids.length } });
  }

  // DELETE /api/jobs/:id - Delete single job
  if (id && !action && method === "DELETE") {
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();
    if (!job) {
      return jsonResponse({ success: false, error: "Job not found" }, 404);
    }
    await env.DB.prepare("DELETE FROM processed_videos WHERE job_id = ? AND user_id = ?").bind(id, userId).run();
    await env.DB.prepare("DELETE FROM video_uploads WHERE job_id = ? AND user_id = ?").bind(id, userId).run();
    await env.DB.prepare("DELETE FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return jsonResponse({ success: true, message: "Job deleted" });
  }

  // POST /api/jobs/:id/cancel - Cancel a running job (cancel GitHub workflow)
  if (id && action === "cancel" && method === "POST") {
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();
    if (!job) {
      return jsonResponse({ success: false, error: "Job not found" }, 404);
    }
    
    // If job has a GitHub run ID, cancel it
    if (job.github_run_id) {
      const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
      if (githubSettings) {
        try {
          const cancelResponse = await fetch(
            `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/runs/${job.github_run_id}/cancel`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${githubSettings.pat_token}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "waqas-ai-studio",
              },
            }
          );
          
          if (cancelResponse.ok || cancelResponse.status === 409) {
            // Update job status
            await env.DB.prepare(
              "UPDATE jobs SET status = 'cancelled', error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
            ).bind("Cancelled by user", id, userId).run();
            
            return jsonResponse({ success: true, message: "Job cancelled successfully" });
          } else {
            const errorText = await cancelResponse.text();
            return jsonResponse({ success: false, error: `GitHub cancel failed: ${errorText}` }, 500);
          }
        } catch (err) {
          return jsonResponse({ success: false, error: `Cancel error: ${err instanceof Error ? err.message : "Unknown"}` }, 500);
        }
      }
    }
    
    // If no GitHub run, just mark as cancelled
    await env.DB.prepare(
      "UPDATE jobs SET status = 'cancelled', error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
    ).bind("Cancelled by user", id, userId).run();
    
    return jsonResponse({ success: true, message: "Job marked as cancelled" });
  }

  // POST /api/jobs/:id/force-continue - Force-fail a stuck job to unblock the queue
  if (id && action === "force-continue" && method === "POST") {
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first<Job>();
    if (!job) {
      return jsonResponse({ success: false, error: "Job not found" }, 404);
    }

    if (job.status !== "running" && job.status !== "queued") {
      return jsonResponse({ success: false, error: `Job is "${job.status}", not stuck. Only running/queued jobs can be force-continued.` }, 400);
    }

    await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
    ).bind("Force-continued by user", id, userId).run();

    await markAutomationRunCompleted(env, id, new Date());

    return jsonResponse({ success: true, message: "Job force-continued. Next automation run can now proceed." });
  }

  return jsonResponse({ success: false, error: "Job route not found" }, 404);
}
