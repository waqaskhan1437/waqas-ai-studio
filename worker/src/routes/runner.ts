import { AISettings, AuthContext, Env, PostformeSettings, TailscaleSettings, User, VideoSourceSettings } from "../types";
import { jsonResponse, safeRequestJson } from "../utils";
import { createOpaqueToken, findUserByRunnerToken, hashToken, requireAdmin } from "../services/auth";
import { markAutomationRunCompleted } from "../services/automation-scheduler";
import { getScopedSettings, upsertScopedSettings } from "../services/user-settings";

const STALE_LOCAL_JOB_MINUTES = 15;
const STALE_RUNNER_COMMAND_MINUTES = 15;
const RUNNER_COMMAND_TYPES = new Set([
  "restart_runner", 
  "run_setup", 
  "sync_runner_code", 
  "refresh_remote_access",
  "process_image",
  "upload_media", 
  "fetch_videos",
  "execute_script"
]);

type RunnerIdentity = {
  user: User | null;
  error?: string;
};

type RunnerPresencePayload = {
  hostname?: string;
  startedAt?: string;
  platform?: string;
  version?: string;
  status?: string;
  tailscale?: {
    installed?: boolean;
    status?: string | null;
    ip?: string | null;
    dnsName?: string | null;
  };
  ssh?: {
    enabled?: boolean;
    status?: string | null;
    target?: string | null;
  };
};

function isRunnerEligible(user: User | null): user is User {
  return Boolean(user && user.role !== "admin" && user.status === "active");
}

async function loadRunnerUser(env: Env, token: string): Promise<RunnerIdentity> {
  if (!token) {
    return { user: null };
  }
  const runnerUser = await findUserByRunnerToken(env, token);
  if (runnerUser) {
    if (!isRunnerEligible(runnerUser)) {
      return { user: null, error: "Admin accounts cannot be used as local runners. Use a generated user runner token." };
    }
    return { user: runnerUser };
  }

  return { user: null };
}

function getRequiredRunnerToken(payload: { token?: string } | null | undefined): string {
  return typeof payload?.token === "string" ? payload.token.trim() : "";
}

function getRunnerAuthError(identity: RunnerIdentity, fallbackMessage: string): Response {
  return jsonResponse(
    { success: false, error: identity.error || fallbackMessage },
    identity.error ? 403 : 401
  );
}

function buildInClausePlaceholders(values: number[]): string {
  return values.map(() => "?").join(", ");
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBooleanFlag(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

async function getEffectiveTailscaleSettings(env: Env, userId: number): Promise<TailscaleSettings | null> {
  try {
    const userSettings = await getScopedSettings<TailscaleSettings>(env.DB, "tailscale", userId);
    if (userSettings) {
      return userSettings;
    }

    const adminSettings = await env.DB.prepare(
      `SELECT s.*
       FROM settings_tailscale s
       INNER JOIN users u ON u.id = s.user_id
       WHERE u.role = 'admin' AND u.status = 'active'
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT 1`
    ).first<TailscaleSettings>();

    return adminSettings || null;
  } catch {
    return null;
  }
}

async function updateRunnerPresence(
  env: Env,
  userId: number,
  payload: RunnerPresencePayload,
  fallbackStatus: string
): Promise<void> {
  const hostname = toNullableString(payload.hostname);
  const startedAt = toNullableString(payload.startedAt);
  const platform = toNullableString(payload.platform);
  const version = toNullableString(payload.version);
  const runnerStatus = toNullableString(payload.status) || fallbackStatus;
  const tailscaleStatus = normalizeBooleanFlag(payload.tailscale?.installed, false)
    ? (toNullableString(payload.tailscale?.status) || "connected")
    : "not_installed";
  const tailscaleIp = toNullableString(payload.tailscale?.ip);
  const tailscaleDnsName = toNullableString(payload.tailscale?.dnsName);
  const sshStatus = normalizeBooleanFlag(payload.ssh?.enabled, false)
    ? (toNullableString(payload.ssh?.status) || "enabled")
    : "disabled";
  const sshTarget = toNullableString(payload.ssh?.target);

  try {
    await env.DB.prepare(
      `UPDATE users
       SET updated_at = CURRENT_TIMESTAMP,
           runner_hostname = COALESCE(?, runner_hostname),
           runner_status = ?,
           runner_started_at = COALESCE(?, runner_started_at),
           runner_last_seen_at = CURRENT_TIMESTAMP,
           runner_platform = COALESCE(?, runner_platform),
           runner_version = COALESCE(?, runner_version),
           tailscale_status = ?,
           tailscale_ip = ?,
           tailscale_dns_name = ?,
           ssh_status = ?,
           ssh_target = ?
       WHERE id = ?`
    ).bind(
      hostname,
      runnerStatus,
      startedAt,
      platform,
      version,
      tailscaleStatus,
      tailscaleIp,
      tailscaleDnsName,
      sshStatus,
      sshTarget,
      userId
    ).run();
  } catch {
    await env.DB.prepare(
      "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(userId).run();
  }
}

async function runRunnerRemoteAccessMigration(env: Env): Promise<{ applied: string[]; skipped: string[] }> {
  const statements = [
    "ALTER TABLE users ADD COLUMN runner_hostname TEXT",
    "ALTER TABLE users ADD COLUMN runner_status TEXT",
    "ALTER TABLE users ADD COLUMN runner_started_at DATETIME",
    "ALTER TABLE users ADD COLUMN runner_last_seen_at DATETIME",
    "ALTER TABLE users ADD COLUMN runner_platform TEXT",
    "ALTER TABLE users ADD COLUMN runner_version TEXT",
    "ALTER TABLE users ADD COLUMN tailscale_status TEXT",
    "ALTER TABLE users ADD COLUMN tailscale_ip TEXT",
    "ALTER TABLE users ADD COLUMN tailscale_dns_name TEXT",
    "ALTER TABLE users ADD COLUMN ssh_status TEXT",
    "ALTER TABLE users ADD COLUMN ssh_target TEXT",
    `CREATE TABLE IF NOT EXISTS settings_tailscale (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      auth_key TEXT,
      tailnet TEXT,
      device_tag TEXT,
      hostname_prefix TEXT,
      auto_install INTEGER DEFAULT 0,
      ssh_enabled INTEGER DEFAULT 1,
      unattended INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_settings_tailscale_user ON settings_tailscale(user_id)",
`CREATE TABLE IF NOT EXISTS runner_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  requested_by_user_id INTEGER,
  command_type TEXT NOT NULL CHECK(command_type IN ('restart_runner','run_setup','sync_runner_code','refresh_remote_access','process_image','upload_media','fetch_videos','execute_script')),
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
  result_text TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id)
)`,
    "CREATE INDEX IF NOT EXISTS idx_runner_commands_user_status ON runner_commands(user_id, status, created_at)",
  ];

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const statement of statements) {
    try {
      await env.DB.prepare(statement).run();
      applied.push(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("duplicate column name") || message.includes("already exists")) {
        skipped.push(statement);
        continue;
      }

      throw error;
    }
  }

  return { applied, skipped };
}

async function copyUserScopedSettings(env: Env, sourceUserId: number, targetUserId: number): Promise<void> {
  const postforme = await getScopedSettings<PostformeSettings>(env.DB, "postforme", sourceUserId);
  if (postforme) {
    await upsertScopedSettings(env.DB, "settings_postforme", targetUserId, {
      api_key: postforme.api_key,
      platforms: postforme.platforms,
      saved_accounts: postforme.saved_accounts,
      default_schedule: postforme.default_schedule,
    });
  }

  const videoSources = await getScopedSettings<VideoSourceSettings>(env.DB, "video-sources", sourceUserId);
  if (videoSources) {
    await upsertScopedSettings(env.DB, "settings_video_sources", targetUserId, {
      bunny_api_key: videoSources.bunny_api_key || null,
      bunny_library_id: videoSources.bunny_library_id || null,
      youtube_cookies: videoSources.youtube_cookies || null,
      google_photos_cookies: videoSources.google_photos_cookies || null,
    });
  }

  const ai = await getScopedSettings<AISettings>(env.DB, "ai", sourceUserId);
  if (ai) {
    await upsertScopedSettings(env.DB, "settings_ai", targetUserId, {
      gemini_key: ai.gemini_key || null,
      grok_key: ai.grok_key || null,
      cohere_key: ai.cohere_key || null,
      openrouter_key: ai.openrouter_key || null,
      openai_key: ai.openai_key || null,
      groq_key: ai.groq_key || null,
      elevenlabs_api_key: ai.elevenlabs_api_key || null,
      default_provider: ai.default_provider || "openai",
    });
  }
}

async function moveAdminWorkspaceData(env: Env, sourceUserId: number, targetUserId: number): Promise<{
  automations: number;
  jobs: number;
  uploads: number;
  processedVideos: number;
}> {
  const automationRows = await env.DB.prepare(
    "SELECT id FROM automations WHERE user_id = ? ORDER BY id ASC"
  ).bind(sourceUserId).all<{ id: number }>();
  const automationIds = (automationRows.results || []).map((row) => row.id);

  if (automationIds.length === 0) {
    return {
      automations: 0,
      jobs: 0,
      uploads: 0,
      processedVideos: 0,
    };
  }

  const automationPlaceholders = buildInClausePlaceholders(automationIds);
  const jobRows = await env.DB.prepare(
    `SELECT id FROM jobs WHERE user_id = ? AND automation_id IN (${automationPlaceholders}) ORDER BY id ASC`
  ).bind(sourceUserId, ...automationIds).all<{ id: number }>();
  const jobIds = (jobRows.results || []).map((row) => row.id);

  const automationsResult = await env.DB.prepare(
    `UPDATE automations
     SET user_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND id IN (${automationPlaceholders})`
  ).bind(targetUserId, sourceUserId, ...automationIds).run();

  const processedVideosResult = await env.DB.prepare(
    `UPDATE processed_videos
     SET user_id = ?
     WHERE user_id = ? AND automation_id IN (${automationPlaceholders})`
  ).bind(targetUserId, sourceUserId, ...automationIds).run();

  let jobsChanged = 0;
  let uploadsChanged = 0;

  if (jobIds.length > 0) {
    const jobPlaceholders = buildInClausePlaceholders(jobIds);

    const jobsResult = await env.DB.prepare(
      `UPDATE jobs
       SET user_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND id IN (${jobPlaceholders})`
    ).bind(targetUserId, sourceUserId, ...jobIds).run();
    jobsChanged = Number(jobsResult.meta.changes || 0);

    const uploadsResult = await env.DB.prepare(
      `UPDATE video_uploads
       SET user_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND job_id IN (${jobPlaceholders})`
    ).bind(targetUserId, sourceUserId, ...jobIds).run();
    uploadsChanged = Number(uploadsResult.meta.changes || 0);
  }

  return {
    automations: Number(automationsResult.meta.changes || 0),
    jobs: jobsChanged,
    uploads: uploadsChanged,
    processedVideos: Number(processedVideosResult.meta.changes || 0),
  };
}

async function runDeleteIfTableExists(
  env: Env,
  query: string,
  bindings: Array<string | number>
): Promise<void> {
  try {
    await env.DB.prepare(query).bind(...bindings).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) {
      return;
    }
    throw error;
  }
}

async function deleteUserWorkspace(env: Env, userId: number): Promise<void> {
  const automationRows = await env.DB.prepare(
    "SELECT id FROM automations WHERE user_id = ? ORDER BY id ASC"
  ).bind(userId).all<{ id: number }>();
  const automationIds = (automationRows.results || []).map((row) => row.id);

  const jobRows = await env.DB.prepare(
    "SELECT id FROM jobs WHERE user_id = ? ORDER BY id ASC"
  ).bind(userId).all<{ id: number }>();
  const jobIds = (jobRows.results || []).map((row) => row.id);

  if (jobIds.length > 0) {
    const jobPlaceholders = buildInClausePlaceholders(jobIds);
    await env.DB.prepare(
      `DELETE FROM video_uploads WHERE user_id = ? AND job_id IN (${jobPlaceholders})`
    ).bind(userId, ...jobIds).run();
    await runDeleteIfTableExists(env, `DELETE FROM video_queue WHERE job_id IN (${jobPlaceholders})`, jobIds);
  }

  if (automationIds.length > 0) {
    const automationPlaceholders = buildInClausePlaceholders(automationIds);
    await runDeleteIfTableExists(
      env,
      `DELETE FROM processed_videos WHERE user_id = ? AND automation_id IN (${automationPlaceholders})`,
      [userId, ...automationIds]
    );
  } else {
    await runDeleteIfTableExists(env, "DELETE FROM processed_videos WHERE user_id = ?", [userId]);
  }

  await env.DB.prepare("DELETE FROM runner_commands WHERE user_id = ? OR requested_by_user_id = ?").bind(userId, userId).run();
  await env.DB.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM api_audit_logs WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM settings_postforme WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM settings_github WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM settings_video_sources WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM settings_ai WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM settings_tailscale WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM video_uploads WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM jobs WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM automations WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}

export async function handleRunnerRoutes(
  request: Request,
  env: Env,
  path: string,
  method: string,
  auth: AuthContext | null
): Promise<Response> {
  const adminError = requireAdmin(request, env, auth);

  if (path === "/api/admin/users" && method === "GET") {
    if (adminError) {
      return adminError;
    }

    let result;
    try {
      result = await env.DB.prepare(
        `SELECT id, name, email, role, status, created_at, updated_at, last_login_at, revoked_at,
                runner_hostname, runner_status, runner_started_at, runner_last_seen_at,
                runner_platform, runner_version, tailscale_status, tailscale_ip,
                tailscale_dns_name, ssh_status, ssh_target
         FROM users
         ORDER BY created_at DESC`
      ).all();
    } catch {
      result = await env.DB.prepare(
        "SELECT id, name, email, role, status, created_at, updated_at, last_login_at, revoked_at FROM users ORDER BY created_at DESC"
      ).all();
    }
    return jsonResponse({ success: true, data: result.results || [] });
  }

  if (path === "/api/admin/users" && method === "POST") {
    if (adminError) {
      return adminError;
    }

    const body = await safeRequestJson<{ name?: string; email?: string | null }>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    const name = body.name?.trim();
    if (!name) {
      return jsonResponse({ success: false, error: "name is required" }, 400);
    }

    const accessToken = createOpaqueToken("atk");
    const runnerToken = createOpaqueToken("rnr");
    const accessTokenHash = await hashToken(accessToken);
    const runnerTokenHash = await hashToken(runnerToken);

    const result = await env.DB.prepare(
      "INSERT INTO users (name, email, role, access_token_hash, runner_token_hash, status) VALUES (?, ?, 'user', ?, ?, 'active')"
    ).bind(name, body.email || null, accessTokenHash, runnerTokenHash).run();

    return jsonResponse({
      success: true,
      data: {
        id: result.meta.last_row_id,
        name,
        email: body.email || null,
        access_token: accessToken,
        runner_token: runnerToken,
      },
      message: "User created",
    }, 201);
  }

  if (path === "/api/admin/users/bootstrap-local-workspace" && method === "POST") {
    if (adminError) {
      return adminError;
    }

    const body = await safeRequestJson<{
      name?: string;
      email?: string | null;
      copy_settings?: boolean;
      move_existing_data?: boolean;
    }>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    const name = body.name?.trim() || "Local Runner User";
    const accessToken = createOpaqueToken("atk");
    const runnerToken = createOpaqueToken("rnr");
    const accessTokenHash = await hashToken(accessToken);
    const runnerTokenHash = await hashToken(runnerToken);

    const result = await env.DB.prepare(
      "INSERT INTO users (name, email, role, access_token_hash, runner_token_hash, status) VALUES (?, ?, 'user', ?, ?, 'active')"
    ).bind(name, body.email || null, accessTokenHash, runnerTokenHash).run();

    const newUserId = Number(result.meta.last_row_id);

    if ((body.copy_settings ?? true) && auth) {
      await copyUserScopedSettings(env, auth.userId, newUserId);
    }

    const moved = (body.move_existing_data ?? true) && auth
      ? await moveAdminWorkspaceData(env, auth.userId, newUserId)
      : { automations: 0, jobs: 0, uploads: 0, processedVideos: 0 };

    return jsonResponse({
      success: true,
      data: {
        id: newUserId,
        name,
        email: body.email || null,
        access_token: accessToken,
        runner_token: runnerToken,
        migrated: moved,
      },
      message: "Local workspace user created",
    }, 201);
  }

  if (path.match(/^\/api\/admin\/users\/\d+\/tokens\/rotate$/) && method === "POST") {
    if (adminError) {
      return adminError;
    }

    const userId = Number(path.split("/")[4]);
    const accessToken = createOpaqueToken("atk");
    const runnerToken = createOpaqueToken("rnr");

    await env.DB.prepare(
      "UPDATE users SET access_token_hash = ?, runner_token_hash = ?, status = 'active', revoked_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(await hashToken(accessToken), await hashToken(runnerToken), userId).run();

    return jsonResponse({
      success: true,
      data: {
        user_id: userId,
        access_token: accessToken,
        runner_token: runnerToken,
      },
      message: "Tokens rotated",
    });
  }

  if (path.match(/^\/api\/admin\/users\/\d+\/revoke$/) && method === "POST") {
    if (adminError) {
      return adminError;
    }

    const userId = Number(path.split("/")[4]);
    await env.DB.prepare(
      "UPDATE users SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(userId).run();

    return jsonResponse({ success: true, message: "User revoked" });
  }

  if (path.match(/^\/api\/admin\/users\/\d+$/) && method === "DELETE") {
    if (adminError) {
      return adminError;
    }

    const userId = Number(path.split("/")[4]);
    const user = await env.DB.prepare(
      "SELECT id, role FROM users WHERE id = ? LIMIT 1"
    ).bind(userId).first<{ id: number; role: string }>();

    if (!user?.id) {
      return jsonResponse({ success: false, error: "User not found" }, 404);
    }

    if (user.role === "admin") {
      return jsonResponse({ success: false, error: "Admin users cannot be deleted from this screen" }, 400);
    }

    if (auth?.userId === userId) {
      return jsonResponse({ success: false, error: "You cannot delete your own account" }, 400);
    }

    await deleteUserWorkspace(env, userId);
    return jsonResponse({ success: true, message: "User deleted" });
  }

  if (path.match(/^\/api\/admin\/users\/\d+\/commands$/) && method === "GET") {
    if (adminError) {
      return adminError;
    }

    const userId = Number(path.split("/")[4]);
    try {
      const result = await env.DB.prepare(
        `SELECT id, user_id, requested_by_user_id, command_type, payload, status, result_text, error_message, created_at, started_at, completed_at, updated_at
         FROM runner_commands
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 20`
      ).bind(userId).all();
      return jsonResponse({ success: true, data: result.results || [] });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to load runner commands";
      return jsonResponse({ success: false, error: errorMsg }, 500);
    }
  }

  if (path.match(/^\/api\/admin\/users\/\d+\/commands$/) && method === "POST") {
    if (adminError) {
      return adminError;
    }

    const targetUserId = Number(path.split("/")[4]);
    const body = await safeRequestJson<{
      command_type?: string;
      payload?: Record<string, unknown> | null;
    }>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    const commandType = String(body.command_type || "").trim();
    const payload = body.payload;

    if (!RUNNER_COMMAND_TYPES.has(commandType)) {
      return jsonResponse({ success: false, error: "Unsupported command type" }, 400);
    }

    // Enhanced validation for new command types
    if (commandType === "process_image") {
      if (!payload || typeof payload !== 'object') {
        return jsonResponse({ success: false, error: "Image processing requires a payload object" }, 400);
      }
      if (!payload.image_url || typeof payload.image_url !== 'string') {
        return jsonResponse({ success: false, error: "image_url is required for image processing" }, 400);
      }
    }

    if (commandType === "upload_media") {
      if (!payload || typeof payload !== 'object') {
        return jsonResponse({ success: false, error: "Media upload requires a payload object" }, 400);
      }
      if (!payload.file_url || typeof payload.file_url !== 'string') {
        return jsonResponse({ success: false, error: "file_url is required for media upload" }, 400);
      }
      if (payload.platforms && !Array.isArray(payload.platforms)) {
        return jsonResponse({ success: false, error: "platforms must be an array" }, 400);
      }
    }

    if (commandType === "fetch_videos") {
      if (!payload || typeof payload !== 'object') {
        return jsonResponse({ success: false, error: "Video fetching requires a payload object" }, 400);
      }
      if (!payload.source_url || typeof payload.source_url !== 'string') {
        return jsonResponse({ success: false, error: "source_url is required for video fetching" }, 400);
      }
    }

    if (commandType === "execute_script") {
      if (!payload || typeof payload !== 'object') {
        return jsonResponse({ success: false, error: "Script execution requires a payload object" }, 400);
      }
      if (!payload.script || typeof payload.script !== 'string') {
        return jsonResponse({ success: false, error: "script is required for execution" }, 400);
      }
      // Security: Only allow certain safe script types
      if (!['javascript', 'python', 'bash'].includes((payload.type as string) || '')) {
        return jsonResponse({ success: false, error: "Unsupported script type. Allowed: javascript, python, bash" }, 400);
      }
    }

    const userExists = await env.DB.prepare(
      "SELECT id FROM users WHERE id = ? LIMIT 1"
    ).bind(targetUserId).first<{ id: number }>();

    if (!userExists?.id) {
      return jsonResponse({ success: false, error: "User not found" }, 404);
    }

    try {
      const payload = body.payload && typeof body.payload === "object" ? JSON.stringify(body.payload) : null;
      const result = await env.DB.prepare(
        `INSERT INTO runner_commands (user_id, requested_by_user_id, command_type, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).bind(targetUserId, auth?.userId || null, commandType, payload).run();

      return jsonResponse({
        success: true,
        data: {
          id: Number(result.meta.last_row_id),
          user_id: targetUserId,
          command_type: commandType,
          payload: body.payload || null,
          status: "pending",
        },
        message: "Runner command queued",
      }, 201);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to queue runner command";
      return jsonResponse({ success: false, error: errorMsg }, 500);
    }
  }

  if (path === "/api/admin/system/runner-remote-access/migrate" && method === "POST") {
    if (adminError) {
      return adminError;
    }

    const result = await runRunnerRemoteAccessMigration(env);
    return jsonResponse({
      success: true,
      data: result,
      message: "Runner remote access schema migration completed",
    });
  }

  if (path === "/api/runner/bootstrap" && method === "POST") {
    const body = await safeRequestJson<{ token?: string }>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    const authToken = getRequiredRunnerToken(body);
    if (!authToken) {
      return jsonResponse({ success: false, error: "Runner token required" }, 400);
    }

    const identity = await loadRunnerUser(env, authToken);
    if (!identity.user) {
      return getRunnerAuthError(identity, "Invalid or revoked runner token");
    }

    const tailscale = await getEffectiveTailscaleSettings(env, identity.user.id);
    const autoInstall = normalizeBooleanFlag(tailscale?.auto_install, false);
    const sshEnabled = normalizeBooleanFlag(tailscale?.ssh_enabled, true);
    const unattended = normalizeBooleanFlag(tailscale?.unattended, true);

    return jsonResponse({
      success: true,
      data: {
        tailscale: {
          auto_install: autoInstall,
          auth_key: autoInstall ? toNullableString(tailscale?.auth_key) : null,
          tailnet: toNullableString(tailscale?.tailnet),
          device_tag: toNullableString(tailscale?.device_tag),
          hostname_prefix: toNullableString(tailscale?.hostname_prefix),
          ssh_enabled: sshEnabled,
          unattended,
          ssh_mode: "openssh",
          windows_note: "Windows runners use OpenSSH over the Tailscale network; Tailscale SSH server is not available on Windows.",
        },
      },
    });
  }

  if (path === "/api/runner/register" && method === "POST") {
    const body = await safeRequestJson<{ token?: string } & RunnerPresencePayload>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    const runnerToken = getRequiredRunnerToken(body);
    if (!runnerToken) {
      return jsonResponse({ success: false, error: "Runner token required" }, 400);
    }

    const identity = await loadRunnerUser(env, runnerToken);
    if (!identity.user) {
      return getRunnerAuthError(identity, "Invalid or revoked runner token");
    }
    const user = identity.user;

    await updateRunnerPresence(env, user.id, body, "online");

    return jsonResponse({
      success: true,
      data: {
        user_id: user.id,
        hostname: body.hostname || "unknown",
        started_at: body.startedAt || new Date().toISOString(),
      },
      message: "Runner registered successfully",
    });
  }

  if (path === "/api/runner/identity" && method === "GET") {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    const identity = await loadRunnerUser(env, token);
    if (!identity.user) {
      return getRunnerAuthError(identity, "Invalid runner token");
    }
    const user = identity.user;

    return jsonResponse({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          status: user.status,
          role: user.role,
          is_admin: user.role === "admin",
        },
      },
      message: "Runner identity resolved",
    });
  }

  if (path === "/api/runner/heartbeat" && method === "POST") {
    const body = await safeRequestJson<{ token?: string } & RunnerPresencePayload>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    const authToken = getRequiredRunnerToken(body);
    if (!authToken) {
      return jsonResponse({ success: false, error: "Runner token required" }, 400);
    }

    const identity = await loadRunnerUser(env, authToken);
    if (!identity.user) {
      return getRunnerAuthError(identity, "Invalid or revoked runner token");
    }
    const user = identity.user;

    await updateRunnerPresence(env, user.id, body, body.status || "online");

    return jsonResponse({ success: true, message: "Heartbeat received", data: { status: body.status || "online" } });
  }

  if (path === "/api/runner/queue-count" && method === "GET") {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    const identity = await loadRunnerUser(env, token);
    if (!identity.user) {
      return jsonResponse({ success: true, data: 0 });
    }

    try {
      const result = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM jobs
         WHERE user_id = ?
           AND status IN ('pending', 'queued')
           AND github_run_id IS NULL`
      ).bind(identity.user.id).first<{ count: number }>();

      return jsonResponse({ success: true, data: result?.count || 0 });
    } catch (error) {
      return jsonResponse({ success: true, data: 0 });
    }
  }

  if (path === "/api/runner/commands" && method === "GET") {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    const identity = await loadRunnerUser(env, token);
    if (!identity.user) {
      return getRunnerAuthError(identity, "Invalid runner token");
    }
    const user = identity.user;

    try {
      const pendingCommand = await env.DB.prepare(
        `SELECT id, command_type, payload
         FROM runner_commands
         WHERE user_id = ?
           AND (
             status = 'pending'
             OR (
               status = 'running'
               AND updated_at <= datetime('now', ?)
             )
           )
         ORDER BY
           CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
           created_at ASC
         LIMIT 1`
      ).bind(user.id, `-${STALE_RUNNER_COMMAND_MINUTES} minutes`).first<{ id: number; command_type: string; payload: string | null }>();

      if (!pendingCommand?.id) {
        return jsonResponse({ success: true, data: null });
      }

      await env.DB.prepare(
        `UPDATE runner_commands
         SET status = 'running',
             started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
             error_message = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`
      ).bind(pendingCommand.id, user.id).run();

      let payload: Record<string, unknown> | null = null;
      try {
        payload = pendingCommand.payload ? JSON.parse(pendingCommand.payload) as Record<string, unknown> : null;
      } catch {}

      return jsonResponse({
        success: true,
        data: {
          id: pendingCommand.id,
          command_type: pendingCommand.command_type,
          payload,
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to fetch runner commands";
      return jsonResponse({ success: false, error: errorMsg }, 500);
    }
  }

  if (path.match(/^\/api\/runner\/commands\/[0-9]+\/complete$/) && method === "POST") {
    const commandId = Number(path.split("/")[4]);
    const body = await safeRequestJson<{
      token?: string;
      success?: boolean;
      result?: unknown;
      error?: string | null;
    }>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    const runnerToken = getRequiredRunnerToken(body);
    if (!runnerToken) {
      return jsonResponse({ success: false, error: "Runner token required" }, 400);
    }
    const identity = await loadRunnerUser(env, runnerToken);
    if (!identity.user) {
      return getRunnerAuthError(identity, "Invalid runner token");
    }
    const user = identity.user;

    const commandRecord = await env.DB.prepare(
      "SELECT id FROM runner_commands WHERE id = ? AND user_id = ? LIMIT 1"
    ).bind(commandId, user.id).first<{ id: number }>();

    if (!commandRecord?.id) {
      return jsonResponse({ success: false, error: "Command not found" }, 404);
    }

    const resultText = body.result == null
      ? null
      : typeof body.result === "string"
      ? body.result
      : JSON.stringify(body.result);

    await env.DB.prepare(
      `UPDATE runner_commands
       SET status = ?,
           result_text = ?,
           error_message = ?,
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`
    ).bind(
      body.success === false ? "failed" : "completed",
      resultText,
      body.success === false ? (body.error || "Runner command failed") : null,
      commandId,
      user.id
    ).run();

    return jsonResponse({ success: true, message: "Runner command updated" });
  }

  if (path === "/api/runner/jobs" && method === "GET") {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    const identity = await loadRunnerUser(env, token);
    if (!identity.user) {
      return getRunnerAuthError(identity, "Invalid runner token or not registered");
    }
    const user = identity.user;

    const pendingJob = await env.DB.prepare(
      `SELECT j.id, j.automation_id, j.input_data, j.output_data, a.config AS automation_config, a.type AS automation_type
       FROM jobs j
       INNER JOIN automations a ON a.id = j.automation_id
       WHERE j.user_id = ?
         AND (
           j.status IN ('pending', 'queued')
           OR (
             j.status = 'running'
             AND j.github_run_id IS NULL
             AND j.updated_at <= datetime('now', ?)
           )
         )
       ORDER BY
         CASE
           WHEN j.status IN ('pending', 'queued') THEN 0
           ELSE 1
         END,
         j.created_at ASC
       LIMIT 1`
    ).bind(user.id, `-${STALE_LOCAL_JOB_MINUTES} minutes`).first<{ id: number; automation_id: number; input_data: string | null; output_data: string | null; automation_config: string | null; automation_type: string | null }>();

    if (!pendingJob?.id) {
      return jsonResponse({ success: true, data: null });
    }

    await env.DB.prepare(
      "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
    ).bind(pendingJob.id, user.id).run();

    let parsedInputData: Record<string, unknown> = {};
    let parsedConfig: Record<string, unknown> = {};
    try {
      parsedInputData = pendingJob.input_data ? JSON.parse(pendingJob.input_data) : {};
    } catch {}
    try {
      parsedConfig = pendingJob.automation_config ? JSON.parse(pendingJob.automation_config) : {};
    } catch {}

    // Fetch AI settings (API keys) so the runner can pass them to the dubbing pipeline
    let aiSettings: Record<string, string | null> | null = null;
    try {
      const settings = await getScopedSettings<AISettings>(env.DB, "ai", user.id);
      if (settings) {
        aiSettings = {
          openai_key: settings.openai_key || null,
          gemini_key: settings.gemini_key || null,
          grok_key: settings.grok_key || null,
          cohere_key: settings.cohere_key || null,
          openrouter_key: settings.openrouter_key || null,
          groq_key: settings.groq_key || null,
          elevenlabs_api_key: settings.elevenlabs_api_key || null,
          default_provider: settings.default_provider || "openai",
        };
      }
    } catch {
      // Non-critical — runner falls back to env vars or placeholders
    }

    return jsonResponse({
      success: true,
      data: {
        id: pendingJob.id,
        automation_id: pendingJob.automation_id,
        automation_type: pendingJob.automation_type || "video",
        input_data: parsedInputData,
        config: parsedConfig,
        ai_settings: aiSettings,
      },
    });
  }

  if (path.match(/^\/api\/runner\/jobs\/[0-9]+\/complete$/) && method === "POST") {
    const jobId = Number(path.split("/")[4]);
    const body = await safeRequestJson<{ token?: string; success?: boolean; result?: unknown; video_url?: string | null; source_video_url?: string | null; aspect_ratio?: string | null; error?: string | null; command_type?: string; command_id?: number }>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    const runnerToken = getRequiredRunnerToken(body);
    if (!runnerToken) {
      return jsonResponse({ success: false, error: "Runner token required" }, 400);
    }
    const identity = await loadRunnerUser(env, runnerToken);

    if (!identity.user) {
      return getRunnerAuthError(identity, "Invalid runner token");
    }
    const user = identity.user;

    const jobRecord = await env.DB.prepare(
      "SELECT id, automation_id FROM jobs WHERE id = ? AND user_id = ? LIMIT 1"
    ).bind(jobId, user.id).first<{ id: number; automation_id: number }>();

    if (!jobRecord) {
      return jsonResponse({ success: false, error: "Job not found" }, 404);
    }

    await env.DB.prepare(
      "UPDATE jobs SET status = ?, output_data = ?, video_url = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
    ).bind(
      body.success ? "success" : "failed",
      body.result ? JSON.stringify(body.result) : null,
      body.video_url || null,
      body.success ? null : (body.error || "Local runner job failed"),
      jobId,
      user.id
    ).run();

    if (body.success && body.source_video_url) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO processed_videos (user_id, automation_id, video_url, job_id, processed_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"
      ).bind(user.id, jobRecord.automation_id, body.source_video_url, jobId).run();
    }

    const resultRecord = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : null;
    const aspectRatio = typeof resultRecord?.aspect_ratio === "string"
      ? resultRecord.aspect_ratio
      : (body.aspect_ratio || "9:16");
    const commandId = body.command_id;

    // Handle successful completion of new command types
    if (body.success && commandId) {
      if (body.command_type === "process_image" && body.result) {
        // Store processed image result
        const processedImageResult = typeof body.result === "string" 
          ? { processed_url: body.result } 
          : (body.result as Record<string, unknown>);
        
        await env.DB.prepare(
          "UPDATE runner_commands SET result_text = ? WHERE id = ?"
        ).bind(JSON.stringify(processedImageResult), commandId).run();
      }
      
      if (body.command_type === "upload_media" && body.result) {
        // Store upload result and potentially create video upload record
        const uploadResult = typeof body.result === "string"
          ? { uploaded_url: body.result }
          : (body.result as Record<string, unknown>);
          
        if (body.video_url) {
          await env.DB.prepare(
            "INSERT INTO video_uploads (user_id, job_id, postforme_id, media_url, upload_status, post_status, aspect_ratio) VALUES (?, ?, NULL, ?, 'uploaded', 'pending', ?)"
          ).bind(user.id, jobId, body.video_url, aspectRatio).run();
        }
        
        await env.DB.prepare(
          "UPDATE runner_commands SET result_text = ? WHERE id = ?"
        ).bind(JSON.stringify(uploadResult), commandId).run();
      }
      
      if (body.command_type === "fetch_videos" && body.result) {
        // Store fetched videos list
        const fetchResult = Array.isArray(body.result) 
          ? { video_urls: body.result, count: body.result.length }
          : (typeof body.result === "object" ? body.result : { result: body.result });
          
        await env.DB.prepare(
          "UPDATE runner_commands SET result_text = ? WHERE id = ?"
        ).bind(JSON.stringify(fetchResult), commandId).run();
      }
    }

    if (body.success && body.video_url) {
      await env.DB.prepare(
        "INSERT INTO video_uploads (user_id, job_id, postforme_id, media_url, upload_status, post_status, aspect_ratio) VALUES (?, ?, NULL, ?, 'uploaded', 'pending', ?)"
      ).bind(user.id, jobId, body.video_url, aspectRatio).run();
    }

    await markAutomationRunCompleted(env, jobId, new Date());

    return jsonResponse({ success: true, message: "Job status updated" });
  }

  if (path === "/api/user/config" && method === "GET") {
    if (!auth) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const config = await env.DB.prepare(
      "SELECT id, name, email, status, created_at, updated_at, last_login_at FROM users WHERE id = ? LIMIT 1"
    ).bind(auth.userId).first();

    return jsonResponse({ success: true, data: config || {} });
  }

  if (path === "/api/user/config" && method === "POST") {
    if (!auth) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const body = await safeRequestJson<{ config?: { name?: string; email?: string | null } }>(request);
    if (!body) {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }
    await env.DB.prepare(
      "UPDATE users SET name = COALESCE(?, name), email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(body.config?.name || null, body.config?.email || auth.user.email, auth.userId).run();

    return jsonResponse({ success: true, message: "Config saved" });
  }

  return jsonResponse({ success: false, error: "Runner route not found" }, 404);
}
