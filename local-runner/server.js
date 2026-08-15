const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFileSync, execSync, spawn } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "config.txt");
const RUNNER_STATE_PATH = path.join(__dirname, "runner-state.json");
const SUPERVISOR_STATE_PATH = path.join(__dirname, "supervisor-state.json");
const LOCAL_MEDIA_ROOTS_PATH = path.join(__dirname, "local-media-roots.json");
const BACKGROUND_SUPERVISOR_PATH = path.join(__dirname, "supervisor.js");
const NODE_EXE = path.join(__dirname, "tools", "node", "node.exe");
const LOCAL_BASE_URL = "http://127.0.0.1:3000";
const RUNNER_SCRIPTS_OUTPUT_DIR = path.resolve(__dirname, "..", "runner-scripts", "output");
const DUBBING_ENGINE_OUTPUT_DIR = path.resolve(__dirname, "..", "runner-scripts", "dubbing-engine", "output");

const DEFAULT_LOCAL_MEDIA_ROOTS = [
  RUNNER_SCRIPTS_OUTPUT_DIR,
  DUBBING_ENGINE_OUTPUT_DIR,
  path.join(__dirname, "processed"),
  path.join(__dirname, "downloads"),
].map((rootPath) => path.resolve(rootPath));
const TOOL_PATHS = {
  node: [
    path.join(__dirname, "tools", "node", "node.exe"),
  ],
  ffmpeg: [
    path.join(__dirname, "tools", "ffmpeg", "bin", "ffmpeg.exe"),
  ],
  "yt-dlp": [
    path.join(__dirname, "tools", "yt-dlp", "yt-dlp.exe"),
  ],
};
const DEFAULTS = {
  SERVER_URL: "https://waqas-ai-studio.waqaskhan1437.workers.dev",
  FRONTEND_URL: "https://frontend-nine-jet-27.vercel.app",
  RUNNER_TOKEN: "",
  ACCESS_TOKEN: "",
};
const AI_PROVIDER_LABELS = {
  openai: "OpenAI",
  gemini: "Google Gemini",
  grok: "xAI Grok",
  cohere: "Cohere",
  openrouter: "OpenRouter",
  groq: "Groq",
};
const AI_PROVIDER_ORDER = ["openai", "gemini", "grok", "cohere", "openrouter", "groq"];
const GEMINI_DEFAULT_TEXT_MODELS = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-2.5-pro",
];
const AI_PROVIDER_DEFAULT_MODELS = {
  openai: ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"],
  gemini: GEMINI_DEFAULT_TEXT_MODELS,
  grok: ["grok-4-fast-reasoning", "grok-4", "grok-3"],
  cohere: ["command-a-03-2025", "command-r-plus", "command-r7b-12-2024"],
  openrouter: [
    "google/gemini-2.5-flash",
    "openai/gpt-4o-mini",
    "meta-llama/llama-3.3-70b-instruct:free",
  ],
  groq: [
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant",
    "meta-llama/llama-4-scout-17b-16e-instruct",
  ],
};
const GEMINI_DEPRECATED_MODEL_IDS = new Set([
  "gemini-3-pro-preview",
  "gemini-2.5-flash-preview-09-2025",
  "gemini-2.5-flash-lite-preview-09-2025",
]);
const GEMINI_EXCLUDED_MODEL_KEYWORDS = [
  "image",
  "tts",
  "live",
  "native-audio",
  "embedding",
  "deep-research",
  "computer-use",
  "robotics",
  "veo",
  "lyria",
];

function loadConfig() {
  const config = { ...DEFAULTS };
  if (!fs.existsSync(CONFIG_PATH)) {
    return config;
  }

  const lines = fs.readFileSync(CONFIG_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const [key, ...rest] = line.split("=");
    if (!key || rest.length === 0) {
      continue;
    }
    config[key.trim()] = rest.join("=").trim();
  }
  return config;
}

function saveConfig(nextConfig) {
  const lines = [
    "# Lightweight local launcher",
    `SERVER_URL=${nextConfig.SERVER_URL || DEFAULTS.SERVER_URL}`,
    `FRONTEND_URL=${nextConfig.FRONTEND_URL || DEFAULTS.FRONTEND_URL}`,
    `RUNNER_TOKEN=${nextConfig.RUNNER_TOKEN || ""}`,
    `ACCESS_TOKEN=${nextConfig.ACCESS_TOKEN || ""}`,
  ];
  fs.writeFileSync(CONFIG_PATH, `${lines.join("\n")}\n`, "utf8");
}

function readRunnerState() {
  if (!fs.existsSync(RUNNER_STATE_PATH)) {
    return {
      status: "not_started",
      message: "Runner has not reported status yet.",
      updatedAt: null,
      currentJobId: null,
      processedVideos: 0,
      lastError: "",
    };
  }

  try {
    return JSON.parse(fs.readFileSync(RUNNER_STATE_PATH, "utf8"));
  } catch {
    return {
      status: "error",
      message: "Runner state file is unreadable.",
      updatedAt: null,
      currentJobId: null,
      processedVideos: 0,
      lastError: "Invalid runner-state.json",
    };
  }
}

function readSupervisorState() {
  if (!fs.existsSync(SUPERVISOR_STATE_PATH)) {
    return {
      status: "not_started",
      message: "Background supervisor has not reported status yet.",
      updatedAt: null,
      supervisorPid: null,
      lastError: "",
    };
  }

  try {
    return JSON.parse(fs.readFileSync(SUPERVISOR_STATE_PATH, "utf8"));
  } catch {
    return {
      status: "error",
      message: "Supervisor state file is unreadable.",
      updatedAt: null,
      supervisorPid: null,
      lastError: "Invalid supervisor-state.json",
    };
  }
}

function writeRunnerState(nextState) {
  const currentState = readRunnerState();
  const state = {
    ...currentState,
    ...nextState,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(RUNNER_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function escapePowerShellString(value) {
  return String(value || "").replace(/'/g, "''");
}

function getMatchingLocalProcessIds(filters) {
  const runnerDir = escapePowerShellString(__dirname);
  const clauses = filters.map((filter) => {
    const processName = escapePowerShellString(filter.processName);
    const fileName = escapePowerShellString(filter.fileName);
    return `($_.Name -eq '${processName}' -and $_.CommandLine -like '*${runnerDir}*${fileName}*')`;
  });

  const findScript = [
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    `  ${clauses.join(" -or ")}`,
    "}",
    "$targets | ForEach-Object { $_.ProcessId }",
  ].join("; ");

  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      findScript,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });

    return String(output)
      .split(/\r?\n/)
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function stopLocalRunnerProcesses() {
  const processIds = getMatchingLocalProcessIds([
    { processName: "node.exe", fileName: "runner.js" },
    { processName: "cmd.exe", fileName: "run-runner.bat" },
  ]);

  for (const pid of processIds) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {}
  }
}

function hasBackgroundSupervisorProcess() {
  const runnerDir = escapePowerShellString(__dirname);
  const countScript = [
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    `  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*${runnerDir}*supervisor.js*') -or`,
    `  ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*${runnerDir}*run-background-supervisor.bat*')`,
    "}",
    "Write-Output ($targets | Measure-Object).Count",
  ].join("; ");

  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      countScript,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });

    return Number.parseInt(String(output).trim(), 10) > 0;
  } catch {
    return false;
  }
}

function ensureBackgroundSupervisor() {
  if (hasBackgroundSupervisorProcess()) {
    return false;
  }

  if (!fs.existsSync(BACKGROUND_SUPERVISOR_PATH)) {
    throw new Error(`Background supervisor not found: ${BACKGROUND_SUPERVISOR_PATH}`);
  }

  const nodeCmd = fs.existsSync(NODE_EXE) ? NODE_EXE : "node";
  spawn(nodeCmd, [BACKGROUND_SUPERVISOR_PATH], {
    cwd: __dirname,
    stdio: "ignore",
    windowsHide: true,
  });
  return true;
}

function commandExists(command) {
  const bundledPaths = TOOL_PATHS[command] || [];
  if (bundledPaths.some((filePath) => fs.existsSync(filePath))) {
    return true;
  }

  try {
    execSync(`where ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getSelfCheck(config) {
  const state = readRunnerState();
  const supervisor = readSupervisorState();
  return {
    config: {
      serverUrl: config.SERVER_URL || DEFAULTS.SERVER_URL,
      dashboardMode: "local_proxy",
      dashboardUrl: "http://localhost:3000",
      hasAccessToken: Boolean(config.ACCESS_TOKEN),
      hasRunnerToken: Boolean(config.RUNNER_TOKEN),
      runnerAuthMode: config.RUNNER_TOKEN ? "runner_token" : "missing",
    },
    dependencies: {
      node: commandExists("node"),
      ffmpeg: commandExists("ffmpeg"),
      ytDlp: commandExists("yt-dlp"),
      winget: commandExists("winget"),
    },
    supervisor,
    runner: state,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isVideoFilePath(filePath) {
  return /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(filePath);
}

function isImageFilePath(filePath) {
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(filePath);
}

function getMediaContentType(filePath) {
  const lower = String(filePath || "").toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function readAllowedLocalMediaRoots() {
  const roots = [...DEFAULT_LOCAL_MEDIA_ROOTS];
  if (!fs.existsSync(LOCAL_MEDIA_ROOTS_PATH)) {
    return roots;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_MEDIA_ROOTS_PATH, "utf8"));
    if (!Array.isArray(parsed)) {
      return roots;
    }

    for (const value of parsed) {
      if (typeof value === "string" && value.trim()) {
        roots.push(path.resolve(value));
      }
    }
  } catch {}

  return Array.from(new Set(roots));
}

function isPathInsideAllowedRoot(absolutePath, allowedRoots) {
  return allowedRoots.some((rootPath) => {
    const relative = path.relative(rootPath, absolutePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function resolveSafeLocalMediaPath(rawPath) {
  const requestedPath = String(rawPath || "").trim();
  if (!requestedPath) {
    return null;
  }

  const absolutePath = path.resolve(requestedPath);
  if (!isPathInsideAllowedRoot(absolutePath, readAllowedLocalMediaRoots())) {
    return null;
  }

  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    return null;
  }

  if (!isVideoFilePath(absolutePath) && !isImageFilePath(absolutePath)) {
    return null;
  }

  return absolutePath;
}

function buildLocalMediaUrl(filePath, req) {
  const localOrigin = `http://${req.headers.host || "127.0.0.1:3000"}`;
  return `${localOrigin}/api/local-media?path=${encodeURIComponent(filePath)}`;
}

function rewriteLocalMediaFields(job, req) {
  if (!job || typeof job !== "object") {
    return job;
  }

  const nextJob = { ...job };
  const rawVideoUrl = typeof nextJob.video_url === "string" ? nextJob.video_url.trim() : "";
  if (rawVideoUrl && resolveSafeLocalMediaPath(rawVideoUrl)) {
    nextJob.video_url = buildLocalMediaUrl(rawVideoUrl, req);
  }

  if (typeof nextJob.output_data === "string" && nextJob.output_data.trim()) {
    try {
      const parsed = JSON.parse(nextJob.output_data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const output = { ...parsed };
        for (const key of ["local_output_media", "video_url", "media_url", "merged_video_url", "merged_local_output_media"]) {
          const value = typeof output[key] === "string" ? output[key].trim() : "";
          if (value && resolveSafeLocalMediaPath(value)) {
            output[key] = buildLocalMediaUrl(value, req);
          }
        }

        if (Array.isArray(output.processed_videos)) {
          output.processed_videos = output.processed_videos.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return item;
            }

            const nextItem = { ...item };
            const videoUrl = typeof nextItem.video_url === "string" ? nextItem.video_url.trim() : "";
            if (videoUrl && resolveSafeLocalMediaPath(videoUrl)) {
              nextItem.video_url = buildLocalMediaUrl(videoUrl, req);
            }
            // Also rewrite report.final_video in processed_videos
            if (nextItem.report && typeof nextItem.report === "object" && !Array.isArray(nextItem.report)) {
              const report = { ...nextItem.report };
              const reportFinalVideo = typeof report.final_video === "string" ? report.final_video.trim() : "";
              if (reportFinalVideo && resolveSafeLocalMediaPath(reportFinalVideo)) {
                report.final_video = buildLocalMediaUrl(reportFinalVideo, req);
              }
              nextItem.report = report;
            }
            return nextItem;
          });
        }

        // Rewrite dubbing_report.final_video
        if (output.dubbing_report && typeof output.dubbing_report === "object" && !Array.isArray(output.dubbing_report)) {
          const dubbingReport = { ...output.dubbing_report };
          const dubbingFinalVideo = typeof dubbingReport.final_video === "string" ? dubbingReport.final_video.trim() : "";
          if (dubbingFinalVideo && resolveSafeLocalMediaPath(dubbingFinalVideo)) {
            dubbingReport.final_video = buildLocalMediaUrl(dubbingFinalVideo, req);
          }
          output.dubbing_report = dubbingReport;
        }

        if (!output.video_url && typeof output.local_output_media === "string") {
          output.video_url = output.local_output_media;
        }

        if (!nextJob.video_url && typeof output.video_url === "string") {
          nextJob.video_url = output.video_url;
        }

        nextJob.output_data = JSON.stringify(output);
      }
    } catch {}
  }

  return nextJob;
}

function rewriteJobsApiPayload(payload, req) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const nextPayload = { ...payload };
  if (Array.isArray(nextPayload.data)) {
    nextPayload.data = nextPayload.data.map((job) => rewriteLocalMediaFields(job, req));
    return nextPayload;
  }

  if (nextPayload.data && typeof nextPayload.data === "object") {
    nextPayload.data = rewriteLocalMediaFields(nextPayload.data, req);
  }

  return nextPayload;
}

function sendLocalMediaFile(req, res, absolutePath) {
  const stats = fs.statSync(absolutePath);
  const contentType = getMediaContentType(absolutePath);
  const rangeHeader = req.headers.range || "";

  if (!isVideoFilePath(absolutePath) || !rangeHeader) {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(absolutePath).pipe(res);
    return;
  }

  const match = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(absolutePath).pipe(res);
    return;
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : stats.size - 1;
  const safeEnd = Math.min(end, stats.size - 1);

  if (!Number.isFinite(start) || !Number.isFinite(safeEnd) || start > safeEnd || start >= stats.size) {
    res.writeHead(416, {
      "Content-Range": `bytes */${stats.size}`,
    });
    res.end();
    return;
  }

  res.writeHead(206, {
    "Content-Type": contentType,
    "Content-Length": safeEnd - start + 1,
    "Content-Range": `bytes ${start}-${safeEnd}/${stats.size}`,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(absolutePath, { start, end: safeEnd }).pipe(res);
}

function yesNo(ok) {
  return ok ? "Ready" : "Missing";
}

function renderBadge(ok) {
  const tone = ok ? "#16a34a" : "#dc2626";
  return `<span style="display:inline-block;padding:6px 10px;border-radius:999px;background:${tone};color:white;font-size:12px;font-weight:600;">${yesNo(ok)}</span>`;
}

function renderPage(config, selfCheck, error = "") {
  const existingAccessToken = config.ACCESS_TOKEN || "";
  const existingFrontendUrl = config.FRONTEND_URL || DEFAULTS.FRONTEND_URL;
  const existingRunnerToken = config.RUNNER_TOKEN || "";
  const supervisor = selfCheck.supervisor;
  const runner = selfCheck.runner;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Automation Launcher</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #1f2937, #020617 58%); color: #e5e7eb; font-family: "Segoe UI", sans-serif; }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 48px; }
    .hero { margin-bottom: 22px; }
    .hero h1 { margin: 0 0 10px; font-size: 34px; }
    .hero p { margin: 0; color: #94a3b8; line-height: 1.6; }
    .grid { display: grid; grid-template-columns: 1.25fr 1fr; gap: 18px; }
    .card { background: rgba(15, 23, 42, 0.88); border: 1px solid rgba(148,163,184,0.18); border-radius: 18px; padding: 22px; box-shadow: 0 24px 64px rgba(0,0,0,0.3); }
    .card h2 { margin: 0 0 14px; font-size: 20px; }
    .card p { color: #94a3b8; line-height: 1.5; }
    label { display: block; margin: 16px 0 8px; font-size: 13px; color: #cbd5e1; }
    input { width: 100%; box-sizing: border-box; padding: 14px 16px; border-radius: 12px; border: 1px solid rgba(148,163,184,0.24); background: rgba(15,23,42,0.7); color: white; }
    button, .button-link { display: inline-block; text-decoration: none; width: 100%; margin-top: 16px; padding: 14px 16px; border: 0; border-radius: 12px; cursor: pointer; background: linear-gradient(135deg, #2563eb, #0ea5e9); color: white; font-weight: 600; text-align: center; box-sizing: border-box; }
    .button-link.secondary { background: rgba(30, 41, 59, 0.92); border: 1px solid rgba(148,163,184,0.2); }
    .error { margin-top: 12px; color: #fca5a5; font-size: 14px; }
    .meta { margin-top: 12px; font-size: 13px; color: #94a3b8; }
    .stats, .deps { display: grid; gap: 12px; }
    .stat { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 12px 14px; border-radius: 14px; background: rgba(2, 6, 23, 0.55); }
    .stat strong { font-size: 14px; }
    .stat span, .stat code { color: #cbd5e1; font-size: 13px; }
    .hint { margin-top: 14px; padding: 12px 14px; border-radius: 14px; background: rgba(59, 130, 246, 0.12); color: #bfdbfe; font-size: 13px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>Automation Launcher</h1>
      <p>Open the dashboard from this PC and use this page to confirm runner health and dependency status.</p>
    </div>
    <div class="grid">
      <form class="card" method="POST" action="/connect">
        <h2>Workspace Access</h2>
        <p>Bind this PC to one user only. The runner token locks the machine to a specific local-runner user, and the access token opens that same user's dashboard on localhost.</p>
        <label for="runner_token">Runner Token</label>
        <input id="runner_token" name="runner_token" type="password" placeholder="rnr_..." value="${escapeHtml(existingRunnerToken)}" />
        <label for="access_token">Access Token</label>
        <input id="access_token" name="access_token" type="password" placeholder="atk_..." value="${escapeHtml(existingAccessToken)}" />
        <label for="frontend_url">Frontend URL</label>
        <input id="frontend_url" name="frontend_url" type="url" placeholder="https://your-frontend.vercel.app" value="${escapeHtml(existingFrontendUrl)}" />
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
        <button type="submit">Open Dashboard</button>
        <a class="button-link secondary" href="/open">Resume Current Session</a>
        <div class="meta">Dashboard URL: http://localhost:3000</div>
        <div class="meta">Frontend URL: ${escapeHtml(existingFrontendUrl)}</div>
        <div class="meta">Worker API: ${escapeHtml(selfCheck.config.serverUrl)}</div>
        <div class="hint">Checklist: add the same user's <code>RUNNER_TOKEN</code> and <code>ACCESS_TOKEN</code>. Different users on the same PC are blocked. If dashboard open karte waqt Vercel 404 aaye, yahan valid hosted frontend URL update karein.</div>
      </form>
      <div class="card">
        <h2>Runner Self-Check</h2>
        <div class="stats" id="runner-stats">
          <div class="stat"><strong>Background</strong><span>${escapeHtml(supervisor.status || "-")}</span></div>
          <div class="stat"><strong>Status</strong><span>${escapeHtml(runner.status)}</span></div>
          <div class="stat"><strong>Message</strong><span>${escapeHtml(runner.message || "-")}</span></div>
          <div class="stat"><strong>Current Job</strong><span>${escapeHtml(runner.currentJobId || "-")}</span></div>
          <div class="stat"><strong>Processed Videos</strong><span>${escapeHtml(runner.processedVideos || 0)}</span></div>
          <div class="stat"><strong>Updated</strong><span>${escapeHtml(runner.updatedAt || "-")}</span></div>
        </div>
        <div class="hint" id="runner-error">${escapeHtml(runner.lastError || supervisor.lastError || "No runner errors reported.")}</div>
      </div>
      <div class="card">
        <h2>Dependency Health</h2>
        <div class="deps" id="deps">
          <div class="stat"><strong>Node.js</strong>${renderBadge(selfCheck.dependencies.node)}</div>
          <div class="stat"><strong>FFmpeg</strong>${renderBadge(selfCheck.dependencies.ffmpeg)}</div>
          <div class="stat"><strong>yt-dlp</strong>${renderBadge(selfCheck.dependencies.ytDlp)}</div>
          <div class="stat"><strong>winget</strong>${renderBadge(selfCheck.dependencies.winget)}</div>
        </div>
        <div class="hint">If FFmpeg or yt-dlp show as missing, rerun <code>setup.bat</code>. It attempts automatic install where possible.</div>
      </div>
      <div class="card">
        <h2>Configuration</h2>
        <div class="stats">
          <div class="stat"><strong>Access Token</strong>${renderBadge(selfCheck.config.hasAccessToken)}</div>
          <div class="stat"><strong>Runner Token</strong>${renderBadge(selfCheck.config.hasRunnerToken)}</div>
          <div class="stat"><strong>Runner Auth Mode</strong><code>${escapeHtml(selfCheck.config.runnerAuthMode)}</code></div>
          <div class="stat"><strong>Dashboard Mode</strong><code>${escapeHtml(selfCheck.config.dashboardMode)}</code></div>
          <div class="stat"><strong>Dashboard URL</strong><code>${escapeHtml(selfCheck.config.dashboardUrl)}</code></div>
          <div class="stat"><strong>Server URL</strong><code>${escapeHtml(selfCheck.config.serverUrl)}</code></div>
        </div>
      </div>
    </div>
  </div>
  <script>
    async function refreshSelfCheck() {
      try {
        const response = await fetch("/api/self-check");
        const data = await response.json();
        const supervisor = data.supervisor || {};
        const runner = data.runner || {};
        const deps = data.dependencies || {};
        document.getElementById("runner-stats").innerHTML = [
          ["Background", supervisor.status || "-"],
          ["Status", runner.status || "-"],
          ["Message", runner.message || "-"],
          ["Current Job", runner.currentJobId || "-"],
          ["Processed Videos", runner.processedVideos || 0],
          ["Updated", runner.updatedAt || "-"]
        ].map(([label, value]) => '<div class="stat"><strong>' + label + '</strong><span>' + String(value) + '</span></div>').join("");
        document.getElementById("runner-error").textContent = runner.lastError || supervisor.lastError || "No runner errors reported.";
        document.getElementById("deps").innerHTML = [
          ["Node.js", deps.node],
          ["FFmpeg", deps.ffmpeg],
          ["yt-dlp", deps.ytDlp],
          ["winget", deps.winget]
        ].map(([label, ok]) => {
          const color = ok ? "#16a34a" : "#dc2626";
          const text = ok ? "Ready" : "Missing";
          return '<div class="stat"><strong>' + label + '</strong><span style="display:inline-block;padding:6px 10px;border-radius:999px;background:' + color + ';color:white;font-size:12px;font-weight:600;">' + text + "</span></div>";
        }).join("");
      } catch {}
    }

    setInterval(refreshSelfCheck, 8000);
  </script>
</body>
</html>`;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendProxyError(res, error) {
  res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Local proxy error: ${error.message}`);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// ── Dubbing dependency doctor (cached) ───────────────────────────────────────
let dubbingDoctorCache = null;
let dubbingDoctorCacheAt = 0;
const DUBBING_DOCTOR_CACHE_MS = 30_000;

function getDoctorScriptPath() {
  const candidates = [
    path.resolve(__dirname, "..", "runner-scripts", "dubbing-engine", "doctor.js"),
    path.resolve(__dirname, "runner-scripts", "dubbing-engine", "doctor.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveDoctorNode() {
  if (fs.existsSync(NODE_EXE)) return NODE_EXE;
  return process.execPath || "node";
}

function summarizeDoctorRows(rows) {
  const get = (name) => rows.find((row) => row.name === name);
  const hasTranscribe = (get("whisperx")?.status) || (get("whisper")?.status);
  const hasTranslate =
    (get("transformers")?.status) ||
    (get("env:OPENAI_API_KEY")?.status) ||
    (get("env:OLLAMA_HOST")?.status);
  const hasVoice = (get("edge_tts")?.status) || (get("TTS")?.status) || (get("voxcpm2")?.status);
  const hasFfmpeg = (get("ffmpeg")?.status) && (get("ffprobe")?.status);
  const hasYtdlp = get("yt-dlp")?.status;
  const okCount = rows.filter((row) => row.status).length;

  let verdict = "ready";
  const missing = [];
  if (!hasFfmpeg) { verdict = "blocked"; missing.push("ffmpeg"); }
  if (!hasVoice) { verdict = "blocked"; missing.push("voice engine (install edge-tts)"); }
  if (verdict !== "blocked") {
    if (!hasTranscribe) { verdict = "degraded"; missing.push("transcription (install openai-whisper)"); }
    if (!hasTranslate) { verdict = "degraded"; missing.push("translation (set OPENAI_API_KEY or install transformers)"); }
  }

  return {
    verdict,
    missing,
    has_ffmpeg: !!hasFfmpeg,
    has_yt_dlp: !!hasYtdlp,
    has_transcribe: !!hasTranscribe,
    has_translate: !!hasTranslate,
    has_voice: !!hasVoice,
    ok_count: okCount,
    total: rows.length,
  };
}

function runDubbingDoctor() {
  return new Promise((resolve) => {
    const scriptPath = getDoctorScriptPath();
    if (!scriptPath) {
      resolve({
        ok: false,
        error: "doctor.js not found",
        verdict: "blocked",
        missing: ["runner-scripts/dubbing-engine/doctor.js missing"],
        rows: [],
      });
      return;
    }

    const nodeBin = resolveDoctorNode();
    const child = spawn(nodeBin, [scriptPath, "--json"], {
      cwd: path.dirname(scriptPath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 60_000);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolve({
        ok: false,
        error: err.message || String(err),
        verdict: "blocked",
        missing: ["doctor.js failed to start"],
        rows: [],
      });
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && !stdout.trim()) {
        resolve({
          ok: false,
          error: stderr.trim() || `doctor exited with code ${code}`,
          verdict: "blocked",
          missing: ["doctor.js error"],
          rows: [],
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
        const summary = summarizeDoctorRows(rows);
        resolve({
          ok: true,
          checked_at: new Date().toISOString(),
          python: parsed.python || null,
          rows,
          ...summary,
        });
      } catch (parseErr) {
        resolve({
          ok: false,
          error: `Failed to parse doctor output: ${parseErr.message}`,
          stdout_excerpt: stdout.slice(0, 500),
          verdict: "blocked",
          missing: ["doctor.js JSON parse failure"],
          rows: [],
        });
      }
    });
  });
}

async function getDubbingDoctorReport({ force = false } = {}) {
  const now = Date.now();
  if (!force && dubbingDoctorCache && (now - dubbingDoctorCacheAt) < DUBBING_DOCTOR_CACHE_MS) {
    return { ...dubbingDoctorCache, cached: true };
  }
  const fresh = await runDubbingDoctor();
  dubbingDoctorCache = fresh;
  dubbingDoctorCacheAt = now;
  return { ...fresh, cached: false };
}

function extractBearerToken(req) {
  const headerValue = req.headers.authorization || "";
  const match = String(headerValue).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function requestJson(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      method: options.method || "GET",
      path: `${url.pathname}${url.search}`,
      headers: options.headers || {},
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {}

        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          const message = parsed && typeof parsed.error === "string"
            ? parsed.error
            : `Request failed with status ${res.statusCode || 500}`;
          reject(new Error(message));
          return;
        }

        resolve(parsed);
      });
    });

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJsonRequestBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) {
    return null;
  }

  return JSON.parse(body);
}

function buildApiHeaders(accessToken, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callRemoteApiJson(config, accessToken, pathname, options = {}) {
  return requestJson(
    new URL(pathname, config.SERVER_URL || DEFAULTS.SERVER_URL).toString(),
    {
      method: options.method || "GET",
      headers: buildApiHeaders(accessToken, options.headers || {}),
      body: options.body || "",
    }
  );
}

async function loadAiSettings(config, accessToken) {
  const response = await callRemoteApiJson(config, accessToken, "/api/settings/ai");
  if (!response || typeof response !== "object") {
    return null;
  }

  return response.data && typeof response.data === "object" ? response.data : null;
}

function uniqueModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}

function compareModels(a, b) {
  if (a.tier === "free" && b.tier !== "free") return -1;
  if (b.tier === "free" && a.tier !== "free") return 1;
  return String(a.label || "").localeCompare(String(b.label || ""));
}

function parseContextWindow(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getModelTierFromPricing(pricing, id) {
  if (String(id || "").includes(":free")) return "free";
  if (!pricing || typeof pricing !== "object") return "unknown";
  const values = Object.values(pricing)
    .map((value) => Number.parseFloat(String(value)))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return "unknown";
  return values.every((value) => value === 0) ? "free" : "paid";
}

function isOpenAITextModel(id) {
  const lower = String(id || "").toLowerCase();
  if (
    lower.includes("embedding") ||
    lower.includes("realtime") ||
    lower.includes("audio") ||
    lower.includes("transcribe") ||
    lower.includes("tts") ||
    lower.includes("moderation") ||
    lower.includes("image") ||
    lower.includes("whisper") ||
    lower.includes("sora") ||
    lower.includes("search-preview") ||
    lower.includes("deep-research")
  ) {
    return false;
  }

  if (
    lower.includes("clipboard") ||
    lower.includes("vision") ||
    lower.includes("embed")
  ) {
    return false;
  }

  return (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("chatgpt-") ||
    lower.startsWith("gpt-oss") ||
    lower.startsWith("codex") ||
    lower.startsWith("gemini-") ||
    lower.startsWith("claude-") ||
    lower.startsWith("llama") ||
    lower.startsWith("mistral") ||
    lower.startsWith("command")
  );
}

function isGroqTextModel(id) {
  const lower = String(id || "").toLowerCase();
  return !(
    lower.includes("whisper") ||
    lower.includes("tts") ||
    lower.includes("guard") ||
    lower.includes("vision-preview")
  );
}

function isGrokTextModel(id) {
  const lower = String(id || "").toLowerCase();
  return !(lower.includes("image") || lower.includes("tts") || lower.includes("vision"));
}

function isGeminiTextModel(id) {
  const lower = String(id || "").toLowerCase();
  if (!lower.startsWith("gemini-")) {
    return false;
  }

  if (GEMINI_DEPRECATED_MODEL_IDS.has(lower)) {
    return false;
  }

  return !GEMINI_EXCLUDED_MODEL_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function getGeminiModelPriority(id) {
  const exactIndex = GEMINI_DEFAULT_TEXT_MODELS.indexOf(id);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const lower = String(id || "").toLowerCase();
  if (lower.startsWith("gemini-3")) return 100;
  if (lower.startsWith("gemini-2.5")) return 200;
  if (lower.startsWith("gemini-2.0")) return 300;
  if (lower.startsWith("gemini-1.5")) return 400;
  return 500;
}

function compareGeminiModels(a, b) {
  const priorityDelta = getGeminiModelPriority(a.id) - getGeminiModelPriority(b.id);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return compareModels(a, b);
}

async function readProviderError(prefix, response) {
  const errorText = String(await response.text()).trim();
  throw new Error(errorText ? `${prefix}: ${response.status} ${errorText}` : `${prefix}: ${response.status}`);
}

async function fetchOpenAIModels(apiKey) {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) await readProviderError("OpenAI models failed", response);
  const payload = await response.json();
  return uniqueModels(
    (Array.isArray(payload.data) ? payload.data : [])
      .filter((model) => model && model.id && isOpenAITextModel(model.id))
      .map((model) => ({ id: model.id, label: model.id, tier: "paid" }))
      .sort(compareModels)
  );
}

async function fetchGeminiModels(apiKey) {
  const params = new URLSearchParams({ key: String(apiKey || "").trim() });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`);
  if (!response.ok) await readProviderError("Gemini models failed", response);
  const payload = await response.json();
  return uniqueModels(
    (Array.isArray(payload.models) ? payload.models : [])
      .filter((model) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"))
      .map((model) => {
        const id = String(model.name || "").replace(/^models\//, "");
        return {
          id,
          label: model.displayName || id,
          description: model.description,
          contextWindow: parseContextWindow(model.inputTokenLimit),
          tier: "paid",
        };
      })
      .filter((model) => isGeminiTextModel(model.id))
      .sort(compareGeminiModels)
  );
}

async function fetchGrokModels(apiKey) {
  const response = await fetch("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) await readProviderError("xAI models failed", response);
  const payload = await response.json();
  return uniqueModels(
    (Array.isArray(payload.data) ? payload.data : [])
      .filter((model) => model && model.id && isGrokTextModel(model.id))
      .map((model) => ({ id: model.id, label: model.id, tier: "paid" }))
      .sort(compareModels)
  );
}

async function fetchCohereModels(apiKey) {
  const response = await fetch("https://api.cohere.com/v1/models?endpoint=chat&page_size=1000", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) await readProviderError("Cohere models failed", response);
  const payload = await response.json();
  return uniqueModels(
    (Array.isArray(payload.models) ? payload.models : [])
      .filter((model) => !model.is_deprecated)
      .filter((model) => {
        const endpoints = Array.isArray(model.endpoints) ? model.endpoints : [];
        const features = Array.isArray(model.features) ? model.features : [];
        return endpoints.includes("chat") || features.includes("chat-completions");
      })
      .map((model) => ({
        id: model.name,
        label: model.name,
        contextWindow: parseContextWindow(model.context_length),
        tier: "paid",
      }))
      .sort(compareModels)
  );
}

async function fetchOpenRouterModels(apiKey) {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) await readProviderError("OpenRouter models failed", response);
  const payload = await response.json();
  return uniqueModels(
    (Array.isArray(payload.data) ? payload.data : [])
      .filter((model) => {
        const outputModalities = Array.isArray(model.architecture?.output_modalities) ? model.architecture.output_modalities : [];
        return outputModalities.includes("text");
      })
      .map((model) => {
        const tier = getModelTierFromPricing(model.pricing, model.id);
        const labelSuffix = tier === "free" ? " (Free)" : "";
        return {
          id: model.id,
          label: `${model.name || model.id}${labelSuffix}`,
          description: model.description,
          tier,
          contextWindow: parseContextWindow(
            model.top_provider?.context_length != null ? model.top_provider.context_length : model.context_length
          ),
        };
      })
      .sort(compareModels)
  );
}

async function fetchGroqModels(apiKey) {
  const response = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) await readProviderError("Groq models failed", response);
  const payload = await response.json();
  return uniqueModels(
    (Array.isArray(payload.data) ? payload.data : [])
      .filter((model) => model && model.id && isGroqTextModel(model.id))
      .map((model) => ({ id: model.id, label: model.id, tier: "paid" }))
      .sort(compareModels)
  );
}

async function fetchProviderModels(provider, apiKey) {
  switch (provider) {
    case "openai":
      return fetchOpenAIModels(apiKey);
    case "gemini":
      return fetchGeminiModels(apiKey);
    case "grok":
      return fetchGrokModels(apiKey);
    case "cohere":
      return fetchCohereModels(apiKey);
    case "openrouter":
      return fetchOpenRouterModels(apiKey);
    case "groq":
      return fetchGroqModels(apiKey);
    default:
      return [];
  }
}

function fallbackModels(provider) {
  return AI_PROVIDER_DEFAULT_MODELS[provider].map((id) => ({
    id,
    label: id,
    tier: id.includes(":free") ? "free" : "unknown",
  }));
}

function getProviderApiKey(settings, provider) {
  switch (provider) {
    case "openai":
      return settings.openai_key || "";
    case "gemini":
      return settings.gemini_key || "";
    case "grok":
      return settings.grok_key || "";
    case "cohere":
      return settings.cohere_key || "";
    case "openrouter":
      return settings.openrouter_key || "";
    case "groq":
      return settings.groq_key || "";
    default:
      return "";
  }
}

function getConfiguredProviderIds(settings) {
  return AI_PROVIDER_ORDER.filter((provider) => Boolean(getProviderApiKey(settings, provider)));
}

async function buildAiCatalog(settings) {
  const configuredProviders = getConfiguredProviderIds(settings);
  const providers = await Promise.all(
    configuredProviders.map(async (provider) => {
      const apiKey = getProviderApiKey(settings, provider);
      try {
        const models = await fetchProviderModels(provider, apiKey);
        return {
          id: provider,
          label: AI_PROVIDER_LABELS[provider],
          models: models.length > 0 ? models : fallbackModels(provider),
        };
      } catch (error) {
        return {
          id: provider,
          label: AI_PROVIDER_LABELS[provider],
          models: fallbackModels(provider),
          error: error instanceof Error ? error.message : "Failed to fetch models",
        };
      }
    })
  );

  const defaultProvider = configuredProviders.includes(settings.default_provider)
    ? settings.default_provider
    : (configuredProviders[0] || null);

  return { default_provider: defaultProvider, providers };
}

function resolveModelForProvider(provider, preferredModel, catalog) {
  const providerModels = ((catalog || []).find((item) => item.id === provider) || {}).models || [];
  if (preferredModel && providerModels.some((model) => model.id === preferredModel)) {
    return preferredModel;
  }

  const configuredDefault = AI_PROVIDER_DEFAULT_MODELS[provider].find((id) =>
    providerModels.some((model) => model.id === id)
  );
  if (configuredDefault) return configuredDefault;
  return providerModels[0]?.id || AI_PROVIDER_DEFAULT_MODELS[provider][0];
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Could not parse JSON object from provider response");
  }

  const parsed = JSON.parse(match[0]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Provider JSON response was not an object");
  }

  return parsed;
}

function cleanTextBlock(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.replace(/\r\n?/g, "\n").trim();
}

function cleanStringList(value, limit, hashtagMode = false) {
  if (!Array.isArray(value)) return [];

  function normalize(str) {
    return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isDuplicate(newItem, existing) {
    const normalizedNew = normalize(newItem);
    return existing.some((item) => normalize(item) === normalizedNew);
  }

  const seen = [];
  value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => (hashtagMode ? (item.startsWith("#") ? item : `#${item.replace(/^#+/, "")}`) : item))
    .filter((item) => !isDuplicate(item, seen))
    .slice(0, limit)
    .forEach((item) => seen.push(item));

  return seen;
}

function parseTimestampSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  const raw = cleanTextBlock(value);
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  const timeMatch = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!timeMatch) return null;
  const first = Number.parseInt(timeMatch[1], 10);
  const second = Number.parseInt(timeMatch[2], 10);
  const third = timeMatch[3] ? Number.parseInt(timeMatch[3], 10) : null;
  if (!Number.isFinite(first) || !Number.isFinite(second) || (third !== null && !Number.isFinite(third))) {
    return null;
  }

  if (third !== null) {
    return first * 3600 + second * 60 + third;
  }

  return first * 60 + second;
}

function getTaglinesMessages(topic, count) {
  return {
    system: "You create short-form video overlay copy. Return valid JSON only. No markdown, no prose, no code fences. IMPORTANT: Never generate duplicate taglines - even if they differ slightly in wording, they must be meaningfully different.",
    user: [
      `Generate exactly ${count} TOP taglines and exactly ${count} BOTTOM taglines for short videos.`,
      `Topic: ${topic}`,
      "",
      "TOP TAGLINES (hooks that create curiosity and explain content):",
      "- Describe WHAT is happening in the video",
      "- Create curiosity or surprise",
      "- Short phrases that make viewers want to watch",
      "- Examples: 'What he did next will shock you', 'This is not what it looks like', 'She never expected this'",
      "- DO NOT repeat similar phrases even with different words",
      "",
      "BOTTOM TAGLINES (call-to-action for the website):",
      "- Website link CTA format: 'Order on [WEBSITE].com'",
      "- Examples: 'Order on prankwish.com', 'Get yours at prankwish.com', 'Shop now at prankwish.com'",
      "- Include the full website domain without 'https://'",
      "- Keep it short and punchy",
      "- DO NOT use generic CTAs like 'Follow for more' or 'Like and subscribe'",
      "",
      "IMPORTANT RULES:",
      "- NEVER generate duplicate taglines - each must be unique in meaning and words",
      "- Top and bottom taglines should complement each other, not overlap",
      "- Avoid emojis entirely",
      "- Each tagline should work alone but pair well with the other section",
      'Return JSON with this exact shape: {"top":["..."],"bottom":["..."]}',
    ].join("\n"),
  };
}

function getSocialMessages(topic, platform, count) {
  const hashtagCount = Math.min(Math.max(count * 3, 10), 40);
  return {
    system: "You create social media metadata. Return valid JSON only. No markdown, no prose, no code fences.",
    user: [
      `Generate social content for ${platform}.`,
      `Topic: ${topic}`,
      `Create exactly ${count} titles.`,
      `Create exactly ${count} descriptions.`,
      `Create exactly ${hashtagCount} hashtags.`,
      "Rules:",
      "- titles should be catchy and platform-native",
      "- descriptions should be short and usable as captions",
      "- hashtags must be unique and relevant",
      '- return JSON with this exact shape: {"titles":["..."],"descriptions":["..."],"hashtags":["#..."]}',
    ].join("\n"),
  };
}

function getShortPromptPlanMessages(prompt) {
  return {
    system: "You convert pasted short-video planning text into structured JSON. Return valid JSON only. No markdown, no prose, no code fences.",
    user: [
      "Analyze the pasted prompt and extract a reusable short-video plan.",
      "The prompt may include hooks, captions, hashtags, titles, timestamps, durations, short ideas, and merge hints.",
      "Rules:",
      "- If timestamps appear, convert them to numeric seconds.",
      "- Preserve the user's hook/caption/title wording as much as possible, but clean obvious formatting noise.",
      "- If a segment has a start and end time, duration_seconds must equal end_seconds - start_seconds.",
      "- If a segment is missing a title, create a short usable title from the same segment idea.",
      "- If a segment is missing hashtags, infer a few relevant ones from the same segment only.",
      "- If the prompt clearly suggests multiple shorts, return multiple segments in the same order.",
      "- recommended_merge should be true only when the prompt clearly asks to merge generated shorts.",
      '- Return JSON with this exact shape: {"overview":"...","recommended_merge":false,"segments":[{"hook":"...","title":"...","caption":"...","hashtags":["#..."],"start_seconds":16,"end_seconds":35,"duration_seconds":19}],"titles":["..."],"descriptions":["..."],"hashtags":["#..."]}',
      "",
      "Prompt text:",
      prompt,
    ].join("\n"),
  };
}

async function parseTextResponse(response) {
  const payload = await response.json();

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (Array.isArray(payload.output)) {
    const text = payload.output
      .flatMap((item) => {
        const content = item.content;
        if (!Array.isArray(content)) return [];
        return content
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .filter(Boolean);
      })
      .join("\n");

    if (text.trim()) return text;
  }

  if (Array.isArray(payload.choices)) {
    const text = payload.choices
      .map((choice) => {
        const message = choice.message;
        return typeof message?.content === "string" ? message.content : "";
      })
      .join("\n");

    if (text.trim()) return text;
  }

  throw new Error("Provider returned no usable text");
}

async function generateWithOpenAI(apiKey, model, messages) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
    }),
  });

  if (response.ok) {
    return parseTextResponse(response);
  }

  const fallback = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
      temperature: 0.7,
    }),
  });

  if (!fallback.ok) {
    const errorText = await fallback.text();
    throw new Error(`OpenAI request failed: ${fallback.status} ${errorText}`);
  }

  return parseTextResponse(fallback);
}

async function generateWithOpenAICompatible(baseUrl, apiKey, model, messages, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Provider request failed: ${response.status} ${errorText}`);
  }

  return parseTextResponse(response);
}

async function generateWithGemini(apiKey, model, messages) {
  const params = new URLSearchParams({ key: String(apiKey || "").trim() });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?${params.toString()}`;
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [{ text: `${messages.system}\n\n${messages.user}` }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: "application/json",
    },
  });

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (response.ok) {
      const payload = await response.json();
      const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini returned no usable text");
      return text;
    }

    const errorText = await response.text();
    const isRetryable = response.status === 429 || response.status === 503;
    lastError = new Error(`Gemini request failed: ${response.status} ${errorText}`);
    if (!isRetryable || attempt === 2) {
      throw lastError;
    }

    await sleep(1200 * (attempt + 1));
  }

  throw lastError || new Error("Gemini request failed");
}

async function generateWithCohere(apiKey, model, messages) {
  const response = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const fallback = await fetch("https://api.cohere.com/v2/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
      }),
    });

    if (!fallback.ok) {
      const errorText = await fallback.text();
      throw new Error(`Cohere request failed: ${fallback.status} ${errorText}`);
    }

    const payload = await fallback.json();
    const text = payload.message?.content?.find((item) => typeof item.text === "string")?.text;
    if (!text) throw new Error("Cohere returned no usable text");
    return text;
  }

  const payload = await response.json();
  const text = payload.message?.content?.find((item) => typeof item.text === "string")?.text;
  if (!text) throw new Error("Cohere returned no usable text");
  return text;
}

async function generateAiJson(settings, provider, model, messages, config) {
  const apiKey = getProviderApiKey(settings, provider);
  if (!apiKey) {
    throw new Error(`No API key saved for ${AI_PROVIDER_LABELS[provider]}`);
  }

  let rawText = "";
  switch (provider) {
    case "openai":
      rawText = await generateWithOpenAI(apiKey, model, messages);
      break;
    case "gemini":
      rawText = await generateWithGemini(apiKey, model, messages);
      break;
    case "grok":
      rawText = await generateWithOpenAICompatible("https://api.x.ai/v1", apiKey, model, messages);
      break;
    case "cohere":
      rawText = await generateWithCohere(apiKey, model, messages);
      break;
    case "openrouter":
      rawText = await generateWithOpenAICompatible(
        "https://openrouter.ai/api/v1",
        apiKey,
        model,
        messages,
        {
          "HTTP-Referer": config.FRONTEND_URL || DEFAULTS.FRONTEND_URL,
          "X-Title": "Automation Frontend",
        }
      );
      break;
    case "groq":
      rawText = await generateWithOpenAICompatible("https://api.groq.com/openai/v1", apiKey, model, messages);
      break;
    default:
      throw new Error("Unsupported AI provider");
  }

  return parseJsonObject(rawText);
}

function normalizeTaglinesResult(payload, count) {
  const top = cleanStringList(payload.top, count);
  const bottom = cleanStringList(payload.bottom, count);
  if (top.length === 0 || bottom.length === 0) {
    throw new Error("Provider response did not include valid top/bottom taglines");
  }
  return { top, bottom };
}

function normalizeSocialResult(payload, count) {
  const titles = cleanStringList(payload.titles, count);
  const descriptions = cleanStringList(payload.descriptions, count);
  const hashtags = cleanStringList(payload.hashtags, Math.min(Math.max(count * 3, 10), 40), true);
  if (titles.length === 0 || descriptions.length === 0 || hashtags.length === 0) {
    throw new Error("Provider response did not include valid titles, descriptions, and hashtags");
  }
  return { titles, descriptions, hashtags };
}

function normalizeShortPromptPlanResult(payload) {
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
  const segments = rawSegments
    .map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const record = item;
      const hook = cleanTextBlock(record.hook);
      const title = cleanTextBlock(record.title || record.headline || record.name);
      const caption = cleanTextBlock(record.caption || record.description);
      const hashtags = cleanStringList(record.hashtags, 12, true);
      const start = parseTimestampSeconds(record.start_seconds ?? record.start ?? record.timestamp_start);
      const end = parseTimestampSeconds(record.end_seconds ?? record.end ?? record.timestamp_end);
      const durationValue = parseTimestampSeconds(record.duration_seconds ?? record.duration);
      const resolvedStart = start ?? 0;
      const resolvedEnd = end ?? (durationValue !== null ? resolvedStart + durationValue : null);
      const resolvedDuration = resolvedEnd !== null
        ? Math.max(1, resolvedEnd - resolvedStart)
        : (durationValue !== null ? Math.max(1, durationValue) : null);

      if ((!hook && !title && !caption) || resolvedEnd === null || resolvedEnd <= resolvedStart) {
        return null;
      }

      return {
        hook: hook || title || caption || `Segment ${index + 1}`,
        title: title || hook || `Short ${index + 1}`,
        caption: caption || title || hook || "",
        hashtags,
        start_seconds: resolvedStart,
        end_seconds: resolvedEnd,
        duration_seconds: resolvedDuration || Math.max(1, resolvedEnd - resolvedStart),
      };
    })
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error("Provider response did not include valid timestamp segments");
  }

  const socialSetCount = Math.max(segments.length, 1);
  const titles = cleanStringList(payload.titles, socialSetCount);
  const descriptions = cleanStringList(payload.descriptions, socialSetCount);
  const hashtags = cleanStringList(payload.hashtags, Math.min(Math.max(socialSetCount * 3, 3), 40), true);

  return {
    overview: cleanTextBlock(payload.overview, `Prompt-based short plan with ${segments.length} segment(s).`),
    recommended_merge: payload.recommended_merge === true,
    segments,
    titles: titles.length > 0 ? titles : segments.map((segment) => segment.title),
    descriptions: descriptions.length > 0 ? descriptions : segments.map((segment) => segment.caption),
    hashtags: hashtags.length > 0
      ? hashtags
      : Array.from(new Set(segments.flatMap((segment) => segment.hashtags))).slice(0, 40),
  };
}

async function testAiProvider(provider, apiKey) {
  switch (provider) {
    case "openai": {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok
        ? { success: true, message: "OpenAI connected successfully" }
        : { success: false, message: await readProviderTestMessage("OpenAI", response) };
    }
    case "gemini": {
      const params = new URLSearchParams({ key: String(apiKey || "").trim() });
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`);
      return response.ok
        ? { success: true, message: "Gemini connected successfully" }
        : { success: false, message: await readProviderTestMessage("Gemini", response) };
    }
    case "grok": {
      const response = await fetch("https://api.x.ai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok
        ? { success: true, message: "Grok connected successfully" }
        : { success: false, message: await readProviderTestMessage("Grok", response) };
    }
    case "cohere": {
      const response = await fetch("https://api.cohere.ai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok
        ? { success: true, message: "Cohere connected successfully" }
        : { success: false, message: await readProviderTestMessage("Cohere", response) };
    }
    case "openrouter": {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok
        ? { success: true, message: "OpenRouter connected successfully" }
        : { success: false, message: await readProviderTestMessage("OpenRouter", response) };
    }
    case "groq": {
      const response = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok
        ? { success: true, message: "Groq connected successfully" }
        : { success: false, message: await readProviderTestMessage("Groq", response) };
    }
    default:
      throw new Error("Unknown provider");
  }
}

async function readProviderTestMessage(providerLabel, response) {
  if (response.ok) {
    return `${providerLabel} connected successfully`;
  }
  const errorText = String(await response.text()).trim();
  return errorText ? `${providerLabel} error: ${response.status} ${errorText}` : `${providerLabel} error: ${response.status}`;
}

async function handleLocalAiTest(req, res, config) {
  try {
    const body = await readJsonRequestBody(req);
    if (!body || !body.provider || !body.api_key) {
      sendJson(res, 400, { success: false, error: "provider and api_key required" });
      return;
    }

    const result = await testAiProvider(String(body.provider), String(body.api_key).trim());
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : "Connection failed" });
  }
}

async function handleLocalAiModels(req, res, config) {
  try {
    const accessToken = extractBearerToken(req) || config.ACCESS_TOKEN || "";
    if (!accessToken) {
      sendJson(res, 401, { success: false, error: "Access token required" });
      return;
    }

    const settings = await loadAiSettings(config, accessToken);
    if (!settings) {
      sendJson(res, 200, { success: true, data: { default_provider: null, providers: [] } });
      return;
    }

    const catalog = await buildAiCatalog(settings);
    sendJson(res, 200, { success: true, data: catalog });
  } catch (error) {
    sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : "Failed to load AI models" });
  }
}

async function handleLocalAiGenerate(req, res, config) {
  try {
    const accessToken = extractBearerToken(req) || config.ACCESS_TOKEN || "";
    if (!accessToken) {
      sendJson(res, 401, { success: false, error: "Access token required" });
      return;
    }

    const body = await readJsonRequestBody(req);
    if (!body || !body.task) {
      sendJson(res, 400, { success: false, error: "task is required" });
      return;
    }

    if (body.task === "image_banner") {
      const forwarded = await callRemoteApiJson(config, accessToken, "/api/settings/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      sendJson(res, 200, forwarded);
      return;
    }

    const settings = await loadAiSettings(config, accessToken);
    if (!settings) {
      sendJson(res, 400, { success: false, error: "No AI settings configured" });
      return;
    }

    const configuredProviders = getConfiguredProviderIds(settings);
    if (configuredProviders.length === 0) {
      sendJson(res, 400, { success: false, error: "No AI provider API keys saved in Settings" });
      return;
    }

    const catalog = await buildAiCatalog(settings);
    const requestedProvider = typeof body.provider === "string" ? body.provider : "";
    const provider = requestedProvider && configuredProviders.includes(requestedProvider)
      ? requestedProvider
      : catalog.default_provider;

    if (!provider) {
      sendJson(res, 400, { success: false, error: "No configured AI provider available" });
      return;
    }

    const resolvedModel = resolveModelForProvider(provider, typeof body.model === "string" ? body.model : "", catalog.providers);

    if (body.task === "taglines") {
      const topic = String(body.prompt || body.topic || "").trim();
      const count = Math.min(Math.max(Number(body.count || 5), 1), 10);
      if (!topic) {
        sendJson(res, 400, { success: false, error: "prompt is required for tagline generation" });
        return;
      }

      const parsed = await generateAiJson(settings, provider, resolvedModel, getTaglinesMessages(topic, count), config);
      sendJson(res, 200, {
        success: true,
        data: {
          ...normalizeTaglinesResult(parsed, count),
          provider,
          model: resolvedModel,
        },
      });
      return;
    }

    if (body.task === "social") {
      const topic = String(body.topic || body.prompt || "").trim();
      const platform = String(body.platform || "instagram").trim();
      const count = Math.min(Math.max(Number(body.count || 10), 1), 50);
      if (!topic) {
        sendJson(res, 400, { success: false, error: "topic is required for social generation" });
        return;
      }

      const parsed = await generateAiJson(settings, provider, resolvedModel, getSocialMessages(topic, platform, count), config);
      sendJson(res, 200, {
        success: true,
        data: {
          ...normalizeSocialResult(parsed, count),
          provider,
          model: resolvedModel,
        },
      });
      return;
    }

    if (body.task === "short_prompt_plan") {
      const prompt = String(body.prompt || body.topic || "").trim();
      if (!prompt) {
        sendJson(res, 400, { success: false, error: "prompt is required for short prompt planning" });
        return;
      }

      const parsed = await generateAiJson(settings, provider, resolvedModel, getShortPromptPlanMessages(prompt), config);
      sendJson(res, 200, {
        success: true,
        data: {
          plan: normalizeShortPromptPlanResult(parsed),
          provider,
          model: resolvedModel,
        },
      });
      return;
    }

    sendJson(res, 400, { success: false, error: "Unknown AI generation task" });
  } catch (error) {
    sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : "AI generation failed" });
  }
}

async function fetchAccessTokenUser(config, accessToken) {
  if (!accessToken) {
    return null;
  }

  const response = await requestJson(
    new URL("/api/auth/token", config.SERVER_URL || DEFAULTS.SERVER_URL).toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response?.data?.user || null;
}

async function fetchRunnerTokenUser(config, runnerToken) {
  if (!runnerToken) {
    return null;
  }

  const identityUrl = new URL("/api/runner/identity", config.SERVER_URL || DEFAULTS.SERVER_URL);
  identityUrl.searchParams.set("token", runnerToken);
  const response = await requestJson(identityUrl.toString());
  return response?.data?.user || null;
}

async function resolveWorkspaceBinding(config, accessToken = config.ACCESS_TOKEN || "") {
  const runnerToken = config.RUNNER_TOKEN || "";
  if (!runnerToken) {
    return {
      ok: false,
      accessUser: null,
      runnerUser: null,
      error: "Runner token is required on this PC before the local runner can be used.",
    };
  }

  if (!accessToken) {
    return {
      ok: false,
      accessUser: null,
      runnerUser: null,
      error: "Access token is required to open the local dashboard for this PC.",
    };
  }

  const [accessUser, runnerUser] = await Promise.all([
    fetchAccessTokenUser(config, accessToken).catch(() => null),
    fetchRunnerTokenUser(config, runnerToken).catch(() => null),
  ]);

  if (!runnerUser) {
    return {
      ok: false,
      accessUser,
      runnerUser: null,
      error: "Runner token is invalid or not linked to an active user.",
    };
  }

  if (accessToken && !accessUser) {
    return {
      ok: false,
      accessUser: null,
      runnerUser,
      error: "Access token is invalid or revoked.",
    };
  }

  if (accessUser && runnerUser && accessUser.id !== runnerUser.id) {
    return {
      ok: false,
      accessUser,
      runnerUser,
      error: `This PC is linked to runner workspace user ${runnerUser.id}, but the dashboard token belongs to user ${accessUser.id}. Use the matching token for this PC.`,
    };
  }

  return {
    ok: true,
    accessUser,
    runnerUser,
    error: "",
  };
}

function rewriteLocationHeader(location, req) {
  if (!location) {
    return location;
  }

  const localOrigin = `http://${req.headers.host || "127.0.0.1:3000"}`;
  const configuredFrontend = loadConfig().FRONTEND_URL || DEFAULTS.FRONTEND_URL;

  try {
    const nextLocation = new URL(location, configuredFrontend);
    const frontendOrigin = new URL(configuredFrontend).origin;
    if (nextLocation.origin === frontendOrigin) {
      return `${localOrigin}${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`;
    }
  } catch {}

  return location;
}

function injectLocalApiRewriteScript(html, req, config) {
  const localOrigin = `http://${req.headers.host || "127.0.0.1:3000"}`;
  const configuredServer = String(config.SERVER_URL || DEFAULTS.SERVER_URL).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const localOriginLiteral = localOrigin.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const rewriteScript = `
<script>
(() => {
  const LOCAL_ORIGIN = "${localOriginLiteral}";
  const REMOTE_API_BASE = "${configuredServer}";

  function isLocalMediaPath(value) {
    return typeof value === "string" && /^[A-Za-z]:\\\\/.test(value.trim());
  }

  function toLocalMediaUrl(value) {
    return LOCAL_ORIGIN + "/api/local-media?path=" + encodeURIComponent(String(value || "").trim());
  }

  function rewriteJobRecord(job) {
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      return job;
    }

    const nextJob = { ...job };
    if (isLocalMediaPath(nextJob.video_url)) {
      nextJob.video_url = toLocalMediaUrl(nextJob.video_url);
    }

    if (typeof nextJob.output_data === "string" && nextJob.output_data.trim()) {
      try {
        const parsed = JSON.parse(nextJob.output_data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const output = { ...parsed };
          for (const key of ["local_output_media", "video_url", "media_url", "merged_video_url", "merged_local_output_media"]) {
            if (isLocalMediaPath(output[key])) {
              output[key] = toLocalMediaUrl(output[key]);
            }
          }

          if (Array.isArray(output.processed_videos)) {
            output.processed_videos = output.processed_videos.map((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) {
                return item;
              }

              const nextItem = { ...item };
              if (isLocalMediaPath(nextItem.video_url)) {
                nextItem.video_url = toLocalMediaUrl(nextItem.video_url);
              }
              // Also rewrite report.final_video in processed_videos
              if (nextItem.report && typeof nextItem.report === "object" && !Array.isArray(nextItem.report)) {
                const report = { ...nextItem.report };
                if (isLocalMediaPath(report.final_video)) {
                  report.final_video = toLocalMediaUrl(report.final_video);
                }
                nextItem.report = report;
              }
              return nextItem;
            });
          }

          // Rewrite dubbing_report.final_video
          if (output.dubbing_report && typeof output.dubbing_report === "object" && !Array.isArray(output.dubbing_report)) {
            const dubbingReport = { ...output.dubbing_report };
            if (isLocalMediaPath(dubbingReport.final_video)) {
              dubbingReport.final_video = toLocalMediaUrl(dubbingReport.final_video);
            }
            output.dubbing_report = dubbingReport;
          }

          if (!output.video_url && typeof output.local_output_media === "string") {
            output.video_url = output.local_output_media;
          }

          if (!nextJob.video_url && typeof output.video_url === "string") {
            nextJob.video_url = output.video_url;
          }

          nextJob.output_data = JSON.stringify(output);
        }
      } catch {}
    }

    return nextJob;
  }

  function rewriteJobsPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return payload;
    }

    const nextPayload = { ...payload };
    if (Array.isArray(nextPayload.data)) {
      nextPayload.data = nextPayload.data.map((job) => rewriteJobRecord(job));
      return nextPayload;
    }

    if (nextPayload.data && typeof nextPayload.data === "object") {
      nextPayload.data = rewriteJobRecord(nextPayload.data);
    }

    return nextPayload;
  }

  function shouldRewriteJobsResponse(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.pathname === "/api/jobs" || /^\\/api\\/jobs\\/\\d+$/.test(parsed.pathname);
    } catch {}

    return false;
  }

  function cloneJsonResponse(response, payload) {
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  function rewriteUrl(input) {
    try {
      const candidate = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input && typeof input.url === "string"
        ? input.url
        : "";
      if (!candidate) {
        return null;
      }

      const parsed = new URL(candidate, window.location.origin);
      const remote = new URL(REMOTE_API_BASE, window.location.origin);
      if (parsed.origin === remote.origin && parsed.pathname.startsWith("/api/")) {
        return LOCAL_ORIGIN + parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {}

    return null;
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const rewritten = rewriteUrl(input);
    const requestUrl = rewritten || (typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input && typeof input.url === "string"
      ? input.url
      : "");

    let response;
    if (!rewritten) {
      response = await originalFetch(input, init);
    } else if (typeof Request !== "undefined" && input instanceof Request) {
      response = await originalFetch(new Request(rewritten, input), init);
    } else {
      response = await originalFetch(rewritten, init);
    }

    if (!shouldRewriteJobsResponse(requestUrl) || !response || !response.ok) {
      return response;
    }

    try {
      const payload = await response.clone().json();
      return cloneJsonResponse(response, rewriteJobsPayload(payload));
    } catch {
      return response;
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
    const rewritten = rewriteUrl(url);
    return originalOpen.call(this, method, rewritten || url, async, user, password);
  };
})();
</script>`;

  if (html.includes("</head>")) {
    return html.replace("</head>", `${rewriteScript}</head>`);
  }

  return `${rewriteScript}${html}`;
}

function getProxyHeaders(req, targetUrl, options = {}) {
  const headers = { ...req.headers };
  headers.host = targetUrl.host;
  headers.connection = "close";
  delete headers["content-length"];
  if (options.disableCompression) {
    delete headers["accept-encoding"];
  }
  return headers;
}

function proxyRequest(req, res, targetBaseUrl, hooks = {}) {
  const onProxyResponse = typeof hooks.onProxyResponse === "function" ? hooks.onProxyResponse : null;
  const onProxyError = typeof hooks.onProxyError === "function" ? hooks.onProxyError : null;
  const interceptResponse = typeof hooks.interceptResponse === "function" ? hooks.interceptResponse : null;
  const transformJson = typeof hooks.transformJson === "function" ? hooks.transformJson : null;
  const transformHtml = typeof hooks.transformHtml === "function" ? hooks.transformHtml : null;
  const requestUrl = new URL(req.url, LOCAL_BASE_URL);
  const upstreamBase = new URL(targetBaseUrl);
  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, upstreamBase);
  const transport = targetUrl.protocol === "https:" ? https : http;
  const disableCompression = Boolean(transformJson || transformHtml);

  const proxyReq = transport.request({
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    headers: getProxyHeaders(req, targetUrl, { disableCompression }),
  }, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    if (responseHeaders.location) {
      responseHeaders.location = rewriteLocationHeader(responseHeaders.location, req);
    }

    if (onProxyResponse) {
      onProxyResponse(proxyRes);
    }

    if (interceptResponse && interceptResponse(proxyRes, responseHeaders)) {
      proxyRes.resume();
      return;
    }

    const contentType = String(proxyRes.headers["content-type"] || "");
    if (transformJson && contentType.includes("application/json")) {
      let body = "";
      proxyRes.setEncoding("utf8");
      proxyRes.on("data", (chunk) => {
        body += chunk;
      });
      proxyRes.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : null;
          const transformed = transformJson(parsed, proxyRes) ?? parsed;
          const nextBody = JSON.stringify(transformed);
          delete responseHeaders["content-encoding"];
          delete responseHeaders["transfer-encoding"];
          responseHeaders["content-length"] = Buffer.byteLength(nextBody);
          res.writeHead(proxyRes.statusCode || 502, responseHeaders);
          res.end(nextBody);
        } catch {
          res.writeHead(proxyRes.statusCode || 502, responseHeaders);
          res.end(body);
        }
      });
      return;
    }

    if (transformHtml && contentType.includes("text/html")) {
      let body = "";
      proxyRes.setEncoding("utf8");
      proxyRes.on("data", (chunk) => {
        body += chunk;
      });
      proxyRes.on("end", () => {
        const nextBody = transformHtml(body, proxyRes) ?? body;
        delete responseHeaders["content-encoding"];
        delete responseHeaders["transfer-encoding"];
        responseHeaders["content-length"] = Buffer.byteLength(nextBody);
        res.writeHead(proxyRes.statusCode || 502, responseHeaders);
        res.end(nextBody);
      });
      return;
    }

    res.writeHead(proxyRes.statusCode || 502, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (error) => {
    if (onProxyError) {
      onProxyError(error);
    }
    sendProxyError(res, error);
  });

  if (req.method === "GET" || req.method === "HEAD") {
    proxyReq.end();
    return;
  }

  req.pipe(proxyReq);
}

function proxyFrontend(req, res, config, hooks = {}) {
  return proxyRequest(req, res, config.FRONTEND_URL || DEFAULTS.FRONTEND_URL, hooks);
}

function proxyApi(req, res, config, hooks = {}) {
  return proxyRequest(req, res, config.SERVER_URL || DEFAULTS.SERVER_URL, hooks);
}

function isLocalAutomationRunRequest(method, pathname) {
  return method === "POST" && /^\/api\/automations\/\d+\/run$/.test(pathname);
}

function isLocalJobCancelRequest(method, pathname) {
  return method === "POST" && /^\/api\/jobs\/\d+\/cancel$/.test(pathname);
}

function isJobsApiRequest(method, pathname) {
  if (method !== "GET") {
    return false;
  }

  return pathname === "/api/jobs" || /^\/api\/jobs\/\d+$/.test(pathname);
}

async function handleLocalAutomationRun(req, res, config) {
  const requestToken = extractBearerToken(req) || config.ACCESS_TOKEN || "";
  const workspaceBinding = await resolveWorkspaceBinding(config, requestToken);
  if (!workspaceBinding.ok) {
    writeRunnerState({
      status: "error",
      message: "Blocked local automation run because dashboard and runner tokens point to different workspaces.",
      currentJobId: null,
      lastError: workspaceBinding.error,
    });
    sendJson(res, 409, {
      success: false,
      error: workspaceBinding.error,
      code: "LOCAL_RUNNER_WORKSPACE_MISMATCH",
      data: {
        runner_user_id: workspaceBinding.runnerUser?.id || null,
        access_user_id: workspaceBinding.accessUser?.id || null,
      },
    });
    return;
  }

  // Check for queued or in-progress jobs using local state (no body read needed)
  const runnerStatus = readRunnerState();
  const { currentJobId, status, queuedJobs } = runnerStatus;
  const hasActiveJob = currentJobId !== null && (status === "processing" || status === "error");
  const queueCount = queuedJobs || 0;

  if (hasActiveJob || queueCount > 0) {
    const warningParts = [];
    if (hasActiveJob) warningParts.push(`Job #${currentJobId} is currently running`);
    if (queueCount > 0) warningParts.push(`${queueCount} job(s) are queued`);
    const warningMsg = warningParts.join(", ") + ". Starting a new automation will cancel existing jobs.";

    // Check for confirm=true query param (added by frontend after user confirmation)
    const confirmParam = requestUrl.searchParams.get("confirm");
    if (confirmParam !== "true" && confirmParam !== "1") {
      sendJson(res, 409, {
        success: false,
        error: warningMsg,
        code: "LOCAL_RUNNER_JOBS_QUEUED",
        data: {
          currentJobId,
          queueCount,
          hasActiveJob,
          needsConfirmation: true,
        },
      });
      return;
    }
  }

  writeRunnerState({
    status: "restarting",
    message: "Stopping previous local runner before starting the latest automation run.",
    currentJobId: null,
    lastError: "",
  });

  try {
    stopLocalRunnerProcesses();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeRunnerState({
      status: "error",
      message: "Failed to stop the previous local runner.",
      currentJobId: null,
      lastError: message,
    });
    sendProxyError(res, new Error(`Runner stop failed: ${message}`));
    return;
  }

  let runnerStarted = false;
  const ensureRunnerStarted = () => {
    if (runnerStarted) {
      return;
    }
    runnerStarted = true;

    try {
      ensureBackgroundSupervisor();
      writeRunnerState({
        status: "starting",
        message: "Background supervisor will bring the local runner back online.",
        currentJobId: null,
        lastError: "",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeRunnerState({
        status: "error",
        message: "Automation was triggered but the background supervisor could not be ensured.",
        currentJobId: null,
        lastError: message,
      });
    }
  };

  proxyFrontend(req, res, config, {
    onProxyResponse: ensureRunnerStarted,
    onProxyError: ensureRunnerStarted,
  });
}

function handleLocalJobCancel(req, res, config) {
  proxyFrontend(req, res, config, {
    onProxyResponse: (proxyRes) => {
      if ((proxyRes.statusCode || 500) < 200 || (proxyRes.statusCode || 500) >= 300) {
        return;
      }

      setTimeout(() => {
        try {
          writeRunnerState({
            status: "restarting",
            message: "Cancelling local job and restarting runner.",
            currentJobId: null,
            lastError: "",
          });
          stopLocalRunnerProcesses();
          ensureBackgroundSupervisor();
          writeRunnerState({
            status: "idle",
            message: "Local job cancelled. Runner is ready for the next job.",
            currentJobId: null,
            lastError: "",
          });
        } catch (error) {
          writeRunnerState({
            status: "error",
            message: "Local job was cancelled but runner restart failed.",
            currentJobId: null,
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      }, 250);
    },
  });
}

function serveLauncher(res, config, selfCheck, error = "", status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage(config, selfCheck, error));
}

function chooseLocalVideoFile() {
  const pickerScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "$dialog.Title = 'Choose video file for Short with Prompt'",
    "$dialog.Filter = 'Video Files|*.mp4;*.mov;*.m4v;*.webm;*.avi;*.mkv|All Files|*.*'",
    "$dialog.Multiselect = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  Write-Output $dialog.FileName",
    "}",
  ].join("; ");

  const output = execFileSync("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    pickerScript,
  ], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });

  return String(output || "").trim();
}

const server = http.createServer((req, res) => {
  const config = loadConfig();
  const selfCheck = getSelfCheck(config);
  const requestUrl = new URL(req.url, LOCAL_BASE_URL);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/api/self-check") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(selfCheck));
    return;
  }

  if (req.method === "GET" && pathname === "/api/local-session") {
    void resolveWorkspaceBinding(config).then((workspaceBinding) => {
      sendJson(res, workspaceBinding.ok ? 200 : 409, {
        success: workspaceBinding.ok,
        data: {
          runner_user: workspaceBinding.runnerUser,
          access_user: workspaceBinding.accessUser,
        },
        error: workspaceBinding.ok ? null : workspaceBinding.error,
      });
    }).catch((error) => {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/runner/queue-count") {
    const bearerToken = extractBearerToken(req) || config.ACCESS_TOKEN || "";
    const targetUrl = new URL(`/api/runner/queue-count`, config.SERVER_URL || DEFAULTS.SERVER_URL);
    targetUrl.searchParams.set("token", config.RUNNER_TOKEN || "");
    void requestJson(targetUrl.toString(), {
      headers: buildApiHeaders(bearerToken),
    }).then((payload) => {
      sendJson(res, 200, payload);
    }).catch((error) => {
      sendJson(res, 200, { success: true, data: 0 });
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/dubbing/doctor") {
    const force = requestUrl.searchParams.get("refresh") === "1";
    getDubbingDoctorReport({ force }).then((report) => {
      sendJson(res, 200, { success: true, data: report });
    }).catch((error) => {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/local-media") {
    const requestedPath = requestUrl.searchParams.get("path") || "";
    const resolvedPath = resolveSafeLocalMediaPath(requestedPath);
    if (!resolvedPath) {
      sendJson(res, 404, {
        success: false,
        error: "Local media file not found",
      });
      return;
    }

    sendLocalMediaFile(req, res, resolvedPath);
    return;
  }

  if (req.method === "POST" && pathname === "/api/local-file-picker") {
    try {
      const selectedPath = chooseLocalVideoFile();
      if (!selectedPath) {
        sendJson(res, 200, {
          success: false,
          error: "No file selected",
        });
        return;
      }

      sendJson(res, 200, {
        success: true,
        data: {
          path: selectedPath,
        },
      });
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/connect") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const accessToken = (params.get("access_token") || params.get("token") || "").trim();
      const frontendUrl = (params.get("frontend_url") || "").trim();
      const runnerToken = (params.get("runner_token") || "").trim();
      if (!runnerToken) {
        serveLauncher(res, config, selfCheck, "Runner token is required.", 400);
        return;
      }
      if (!accessToken) {
        serveLauncher(res, config, selfCheck, "Access token is required.", 400);
        return;
      }

      const nextConfig = {
        ...config,
        FRONTEND_URL: frontendUrl || config.FRONTEND_URL || DEFAULTS.FRONTEND_URL,
        RUNNER_TOKEN: runnerToken,
        ACCESS_TOKEN: accessToken,
      };
      void resolveWorkspaceBinding(nextConfig, accessToken).then((workspaceBinding) => {
        if (!workspaceBinding.ok) {
          serveLauncher(res, config, selfCheck, workspaceBinding.error, 409);
          return;
        }

        saveConfig(nextConfig);
        redirect(res, `/?token=${encodeURIComponent(accessToken)}`);
      }).catch((error) => {
        serveLauncher(
          res,
          config,
          selfCheck,
          error instanceof Error ? error.message : String(error),
          500
        );
      });
    });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/open") {
    const token = config.ACCESS_TOKEN || "";
    if (token && config.RUNNER_TOKEN) {
      redirect(res, `/?token=${encodeURIComponent(token)}`);
    } else {
      redirect(res, "/launcher");
    }
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/logout") {
    saveConfig({ ...config, ACCESS_TOKEN: "" });
    redirect(res, "/launcher");
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/adminlogin") {
    serveLauncher(res, config, selfCheck, "Admin login is only available from the hosted admin portal.", 403);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/launcher") {
    serveLauncher(res, config, selfCheck);
    return;
  }

  const hasLocalAccessToken = Boolean(config.ACCESS_TOKEN || requestUrl.searchParams.get("token"));
  const hasLocalRunnerToken = Boolean(config.RUNNER_TOKEN);
  if (!hasLocalAccessToken || !hasLocalRunnerToken) {
    redirect(res, "/launcher");
    return;
  }

  if (req.method === "POST" && pathname === "/api/settings/ai/test") {
    void handleLocalAiTest(req, res, config);
    return;
  }

  if (req.method === "GET" && pathname === "/api/settings/ai/models") {
    void handleLocalAiModels(req, res, config);
    return;
  }

  if (req.method === "POST" && pathname === "/api/settings/ai/generate") {
    void handleLocalAiGenerate(req, res, config);
    return;
  }

  if (isLocalAutomationRunRequest(req.method, pathname)) {
    void handleLocalAutomationRun(req, res, config);
    return;
  }

  if (isLocalJobCancelRequest(req.method, pathname)) {
    handleLocalJobCancel(req, res, config);
    return;
  }

  if (isJobsApiRequest(req.method, pathname)) {
    proxyApi(req, res, config, {
      transformJson: (payload) => rewriteJobsApiPayload(payload, req),
    });
    return;
  }

  if (pathname.startsWith("/api/")) {
    proxyApi(req, res, config);
    return;
  }

  proxyFrontend(req, res, config, {
    interceptResponse: (proxyRes, responseHeaders) => {
      const vercelError = String(responseHeaders["x-vercel-error"] || "").toUpperCase();
      if ((proxyRes.statusCode || 0) !== 404 || vercelError !== "NOT_FOUND") {
        return false;
      }

      const configuredFrontendUrl = config.FRONTEND_URL || DEFAULTS.FRONTEND_URL;
      serveLauncher(
        res,
        config,
        getSelfCheck(config),
        `Configured FRONTEND_URL ${configuredFrontendUrl} returned Vercel NOT_FOUND. Runner token aur access token valid lag rahe hain, lekin hosted dashboard URL missing ya undeployed hai. FRONTEND_URL ko correct deployed dashboard URL par update karein.`,
        502
      );
      return true;
    },
    transformHtml: (html) => injectLocalApiRewriteScript(html, req, config),
  });
});

server.listen(3000, "127.0.0.1", () => {
  console.log("==========================================");
  console.log("  Local User Dashboard Ready");
  console.log("  URL: http://localhost:3000");
  console.log("  Launcher: http://localhost:3000/launcher");
  console.log("  Self-check: http://localhost:3000/api/self-check");
  console.log("==========================================");
});

setTimeout(() => {
  try {
    ensureBackgroundSupervisor();
  } catch (error) {
    console.error("[BACKGROUND] Failed to ensure background supervisor:", error instanceof Error ? error.message : String(error));
  }
}, 1_500);
