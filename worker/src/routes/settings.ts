import { AuthContext, Env, PostformeSettings, GithubSettings, VideoSourceSettings, AISettings, TailscaleSettings } from "../types";
import { jsonResponse, safeRequestJson } from "../utils";
import {
  buildAiRuntimeConfig,
  buildAiCatalog,
  generateAiJson,
  getConfiguredProviderIds,
  getShortPromptPlanMessages,
  getSocialMessages,
  getTaglinesMessages,
  normalizeShortPromptPlanResult,
  normalizeSocialResult,
  normalizeTaglinesResult,
  resolveModelForProvider,
  testGeminiApiKey,
  type SupportedAIProvider,
} from "../services/ai";
import { getCloudflareVisualCatalog } from "../services/cloudflare-ai";
import { generateImageBannerPreviewSpecs, normalizeBannerFormat } from "../services/image-automation";
import { getScopedSettings, upsertScopedSettings } from "../services/user-settings";
import { buildCookieUploadDiagnostics } from "../services/cookie-files";
import { syncVideoSourceSecretsToGithub } from "../services/github-secrets";
import { testYouTubeCookies, testGooglePhotosCookies } from "../services/cookie-test";

type SyncedPostformeAccount = {
  id: string;
  platform: string;
  username: string;
  connected: boolean;
};

function normalizePostformeAccounts(accounts: Array<{ platform: string; username: string; id: string }>): SyncedPostformeAccount[] {
  return accounts.map((a) => ({
    id: a.id,
    platform: a.platform,
    username: a.username,
    connected: true,
  }));
}

function parseSavedAccounts(raw: unknown): SyncedPostformeAccount[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
      .map((value) => ({
        id: String(value.id || ""),
        platform: String(value.platform || ""),
        username: String(value.username || ""),
        connected: value.connected !== false,
      }))
      .filter((value) => value.id && value.platform && value.username);
  } catch {
    return [];
  }
}

function normalizeCookieText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizeOptionalCookieValue(value: unknown, label: string): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be provided as text`);
  }

  const normalized = normalizeCookieText(value);
  if (!normalized) {
    return null;
  }

  if (!looksLikeNetscapeCookieFile(normalized)) {
    throw new Error(`${label} must be in Netscape text format`);
  }

  return normalized;
}

function looksLikeNetscapeCookieFile(value: string): boolean {
  if (!value.trim()) {
    return false;
  }

  const normalized = normalizeCookieText(value);
  if (normalized.includes("# Netscape HTTP Cookie File")) {
    return true;
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"));

  return lines.some((line) => line.split("\t").length >= 7);
}

function maskStoredCookieValue(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? "[stored]" : null;
}

function maskVideoSourceSettingsForApiKey(
  value: (VideoSourceSettings & { youtube_cookies_meta?: string | null; google_photos_cookies_meta?: string | null }) | null
): (VideoSourceSettings & { youtube_cookies_meta?: string | null; google_photos_cookies_meta?: string | null }) | null {
  if (!value) {
    return value;
  }

  return {
    ...value,
    youtube_cookies: maskStoredCookieValue(value.youtube_cookies),
    google_photos_cookies: maskStoredCookieValue(value.google_photos_cookies),
  };
}

async function buildProviderTestMessage(providerLabel: string, response: Response): Promise<string> {
  if (response.ok) {
    return `${providerLabel} connected successfully`;
  }

  const errorText = (await response.text()).trim();
  return errorText ? `${providerLabel} error: ${response.status} ${errorText}` : `${providerLabel} error: ${response.status}`;
}

async function ensureVideoSourceCookieMetadataColumns(env: Env): Promise<void> {
  for (const statement of [
    "ALTER TABLE settings_video_sources ADD COLUMN youtube_cookies_meta TEXT",
    "ALTER TABLE settings_video_sources ADD COLUMN google_photos_cookies_meta TEXT",
  ]) {
    try { await env.DB.prepare(statement).run(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) console.warn("[settings.video-sources] Cookie metadata migration skipped:", message);
    }
  }
}

export async function handleSettingsRoutes(
  request: Request,
  env: Env,
  path: string,
  auth: AuthContext
): Promise<Response> {
  const method = request.method;
  const userId = auth.userId;
  const aiRuntimeConfig = buildAiRuntimeConfig(env, {
    request,
    authToken: auth.token,
  });

  // POSTFORME SETTINGS
  if (path === "/api/settings/postforme") {
    if (method === "GET") {
      const result = await getScopedSettings<PostformeSettings>(env.DB, "postforme", userId);
      return jsonResponse({ success: true, data: result || null });
    }

    if (method === "POST") {
      const body = await safeRequestJson<Partial<PostformeSettings>>(request);
      if (!body) {
        return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
      }
      const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
      if (!apiKey) {
        return jsonResponse({ success: false, error: "api_key is required" }, 400);
      }

      try {
        await upsertScopedSettings(env.DB, "settings_postforme", userId, {
          api_key: apiKey,
          platforms: body.platforms || "[]",
          saved_accounts: body.saved_accounts || "[]",
          default_schedule: body.default_schedule || null,
        });
        return jsonResponse({ success: true, message: "Postforme settings saved" });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Failed to save Postforme settings";
        return jsonResponse({ success: false, error: errorMsg }, 500);
      }
    }
  }

  // POSTFORME ACCOUNTS (Get saved accounts)
  if (path === "/api/settings/postforme/accounts" && method === "GET") {
    console.log("[POSTFORME] /accounts endpoint called");
    try {
      // First get basic settings
      const basicSettings = await getScopedSettings<{ api_key: string } & PostformeSettings>(env.DB, "postforme", userId);
      const savedAccounts = parseSavedAccounts(basicSettings?.saved_accounts);
      if (!basicSettings?.api_key) {
        console.log("[POSTFORME] No API key in DB");
        if (savedAccounts.length > 0) {
          return jsonResponse({ success: true, data: savedAccounts });
        }
        return jsonResponse({ success: false, error: "No API key configured" }, 400);
      }
      console.log("[POSTFORME] Found API key, fetching from Postforme API");
      
      // Always fetch fresh from API
      const res = await fetch("https://api.postforme.dev/v1/social-accounts", {
        headers: { Authorization: `Bearer ${basicSettings.api_key}` },
      });
      console.log("[POSTFORME] API response status:", res.status);
      
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ platform: string; username: string; id: string }> };
        const accounts = normalizePostformeAccounts(data.data || []);
        console.log("[POSTFORME] Found accounts:", accounts.length);
        try {
          await upsertScopedSettings(env.DB, "settings_postforme", userId, {
            api_key: basicSettings.api_key,
            platforms: basicSettings.platforms || "[]",
            saved_accounts: JSON.stringify(accounts),
            default_schedule: basicSettings.default_schedule || null,
          });
        } catch (saveErr) {
          console.log("[POSTFORME] Could not refresh saved accounts cache:", saveErr);
        }
        return jsonResponse({ success: true, data: accounts });
      }
      if (savedAccounts.length > 0) {
        return jsonResponse({ success: true, data: savedAccounts });
      }
      return jsonResponse({ success: false, error: "Failed to fetch accounts from Postforme" }, 400);
    } catch (err: unknown) {
      console.log("[POSTFORME] Error:", err);
      const basicSettings = await getScopedSettings<{ api_key: string } & PostformeSettings>(env.DB, "postforme", userId);
      const savedAccounts = parseSavedAccounts(basicSettings?.saved_accounts);
      if (savedAccounts.length > 0) {
        return jsonResponse({ success: true, data: savedAccounts });
      }
      const errorMsg = err instanceof Error ? err.message : "Failed to fetch accounts";
      return jsonResponse({ success: false, error: errorMsg }, 500);
    }
  }

  // POSTFORME TEST
  if (path === "/api/settings/postforme/test" && method === "POST") {
    const body = await safeRequestJson<{ api_key: string }>(request);
    if (!body || !body.api_key) {
      return jsonResponse({ success: false, error: "api_key required" }, 400);
    }
    try {
      const res = await fetch("https://api.postforme.dev/v1/social-accounts", {
        headers: { Authorization: `Bearer ${body.api_key}` },
      });
      if (res.ok) {
        return jsonResponse({ success: true, message: "Postforme API connected successfully!" });
      }
      const errText = await res.text();
      return jsonResponse({ success: false, message: `Error ${res.status}: ${errText || "Invalid API key"}` });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Connection failed";
      return jsonResponse({ success: false, error: errorMsg });
    }
  }

  // POSTFORME SYNC ACCOUNTS
  if (path === "/api/settings/postforme/sync" && method === "POST") {
    const body = await safeRequestJson<{ api_key: string }>(request);
    if (!body || !body.api_key) {
      return jsonResponse({ success: false, error: "api_key required" }, 400);
    }
    try {
      const res = await fetch("https://api.postforme.dev/v1/social-accounts", {
        headers: { Authorization: `Bearer ${body.api_key}` },
      });
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ platform: string; username: string; id: string }> };
        const accounts = normalizePostformeAccounts(data.data || []);
        const connectedPlatforms = accounts.map((a) => a.platform);
        
        // Save accounts to database (wrapped in try/catch in case column doesn't exist)
        try {
          await upsertScopedSettings(env.DB, "settings_postforme", userId, {
            api_key: body.api_key,
            platforms: JSON.stringify(connectedPlatforms),
            saved_accounts: JSON.stringify(accounts),
          });
          console.log("[POSTFORME] Saved accounts to database:", accounts.length);
        } catch (e) {
          console.log("[POSTFORME] Could not save accounts - column may not exist:", e);
        }
        
        return jsonResponse({ success: true, data: accounts });
      }
      return jsonResponse({ success: false, error: `Postforme error: ${res.status}` });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Sync failed";
      return jsonResponse({ success: false, error: errorMsg });
    }
  }

  // GITHUB SETTINGS
  if (path === "/api/settings/github") {
    if (method === "GET") {
      const result = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
      return jsonResponse({ success: true, data: result || null });
    }

    if (method === "POST") {
      const body = await safeRequestJson<Partial<GithubSettings>>(request);
      if (!body || !body.pat_token || !body.repo_owner || !body.repo_name) {
        return jsonResponse({ success: false, error: "pat_token, repo_owner, and repo_name are required" }, 400);
      }

      await upsertScopedSettings(env.DB, "settings_github", userId, {
        pat_token: body.pat_token,
        repo_owner: body.repo_owner,
        repo_name: body.repo_name,
        runner_labels: body.runner_labels || "self-hosted",
        workflow_dispatch_url: body.workflow_dispatch_url || null,
      });
      return jsonResponse({ success: true, message: "GitHub settings saved" });
    }
  }

  // TAILSCALE SETTINGS (admin only)
  if (path === "/api/settings/tailscale") {
    if (!auth.isAdmin) {
      return jsonResponse({ success: false, error: "Admin only" }, 403);
    }

    if (method === "GET") {
      try {
        const result = await getScopedSettings<TailscaleSettings>(env.DB, "tailscale", userId);
        return jsonResponse({ success: true, data: result || null });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Failed to load Tailscale settings";
        return jsonResponse({ success: false, error: errorMsg }, 500);
      }
    }

    if (method === "POST") {
      const body = await safeRequestJson<Partial<TailscaleSettings>>(request);
      if (!body) {
        return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
      }

      try {
        await upsertScopedSettings(env.DB, "settings_tailscale", userId, {
          auth_key: typeof body.auth_key === "string" ? body.auth_key.trim() || null : null,
          tailnet: typeof body.tailnet === "string" ? body.tailnet.trim() || null : null,
          device_tag: typeof body.device_tag === "string" ? body.device_tag.trim() || null : null,
          hostname_prefix: typeof body.hostname_prefix === "string" ? body.hostname_prefix.trim() || null : null,
          auto_install: body.auto_install === false || body.auto_install === 0 ? 0 : 1,
          ssh_enabled: body.ssh_enabled === false || body.ssh_enabled === 0 ? 0 : 1,
          unattended: body.unattended === false || body.unattended === 0 ? 0 : 1,
        });
        return jsonResponse({ success: true, message: "Tailscale settings saved" });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Failed to save Tailscale settings";
        return jsonResponse({ success: false, error: errorMsg }, 500);
      }
    }
  }

  // VIDEO SOURCE SETTINGS
  if (path === "/api/settings/video-sources") {
    if (method === "GET") {
      await ensureVideoSourceCookieMetadataColumns(env);
      const result = await getScopedSettings<VideoSourceSettings & { youtube_cookies_meta?: string | null; google_photos_cookies_meta?: string | null }>(env.DB, "video-sources", userId);
      const payload = auth.apiKeyId ? maskVideoSourceSettingsForApiKey(result || null) : (result || null);
      return jsonResponse({ success: true, data: payload });
    }

    if (method === "POST") {
      const body = await safeRequestJson<Partial<VideoSourceSettings>>(request);
      if (!body) {
        return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
      }

      try {
        await ensureVideoSourceCookieMetadataColumns(env);
        const normalizedYoutubeCookies = normalizeOptionalCookieValue(body.youtube_cookies, "YouTube cookies");
        const normalizedGooglePhotosCookies = normalizeOptionalCookieValue(body.google_photos_cookies, "Google Photos cookies");
        await upsertScopedSettings(env.DB, "settings_video_sources", userId, {
          bunny_api_key: body.bunny_api_key || null,
          bunny_library_id: body.bunny_library_id || null,
          youtube_cookies: normalizedYoutubeCookies,
          google_photos_cookies: normalizedGooglePhotosCookies,
          youtube_cookies_meta: normalizedYoutubeCookies ? JSON.stringify(buildCookieUploadDiagnostics(normalizedYoutubeCookies, "youtube", "manual-paste.txt")) : null,
          google_photos_cookies_meta: normalizedGooglePhotosCookies ? JSON.stringify(buildCookieUploadDiagnostics(normalizedGooglePhotosCookies, "google_photos", "manual-paste.txt")) : null,
        });

        // Auto-sync cookies to GitHub Secrets immediately
        const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
        let syncWarning: string | null = null;
        if (githubSettings?.pat_token) {
          const syncResult = await syncVideoSourceSecretsToGithub(githubSettings, {
            youtubeCookies: normalizedYoutubeCookies,
            googlePhotosCookies: normalizedGooglePhotosCookies,
          });
          if (!syncResult.success && syncResult.failed.length > 0) {
            syncWarning = `GitHub sync warnings: ${syncResult.failed.map(f => `${f.name}: ${f.error}`).join(", ")}`;
            console.warn(`[settings] ${syncWarning}`);
          } else if (syncResult.updated.length > 0) {
            console.log(`[settings] GitHub secrets synced: ${syncResult.updated.join(", ")}`);
          }
        }

        return jsonResponse({
          success: true,
          message: "Video source settings saved",
          ...(syncWarning ? { warning: syncWarning } : {}),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Failed to save video source settings";
        return jsonResponse({ success: false, error: errorMsg }, 400);
      }
    }
  }

  if (path === "/api/settings/video-sources/upload" && method === "POST") {
    try {
      const formData = await request.formData();
      const source = String(formData.get("source") || "").trim().toLowerCase();
      const file = formData.get("file") as { name?: string; text?: () => Promise<string> } | null;
      const sourceFieldMap: Record<string, { field: "youtube_cookies" | "google_photos_cookies"; label: string }> = {
        youtube: { field: "youtube_cookies", label: "YouTube cookies" },
        google_photos: { field: "google_photos_cookies", label: "Google Photos cookies" },
      };
      const sourceConfig = sourceFieldMap[source];

      if (!sourceConfig) {
        return jsonResponse({ success: false, error: "Unsupported cookies source" }, 400);
      }

      if (!file || typeof file.text !== "function") {
        return jsonResponse({ success: false, error: "Cookies file is required" }, 400);
      }

      const fileName = file.name || "youtube-cookies.txt";
      if (!fileName.toLowerCase().endsWith(".txt")) {
        return jsonResponse({ success: false, error: "Upload a .txt cookies file" }, 400);
      }

      const rawText = await file.text();
      const normalized = normalizeOptionalCookieValue(rawText, sourceConfig.label);
      if (!normalized) {
        return jsonResponse({ success: false, error: "Uploaded cookies file is empty" }, 400);
      }

      await ensureVideoSourceCookieMetadataColumns(env);
      const diagnostics = buildCookieUploadDiagnostics(normalized, source === "youtube" ? "youtube" : "google_photos", fileName);
      const existing = await getScopedSettings<VideoSourceSettings & { youtube_cookies_meta?: string | null; google_photos_cookies_meta?: string | null }>(env.DB, "video-sources", userId);
      const finalYoutubeCookies = sourceConfig.field === "youtube_cookies" ? normalized : existing?.youtube_cookies || null;
      const finalGooglePhotosCookies = sourceConfig.field === "google_photos_cookies" ? normalized : existing?.google_photos_cookies || null;

      await upsertScopedSettings(env.DB, "settings_video_sources", userId, {
        bunny_api_key: existing?.bunny_api_key || null,
        bunny_library_id: existing?.bunny_library_id || null,
        youtube_cookies: finalYoutubeCookies,
        google_photos_cookies: finalGooglePhotosCookies,
        youtube_cookies_meta: sourceConfig.field === "youtube_cookies" ? JSON.stringify(diagnostics) : existing?.youtube_cookies_meta || null,
        google_photos_cookies_meta: sourceConfig.field === "google_photos_cookies" ? JSON.stringify(diagnostics) : existing?.google_photos_cookies_meta || null,
      });

      // Auto-sync cookies to GitHub Secrets immediately
      const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
      if (githubSettings?.pat_token) {
        const syncResult = await syncVideoSourceSecretsToGithub(githubSettings, {
          youtubeCookies: sourceConfig.field === "youtube_cookies" ? normalized : finalYoutubeCookies,
          googlePhotosCookies: sourceConfig.field === "google_photos_cookies" ? normalized : finalGooglePhotosCookies,
        });
        if (!syncResult.success && syncResult.failed.length > 0) {
          console.warn(`[settings] Upload GitHub secret sync had failures: ${syncResult.failed.map(f => `${f.name}: ${f.error}`).join(", ")}`);
        } else if (syncResult.updated.length > 0) {
          console.log(`[settings] Upload GitHub secrets synced: ${syncResult.updated.join(", ")}`);
        }
      }

      return jsonResponse({
        success: true,
        message: `${sourceConfig.label} uploaded and replaced successfully`,
        data: { source, file_name: fileName, bytes: normalized.length, diagnostics },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Cookies upload failed";
      return jsonResponse({ success: false, error: errorMsg }, 500);
    }
  }

  // VIDEO SOURCE: Refresh cookies to GitHub Secrets (manual re-push of stored DB cookies)
  if (path === "/api/settings/video-sources/refresh-secrets" && method === "POST") {
    try {
      const videoSourceSettings = await getScopedSettings<VideoSourceSettings>(env.DB, "video-sources", userId);
      const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
      if (!githubSettings?.pat_token || !githubSettings.repo_owner || !githubSettings.repo_name) {
        return jsonResponse({ success: false, error: "GitHub settings not configured. Settings -> GitHub Runner me PAT/repo set karein." }, 400);
      }

      const syncResult = await syncVideoSourceSecretsToGithub(githubSettings, {
        youtubeCookies: videoSourceSettings?.youtube_cookies || null,
        googlePhotosCookies: videoSourceSettings?.google_photos_cookies || null,
      });

      const failedDetails = syncResult.failed.length > 0
        ? syncResult.failed.map((f) => `${f.name}: ${f.error}`).join(" | ")
        : null;

      return jsonResponse({
        success: syncResult.success,
        message: failedDetails ? `${syncResult.message} Issues: ${failedDetails}` : syncResult.message,
        data: { updated: syncResult.updated, deleted: syncResult.deleted, failed: syncResult.failed },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to refresh GitHub secrets";
      return jsonResponse({ success: false, error: errorMsg }, 500);
    }
  }

  // VIDEO SOURCE: Live test cookies against the real provider (signed-in verdict)
  if (path === "/api/settings/video-sources/test-cookies" && method === "POST") {
    const body = await safeRequestJson<{ source?: string; cookies?: string }>(request);
    const source = String(body?.source || "").trim().toLowerCase();
    if (source !== "youtube" && source !== "google_photos") {
      return jsonResponse({ success: false, error: "source must be 'youtube' or 'google_photos'" }, 400);
    }

    try {
      let rawCookies = typeof body?.cookies === "string" ? body.cookies.trim() : "";
      if (!rawCookies) {
        const videoSourceSettings = await getScopedSettings<VideoSourceSettings>(env.DB, "video-sources", userId);
        rawCookies = (source === "youtube"
          ? videoSourceSettings?.youtube_cookies
          : videoSourceSettings?.google_photos_cookies) || "";
        rawCookies = rawCookies.trim();
      }

      if (!rawCookies) {
        return jsonResponse({ success: false, error: "No cookies to test. Pehle cookies upload/paste karein." }, 400);
      }

      const result = source === "youtube"
        ? await testYouTubeCookies(rawCookies)
        : await testGooglePhotosCookies(rawCookies);

      return jsonResponse({ success: true, data: { source, ...result } });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Cookie test failed";
      return jsonResponse({ success: false, error: errorMsg }, 500);
    }
  }

  // AI SETTINGS
  if (path === "/api/settings/ai") {
    if (method === "GET") {
      const result = await getScopedSettings<AISettings>(env.DB, "ai", userId);
      return jsonResponse({ success: true, data: result || null });
    }

    if (method === "POST") {
      const body = await safeRequestJson<Partial<AISettings>>(request);
      if (!body) {
        return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
      }

      await upsertScopedSettings(env.DB, "settings_ai", userId, {
        gemini_key: body.gemini_key || null,
        grok_key: body.grok_key || null,
        cohere_key: body.cohere_key || null,
        openrouter_key: body.openrouter_key || null,
        openai_key: body.openai_key || null,
        groq_key: body.groq_key || null,
        elevenlabs_api_key: body.elevenlabs_api_key || null,
        default_provider: body.default_provider || "openai",
      });
      return jsonResponse({ success: true, message: "AI settings saved" });
    }
  }

  // AI KEY TEST
  if (path === "/api/settings/ai/test" && method === "POST") {
    const body = await safeRequestJson<{ provider: string; api_key: string }>(request);
    if (!body || !body.provider || !body.api_key) {
      return jsonResponse({ success: false, error: "provider and api_key required" }, 400);
    }

    const apiKey = body.api_key.trim();
    if (!apiKey) {
      return jsonResponse({ success: false, error: "provider and api_key required" }, 400);
    }

    try {
      let testResult = false;
      let message = "";

      switch (body.provider) {
        case "openai": {
          const res = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          testResult = res.ok;
          message = await buildProviderTestMessage("OpenAI", res);
          break;
        }
        case "gemini": {
          try {
            await testGeminiApiKey(apiKey, aiRuntimeConfig);
            testResult = true;
            message = "Gemini connected successfully";
          } catch (error) {
            testResult = false;
            message = error instanceof Error ? error.message : "Gemini connection failed";
          }
          break;
        }
        case "grok": {
          const res = await fetch("https://api.x.ai/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          testResult = res.ok;
          message = await buildProviderTestMessage("Grok", res);
          break;
        }
        case "cohere": {
          const res = await fetch("https://api.cohere.ai/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          testResult = res.ok;
          message = await buildProviderTestMessage("Cohere", res);
          break;
        }
        case "openrouter": {
          const res = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          testResult = res.ok;
          message = await buildProviderTestMessage("OpenRouter", res);
          break;
        }
        case "groq": {
          const res = await fetch("https://api.groq.com/openai/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          testResult = res.ok;
          message = await buildProviderTestMessage("Groq", res);
          break;
        }
        case "elevenlabs": {
          const res = await fetch("https://api.elevenlabs.io/v1/user", {
            headers: { "xi-api-key": apiKey },
          });
          testResult = res.ok;
          message = await buildProviderTestMessage("ElevenLabs", res);
          break;
        }
        default:
          return jsonResponse({ success: false, error: "Unknown provider" }, 400);
      }

      return jsonResponse({ success: testResult, message });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Connection failed";
      return jsonResponse({ success: false, error: errorMsg });
    }
  }

  // AI MODEL CATALOG
  if (path === "/api/settings/ai/models" && method === "GET") {
    const aiSettings = await getScopedSettings<AISettings>(env.DB, "ai", userId);
    if (!aiSettings) {
      return jsonResponse({
        success: true,
        data: {
          default_provider: null,
          providers: [],
          cloudflare_visual: getCloudflareVisualCatalog(),
        },
      });
    }

    const catalog = await buildAiCatalog(aiSettings, aiRuntimeConfig);
    return jsonResponse({ success: true, data: catalog });
  }

  // AI GENERATE TAGLINES
  if (path === "/api/settings/ai/generate" && method === "POST") {
    const body = await safeRequestJson<{
      task: "taglines" | "social" | "image_banner" | "short_prompt_plan";
      provider?: string;
      model?: string;
      prompt?: string;
      topic?: string;
      platform?: string;
      count?: number;
      focusKeyword?: string;
      brief?: string;
      automationName?: string;
      brandName?: string;
      brandingUrl?: string;
      bannerTitle?: string;
      bannerPrompt?: string;
      bannerProductSummary?: string;
      bannerFormat?: string;
      layout?: string;
    }>(request);

    if (!body || !body.task) {
      return jsonResponse({ success: false, error: "task is required" }, 400);
    }

    if (body.task === "image_banner") {
      try {
        const previewResult = await generateImageBannerPreviewSpecs(env, userId, {
          automationName: String(body.automationName || "Image automation").trim(),
          brandName: String(body.brandName || "").trim(),
          brandingUrl: String(body.brandingUrl || "").trim(),
          bannerTitle: String(body.bannerTitle || "").trim(),
          bannerPrompt: String(body.bannerPrompt || "").trim(),
          bannerProductSummary: String(body.bannerProductSummary || "").trim(),
          bannerFormat: normalizeBannerFormat(body.bannerFormat),
          layout: String(body.layout || "").trim().toLowerCase() === "landscape" ? "landscape" : "portrait",
          providerValue: body.provider,
          modelValue: body.model,
          count: Math.min(Math.max(Number(body.count || 3), 1), 4),
        }, aiRuntimeConfig);

        return jsonResponse({
          success: true,
          data: {
            specs: previewResult.specs,
            provider: previewResult.provider,
            model: previewResult.model,
          },
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Image banner generation failed";
        return jsonResponse({ success: false, error: errorMsg }, 500);
      }
    }

    const aiSettings = await getScopedSettings<AISettings>(env.DB, "ai", userId);
    if (!aiSettings) {
      return jsonResponse({ success: false, error: "No AI settings configured" }, 400);
    }

    const configuredProviders = getConfiguredProviderIds(aiSettings);
    if (configuredProviders.length === 0) {
      return jsonResponse({ success: false, error: "No AI provider API keys saved in Settings" }, 400);
    }

    try {
      const catalog = await buildAiCatalog(aiSettings, aiRuntimeConfig);
      const requestedProvider = body.provider as SupportedAIProvider | undefined;
      const provider = requestedProvider && configuredProviders.includes(requestedProvider)
        ? requestedProvider
        : catalog.default_provider;

      if (!provider) {
        return jsonResponse({ success: false, error: "No configured AI provider available" }, 400);
      }

      const resolvedModel = resolveModelForProvider(provider, body.model, catalog.providers);

      if (body.task === "taglines") {
        const topic = String(body.prompt || body.topic || "").trim();
        const count = Math.min(Math.max(Number(body.count || 5), 1), 10);
        if (!topic) {
          return jsonResponse({ success: false, error: "prompt is required for tagline generation" }, 400);
        }

        const parsed = await generateAiJson(
          aiSettings,
          provider,
          resolvedModel,
          getTaglinesMessages({ topic, count }),
          aiRuntimeConfig
        );
        const normalized = normalizeTaglinesResult(parsed, count, topic);

        return jsonResponse({
          success: true,
          data: {
            ...normalized,
            provider,
            model: resolvedModel,
          },
        });
      }

      if (body.task === "social") {
        const topic = String(body.topic || body.prompt || "").trim();
        const platform = String(body.platform || "instagram").trim();
        const count = Math.min(Math.max(Number(body.count || 10), 1), 50);
        const focusKeyword = String(body.focusKeyword || "").trim();
        const brief = String(body.brief || "").trim();

        if (!topic) {
          return jsonResponse({ success: false, error: "topic is required for social generation" }, 400);
        }

        const parsed = await generateAiJson(
          aiSettings,
          provider,
          resolvedModel,
          getSocialMessages({ topic, platform, count, focusKeyword, brief }),
          aiRuntimeConfig
        );
        const normalized = normalizeSocialResult(parsed, count, platform);

        return jsonResponse({
          success: true,
          data: {
            ...normalized,
            provider,
            model: resolvedModel,
          },
        });
      }

      if (body.task === "short_prompt_plan") {
        const prompt = String(body.prompt || body.topic || "").trim();
        if (!prompt) {
          return jsonResponse({ success: false, error: "prompt is required for short prompt planning" }, 400);
        }

        const parsed = await generateAiJson(
          aiSettings,
          provider,
          resolvedModel,
          getShortPromptPlanMessages({ prompt }),
          aiRuntimeConfig
        );
        const normalized = normalizeShortPromptPlanResult(parsed);

        return jsonResponse({
          success: true,
          data: {
            plan: normalized,
            provider,
            model: resolvedModel,
          },
        });
      }

      return jsonResponse({ success: false, error: "Unknown AI generation task" }, 400);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "AI generation failed";
      return jsonResponse({ success: false, error: errorMsg });
    }
  }

  return jsonResponse({ success: false, error: "Settings route not found" }, 404);
}
