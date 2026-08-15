/**
 * ============================================================================
 * AUTOMATION SYSTEM - Cloudflare Worker API
 * ============================================================================
 * Project: waqas-ai-studio
 * GitHub: https://github.com/waqaskhan1437/waqas-ai-studio
 * Cloudflare Worker: waqas-ai-studio
 * URL: https://waqas-ai-studio.waqaskhan1437.workers.dev
 * 
 * This worker provides the backend API for:
 * - Automation management (CRUD)
 * - Job scheduling and execution
 * - Video upload handling
 * - Settings management
 * - GitHub Actions integration
 * 
 * Deploy command: cd worker && npm run deploy
 * ============================================================================
 */

import { Env, GithubSettings, Job, PostformeSettings, AuthContext, VideoSourceSettings } from "./types";
import { jsonResponse, githubHeaders, safeRequestJson } from "./utils";
import { unzipSync } from "fflate";
import { decompress } from "zstd-wasm-decoder/cloudflare";
import { handleSettingsRoutes } from "./routes/settings";
import { handleAutomationsRoutes } from "./routes/automations";
import { handleJobsRoutes } from "./routes/jobs";
import { handleUploadsRoutes } from "./routes/uploads";
import { handleRunnerRoutes } from "./routes/runner";
import { handleApiKeysRoutes } from "./routes/api-keys";
import { handleAiAccessRoutes } from "./routes/ai-access";
import { handleWebhookRoutes } from "./routes/webhooks";
import { handleYoutubeExtractRoutes } from "./routes/youtube-extract";
import { handleOAuthRoutes } from "./routes/oauth";
import { formatDatabaseDate, markAutomationRunCompleted, processDueAutomations, processPendingUploads, syncStaleRunningJobs } from "./services/automation-scheduler";
import { getAdminEmail, getAdminPassword, getAuthContext, issueAdminAccessToken, requireAuth, logApiRequest, findUserByAccessToken } from "./services/auth";
import { verifyWorkflowRuntimeConfigToken } from "./services/github";
import { syncScheduledUploads } from "./services/postforme-sync";
import { getScopedSettings } from "./services/user-settings";
import { AISettings } from "./types";
import { generateAiJson, getSocialMessages, normalizeSocialResult, getProviderApiKey, SupportedAIProvider } from "./services/ai";

function buildVideoHeaders(sourceHeaders?: Headers): Headers {
  const headers = new Headers();
  const contentType = sourceHeaders?.get("content-type");
  headers.set("Content-Type", contentType && contentType !== "application/octet-stream" ? contentType : "video/mp4");
  headers.set("Accept-Ranges", sourceHeaders?.get("accept-ranges") || "bytes");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", sourceHeaders?.get("cache-control") || "public, max-age=86400");

  const contentLength = sourceHeaders?.get("content-length");
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  const contentRange = sourceHeaders?.get("content-range");
  if (contentRange) {
    headers.set("Content-Range", contentRange);
  }

  const etag = sourceHeaders?.get("etag");
  if (etag) {
    headers.set("ETag", etag);
  }

  const lastModified = sourceHeaders?.get("last-modified");
  if (lastModified) {
    headers.set("Last-Modified", lastModified);
  }

  return headers;
}

function buildVideoResponse(request: Request, fileBytes: Uint8Array): Response {
  const rangeHeader = request.headers.get("range");
  const total = fileBytes.byteLength;

  if (!rangeHeader) {
    const headers = buildVideoHeaders();
    headers.set("Content-Length", String(total));
    return new Response(request.method === "HEAD" ? null : fileBytes, {
      status: 200,
      headers,
    });
  }

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    const headers = buildVideoHeaders();
    headers.set("Content-Length", String(total));
    return new Response(request.method === "HEAD" ? null : fileBytes, {
      status: 200,
      headers,
    });
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : total - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || end < start) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${total}`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const chunk = fileBytes.slice(start, Math.min(end + 1, total));
  const headers = buildVideoHeaders();
  headers.set("Content-Length", String(chunk.byteLength));
  headers.set("Content-Range", `bytes ${start}-${start + chunk.byteLength - 1}/${total}`);
  return new Response(request.method === "HEAD" ? null : chunk, {
    status: 206,
    headers,
  });
}

function isSameOutputUrl(requestUrl: string, candidateUrl: string, jobId: number): boolean {
  try {
    const request = new URL(requestUrl);
    const candidate = new URL(candidateUrl);
    return request.origin === candidate.origin && candidate.pathname === `/api/output/${jobId}`;
  } catch {
    return false;
  }
}

function extractStoredPostMetadata(record: Record<string, unknown> | null | undefined): string | null {
  if (!record) {
    return null;
  }

  if (typeof record.post_metadata === "string" && record.post_metadata.trim()) {
    return record.post_metadata;
  }

  if (record.post_metadata && typeof record.post_metadata === "object") {
    return JSON.stringify(record.post_metadata);
  }

  return null;
}

function parseStoredPostMetadataObject(rawMetadata: string | null | undefined): Record<string, unknown> | null {
  if (!rawMetadata) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function cleanDerivedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function pickEarliestScheduledAt(values: Array<string | null | undefined>): string | null {
  const parsed = values
    .map((value) => cleanDerivedString(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);

  return parsed[0]?.value || null;
}

function extractScheduledAtFromMetadata(rawMetadata: string | null | undefined): string | null {
  const metadata = parseStoredPostMetadataObject(rawMetadata);
  if (!metadata) {
    return null;
  }

  const directScheduledAt = cleanDerivedString(metadata.scheduled_at) || cleanDerivedString(metadata.scheduledAt);
  if (directScheduledAt) {
    return directScheduledAt;
  }

  const scheduledAccounts = Array.isArray(metadata.scheduled_accounts)
    ? metadata.scheduled_accounts
    : [];

  return pickEarliestScheduledAt(
    scheduledAccounts.map((account) => {
      if (!account || typeof account !== "object" || Array.isArray(account)) {
        return null;
      }

      const record = account as Record<string, unknown>;
      return cleanDerivedString(record.scheduled_at) || cleanDerivedString(record.scheduledAt);
    })
  );
}

function normalizeDerivedPostStatus(value: unknown): "pending" | "scheduled" | "posted" | null {
  const normalized = cleanDerivedString(value)?.toLowerCase();
  if (normalized === "pending" || normalized === "scheduled" || normalized === "posted") {
    return normalized;
  }
  return null;
}

function deriveUploadPostState(
  uploadRecord: Record<string, unknown>,
  mergedOutputData: Record<string, unknown> | null,
  storedPostMetadata: string | null,
  livePostId: string | null,
  draftPostId: string | null
): { postStatus: "pending" | "scheduled" | "posted"; scheduledAt: string | null } {
  const scheduledAt = pickEarliestScheduledAt([
    cleanDerivedString(uploadRecord.scheduled_at) || cleanDerivedString(uploadRecord.scheduledAt),
    cleanDerivedString(mergedOutputData?.scheduled_at) || cleanDerivedString(mergedOutputData?.scheduledAt),
    extractScheduledAtFromMetadata(storedPostMetadata),
  ]);

  const explicitStatus = normalizeDerivedPostStatus(uploadRecord.post_status)
    || normalizeDerivedPostStatus(mergedOutputData?.post_status);

  if (explicitStatus) {
    return {
      postStatus: explicitStatus === "scheduled" && !scheduledAt ? "posted" : explicitStatus,
      scheduledAt,
    };
  }

  if (scheduledAt) {
    return {
      postStatus: "scheduled",
      scheduledAt,
    };
  }

  if (livePostId || draftPostId) {
    return {
      postStatus: "posted",
      scheduledAt: null,
    };
  }

  return {
    postStatus: "pending",
    scheduledAt: null,
  };
}

type GithubContentFile = {
  download_url?: string;
};

function getPreferredArtifactVideoFileName(extracted: Record<string, Uint8Array>): string | null {
  const names = Object.keys(extracted);
  const normalized = names.map((name) => ({ name, lower: name.toLowerCase() }));

  const preferred =
    normalized.find((entry) => entry.lower.endsWith("/processed-video.mp4")) ||
    normalized.find((entry) => entry.lower === "processed-video.mp4") ||
    normalized.find((entry) => entry.lower.includes("processed-video.mp4")) ||
    normalized.find((entry) => entry.lower.endsWith(".mp4"));

  return preferred?.name || null;
}

async function fetchRepoVideoResponse(request: Request, githubSettings: GithubSettings, jobId: number): Promise<Response | null> {
  const fileName = `video-job-${jobId}.mp4`;
  const apiUrl = `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/contents/${fileName}`;
  const metadataRes = await fetch(apiUrl, {
    headers: githubHeaders(githubSettings.pat_token),
  });

  if (!metadataRes.ok) {
    return null;
  }

  const metadata = await metadataRes.json() as GithubContentFile;
  if (!metadata.download_url) {
    return null;
  }

  const upstreamHeaders: Record<string, string> = {
    "User-Agent": "AutomationSystem/1.0",
  };
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    upstreamHeaders.Range = rangeHeader;
  }

  const upstreamRes = await fetch(metadata.download_url, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: upstreamHeaders,
  });

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return null;
  }

  const headers = buildVideoHeaders(upstreamRes.headers);
  return new Response(request.method === "HEAD" ? null : upstreamRes.body, {
    status: upstreamRes.status,
    headers,
  });
}

async function fetchArtifactVideoBytes(githubSettings: GithubSettings, job: Job): Promise<Uint8Array | null> {
  if (!job.github_run_id) {
    console.log("No github_run_id for job");
    return null;
  }

  console.log("Fetching artifact for run:", job.github_run_id);
  console.log("Repo:", githubSettings.repo_owner, githubSettings.repo_name);

  const artRes = await fetch(
    `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/runs/${job.github_run_id}/artifacts`,
    { headers: githubHeaders(githubSettings.pat_token) }
  );

  console.log("Artifact API response:", artRes.status);
  
  if (!artRes.ok) {
    const errorText = await artRes.text();
    console.log("Artifact API error:", errorText);
    return null;
  }

  const artData = await artRes.json() as {
    artifacts?: Array<{ id: number; archive_download_url: string; name: string; size_in_bytes: number; created_at: string }>;
    total_count?: number;
  };
  console.log("Total artifacts:", artData.total_count);
  console.log("Artifacts found:", artData.artifacts?.length || 0);
  
  const artifact = artData.artifacts?.[0];
  if (!artifact) {
    console.log("No artifact found in response");
    return null;
  }
  
  console.log("Artifact:", artifact.name, artifact.size_in_bytes, "bytes");
  
  // Use GitHub's artifact download API instead of the pre-signed URL
  console.log("Downloading artifact using GitHub API...");
  
  const downloadRes = await fetch(
    `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: {
        ...githubHeaders(githubSettings.pat_token),
        "Accept": "application/vnd.github+json",
      },
      redirect: "manual", // Handle redirect manually
    }
  );

  console.log("Download response status:", downloadRes.status);
  
  // Handle redirect
  const location = downloadRes.headers.get("location");
  if (location && (downloadRes.status === 302 || downloadRes.status === 301)) {
    console.log("Following redirect to artifact storage:", location.substring(0, 100));
    
    // The redirect URL already contains the authentication token
    // Just follow it without adding extra headers
    const redirectRes = await fetch(location, {
      redirect: "follow",
    });
    
    console.log("Redirect fetch status:", redirectRes.status);
    
    if (!redirectRes.ok) {
      console.log("Redirect fetch failed:", redirectRes.status);
      return null;
    }
    
    const zipBytes = new Uint8Array(await redirectRes.arrayBuffer());
    console.log("Downloaded size:", zipBytes.length, "bytes");
    
    if (zipBytes.length < 100) {
      console.log("Downloaded file too small");
      return null;
    }
    
    // Check if it's a ZIP file
    const header = zipBytes[0] === 0x50 && zipBytes[1] === 0x4B;
    console.log("Is ZIP file:", header);
    
    if (header) {
      const extracted = unzipSync(zipBytes);
      console.log("Extracted files:", Object.keys(extracted).join(", "));
      const fileName = getPreferredArtifactVideoFileName(extracted);
      console.log("Found mp4 file:", fileName);
      return fileName ? extracted[fileName] : null;
    }
    
    // Check if it's ZSTD
    const isZstd = zipBytes[0] === 0x28 && zipBytes[1] === 0xb5 && zipBytes[2] === 0x2f && zipBytes[3] === 0xfd;
    console.log("Is ZSTD file:", isZstd);
    
    if (isZstd) {
      try {
        const decompressed = await decompress(zipBytes);
        const dataToExtract = new Uint8Array(decompressed);
        console.log("Decompressed size:", dataToExtract.length, "bytes");
        const extracted = unzipSync(dataToExtract);
        const fileName = getPreferredArtifactVideoFileName(extracted);
        return fileName ? extracted[fileName] : null;
      } catch (err) {
        console.log("ZSTD decompression failed:", err instanceof Error ? err.message : String(err));
        return null;
      }
    }
    
    return null;
  }
  
  // Direct download (no redirect)
  if (downloadRes.ok) {
    const zipBytes = new Uint8Array(await downloadRes.arrayBuffer());
    console.log("Direct download size:", zipBytes.length, "bytes");
    
    if (zipBytes.length > 100) {
      const header = zipBytes[0] === 0x50 && zipBytes[1] === 0x4B;
      if (header) {
        const extracted = unzipSync(zipBytes);
        const fileName = getPreferredArtifactVideoFileName(extracted);
        return fileName ? extracted[fileName] : null;
      }
    }
  }
  
  console.log("Could not download artifact");
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const startTime = Date.now();
    
    // Get auth context early for audit logging
    let auth: AuthContext | null = null;
    try {
      auth = await getAuthContext(request, env);
    } catch (err) {
      console.error("Auth context error:", err instanceof Error ? err.message : String(err));
    }
    
    // Extract IP and User-Agent for audit logging
    const ipAddress = request.headers.get("CF-Connecting-IP") || 
                     request.headers.get("X-Forwarded-For") || 
                     request.headers.get("X-Real-IP") || 
                     "unknown";
    const userAgent = request.headers.get("User-Agent") || "unknown";
    
    // Calculate request size
    let requestSize = 0;
    try {
      requestSize = Number(request.headers.get("Content-Length")) || 0;
    } catch {
      requestSize = 0;
    }

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key, X-Access-Token",
        },
      });
    }

     if (path === "/" || path === "/api") {
       const response = jsonResponse({
         success: true,
         data: { name: "Automation API", version: "1.0.0" },
       });
       
       const durationMs = Date.now() - startTime;
       let responseSize = 0;
       try {
         const body = await response.clone().text();
         responseSize = body.length;
       } catch {
         responseSize = 0;
       }
       
       await logApiRequest(
         env,
         auth?.userId || null,
         auth?.apiKeyId || null,
         path,
         method,
         200,
         ipAddress,
         userAgent,
         requestSize,
         responseSize,
         durationMs,
         null
       );
       
       return response;
     }

     // OAuth callback routes (public, called by platforms after authorization)
     if (path === "/api/oauth/facebook/callback" && method === "GET") {
       return handleOAuthRoutes(request, env, path, null);
     }

     if (path === "/api/auth/token" && method === "POST") {
       if (!auth) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Invalid token"
         );
         return jsonResponse({ success: false, error: "Invalid token" }, 401);
       }

       const response = jsonResponse({
         success: true,
         data: {
           user: {
             id: auth.user.id,
             name: auth.user.name,
             email: auth.user.email,
             status: auth.user.status,
             role: auth.user.role || "user",
             is_admin: auth.isAdmin,
           },
         },
         message: "Token verified",
       });
       
       const durationMs = Date.now() - startTime;
       let responseSize = 0;
       try {
         const body = await response.clone().text();
         responseSize = body.length;
       } catch {
         responseSize = 0;
       }
       
       await logApiRequest(
         env,
         auth.userId,
         auth.apiKeyId,
         path,
         method,
         200,
         ipAddress,
         userAgent,
         requestSize,
         responseSize,
         durationMs,
         null
       );
       
       return response;
     }

      if (path === "/api/auth/admin-login" && method === "POST") {
        const body = await safeRequestJson<{ email?: string; password?: string }>(request);
        if (!body) {
          return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
        }
        const email = (body.email || "").trim().toLowerCase();
        const password = body.password || "";

        if (!email || !password) {
          const durationMs = Date.now() - startTime;
          await logApiRequest(
            env,
            null,
            null,
            path,
            method,
            400,
            ipAddress,
            userAgent,
            requestSize,
            0,
            durationMs,
            "Email and password are required"
          );
          return jsonResponse({ success: false, error: "Email and password are required" }, 400);
        }

        const expectedEmail = getAdminEmail(env).toLowerCase();
        const expectedPassword = getAdminPassword(env);
        
        // If no secrets configured, use fallback for testing
        const useFallback = !expectedEmail || !expectedPassword;
        
        const emailValid = useFallback ? (email === "admin@test.com") : (email === expectedEmail);
        const passwordValid = useFallback ? (password === "test123") : (password === expectedPassword);

        if (!emailValid || !passwordValid) {
          const durationMs = Date.now() - startTime;
          await logApiRequest(
            env,
            null,
            null,
            path,
            method,
            401,
            ipAddress,
            userAgent,
            requestSize,
            0,
            durationMs,
            "Invalid admin credentials"
          );
          return jsonResponse({ success: false, error: "Invalid admin credentials" }, 401);
        }

        const { user, accessToken } = await issueAdminAccessToken(env);
        const response = jsonResponse({
         success: true,
         data: {
           access_token: accessToken,
           user: {
             id: user.id,
             name: user.name,
             email: user.email,
             status: user.status,
             role: "admin",
             is_admin: true,
           },
         },
         message: "Admin login successful",
       });
       
       const durationMs = Date.now() - startTime;
       let responseSize = 0;
       try {
         const bodyText = await response.clone().text();
         responseSize = bodyText.length;
       } catch {
         responseSize = 0;
       }
       
       await logApiRequest(
         env,
         user.id,
         null, // Admin token doesn't have an API key ID in our current setup
         path,
         method,
         200,
         ipAddress,
         userAgent,
         requestSize,
         responseSize,
         durationMs,
         null
       );
       
       return response;
     }

     if (path === "/api/me" && method === "GET") {
       if (!auth) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Unauthorized"
         );
         return jsonResponse({ success: false, error: "Unauthorized" }, 401);
       }

       const response = jsonResponse({
         success: true,
         data: {
           id: auth.user.id,
           name: auth.user.name,
           email: auth.user.email,
           status: auth.user.status,
           role: auth.user.role || "user",
           is_admin: auth.isAdmin,
         },
       });
       
       const durationMs = Date.now() - startTime;
       let responseSize = 0;
       try {
         const bodyText = await response.clone().text();
         responseSize = bodyText.length;
       } catch {
         responseSize = 0;
       }
       
       await logApiRequest(
         env,
         auth.userId,
         auth.apiKeyId,
         path,
         method,
         200,
         ipAddress,
         userAgent,
         requestSize,
         responseSize,
         durationMs,
         null
       );
       
       return response;
     }

    if (path === "/api/github/runtime-config" && method === "GET") {
      const url = new URL(request.url);
      const jobId = Number.parseInt(url.searchParams.get("job_id") || "", 10);
      const token = String(url.searchParams.get("token") || "").trim();

      if (!Number.isFinite(jobId) || jobId <= 0 || !token) {
        return jsonResponse({ success: false, error: "job_id and token are required" }, 400);
      }

      const job = await env.DB.prepare(
        "SELECT id, user_id, input_data FROM jobs WHERE id = ? LIMIT 1"
      ).bind(jobId).first<{ id: number; user_id: number; input_data: string | null }>();

      if (!job?.id || !job.user_id) {
        return jsonResponse({ success: false, error: "Job not found" }, 404);
      }

      const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", job.user_id);
      if (!githubSettings?.pat_token) {
        return jsonResponse({ success: false, error: "GitHub settings not configured for job" }, 404);
      }

      const isValidToken = await verifyWorkflowRuntimeConfigToken(job.id, token, githubSettings.pat_token);
      if (!isValidToken) {
        return jsonResponse({ success: false, error: "Invalid or expired runtime config token" }, 403);
      }

      let automationConfig: Record<string, unknown> = {};
      try {
        automationConfig = job.input_data ? JSON.parse(job.input_data) as Record<string, unknown> : {};
      } catch {
        return jsonResponse({ success: false, error: "Job config is unreadable" }, 500);
      }

      const postformeSettings = await getScopedSettings<PostformeSettings>(env.DB, "postforme", job.user_id);
      if (postformeSettings?.api_key && !("postforme_api_key" in automationConfig)) {
        automationConfig.postforme_api_key = postformeSettings.api_key;
      }

      // ── Live cookie override (CORE FIX) ──────────────────────────────────
      // Cookies are frozen into jobs.input_data at dispatch time. By the time the
      // runner picks up the job (often 30-60 min later, mid-way through a large
      // video), those cookies may be stale and YouTube rejects them. Inject the
      // LATEST cookies from settings_video_sources here so every run uses the
      // freshest session. The frozen value survives only as a fallback when the
      // live store has been cleared.
      const videoSourceSettings = await getScopedSettings<VideoSourceSettings>(env.DB, "video-sources", job.user_id);
      const liveYoutube = (videoSourceSettings?.youtube_cookies || "").trim();
      const liveGooglePhotos = (videoSourceSettings?.google_photos_cookies || "").trim();
      if (liveYoutube) {
        automationConfig.youtube_cookies = liveYoutube;
        automationConfig.youtube_cookies_meta = videoSourceSettings?.youtube_cookies_meta ?? automationConfig.youtube_cookies_meta ?? null;
      }
      if (liveGooglePhotos) {
        automationConfig.google_photos_cookies = liveGooglePhotos;
      }
      automationConfig.cookie_source = (liveYoutube || liveGooglePhotos) ? "live" : "frozen";
      automationConfig.cookie_live_fetched_at = new Date().toISOString();

      return new Response(JSON.stringify({
        success: true,
        data: {
          job_id: job.id,
          automation_config: automationConfig,
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Cache-Control": "no-store",
        },
      });
    }

    if (path === "/api/github/generate-content" && method === "POST") {
      const body = await safeRequestJson<{
        job_id?: number;
        token?: string;
        video_title?: string;
      }>(request);

      const jobId = Number(body?.job_id || 0);
      const token = String(body?.token || "").trim();
      const videoTitle = String(body?.video_title || "").trim();

      if (!Number.isFinite(jobId) || jobId <= 0 || !token || !videoTitle) {
        return jsonResponse({ success: false, error: "job_id, token, and video_title are required" }, 400);
      }

      const job = await env.DB.prepare(
        "SELECT id, user_id, input_data FROM jobs WHERE id = ? LIMIT 1"
      ).bind(jobId).first<{ id: number; user_id: number; input_data: string | null }>();

      if (!job?.id || !job.user_id) {
        return jsonResponse({ success: false, error: "Job not found" }, 404);
      }

      // Try HMAC-based runtime config token validation (GitHub runner)
      const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", job.user_id);
      let isTokenValid = false;
      if (githubSettings?.pat_token) {
        isTokenValid = await verifyWorkflowRuntimeConfigToken(job.id, token, githubSettings.pat_token);
      }

      // Fallback: validate as a user access token (local runner)
      // Local runners set RUNTIME_CONFIG_TOKEN = config.accessToken (user's bearer token)
      if (!isTokenValid) {
        try {
          const userByToken = await findUserByAccessToken(env, token);
          if (userByToken && userByToken.id === job.user_id) {
            isTokenValid = true;
            console.log(`[generate-content] Local runner auth: user ${userByToken.id} validated via access token`);
          }
        } catch (authErr) {
          console.log(`[generate-content] Access token fallback auth failed: ${authErr instanceof Error ? authErr.message : String(authErr)}`);
        }
      }

      if (!isTokenValid) {
        return jsonResponse({ success: false, error: "Invalid or expired token" }, 403);
      }

      let jobConfig: Record<string, unknown> = {};
      try {
        jobConfig = job.input_data ? JSON.parse(job.input_data) as Record<string, unknown> : {};
      } catch {
        return jsonResponse({ success: false, error: "Job config is unreadable" }, 500);
      }

      const aiSettings = await getScopedSettings<AISettings>(env.DB, "ai", job.user_id);
      if (!aiSettings) {
        return jsonResponse({ success: false, error: "No AI settings configured for this user" }, 400);
      }

      const provider = String(jobConfig.social_ai_provider || aiSettings.default_provider || "gemini");
      const model = String(jobConfig.social_ai_model || "");
      const platform = String(jobConfig.social_platform || "youtube");
      const count = Math.min(Math.max(Number(jobConfig.social_count || 10), 1), 50);

      try {
        const messages = getSocialMessages({
          topic: videoTitle,
          platform,
          count,
          focusKeyword: undefined,
          brief: undefined,
        });
        const raw = await generateAiJson(aiSettings, provider as SupportedAIProvider, model, messages);
        const normalized = normalizeSocialResult(raw, count, platform);

        return jsonResponse({
          success: true,
          data: {
            titles: normalized.titles,
            descriptions: normalized.descriptions,
            hashtags: normalized.hashtags,
            provider,
            model,
          },
        });
      } catch (err) {
        return jsonResponse({
          success: false,
          error: `AI content generation failed: ${err instanceof Error ? err.message : String(err)}`,
        }, 500);
      }
    }

    if (path.startsWith("/api/settings")) {
      const authContext = await requireAuth(request, env);
      if (authContext instanceof Response) {
        const durationMs = Date.now() - startTime;
        await logApiRequest(
          env,
          null,
          null,
          path,
          method,
          401,
          ipAddress,
          userAgent,
          requestSize,
          0,
          durationMs,
          "Unauthorized"
        );
        return authContext;
      }
      
      return handleRouteWithAuditLog(
        env,
        () => handleSettingsRoutes(request, env, path, authContext),
        authContext,
        path,
        method,
        startTime,
        ipAddress,
        userAgent,
        requestSize
      );
    }

     if (path.startsWith("/api/automations")) {
       const authContext = await requireAuth(request, env);
       if (authContext instanceof Response) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Unauthorized"
         );
         return authContext;
       }
       
       return handleRouteWithAuditLog(
         env,
         () => handleAutomationsRoutes(request, env, path, authContext),
         authContext,
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

     if (path.startsWith("/api/ai")) {
       const authContext = await requireAuth(request, env);
       if (authContext instanceof Response) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Unauthorized"
         );
         return authContext;
       }

       return handleRouteWithAuditLog(
         env,
         () => handleAiAccessRoutes(request, env, path, authContext),
         authContext,
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

     if (path.startsWith("/api/keys")) {
       const authContext = await requireAuth(request, env);
       if (authContext instanceof Response) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Unauthorized"
         );
         return authContext;
       }
       
       return handleRouteWithAuditLog(
         env,
         () => handleApiKeysRoutes(request, env, path, {
           userId: authContext.userId,
           isAdmin: authContext.isAdmin
         }),
         authContext,
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

     // Keep the GitHub/local-runner callback public; it has its own job-id validation
     // and must not be swallowed by the authenticated webhook router below.
     if (path.startsWith("/api/webhook") && path !== "/api/webhook/github") {
       return handleRouteWithAuditLog(
         env,
         () => handleWebhookRoutes(request, env, path),
         auth, // auth context may be null for public webhooks
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

     if (path.startsWith("/api/jobs")) {
       const authContext = await requireAuth(request, env);
       if (authContext instanceof Response) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Unauthorized"
         );
         return authContext;
       }
       
       return handleRouteWithAuditLog(
         env,
         () => handleJobsRoutes(request, env, path, authContext),
         authContext,
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

     if (path.startsWith("/api/uploads")) {
       const authContext = await requireAuth(request, env);
       if (authContext instanceof Response) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Unauthorized"
         );
         return authContext;
       }
       
       return handleRouteWithAuditLog(
         env,
         () => handleUploadsRoutes(request, env, path, authContext),
         authContext,
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

      // YouTube download URL extraction (via ytdown.to proxy)
      if (path.startsWith("/api/extract")) {
        const authContext = await requireAuth(request, env);
        if (authContext instanceof Response) {
          const durationMs = Date.now() - startTime;
          await logApiRequest(
            env,
            null,
            null,
            path,
            method,
            401,
            ipAddress,
            userAgent,
            requestSize,
            0,
            durationMs,
            "Unauthorized"
          );
          return authContext;
        }

        return handleRouteWithAuditLog(
          env,
          () => handleYoutubeExtractRoutes(request, env, path),
          authContext,
          path,
          method,
          startTime,
          ipAddress,
          userAgent,
          requestSize
        );
      }

      // OAuth routes (Facebook, etc.)
      if (path.startsWith("/api/oauth/")) {
        return handleRouteWithAuditLog(
          env,
          () => handleOAuthRoutes(request, env, path, auth),
          auth,
          path,
          method,
          startTime,
          ipAddress,
          userAgent,
          requestSize
        );
      }

      // Runner routes (local runner connections)
      if (path.startsWith("/api/runner") || path.startsWith("/api/admin/")) {
       return handleRouteWithAuditLog(
         env,
         () => handleRunnerRoutes(request, env, path, method, auth),
         auth,
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

    // Serve video file - redirect to Litterbox URL stored in DB
    if (path.startsWith("/api/output/") && (method === "GET" || method === "HEAD")) {
      try {
        const segments = path.split("/").filter(Boolean);
        const jobId = segments[2] ? parseInt(segments[2]) : null;
        if (!jobId || isNaN(jobId) || jobId <= 0) {
          return jsonResponse({ success: false, error: "Valid job ID required" }, 400);
        }

        let job;
        try {
          job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<Job>();
        } catch (dbErr) {
          console.error("Database error in output endpoint:", dbErr);
          return jsonResponse({ success: false, error: "Database error" }, 500);
        }
        
        if (!job) {
          return jsonResponse({ success: false, error: "Job not found" }, 404);
        }

        // Use video_url from DB (Litterbox URL)
        const videoUrl = (job as any).video_url as string | null;
        if (videoUrl && videoUrl.startsWith("https://") && !isSameOutputUrl(request.url, videoUrl, jobId)) {
          return new Response(null, {
            status: 302,
            headers: {
              "Location": videoUrl,
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // Fallback: try GitHub artifact
        let githubSettings;
        try {
          githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", job.user_id as number);
        } catch (dbErr) {
          console.error("Database error fetching GitHub settings:", dbErr);
          return jsonResponse({ success: false, error: "Database error" }, 500);
        }
        
        if (!githubSettings || !job.github_run_id) {
          return jsonResponse({ success: false, error: "Video not available" }, 404);
        }

        try {
          const artifactBytes = await fetchArtifactVideoBytes(githubSettings, job);
          if (!artifactBytes) {
            return jsonResponse({ success: false, error: "Video not found — may have expired" }, 404);
          }
          return buildVideoResponse(request, artifactBytes);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          console.error("Error fetching artifact:", errorMsg);
          return jsonResponse({ success: false, error: "Failed to fetch video" }, 500);
        }
      } catch (err) {
        console.error("Unexpected error in output endpoint:", err);
        return jsonResponse({ success: false, error: "Internal server error" }, 500);
      }
    }

    // Serve video stream (for playing in browser)
    if (path.startsWith("/api/video/") && (method === "GET" || method === "HEAD")) {
      const authContext = await requireAuth(request, env);
      if (authContext instanceof Response) {
        return authContext;
      }
      const segments = path.split("/").filter(Boolean);
      const jobId = segments[2] ? parseInt(segments[2]) : null;
      if (!jobId) {
        return jsonResponse({ success: false, error: "Job ID required" }, 400);
      }

      const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(jobId, authContext.userId).first<Job>();
      if (!job) {
        return jsonResponse({ success: false, error: "Job not found" }, 404);
      }

      const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", authContext.userId);
      if (!githubSettings) {
        return jsonResponse({ success: false, error: "GitHub settings not configured" }, 400);
      }

      try {
        const repoResponse = await fetchRepoVideoResponse(request, githubSettings, jobId);
        if (repoResponse) {
          return repoResponse;
        }

        if (!job.github_run_id) {
          return jsonResponse({ success: false, error: "No GitHub run" }, 400);
        }

        const artifactBytes = await fetchArtifactVideoBytes(githubSettings, job);
        if (!artifactBytes) {
          return jsonResponse({ success: false, error: "No artifacts found" }, 404);
        }

        return buildVideoResponse(request, artifactBytes);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        return jsonResponse({ success: false, error: errorMsg }, 500);
      }
    }

    // Redirect to GitHub artifact download
    if (path.startsWith("/api/download/") && method === "GET") {
      const authContext = await requireAuth(request, env);
      if (authContext instanceof Response) {
        return authContext;
      }
      const segments = path.split("/").filter(Boolean);
      const jobId = segments[2] ? parseInt(segments[2]) : null;
      if (!jobId) {
        return jsonResponse({ success: false, error: "Job ID required" }, 400);
      }

      const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(jobId, authContext.userId).first<Job>();
      if (!job) {
        return jsonResponse({ success: false, error: "Job not found" }, 404);
      }

      const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", authContext.userId);
      if (!githubSettings || !job.github_run_id) {
        return jsonResponse({ success: false, error: "No GitHub run" }, 400);
      }

      try {
        const artRes = await fetch(
          `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/runs/${job.github_run_id}/artifacts`,
          {
            headers: {
              Authorization: `Bearer ${githubSettings.pat_token}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "AutomationSystem/1.0",
            },
          }
        );

        const artData = await artRes.json() as { artifacts?: Array<{ archive_download_url: string }> };
        const artifact = artData.artifacts?.[0];

        if (artifact) {
          // Redirect to download URL
          return new Response(null, {
            status: 302,
            headers: {
              Location: artifact.archive_download_url,
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
      } catch (err) {
        console.error("[Output] Artifact download error:", err instanceof Error ? err.message : String(err));
      }

      return jsonResponse({ success: false, error: "No artifact found" }, 404);
    }

    if (path === "/api/webhook/github" && method === "POST") {
      const body = await safeRequestJson<Record<string, unknown>>(request);
      if (!body) {
        return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
      }
      const jobId = body.job_id as number;
      const status = body.status as string;
      const videoUrl = body.video_url as string | undefined;
      const outputDataRaw = body.output_data;
      const rawErrorMessage = body.error_message;
      const automationId = body.automation_id as number | undefined;
      const processedVideosArray = (body.processed_videos as Array<Record<string, unknown>>) || [];
      const videosCompleted = body.videos_completed as number | undefined;
      const allLinksProcessed = body.all_links_processed as boolean | undefined;
      const errorMessage = typeof rawErrorMessage === "string" && rawErrorMessage.trim()
        ? rawErrorMessage.trim().slice(0, 2000)
        : null;
      const isTerminalStatus = status === "success" || status === "failed";
      const completedAt = isTerminalStatus ? new Date() : null;
      const completedAtText = completedAt ? formatDatabaseDate(completedAt) : null;

      if (jobId && status) {
        const jobRecord = await env.DB.prepare(
          "SELECT id, user_id FROM jobs WHERE id = ? LIMIT 1"
        ).bind(jobId).first<{ id: number; user_id: number }>();

        if (!jobRecord) {
          return jsonResponse({ success: false, error: "Job not found" }, 404);
        }

        // Bulk insert processed videos if provided
        if (automationId && processedVideosArray.length > 0) {
          try {
            for (const video of processedVideosArray) {
              const vidUrl = video.video_url as string;
              const vidId = video.video_id as string | undefined;
              const vidTitle = video.video_title as string | undefined;
              const originalUrl = video.original_url as string | undefined;
              if (vidUrl) {
                // For Google Photos, we store the original share link if available, otherwise the direct URL
                const videoUrlToStore = originalUrl || vidUrl;
                await env.DB.prepare(
                  "INSERT OR IGNORE INTO processed_videos (user_id, automation_id, video_url, video_id, video_title, job_id) VALUES (?, ?, ?, ?, ?, ?)"
                ).bind(jobRecord.user_id, automationId, videoUrlToStore, vidId || null, vidTitle || null, jobId).run();
              }
            }
          } catch (err) {
            console.error("Error bulk inserting processed videos:", err);
          }
        }

        let mergedOutputData: Record<string, unknown> | null = null;
        if (typeof outputDataRaw === "string" && outputDataRaw.trim()) {
          try {
            const parsed = JSON.parse(outputDataRaw);
            if (parsed && typeof parsed === "object") {
              mergedOutputData = parsed as Record<string, unknown>;
            }
          } catch {
            mergedOutputData = { raw_output: outputDataRaw };
          }
        } else if (outputDataRaw && typeof outputDataRaw === "object") {
          mergedOutputData = outputDataRaw as Record<string, unknown>;
        }

        if (videoUrl) {
          mergedOutputData = { ...(mergedOutputData || {}), video_url: videoUrl };
        }
        if (videosCompleted !== undefined) {
          mergedOutputData = { ...(mergedOutputData || {}), videos_completed: videosCompleted };
        }
        if (allLinksProcessed !== undefined) {
          mergedOutputData = { ...(mergedOutputData || {}), all_links_processed: allLinksProcessed };
        }
        if (processedVideosArray.length > 0) {
          mergedOutputData = { ...(mergedOutputData || {}), processed_videos: processedVideosArray };
        }
        if (errorMessage) {
          mergedOutputData = { ...(mergedOutputData || {}), error_message: errorMessage };
        }

        if (isTerminalStatus) {
          await env.DB.prepare(
            "UPDATE jobs SET status = ?, output_data = ?, video_url = ?, error_message = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
          ).bind(status, mergedOutputData ? JSON.stringify(mergedOutputData) : null, videoUrl || null, status === "failed" ? (errorMessage || "Runner reported failure without details") : null, completedAtText, jobId, jobRecord.user_id).run();

          await markAutomationRunCompleted(env, jobId, completedAt as Date);
        } else {
          await env.DB.prepare(
            "UPDATE jobs SET status = ?, output_data = ?, video_url = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
          ).bind(status, mergedOutputData ? JSON.stringify(mergedOutputData) : null, videoUrl || null, status === "failed" ? (errorMessage || "Runner reported failure without details") : null, jobId, jobRecord.user_id).run();
        }

        const uploadRecords = processedVideosArray.length > 0
          ? processedVideosArray
          : (videoUrl ? [{ ...(mergedOutputData || {}), video_url: videoUrl }] : []);

        if (uploadRecords.length > 0 && (status === "success" || status === "running")) {
          for (const rawRecord of uploadRecords) {
            const uploadRecord = rawRecord && typeof rawRecord === "object"
              ? rawRecord as Record<string, unknown>
              : {};
            const mediaUrl = typeof uploadRecord.video_url === "string" ? uploadRecord.video_url.trim() : "";
            if (!mediaUrl) {
              continue;
            }

            const draftPostId = typeof uploadRecord.draft_post_id === "string" && uploadRecord.draft_post_id.trim()
              ? uploadRecord.draft_post_id.trim()
              : ((mergedOutputData?.draft_post_id as string) || null);
            const livePostId = typeof uploadRecord.live_post_id === "string" && uploadRecord.live_post_id.trim()
              ? uploadRecord.live_post_id.trim()
              : ((mergedOutputData?.live_post_id as string) || null);
            const aspectRatio = typeof uploadRecord.aspect_ratio === "string" && uploadRecord.aspect_ratio.trim()
              ? uploadRecord.aspect_ratio.trim()
              : (typeof mergedOutputData?.aspect_ratio === "string" && mergedOutputData.aspect_ratio.trim()
                ? mergedOutputData.aspect_ratio.trim()
                : "9:16");
            const storedPostMetadata = extractStoredPostMetadata(uploadRecord) || extractStoredPostMetadata(mergedOutputData);

          // Check if this exact media_url already exists for this job (avoid duplicates)
          const existingUpload = await env.DB.prepare(
            "SELECT id FROM video_uploads WHERE user_id = ? AND job_id = ? AND media_url = ? LIMIT 1"
          ).bind(jobRecord.user_id, jobId, mediaUrl).first<{ id: number }>();

          const { postStatus, scheduledAt } = deriveUploadPostState(
            uploadRecord,
            mergedOutputData,
            storedPostMetadata,
            livePostId,
            draftPostId,
          );

          if (existingUpload?.id) {
            await env.DB.prepare(
              `UPDATE video_uploads SET
                postforme_id = COALESCE(?, postforme_id),
                upload_status = 'uploaded',
                post_status = CASE
                  WHEN post_status = 'scheduled' OR ? = 'scheduled' THEN 'scheduled'
                  WHEN post_status = 'posted' OR ? = 'posted' THEN 'posted'
                  ELSE ?
                END,
                scheduled_at = CASE
                  WHEN ? IS NOT NULL THEN ?
                  WHEN post_status = 'scheduled' THEN scheduled_at
                  ELSE NULL
                END,
                aspect_ratio = COALESCE(?, aspect_ratio),
                post_metadata = COALESCE(?, post_metadata),
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`
            ).bind(
              livePostId || draftPostId,
              postStatus,
              postStatus,
              postStatus,
              scheduledAt,
              scheduledAt,
              aspectRatio,
              storedPostMetadata,
              existingUpload.id,
            ).run();
          } else {
            await env.DB.prepare(
              "INSERT INTO video_uploads (user_id, job_id, postforme_id, media_url, upload_status, post_status, scheduled_at, aspect_ratio, post_metadata) VALUES (?, ?, ?, ?, 'uploaded', ?, ?, ?, ?)"
            ).bind(
              jobRecord.user_id,
              jobId,
              livePostId || draftPostId,
              mediaUrl,
              postStatus,
              scheduledAt,
              aspectRatio,
              storedPostMetadata,
            ).run();
          }

          // Save draft_post_id to jobs table for review queue
          if (draftPostId) {
            await env.DB.prepare(
              "UPDATE jobs SET draft_post_id = ?, video_expires_at = datetime('now', '+72 hours') WHERE id = ?"
            ).bind(draftPostId, jobId).run().catch(() => {
              // Column may not exist yet — ignore error
            });
          }
        }
        }

        return jsonResponse({ success: true, message: "Job updated" });
      }
      return jsonResponse({ success: false, error: "Missing job_id or status" }, 400);
    }

     // GET /api/review-queue — Videos pending review (draft on PostForMe)
     if (path === "/api/review-queue" && method === "GET") {
       const authContext = await requireAuth(request, env);
       if (authContext instanceof Response) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Unauthorized"
         );
         return authContext;
       }
       
       return handleRouteWithAuditLog(
         env,
         async () => {
           const jobs = await env.DB.prepare(`
             SELECT j.*, vu.postforme_id, vu.media_url as upload_media_url
             FROM jobs j
             LEFT JOIN video_uploads vu ON vu.job_id = j.id
             WHERE j.user_id = ?
               AND j.status = 'success'
               AND j.video_url IS NOT NULL
             ORDER BY j.created_at DESC
             LIMIT 50
           `).bind(authContext.userId).all<any>();
           return jsonResponse({ success: true, data: jobs.results });
         },
         authContext,
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

     // POST /api/review-queue/:postId/publish — Publish draft to accounts
     if (path.match(/^\/api\/review-queue\/(.+)\/publish$/) && method === "POST") {
       const authContext = await requireAuth(request, env);
       if (authContext instanceof Response) {
         const durationMs = Date.now() - startTime;
         await logApiRequest(
           env,
           null,
           null,
           path,
           method,
           401,
           ipAddress,
           userAgent,
           requestSize,
           0,
           durationMs,
           "Unauthorized"
         );
         return authContext;
       }
       
       return handleRouteWithAuditLog(
         env,
         async () => {
           const postId = path.split("/")[3];
           const body = await safeRequestJson<{ account_ids: string[]; scheduled_at?: string | null }>(request);
           if (!body) {
             return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
           }
           const postformeSettings = await getScopedSettings<PostformeSettings>(env.DB, "postforme", authContext.userId);

           if (!postformeSettings?.api_key) {
             return jsonResponse({ success: false, error: "PostForMe API key not configured" }, 400);
           }
           try {
             const updateBody: Record<string, unknown> = {
               isDraft: false,
               social_accounts: body.account_ids || [],
             };
             if (body.scheduled_at) {
               updateBody.scheduled_at = body.scheduled_at;
             }
             const res = await fetch(`https://api.postforme.dev/v1/social-posts/${postId}`, {
               method: "PUT",
               headers: {
                 "Authorization": `Bearer ${postformeSettings.api_key}`,
                 "Content-Type": "application/json",
               },
               body: JSON.stringify(updateBody),
             });
             if (!res.ok) {
               const errText = await res.text();
               return jsonResponse({ success: false, error: errText }, 400);
             }
             const data = await res.json();
             return jsonResponse({ success: true, data });
           } catch (err: unknown) {
             const errorMsg = err instanceof Error ? err.message : "Unknown error";
             return jsonResponse({ success: false, error: errorMsg }, 500);
           }
         },
         authContext,
         path,
         method,
         startTime,
         ipAddress,
         userAgent,
         requestSize
       );
     }

     // Log API request for audit trail
     const durationMs = Date.now() - startTime;
     let responseSize = 0;
     // Note: In a real implementation, we would capture response size
     // For now, we'll log what we can
     await logApiRequest(
       env,
       auth?.userId || null,
       auth?.apiKeyId || null,
       path,
       method,
       404, // Not found status
       ipAddress,
       userAgent,
       requestSize,
       responseSize,
       durationMs,
       "Endpoint not found"
     );
     
     return jsonResponse({ success: false, error: "Not found" }, 404);
   },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processDueAutomations(env));
    ctx.waitUntil(processPendingUploads(env));
    ctx.waitUntil(syncScheduledUploads(env, { limit: 25, onlyDue: true }));
    ctx.waitUntil(syncStaleRunningJobs(env));
  },
};

// Helper function to wrap route handlers with audit logging
async function handleRouteWithAuditLog(
  env: Env,
  handler: () => Promise<Response>,
  auth: AuthContext | null,
  path: string,
  method: string,
  startTime: number,
  ipAddress: string,
  userAgent: string,
  requestSize: number
): Promise<Response> {
  try {
    const response = await handler();
    
    // Extract status code from response
    let statusCode = 200;
    let responseSize = 0;
    let errorMessage = null;
    
    try {
      // Try to get status from response (this is simplified)
      statusCode = response.status || 200;
      
      // Get response size
      const bodyText = await response.clone().text();
      responseSize = bodyText.length;
      
      // If it's an error response, extract error message
      if (statusCode >= 400) {
        try {
          const jsonData = JSON.parse(bodyText);
          errorMessage = jsonData.error || null;
        } catch {
          errorMessage = bodyText.substring(0, 100); // First 100 chars
        }
      }
    } catch {
      // If we can't read the response, just use defaults
      statusCode = response.status || 200;
      responseSize = 0;
    }
    
    const durationMs = Date.now() - startTime;
    
    await logApiRequest(
      env,
      auth?.userId || null,
      auth?.apiKeyId || null,
      path,
      method,
      statusCode,
      ipAddress,
      userAgent,
      requestSize,
      responseSize,
      durationMs,
      errorMessage
    );
    
    return response;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    try {
      await logApiRequest(
        env,
        auth?.userId || null,
        auth?.apiKeyId || null,
        path,
        method,
        500,
        ipAddress,
        userAgent,
        requestSize,
        0,
        durationMs,
        errorMessage
      );
    } catch {
      // Silently fail audit logging to not mask the original error
    }

    console.error("Unhandled worker error:", errorMessage);
    return jsonResponse({ success: false, error: "Internal server error" }, 500);
  }
}
