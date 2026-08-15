const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync, spawn } = require('child_process');
const http = require('http');
const https = require('https');

const RUNNER_STATE_PATH = path.join(__dirname, 'runner-state.json');
const FFMPEG_EXE = path.join(__dirname, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
const YTDLP_EXE = path.join(__dirname, 'tools', 'yt-dlp', 'yt-dlp.exe');
const UPDATE_MANIFEST_PATH = path.join(__dirname, 'update-manifest.json');
const DEFAULT_UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/waqaskhan1437/waqas-ai-studio/master/local-runner/update-manifest.json';
const RUNNER_SCRIPTS_DIR = [
  path.resolve(__dirname, '..', 'runner-scripts'),
  path.join(__dirname, 'runner-scripts'),
].find((candidate) => fs.existsSync(candidate)) || path.resolve(__dirname, '..', 'runner-scripts');
const RUNNER_SCRIPTS_OUTPUT_DIR = path.join(RUNNER_SCRIPTS_DIR, 'output');
const RUNNER_SCRIPTS_CONFIG_PATH = path.join(RUNNER_SCRIPTS_DIR, 'automation-config.json');
const RUNNER_SCRIPTS_FAILURE_REPORT_PATH = path.join(RUNNER_SCRIPTS_OUTPUT_DIR, 'failure-report.json');
const LOCAL_MEDIA_ROOTS_PATH = path.join(__dirname, 'local-media-roots.json');

function quoteShellArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function readAllowedLocalMediaRoots() {
  if (!fs.existsSync(LOCAL_MEDIA_ROOTS_PATH)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_MEDIA_ROOTS_PATH, 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => path.resolve(value));
  } catch {
    return [];
  }
}

function saveAllowedLocalMediaRoots(nextRoots) {
  const uniqueRoots = Array.from(new Set(
    nextRoots
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => path.resolve(value))
  ));

  fs.writeFileSync(LOCAL_MEDIA_ROOTS_PATH, JSON.stringify(uniqueRoots, null, 2), 'utf8');
}

function registerAllowedLocalMediaRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string') {
    return;
  }

  const nextRoot = path.resolve(rootPath);
  const existingRoots = readAllowedLocalMediaRoots();
  if (existingRoots.includes(nextRoot)) {
    return;
  }

  saveAllowedLocalMediaRoots([...existingRoots, nextRoot]);
}

function getToolCommand(toolName) {
  if (toolName === 'ffmpeg' && fs.existsSync(FFMPEG_EXE)) {
    return quoteShellArg(FFMPEG_EXE);
  }

  if (toolName === 'yt-dlp' && fs.existsSync(YTDLP_EXE)) {
    return quoteShellArg(YTDLP_EXE);
  }

  return toolName;
}

// ============= CONFIGURATION =============
let config = {
  postformeApiKey: '',
  runnerToken: '',
  accessToken: '',
  serverUrl: 'https://waqas-ai-studio.waqaskhan1437.workers.dev'
};

// ============= STATE =============
let currentJob = null;
let processedVideos = 0;
let lastHeartbeat = Date.now();
let isProcessing = false;
let isExecutingCommand = false;
let currentRunnerCommand = null;
let remoteAccessSnapshot = null;
let remoteAccessSnapshotAt = 0;

const REMOTE_ACCESS_CACHE_MS = 60_000;
const RUNNER_VERSION = (() => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return String(packageJson.version || 'portable');
  } catch {
    return 'portable';
  }
})();

function getRunnerAuthToken() {
  return config.runnerToken || '';
}

function writeRunnerState(nextState) {
  const state = {
    status: 'idle',
    message: '',
    currentJobId: null,
    processedVideos,
    updatedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date(lastHeartbeat).toISOString(),
    lastError: '',
    lockStatus: 'ok',
    ...nextState
  };

  try {
    fs.writeFileSync(RUNNER_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('[STATE] Failed to write runner state:', error.message);
  }
}

function toNullableString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function tryReadCommandOutput(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      ...options,
    });
  } catch {
    return '';
  }
}

function resolveTailscaleCommand() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
    'tailscale.exe',
    'tailscale',
  ];

  for (const candidate of candidates) {
    if (candidate.includes('\\') ? fs.existsSync(candidate) : true) {
      return candidate;
    }
  }

  return 'tailscale.exe';
}

function readSshStatus() {
  if (process.platform !== 'win32') {
    return {
      enabled: false,
      status: 'unsupported',
      target: null,
    };
  }

  const raw = tryReadCommandOutput('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "$service = Get-Service sshd -ErrorAction SilentlyContinue; if (-not $service) { '{\"enabled\":false,\"status\":\"not_installed\"}' } else { $payload = @{ enabled = $true; status = $service.Status.ToString().ToLowerInvariant() }; $payload | ConvertTo-Json -Compress }",
  ]);

  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled === true,
      status: toNullableString(parsed.status) || 'unknown',
      target: null,
    };
  } catch {
    return {
      enabled: false,
      status: 'unknown',
      target: null,
    };
  }
}

function collectRemoteAccessSnapshot(force = false) {
  if (!force && remoteAccessSnapshot && (Date.now() - remoteAccessSnapshotAt) < REMOTE_ACCESS_CACHE_MS) {
    return remoteAccessSnapshot;
  }

  const snapshot = {
    platform: `${os.platform()} ${os.release()}`,
    version: RUNNER_VERSION,
    tailscale: {
      installed: false,
      status: 'not_installed',
      ip: null,
      dnsName: null,
    },
    ssh: readSshStatus(),
  };

  const tailscaleCommand = resolveTailscaleCommand();
  const tailscaleJson = tryReadCommandOutput(tailscaleCommand, ['status', '--json']);
  if (tailscaleJson) {
    try {
      const parsed = JSON.parse(tailscaleJson);
      const self = parsed.Self || {};
      const tailscaleIp = Array.isArray(self.TailscaleIPs)
        ? self.TailscaleIPs.find((value) => typeof value === 'string' && value.includes('.')) || self.TailscaleIPs[0] || null
        : null;

      snapshot.tailscale = {
        installed: true,
        status: toNullableString(parsed.BackendState) || 'connected',
        ip: toNullableString(String(tailscaleIp || '')),
        dnsName: toNullableString(String(self.DNSName || '').replace(/\.$/, '')),
      };
    } catch {
      snapshot.tailscale = {
        installed: true,
        status: 'installed',
        ip: null,
        dnsName: null,
      };
    }
  }

  const sshHost = snapshot.tailscale.dnsName || snapshot.tailscale.ip;
  if (snapshot.ssh.enabled && sshHost) {
    let username = 'Administrator';
    try {
      username = toNullableString(os.userInfo().username) || username;
    } catch {}
    snapshot.ssh.target = `${username}@${sshHost}`;
  }

  remoteAccessSnapshot = snapshot;
  remoteAccessSnapshotAt = Date.now();
  return snapshot;
}

// ============= LOAD CONFIG =============
function loadConfig() {
  try {
    const configData = fs.readFileSync(path.join(__dirname, 'config.txt'), 'utf8');
    const lines = configData.split('\n');

    for (const line of lines) {
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').trim();

      if (key && value) {
        if (key.trim() === 'POSTFORME_API_KEY') config.postformeApiKey = value;
        if (key.trim() === 'RUNNER_TOKEN') config.runnerToken = value;
        if (key.trim() === 'ACCESS_TOKEN') config.accessToken = value;
        if (key.trim() === 'SERVER_URL') config.serverUrl = value;
      }
    }
  } catch (e) {
    console.error('[CONFIG] Failed to load config:', e.message);
    writeRunnerState({
      status: 'error',
      message: 'Failed to load config.txt',
      lastError: e.message
    });
    process.exit(1);
  }
}

// ============= SIMPLE HTTP REQUEST =============
function httpRequest(urlPath, method = 'GET', body = null) {
  return jsonRequest(urlPath, method, body, getRunnerAuthToken());
}

function bearerRequest(urlPath, method = 'GET', body = null) {
  return jsonRequest(urlPath, method, body, config.accessToken);
}

function jsonRequest(urlPath, method = 'GET', body = null, bearerToken = '') {
  return new Promise((resolve, reject) => {
    const REQUEST_TIMEOUT_MS = 30000;
    const parsedUrl = new URL(urlPath, config.serverUrl);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
      }
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    }

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ success: false, raw: data });
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRunnerActivityStatus() {
  if (isExecutingCommand) {
    return 'maintenance';
  }

  if (isProcessing) {
    return 'processing';
  }

  return 'idle';
}

function getRunnerActivityMessage() {
  if (isExecutingCommand && currentRunnerCommand?.command_type) {
    return `Executing ${currentRunnerCommand.command_type}`;
  }

  if (isProcessing && currentJob?.id) {
    return `Processing job ${currentJob.id}`;
  }

  return 'Runner heartbeat OK';
}

function isPathInsideRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureDirectoryForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function launchDetachedProcess(command, args, options = {}) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    shell: needsShell,
  });
  return child.pid;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'AutomationSystem/1.0',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function loadLocalUpdateManifest() {
  try {
    if (!fs.existsSync(UPDATE_MANIFEST_PATH)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(UPDATE_MANIFEST_PATH, 'utf8'));
  } catch (error) {
    console.warn('[COMMAND] Failed to read local update manifest:', error.message);
    return null;
  }
}

async function fetchUpdateManifest() {
  const localManifest = loadLocalUpdateManifest();
  const remoteManifestUrl = toNullableString(localManifest?.remote_manifest_url) || DEFAULT_UPDATE_MANIFEST_URL;

  try {
    const response = await fetchWithTimeout(remoteManifestUrl, {}, 30000);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const manifest = await response.json();
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Remote manifest payload was invalid');
    }

    return manifest;
  } catch (error) {
    if (localManifest) {
      console.warn('[COMMAND] Falling back to local update manifest:', error.message);
      return localManifest;
    }

    throw error;
  }
}

function normalizeManifestFileEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const source = toNullableString(entry.source || entry.path);
  const target = toNullableString(entry.target || entry.destination);
  if (!source || !target) {
    return null;
  }

  const normalizedTarget = target.replace(/\//g, path.sep);
  const absoluteTarget = path.resolve(__dirname, normalizedTarget);
  if (!isPathInsideRoot(__dirname, absoluteTarget)) {
    throw new Error(`Refusing to write outside portable runner root: ${target}`);
  }

  return {
    source: source.replace(/\\/g, '/').replace(/^\/+/, ''),
    relativeTarget: normalizedTarget,
    absoluteTarget,
  };
}

function buildManifestRawBaseUrl(manifest) {
  const explicitBaseUrl = toNullableString(manifest?.raw_base_url);
  if (explicitBaseUrl) {
    return explicitBaseUrl.replace(/\/$/, '');
  }

  const owner = toNullableString(manifest?.repo_owner) || 'waqaskhan1437';
  const repo = toNullableString(manifest?.repo_name) || 'waqas-ai-studio';
  const branch = toNullableString(manifest?.branch) || 'master';
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
}

async function downloadManifestFile(rawBaseUrl, entry) {
  const fileUrl = `${rawBaseUrl}/${entry.source}`;
  const response = await fetchWithTimeout(fileUrl, {}, 60000);
  if (!response.ok) {
    throw new Error(`Failed to download ${entry.source}: HTTP ${response.status} ${response.statusText}`);
  }

  const tempTarget = `${entry.absoluteTarget}.download`;
  const fileBuffer = Buffer.from(await response.arrayBuffer());
  ensureDirectoryForFile(entry.absoluteTarget);
  fs.writeFileSync(tempTarget, fileBuffer);
  fs.copyFileSync(tempTarget, entry.absoluteTarget);
  fs.rmSync(tempTarget, { force: true });
}

function expandLocalDirectorySources(rawSources) {
  if (!Array.isArray(rawSources)) return [];
  const expanded = [];
  for (const raw of rawSources) {
    const source = typeof raw === 'string' ? raw.trim() : '';
    if (!source) continue;

    // Remote URLs stay as-is — only resolve local paths.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
      expanded.push(source);
      continue;
    }

    let stats;
    try {
      stats = fs.statSync(source);
    } catch {
      expanded.push(source);
      continue;
    }

    if (stats.isDirectory()) {
      const videos = listVideoFiles(source);
      if (videos.length === 0) {
        throw new Error(`No video files found in folder: ${source}`);
      }
      videos.sort((a, b) => a.path.localeCompare(b.path));
      expanded.push(videos[0].path);
      console.log(`[LOCAL] Resolved directory ${source} → ${videos[0].path}`);
    } else {
      expanded.push(source);
    }
  }
  return expanded;
}

function listVideoFiles(folderPath) {
  const allowedExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
  const files = [];

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
        const stats = fs.statSync(fullPath);
        files.push({
          path: path.resolve(fullPath),
          mtimeMs: stats.mtimeMs
        });
      }
    }
  }

  walk(folderPath);
  return files;
}

async function getProcessedSourcePaths(automationId) {
  if (!config.accessToken || !automationId) {
    return new Set();
  }

  try {
    const response = await bearerRequest(`/api/automations/${automationId}/processed-videos`, 'GET');
    return new Set(Array.isArray(response.data) ? response.data : []);
  } catch {
    return new Set();
  }
}

async function clearProcessedSourcePaths(automationId) {
  if (!config.accessToken || !automationId) {
    return false;
  }

  try {
    const response = await bearerRequest(`/api/automations/${automationId}/processed-videos`, 'DELETE');
    return response?.success === true;
  } catch {
    return false;
  }
}

function createLocalFolderExhaustedError(folderPath) {
  const error = new Error('All local folder videos already processed');
  error.code = 'LOCAL_FOLDER_EXHAUSTED';
  error.folderPath = folderPath;
  return error;
}

function isLocalFolderExhaustedError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'LOCAL_FOLDER_EXHAUSTED');
}

async function pickLocalFolderVideos(job, limit = 1) {
  const folderPath = job?.config?.local_folder_path || job?.input_data?.local_folder_path;
  if (!folderPath) {
    throw new Error('Local folder path is missing in automation config');
  }

  const absoluteFolder = path.resolve(folderPath);
  if (!fs.existsSync(absoluteFolder) || !fs.statSync(absoluteFolder).isDirectory()) {
    throw new Error(`Local folder not found: ${absoluteFolder}`);
  }

  const files = listVideoFiles(absoluteFolder);
  if (files.length === 0) {
    throw new Error(`No video files found in folder: ${absoluteFolder}`);
  }

  const mergedConfig = {
    ...(job?.config || {}),
    ...(job?.input_data || {}),
  };
  const rotationEnabled = mergedConfig.rotation_enabled !== false;
  const rotationShuffle = mergedConfig.rotation_shuffle === true;
  const contentRotateOnce = mergedConfig.content_rotate_once === true;
  const hasExplicitAutoReset = Object.prototype.hasOwnProperty.call(mergedConfig, 'rotation_auto_reset');
  const rotationAutoReset = hasExplicitAutoReset
    ? mergedConfig.rotation_auto_reset === true
    : !contentRotateOnce;

  let availableFiles = [...files];
  if (rotationEnabled) {
    const processed = await getProcessedSourcePaths(job.automation_id);
    availableFiles = files.filter((file) => !processed.has(file.path));

    if (availableFiles.length === 0 && rotationAutoReset) {
      const cleared = await clearProcessedSourcePaths(job.automation_id);
      if (cleared) {
        availableFiles = [...files];
        console.log(`[LOCAL_FOLDER] Rotation auto-reset cleared processed history for automation ${job.automation_id}`);
      }
    }
  }

  if (availableFiles.length === 0) {
    throw createLocalFolderExhaustedError(absoluteFolder);
  }

  const strategy = job?.config?.local_folder_strategy || 'alphabetical';
  if (strategy === 'newest') {
    availableFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } else if (strategy === 'random') {
    availableFiles.sort(() => Math.random() - 0.5);
  } else {
    availableFiles.sort((a, b) => a.path.localeCompare(b.path));
  }

  if (rotationShuffle) {
    availableFiles.sort(() => Math.random() - 0.5);
  }

  return availableFiles.slice(0, Math.max(1, limit)).map((file) => file.path);
}

async function pickLocalFolderVideo(job) {
  const files = await pickLocalFolderVideos(job, 1);
  if (!files[0]) {
    throw new Error('No eligible local folder video found');
  }

  return files[0];
}

function resolveLocalOutputDir(job) {
  const configuredPath = toNullableString(job?.config?.local_output_dir || job?.input_data?.local_output_dir);
  if (!configuredPath) {
    return RUNNER_SCRIPTS_OUTPUT_DIR;
  }

  return path.resolve(configuredPath);
}

function ensureLocalOutputDir(job) {
  const outputDir = resolveLocalOutputDir(job);
  fs.mkdirSync(outputDir, { recursive: true });
  registerAllowedLocalMediaRoot(outputDir);
  return outputDir;
}

function findRealExeOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    if (/[\\/]WindowsApps([\\/]|$)/i.test(dir)) continue;
    const full = path.join(dir, `${name}.exe`);
    try {
      if (fs.existsSync(full)) return path.dirname(full);
    } catch {}
  }
  return null;
}

function buildRunnerScriptsEnv(job) {
  const bundledFfmpegDir = path.join(__dirname, 'tools', 'ffmpeg', 'bin');
  const bundledYtDlpDir = path.join(__dirname, 'tools', 'yt-dlp');
  // Prepend real .exe directories so cmd-shell command lookups skip
  // WindowsApps reparse-point .cmd stubs that fail with spawn EINVAL.
  const externalFfmpegDir = fs.existsSync(bundledFfmpegDir) ? null : findRealExeOnPath('ffmpeg');
  const externalFfprobeDir = fs.existsSync(bundledFfmpegDir) ? null : findRealExeOnPath('ffprobe');
  const externalYtDlpDir = fs.existsSync(bundledYtDlpDir) ? null : findRealExeOnPath('yt-dlp');

  const toolPathEntries = [
    bundledFfmpegDir,
    path.join(__dirname, 'tools', 'node'),
    bundledYtDlpDir,
    externalFfmpegDir,
    externalFfprobeDir,
    externalYtDlpDir,
    process.env.PATH || '',
  ].filter(Boolean).join(path.delimiter);

  // Inject AI API keys from worker settings so the dubbing pipeline
  // can use whichever provider the user selected.
  const aiEnv = {};
  if (job && job.ai_settings && typeof job.ai_settings === 'object') {
    const keyMap = {
      openai_key: { normalized: 'OPENAI_KEY', standard: 'OPENAI_API_KEY' },
      gemini_key: { normalized: 'GEMINI_KEY', standard: 'GEMINI_API_KEY' },
      grok_key: { normalized: 'GROK_KEY', standard: 'XAI_API_KEY' },
      cohere_key: { normalized: 'COHERE_KEY', standard: 'CO_API_KEY' },
      openrouter_key: { normalized: 'OPENROUTER_KEY', standard: 'OPENROUTER_API_KEY' },
      groq_key: { normalized: 'GROQ_KEY', standard: 'GROQ_API_KEY' },
    };
    for (const [sourceKey, mapping] of Object.entries(keyMap)) {
      const raw = String(job.ai_settings[sourceKey] || '').trim();
      if (raw) {
        aiEnv[mapping.normalized] = raw;
        aiEnv[mapping.standard] = raw;
      }
    }
    if (job.ai_settings.default_provider) {
      aiEnv.AI_DEFAULT_PROVIDER = String(job.ai_settings.default_provider).trim();
    }
  }

  return {
    ...process.env,
    ...aiEnv,
    PATH: toolPathEntries,
    JOB_ID: String(job.id),
    AUTOMATION_ID: String(job.automation_id || ''),
    AUTOMATION_TYPE: String(job.automation_type || 'video'),
    AUTOMATION_NAME: String(job.automation_name || ''),
    RUNNER_EXECUTION_MODE: 'local',
    WORKER_WEBHOOK_URL: `${config.serverUrl.replace(/\/$/, '')}/api/webhook/github`,
    RUNTIME_CONFIG_TOKEN: config.accessToken,
    LOCAL_OUTPUT_DIR: ensureLocalOutputDir(job),
  };
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeFileWithRetries(filePath, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 12;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 250;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(filePath, { force: true });
      return;
    } catch (error) {
      if (!error || error.code === 'ENOENT') {
        return;
      }

      lastError = error;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === retries) {
        break;
      }

      sleepSync(delayMs);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

const MEDIA_RETENTION_DAYS = 7;
const MEDIA_RETENTION_MS = MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function cleanupOldMediaFiles() {
  const mediaDir = path.join(RUNNER_SCRIPTS_OUTPUT_DIR, 'media');
  if (!fs.existsSync(mediaDir)) {
    return;
  }

  const now = Date.now();
  let removedCount = 0;
  let totalSize = 0;

  try {
    const entries = fs.readdirSync(mediaDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(mediaDir, entry.name);
      try {
        const stats = fs.statSync(filePath);
        const age = now - stats.mtimeMs;
        if (age > MEDIA_RETENTION_MS) {
          totalSize += stats.size;
          fs.rmSync(filePath, { force: true });
          removedCount++;
        }
      } catch (error) {
        console.warn('[CLEANUP] Failed to process file:', entry.name, error.message);
      }
    }
  } catch (error) {
    console.warn('[CLEANUP] Failed to scan media directory:', error.message);
  }

  if (removedCount > 0) {
    const freedMb = (totalSize / 1024 / 1024).toFixed(2);
    console.log(`[CLEANUP] Removed ${removedCount} file(s) older than ${MEDIA_RETENTION_DAYS} days (freed ${freedMb} MB)`);
  }
}

function clearRunnerScriptsWorkspace() {
  // Instead of deleting the whole folder, just delete the temp processing files
  if (fs.existsSync(RUNNER_SCRIPTS_OUTPUT_DIR)) {
    const files = fs.readdirSync(RUNNER_SCRIPTS_OUTPUT_DIR);
    for (const file of files) {
      if (
        file.startsWith('input-')
        || file.startsWith('processed-')
        || file.endsWith('.download')
        || file === 'failure-report.json'
      ) {
        removeFileWithRetries(path.join(RUNNER_SCRIPTS_OUTPUT_DIR, file));
      }
    }
  }
  fs.mkdirSync(RUNNER_SCRIPTS_OUTPUT_DIR, { recursive: true });
}

function getNpmCommand() {
  const localNpm = process.platform === 'win32'
    ? path.join(__dirname, 'tools', 'node', 'npm.cmd')
    : path.join(__dirname, 'tools', 'node', 'npm');

  if (fs.existsSync(localNpm)) {
    return localNpm;
  }

  if (process.platform === 'win32') {
    // npm.cmd ships next to node.exe — resolve absolute path so spawn can
    // find it without relying on PATH (which may also yield .cmd shims).
    const nodeDir = path.dirname(process.execPath);
    const colocatedNpm = path.join(nodeDir, 'npm.cmd');
    if (fs.existsSync(colocatedNpm)) {
      return colocatedNpm;
    }
    return 'npm.cmd';
  }

  return 'npm';
}

async function ensureRunnerScriptsDependency(packageName) {
  const packageDir = path.join(RUNNER_SCRIPTS_DIR, 'node_modules', packageName);
  if (fs.existsSync(packageDir)) {
    return;
  }

  // Some installs lack a matching package-lock.json (or the lockfile drifts
  // when files are edited locally) — `npm ci` would hard-fail on that.
  // `npm install` is permissive and still works without a lockfile, which is
  // what we want on a fresh machine. We also retry on transient registry
  // failures (proxy/DNS hiccups are the #1 cause of "npm.cmd exited 1").
  const npmCmd = getNpmCommand();
  const env = buildRunnerScriptsEnv({ id: 0, automation_id: 0, automation_type: 'image' });
  const args = ['install', '--no-audit', '--no-fund', '--omit=dev', '--prefer-offline'];

  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(
      `[RUNNER] ${packageName} missing, installing runner-scripts dependencies (attempt ${attempt}/${maxAttempts})...`,
    );
    try {
      await runChildProcess(npmCmd, args, {
        cwd: RUNNER_SCRIPTS_DIR,
        env,
        timeoutMs: 900000,
      });
      if (fs.existsSync(packageDir)) {
        return;
      }
      lastError = new Error(
        `npm finished but ${packageName} is still missing under ${RUNNER_SCRIPTS_DIR}`,
      );
    } catch (err) {
      lastError = err;
      console.warn(`[RUNNER] npm install attempt ${attempt} failed: ${err.message || err}`);
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  const detail = lastError ? ` (${lastError.message || lastError})` : '';
  throw new Error(
    `Failed to install runner-scripts dependency "${packageName}" after ${maxAttempts} attempts${detail}. ` +
      `Verify internet access, or pre-bundle node_modules under ${RUNNER_SCRIPTS_DIR}.`,
  );
}

function runChildProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 0;
  // Node 20+ refuses to spawn .cmd/.bat without shell:true (CVE-2024-27980).
  // npm on Windows is npm.cmd, so we must opt into the shell wrapper.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: 'inherit',
      windowsHide: true,
      detached: false,
      shell: needsShell,
    });

    let settled = false;
    let timeoutHandle = null;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const finish = (handler) => (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      handler(value);
    };

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }

        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
          });
        } catch {}

        finish(reject)(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on('error', finish(reject));
    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish(resolve)();
        return;
      }

      const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      finish(reject)(new Error(`${path.basename(command)} exited with ${detail}`));
    });
  });
}

function readProcessedCountFromRunnerScripts() {
  const processedVideosPath = path.join(RUNNER_SCRIPTS_OUTPUT_DIR, 'processed-videos.json');
  try {
    if (!fs.existsSync(processedVideosPath)) {
      return 0;
    }

    const processed = JSON.parse(fs.readFileSync(processedVideosPath, 'utf8'));
    return Array.isArray(processed) ? processed.length : 0;
  } catch {
    return 0;
  }
}

function readProcessedVideosFromRunnerScripts() {
  const processedVideosPath = path.join(RUNNER_SCRIPTS_OUTPUT_DIR, 'processed-videos.json');
  try {
    if (!fs.existsSync(processedVideosPath)) {
      return [];
    }

    const parsed = JSON.parse(fs.readFileSync(processedVideosPath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function readFailureReportFromRunnerScripts() {
  try {
    if (!fs.existsSync(RUNNER_SCRIPTS_FAILURE_REPORT_PATH)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(RUNNER_SCRIPTS_FAILURE_REPORT_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readImageResultFromRunnerScripts() {
  const imageResultPath = path.join(RUNNER_SCRIPTS_OUTPUT_DIR, 'image-result.json');
  try {
    if (!fs.existsSync(imageResultPath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(imageResultPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readDubbingReportFromRunnerScripts() {
  const reportPath = path.join(RUNNER_SCRIPTS_DIR, 'dubbing-engine', 'output', 'latest', 'dubbing-report.json');
  try {
    if (!fs.existsSync(reportPath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeDubbingSourceMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'url') return 'url';
  if (mode === 'upload' || mode === 'local') return 'local';
  return 'url';
}

function buildDubbingManifest(job) {
  const mergedConfig = {
    ...(job?.config || {}),
    ...(job?.input_data || {}),
  };
  const sourceMode = normalizeDubbingSourceMode(mergedConfig.source_mode);
  const sourceValue = String(mergedConfig.source_value || mergedConfig.video_url || '').trim();
  const targetLanguage = String(mergedConfig.target_language || mergedConfig.dubbing?.target_language || 'ur').toLowerCase();
  const translationEngine = String(mergedConfig.translation_engine || mergedConfig.dubbing?.translation_engine || 'llm').toLowerCase();
  const voiceEngine = String(mergedConfig.voice_engine || mergedConfig.dubbing?.voice_engine || 'voxcpm2').toLowerCase();
  const maxTempo = Number(mergedConfig.speedLimit || mergedConfig.max_tempo || mergedConfig.dubbing?.max_tempo || 1.2);
  const voiceReferenceSeconds = Number(mergedConfig.voiceReferenceSeconds || mergedConfig.voice_reference_seconds || mergedConfig.dubbing?.voice_reference_seconds || 18);
  // AI provider for LLM translation – e.g. 'openai', 'gemini', 'grok', 'openrouter', 'groq'
  const aiProvider = String(mergedConfig.ai_provider || mergedConfig.dubbing?.ai_provider || job?.ai_settings?.default_provider || 'openai').toLowerCase();

  if (!sourceValue) {
    throw new Error('Dubbing job is missing a source value');
  }

  return {
    workflow: 'dubbing',
    type: 'video',
    name: String(job?.automation_name || mergedConfig.name || `Dubbing Job ${job.id}`),
    video_source: sourceMode === 'url' ? 'direct' : 'local_file',
    source_mode: sourceMode,
    source_value: sourceValue,
    dubbing: {
      source_language: String(mergedConfig.source_language || mergedConfig.dubbing?.source_language || 'en').toLowerCase(),
      target_language: ['ur', 'hi'].includes(targetLanguage) ? targetLanguage : 'ur',
      translation_engine: ['llm', 'nllb'].includes(translationEngine) ? translationEngine : 'llm',
      voice_engine: ['voxcpm2', 'xtts', 'edge'].includes(voiceEngine) ? voiceEngine : 'voxcpm2',
      voice_reference_seconds: Number.isFinite(voiceReferenceSeconds) ? Math.max(6, Math.min(45, Math.round(voiceReferenceSeconds))) : 18,
      diarization_enabled: mergedConfig.diarization !== false && mergedConfig.diarization_enabled !== false,
      mix_mode: String(mergedConfig.mixMode || mergedConfig.mix_mode || mergedConfig.dubbing?.mix_mode || 'bed'),
      preserve_background: mergedConfig.preserveBackground !== false && mergedConfig.preserve_background !== false,
      max_tempo: Number.isFinite(maxTempo) ? Math.max(1.05, Math.min(1.35, Number(maxTempo))) : 1.2,
      lip_sync_enabled: mergedConfig.lipSync === true || mergedConfig.lip_sync_enabled === true,
      ai_provider: aiProvider,
      stages: Array.isArray(mergedConfig.stages) && mergedConfig.stages.length > 0
        ? mergedConfig.stages
        : ["extract", "separate", "transcribe", "speakers", "translate", "clone", "align", "mix"],
    },
  };
}

function findLatestMediaFileInDirectory(directoryPath) {
  try {
    if (!directoryPath || !fs.existsSync(directoryPath)) {
      return null;
    }

    const candidates = fs.readdirSync(directoryPath)
      .filter((name) => /^final-.*\.(mp4|mov|m4v|webm|avi|mkv|png|jpg|jpeg|webp)$/i.test(name) || /^processed-video\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(name))
      .map((name) => {
        const filePath = path.join(directoryPath, name);
        const stats = fs.statSync(filePath);
        return {
          filePath,
          mtimeMs: stats.mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return candidates[0]?.filePath || null;
  } catch {
    return null;
  }
}

function findLatestLocalOutputMedia(job) {
  const preferredDir = resolveLocalOutputDir(job);
  return findLatestMediaFileInDirectory(preferredDir) || findLatestMediaFileInDirectory(RUNNER_SCRIPTS_OUTPUT_DIR);
}

/**
 * Helper to report job completion/failure to backend
 */
async function completeJob(jobId, data) {
  try {
    return await httpRequest(`/api/runner/jobs/${jobId}/complete`, 'POST', data);
  } catch (error) {
    console.error(`[JOB] Failed to report completion for job ${jobId}:`, error.message);
    throw error;
  }
}

/**
 * Check if a job has been cancelled on the worker
 */
async function checkJobCancelled(jobId) {
  try {
    const response = await httpRequest(`/api/jobs/${jobId}/status`, 'GET');
    return response && response.success && response.data && response.data.status === 'cancelled';
  } catch (error) {
    // If check fails, assume not cancelled to avoid false positives
    return false;
  }
}

async function runRunnerScriptsJob(job, sourceUrls) {
  const isCancelled = await checkJobCancelled(job.id);
  if (isCancelled) {
    throw new Error('Job cancelled by user');
  }

  if (String(job?.config?.workflow || job?.input_data?.workflow || '').trim().toLowerCase() === 'dubbing') {
    return runDubbingRunnerScriptsJob(job);
  }

  await ensureRunnerScriptsDependency('playwright-core');

  const mergedConfig = {
    ...(job?.config || {}),
    ...(job?.input_data || {}),
    video_urls: sourceUrls,
  };

  clearRunnerScriptsWorkspace();
  fs.writeFileSync(RUNNER_SCRIPTS_CONFIG_PATH, JSON.stringify(mergedConfig, null, 2), 'utf8');

  console.log(`[RUNNER] Executing shared runner-scripts pipeline for job ${job.id}`);
  try {
    await runChildProcess(process.execPath, ['main.js'], {
      cwd: RUNNER_SCRIPTS_DIR,
      env: buildRunnerScriptsEnv(job),
      timeoutMs: 3600000,
      jobId: job.id,
    });
  } catch (error) {
    const failureReport = readFailureReportFromRunnerScripts();
    const reportMessage = failureReport && typeof failureReport.last_error === 'string'
      ? failureReport.last_error
      : '';
    const sourceLabel = Array.isArray(failureReport?.failures) && failureReport.failures[0]?.source_url
      ? ` [source: ${failureReport.failures[0].source_url}]`
      : '';
    const enrichedMessage = reportMessage
      ? `${reportMessage}${sourceLabel}`
      : (error instanceof Error ? error.message : String(error));
    throw new Error(enrichedMessage);
  }

  const processedCount = readProcessedCountFromRunnerScripts();
  const processedVideos = readProcessedVideosFromRunnerScripts();
  const primaryVideoUrl = processedVideos.find((item) => typeof item.video_url === 'string' && item.video_url.trim())?.video_url || null;
  return {
    processedCount: processedCount > 0 ? processedCount : 1,
    processedVideos,
    primaryVideoUrl,
  };
}

async function runDubbingRunnerScriptsJob(job) {
  const isCancelled = await checkJobCancelled(job.id);
  if (isCancelled) {
    throw new Error('Job cancelled by user');
  }

  const manifest = buildDubbingManifest(job);
  const manifestDir = path.join(RUNNER_SCRIPTS_DIR, 'dubbing-engine', 'output', 'latest');
  const manifestPath = path.join(manifestDir, 'manifest.json');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[RUNNER] Executing dubbing engine for job ${job.id}`);
  try {
    await runChildProcess(process.execPath, [path.join('dubbing-engine', 'cli.js'), '--manifest', manifestPath], {
      cwd: RUNNER_SCRIPTS_DIR,
      env: buildRunnerScriptsEnv(job),
      timeoutMs: 3600000,
      jobId: job.id,
    });
  } catch (error) {
    const report = readDubbingReportFromRunnerScripts();
    const reportMessage = report && typeof report === 'object' && typeof report.last_error === 'string'
      ? report.last_error
      : '';
    const enrichedMessage = reportMessage
      ? reportMessage
      : (error instanceof Error ? error.message : String(error));
    throw new Error(enrichedMessage);
  }

  const report = readDubbingReportFromRunnerScripts();
  if (!report) {
    throw new Error('Dubbing engine finished but no report was produced');
  }

  return {
    processedCount: 1,
    processedVideos: [{
      video_url: report?.final_video || null,
      original_url: manifest.source_value,
      workflow: 'dubbing',
      report,
    }],
    primaryVideoUrl: report?.final_video || null,
    dubbingReport: report,
  };
}

async function runImageRunnerScriptsJob(job) {
  const mergedConfig = {
    ...(job?.config || {}),
    ...(job?.input_data || {}),
  };

  await ensureRunnerScriptsDependency('playwright-core');
  clearRunnerScriptsWorkspace();
  fs.writeFileSync(RUNNER_SCRIPTS_CONFIG_PATH, JSON.stringify(mergedConfig, null, 2), 'utf8');

  console.log(`[RUNNER] Executing image runner-scripts pipeline for job ${job.id}`);
  await runChildProcess(process.execPath, [path.join('image', 'main.js')], {
    cwd: RUNNER_SCRIPTS_DIR,
    env: buildRunnerScriptsEnv(job),
    timeoutMs: 1800000,
    jobId: job.id,
  });

  const result = readImageResultFromRunnerScripts();
  return result && result.media_url ? 1 : 0;
}

// ============= REGISTRY =============
async function registerRunner() {
  try {
    writeRunnerState({
      status: 'connecting',
      message: 'Registering runner with backend'
    });

    const hostname = os.hostname();
    const remoteAccess = collectRemoteAccessSnapshot(true);
    const response = await httpRequest('/api/runner/register', 'POST', {
      token: getRunnerAuthToken(),
      hostname,
      startedAt: new Date().toISOString(),
      platform: remoteAccess.platform,
      version: remoteAccess.version,
      tailscale: remoteAccess.tailscale,
      ssh: remoteAccess.ssh,
    });

    if (response.success) {
      console.log('[RUNNER] Registered successfully with server');
      writeRunnerState({
        status: 'idle',
        message: 'Runner registered and waiting for jobs',
        remoteAccess,
      });
    } else {
      console.log('[RUNNER] Registration failed:', response.error);
      writeRunnerState({
        status: 'error',
        message: 'Runner registration failed',
        lastError: response.error || 'Unknown registration error',
        remoteAccess,
      });
    }
  } catch (e) {
    console.error('[RUNNER] Registration error:', e.message);
    writeRunnerState({
      status: 'error',
      message: 'Runner registration error',
      lastError: e.message,
      remoteAccess: collectRemoteAccessSnapshot(true),
    });
  }
}

// ============= GET JOB =============
async function getJob() {
  try {
    const url = `/api/runner/jobs?token=${encodeURIComponent(getRunnerAuthToken())}`;
    console.log(`[JOBS] Fetching jobs from: ${url}`);
    const response = await httpRequest(url, 'GET');
    console.log(`[JOBS] API Response:`, JSON.stringify(response, null, 2));

    if (response.success && response.data) {
      const rawJob = Array.isArray(response.data) ? response.data[0] : response.data;
      if (!rawJob) {
        console.log(`[JOBS] No jobs available in response`);
        return null;
      }

      let inputData = rawJob.input_data || {};
      let configData = rawJob.config || {};

      try {
        inputData = typeof inputData === 'string' ? JSON.parse(inputData) : inputData;
      } catch {}

      try {
        configData = typeof configData === 'string' ? JSON.parse(configData) : configData;
      } catch {}

      const aiSettings = rawJob.ai_settings || null;

      return {
        ...rawJob,
        input_data: inputData,
        config: configData,
        ai_settings: aiSettings,
      };
    }
    return null;
  } catch (e) {
    console.error('[JOBS] Error fetching job:', e.message);
    writeRunnerState({
      status: 'warning',
      message: 'Failed to fetch jobs',
      currentJobId: currentJob ? currentJob.id : null,
      lastError: e.message
    });
    return null;
  }
}

// ============= HEARTBEAT =============
async function sendHeartbeat() {
  try {
    const remoteAccess = collectRemoteAccessSnapshot();
    const runnerStatus = getRunnerActivityStatus();
    await httpRequest('/api/runner/heartbeat', 'POST', {
      token: getRunnerAuthToken(),
      status: runnerStatus,
      currentJob: currentJob ? currentJob.id : null,
      processedCount: processedVideos,
      hostname: os.hostname(),
      platform: remoteAccess.platform,
      version: remoteAccess.version,
      tailscale: remoteAccess.tailscale,
      ssh: remoteAccess.ssh,
    });
    lastHeartbeat = Date.now();
    refreshRunnerLock();
    const queuedCount = await getQueuedJobCount();
    writeRunnerState({
      status: runnerStatus,
      message: getRunnerActivityMessage(),
      currentJobId: currentJob ? currentJob.id : null,
      currentCommandId: currentRunnerCommand ? currentRunnerCommand.id : null,
      currentCommandType: currentRunnerCommand ? currentRunnerCommand.command_type : null,
      processedVideos,
      lastError: '',
      remoteAccess,
      queuedJobs: queuedCount,
    });
  } catch (e) {
    console.error('[HEARTBEAT] Error:', e.message);
    writeRunnerState({
      status: isProcessing || isExecutingCommand ? getRunnerActivityStatus() : 'warning',
      message: 'Heartbeat failed',
      currentJobId: currentJob ? currentJob.id : null,
      currentCommandId: currentRunnerCommand ? currentRunnerCommand.id : null,
      currentCommandType: currentRunnerCommand ? currentRunnerCommand.command_type : null,
      processedVideos,
      lastError: e.message,
      remoteAccess: collectRemoteAccessSnapshot(),
      queuedJobs: 0,
    });
  }
}

async function getNextRunnerCommand() {
  try {
    const response = await httpRequest(`/api/runner/commands?token=${encodeURIComponent(getRunnerAuthToken())}`, 'GET');
    if (response.success && response.data) {
      return response.data;
    }

    return null;
  } catch (error) {
    console.error('[COMMAND] Failed to fetch runner commands:', error.message);
    return null;
  }
}

async function completeRunnerCommand(commandId, payload) {
  return httpRequest(`/api/runner/commands/${commandId}/complete`, 'POST', {
    token: getRunnerAuthToken(),
    success: payload.success !== false,
    result: payload.result || null,
    error: payload.error || null,
  });
}

async function refreshRemoteAccess() {
  await runChildProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'install-tailscale.ps1',
  ], {
    cwd: __dirname,
    env: process.env,
    timeoutMs: 900000,
  });

  return collectRemoteAccessSnapshot(true);
}

async function syncRunnerCode() {
  const manifest = await fetchUpdateManifest();
  const rawBaseUrl = buildManifestRawBaseUrl(manifest);
  const fileEntries = Array.isArray(manifest?.files)
    ? manifest.files.map((entry) => normalizeManifestFileEntry(entry)).filter(Boolean)
    : [];

  if (fileEntries.length === 0) {
    throw new Error('Update manifest did not contain any portable runner files');
  }

  const updatedFiles = [];
  for (const entry of fileEntries) {
    console.log(`[COMMAND] Downloading ${entry.source} -> ${entry.relativeTarget}`);
    await downloadManifestFile(rawBaseUrl, entry);
    updatedFiles.push(entry.relativeTarget);
  }

  if (manifest.install_runner_scripts_dependencies !== false) {
    console.log('[COMMAND] Installing updated runner-scripts dependencies...');
    await runChildProcess(getNpmCommand(), ['ci'], {
      cwd: RUNNER_SCRIPTS_DIR,
      env: buildRunnerScriptsEnv({ id: 0, automation_id: 0, automation_type: 'maintenance' }),
      timeoutMs: 900000,
    });
  }

  return {
    manifest_version: toNullableString(String(manifest.version || '')) || 'unknown',
    files_updated: updatedFiles.length,
    first_files: updatedFiles.slice(0, 10),
    raw_base_url: rawBaseUrl,
  };
}

function scheduleRunnerRestart(reason) {
  const restartScriptPath = path.join(__dirname, 'restart-local-runner.ps1').replace(/'/g, "''");
  writeRunnerState({
    status: 'restarting',
    message: reason,
    currentJobId: null,
    currentCommandId: currentRunnerCommand ? currentRunnerCommand.id : null,
    currentCommandType: currentRunnerCommand ? currentRunnerCommand.command_type : null,
    processedVideos,
    remoteAccess: collectRemoteAccessSnapshot(true),
  });

  launchDetachedProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Start-Sleep -Seconds 2; & '${restartScriptPath}'`,
  ], {
    cwd: __dirname,
    env: process.env,
  });
}

function launchSetupInBackground() {
  writeRunnerState({
    status: 'maintenance',
    message: 'Launching setup.bat in background',
    currentJobId: null,
    currentCommandId: currentRunnerCommand ? currentRunnerCommand.id : null,
    currentCommandType: currentRunnerCommand ? currentRunnerCommand.command_type : null,
    processedVideos,
    remoteAccess: collectRemoteAccessSnapshot(true),
  });

  launchDetachedProcess('cmd.exe', ['/c', 'call', 'setup.bat'], {
    cwd: __dirname,
    env: process.env,
  });
}

async function processRunnerCommand(command) {
  isExecutingCommand = true;
  currentRunnerCommand = command;

  writeRunnerState({
    status: 'maintenance',
    message: `Executing ${command.command_type}`,
    currentJobId: null,
    currentCommandId: command.id,
    currentCommandType: command.command_type,
    processedVideos,
    lastError: '',
    remoteAccess: collectRemoteAccessSnapshot(true),
  });

  try {
    if (command.command_type === 'restart_runner') {
      await completeRunnerCommand(command.id, {
        success: true,
        result: { message: 'Restart queued by admin panel' },
      });
      scheduleRunnerRestart('Remote restart queued');
      return { restartQueued: true };
    }

    if (command.command_type === 'run_setup') {
      await completeRunnerCommand(command.id, {
        success: true,
        result: { message: 'setup.bat launched in background' },
      });
      launchSetupInBackground();
      return { restartQueued: true };
    }

    if (command.command_type === 'refresh_remote_access') {
      const remoteAccess = await refreshRemoteAccess();
      await completeRunnerCommand(command.id, {
        success: true,
        result: {
          message: 'Remote access refresh completed',
          remoteAccess,
        },
      });
      return { restartQueued: false };
    }

    if (command.command_type === 'sync_runner_code') {
      const result = await syncRunnerCode();
      await completeRunnerCommand(command.id, {
        success: true,
        result: {
          message: 'Portable runner synced from GitHub',
          ...result,
        },
      });

      if (command.payload && typeof command.payload === 'object' && command.payload.restart === false) {
        return { restartQueued: false };
      }

      scheduleRunnerRestart('Remote update installed. Restarting runner.');
      return { restartQueued: true };
    }

    throw new Error(`Unsupported command type: ${command.command_type}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await completeRunnerCommand(command.id, {
        success: false,
        error: message,
      });
    } catch (completeError) {
      console.error('[COMMAND] Failed to report command failure:', completeError.message);
    }

    writeRunnerState({
      status: 'error',
      message: `Command ${command.command_type} failed`,
      currentJobId: null,
      currentCommandId: command.id,
      currentCommandType: command.command_type,
      processedVideos,
      lastError: message,
      remoteAccess: collectRemoteAccessSnapshot(true),
    });

    return { restartQueued: false };
  } finally {
    isExecutingCommand = false;
    currentRunnerCommand = null;
  }
}

// ============= MAIN LOOP =============
async function mainLoop() {
  console.log('[RUNNER] Starting automation runner...');
  console.log('[RUNNER] Server:', config.serverUrl);
  console.log('[RUNNER] Authenticating with runner token');
  writeRunnerState({
    status: 'starting',
    message: 'Runner process started'
  });

  await registerRunner();
  await sendHeartbeat();
  setInterval(sendHeartbeat, 30000);

  // Clean up any stale media files from previous sessions
  cleanupOldMediaFiles();

  while (true) {
    try {
      if (!isProcessing) {
        const command = await getNextRunnerCommand();
        if (command) {
          console.log(`[COMMAND] Found runner command ${command.id}: ${command.command_type}`);
          const commandResult = await processRunnerCommand(command);
          if (commandResult?.restartQueued) {
            await sleep(15000);
            continue;
          }

          await sleep(2000);
          continue;
        }

        const job = await getJob();

        if (job) {
          if (!job.id) {
            console.log('[JOB] Received malformed job payload, skipping');
            writeRunnerState({
              status: 'warning',
              message: 'Malformed job payload received',
              currentCommandId: currentRunnerCommand ? currentRunnerCommand.id : null,
              currentCommandType: currentRunnerCommand ? currentRunnerCommand.command_type : null,
              lastError: 'Job payload missing id'
            });
            await sleep(5000);
            continue;
          }

          console.log(`[JOB] Found job ${job.id}`);
          isProcessing = true;
          currentJob = job;
          writeRunnerState({
            status: 'processing',
            message: `Processing job ${job.id}`,
            currentJobId: job.id,
            lastError: ''
          });

          try {
            if (job.automation_type === 'image') {
                const processedCount = await runImageRunnerScriptsJob(job);
                const imageResult = readImageResultFromRunnerScripts();
                processedVideos += processedCount;

                await completeJob(job.id, {
                  token: getRunnerAuthToken(),
                  success: true,
                  result: imageResult || { processed_count: processedCount },
                  video_url: typeof imageResult?.media_url === 'string' ? imageResult.media_url : null,
                  aspect_ratio: typeof imageResult?.aspect_ratio === 'string' ? imageResult.aspect_ratio : null,
                });

                writeRunnerState({
                  status: 'idle',
                  message: `Job ${job.id} completed`,
                  currentJobId: null,
                  processedVideos,
                  lastError: ''
                });

                console.log(`[JOB] Image job ${job.id} completed via image pipeline (${processedCount} output(s))`);
                continue;
              }

              const workflow = String(job?.config?.workflow || job?.input_data?.workflow || '').trim().toLowerCase();
              if (workflow === 'dubbing') {
                const rawDubbingSource = String(
                  job?.input_data?.source_value
                  || job?.config?.source_value
                  || job?.input_data?.video_url
                  || job?.video_url
                  || ''
                ).trim();

                const sourceUrls = expandLocalDirectorySources([rawDubbingSource].filter(Boolean));
                if (!sourceUrls.length) {
                  throw new Error('Dubbing job does not contain a usable source');
                }

                const runResult = await runRunnerScriptsJob(job, sourceUrls);
                const processedCount = runResult.processedCount;
                const localOutputMedia = findLatestLocalOutputMedia(job);
                processedVideos += processedCount;
                const dubbingReport = runResult.dubbingReport || readDubbingReportFromRunnerScripts();
                const finalVideoPath = dubbingReport?.final_video || null;

                await completeJob(job.id, {
                  token: getRunnerAuthToken(),
                  success: true,
                  result: {
                    workflow: 'dubbing',
                    processed_count: processedCount,
                    processed_videos: Array.isArray(runResult.processedVideos) ? runResult.processedVideos : [],
                    source_urls: sourceUrls,
                    source_value: rawDubbingSource,
                    local_output_media: finalVideoPath || localOutputMedia,
                    dubbing_report: dubbingReport,
                    skip_upload: true,
                  },
                  video_url: finalVideoPath || null,
                  source_video_url: sourceUrls[0] || null,
                  aspect_ratio: job?.config?.aspect_ratio || job?.input_data?.aspect_ratio || null,
                });

                writeRunnerState({
                  status: 'idle',
                  message: `Job ${job.id} completed`,
                  currentJobId: null,
                  processedVideos,
                  lastError: ''
                });

                console.log(`[JOB] Dubbing job ${job.id} completed via dubbing pipeline (${processedCount} output(s))`);
                continue;
              }

              const videosPerRun = parseInt(
                String(job?.input_data?.videos_per_run || job?.config?.videos_per_run || '1'),
                10
              ) || 1;

              const rawSourceUrls = job?.config?.video_source === 'local_folder'
                ? await pickLocalFolderVideos(job, videosPerRun)
                : Array.isArray(job?.input_data?.video_urls) && job.input_data.video_urls.length > 0
                ? job.input_data.video_urls
                : [job?.input_data?.video_url || job.video_url].filter(Boolean);

              const sourceUrls = expandLocalDirectorySources(rawSourceUrls);

              if (!sourceUrls.length) {
                throw new Error('Job does not contain a usable video source');
              }

              const runResult = await runRunnerScriptsJob(job, sourceUrls);
              const processedCount = runResult.processedCount;
              const localOutputMedia = findLatestLocalOutputMedia(job);
              processedVideos += processedCount;

              await completeJob(job.id, {
                token: getRunnerAuthToken(),
                success: true,
                result: {
                  processed_count: processedCount,
                  processed_videos: Array.isArray(runResult.processedVideos) ? runResult.processedVideos : [],
                  source_urls: sourceUrls,
                  local_output_media: localOutputMedia,
                  skip_upload: job?.config?.skip_upload === true || job?.input_data?.skip_upload === true,
                },
                video_url: runResult.primaryVideoUrl || localOutputMedia,
                source_video_url: sourceUrls[0] || null,
                aspect_ratio: job?.config?.aspect_ratio || job?.input_data?.aspect_ratio || null,
              });

              writeRunnerState({
                status: 'idle',
                message: `Job ${job.id} completed`,
                currentJobId: null,
                processedVideos,
                lastError: ''
              });

              console.log(`[JOB] Job ${job.id} completed successfully via shared pipeline (${processedCount} output(s))`);
              continue;
            } catch (e) {
              if (isLocalFolderExhaustedError(e)) {
                console.log(`[JOB] Job ${job.id} completed with no new local-folder videos remaining.`);
                await completeJob(job.id, {
                  success: true,
                  skipped: true,
                  processed_count: 0,
                  all_links_processed: true,
                  all_source_videos_processed: true,
                  completion_label: 'All local folder videos processed',
                  exhausted_source: 'local_folder',
                  source_folder: e.folderPath || null,
                  message: 'All local folder videos were already processed. History was preserved.',
                });
                continue;
              }

              console.error(`[JOB] Job ${job.id} failed:`, e.message);
              writeRunnerState({
                status: 'error',
                message: `Job ${job.id} failed`,
                currentJobId: job.id,
                lastError: e.message,
              });

              await httpRequest(`/api/runner/jobs/${job.id}/complete`, 'POST', {
                token: getRunnerAuthToken(),
                success: false,
                error: e.message
              });
              continue;
            }
          }
          isProcessing = false;
          currentJob = null;
          cleanupOldMediaFiles();
        } else {
          console.log('[WAIT] No pending jobs, waiting...');
          writeRunnerState({
            status: 'idle',
            message: 'No pending jobs. Waiting for next poll.',
            currentJobId: null,
            processedVideos,
          });
        }
    } catch (e) {
      console.error('[LOOP] Error:', e.message);
      writeRunnerState({
        status: 'error',
        message: 'Runner loop error',
        currentJobId: currentJob ? currentJob.id : null,
        lastError: e.message
      });
    }

    await sleep(10000);
  }
}

// ============= START =============
loadConfig();

if (!getRunnerAuthToken()) {
  console.error('[CONFIG] Missing required config! Please check config.txt');
  writeRunnerState({
    status: 'error',
    message: 'Missing runner auth in config.txt',
    lastError: 'RUNNER_TOKEN is required for this PC to act as a local runner'
  });
  process.exit(1);
}

console.log('[RUNNER] Config loaded successfully');
mainLoop().catch((e) => {
  console.error('[FATAL] Runner crashed:', e);
  writeRunnerState({
    status: 'crashed',
    message: 'Runner crashed and will be restarted by supervisor',
    currentJobId: currentJob ? currentJob.id : null,
    lastError: e.message || String(e)
  });
  process.exit(1);
});
