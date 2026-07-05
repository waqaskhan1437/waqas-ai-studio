/**
 * Main Orchestrator - Video processing pipeline with segment support
 */
const { fs, path, execSync } = require('./lib/core');
const crypto = require('crypto');
const os = require('os');
const { OUTPUT_DIR, CONFIG_PATH } = require('./lib/paths');

const download = require('./steps/download');
const processVideo = require('./steps/process');
const caption = require('./steps/caption');
const upload = require('./steps/upload');
const uploadToLitterbox = require('./steps/upload-to-litterbox');
const post = require('./steps/post');
const webhook = require('./steps/webhook');
const tracker = require('./steps/tracker');

const FAILURE_REPORT_PATH = path.join(OUTPUT_DIR, 'failure-report.json');
const ERROR_LOG_PATH = path.join(OUTPUT_DIR, 'error.log');

function getCommandCandidates(name) {
  const isWin = process.platform === 'win32';
  const extension = isWin ? '.exe' : '';
  return [
    path.resolve(__dirname, '..', 'local-runner', 'tools', 'ffmpeg', 'bin', `${name}${extension}`),
    path.resolve(__dirname, 'tools', 'ffmpeg', 'bin', `${name}${extension}`),
    path.resolve(process.cwd(), `${name}${extension}`),
  ];
}

function resolveCommand(name) {
  for (const candidate of getCommandCandidates(name)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir || /[\\/]WindowsApps([\\/]|$)/i.test(dir)) continue;
      const full = path.join(dir, `${name}.exe`);
      if (fs.existsSync(full)) return full;
    }
  }
  return name;
}

function quoteCommand(command) {
  return command.includes(' ') || command.includes('\\') ? `"${command}"` : command;
}

const FFMPEG = quoteCommand(resolveCommand('ffmpeg'));
const FFPROBE = quoteCommand(resolveCommand('ffprobe'));

function isTransientError(error) {
  if (!error) return false;
  const message = String(error.message || error || '').toLowerCase();
  return /etimedout|econnrefused|econnreset|eai_again|enotfound|timeout|rate.limit|429|503|503|service.unavailable|temporary|dns|network|reset|busy|ebusy|eperm|eacces/.test(message);
}

function isSignalAbortError(error) {
  if (!error) return false;
  const message = String(error.message || error || '').toLowerCase();
  return /signal is aborted without reason|abortcontroller|abortsignal|this operation was aborted|abort_error/i.test(message);
}

async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries || 2;
  const delayMs = options.delayMs || 5000;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isTransientError(error)) {
        console.warn(`[RETRY] Transient error (${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms: ${error.message}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function writeFailureReport(payload) {
  try {
    fs.writeFileSync(FAILURE_REPORT_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('[FAILURE-REPORT] Could not write report:', error.message);
  }
}

function clearFailureReport() {
  try {
    if (fs.existsSync(FAILURE_REPORT_PATH)) {
      fs.unlinkSync(FAILURE_REPORT_PATH);
    }
    if (fs.existsSync(ERROR_LOG_PATH)) {
      fs.unlinkSync(ERROR_LOG_PATH);
    }
  } catch {}
}

function appendErrorLog(message) {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch (error) {
    console.error('[ERROR-LOG] Could not write error log:', error.message);
  }
}

function isBlockingDownloadFailure(error) {
  const message = String(error && (error.message || error) || '').toLowerCase();
  // Comprehensive blocking failure detection covering all 5 download layers
  return /youtube authentication|cookies?|sign in|login|not a bot|confirm.*bot|bot check|private video|age.?restricted|members-only|google photos.*download|forbidden|unauthorized|http error 401|http error 403|http error 429|too many requests|rate limit|all 5 download layers|all.*layers.*failed|bot challenge|video unavailable|video deleted|age. restricted/i.test(message);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid automation config at ${CONFIG_PATH}: ${error.message}`);
  }
}

function classifyMainError(error) {
  const message = String(error && (error.message || error) || '').toLowerCase();
  const categories = [];
  if (/429|too many requests|rate.limit/i.test(message)) categories.push('RATE_LIMIT');
  if (/403|forbidden/i.test(message)) categories.push('FORBIDDEN');
  if (/401|unauthorized/i.test(message)) categories.push('UNAUTHORIZED');
  if (/not a bot|confirm.*bot|bot.check|captcha|unusual.traffic/i.test(message)) categories.push('BOT_CHALLENGE');
  if (/sign in|login|authentication|cookie/i.test(message)) categories.push('AUTH_FAILURE');
  if (/private.video/i.test(message)) categories.push('PRIVATE_VIDEO');
  if (/age.restricted|members.only/i.test(message)) categories.push('AGE_RESTRICTED');
  if (/video.unavailable|unavailable|deleted|removed|410/i.test(message)) categories.push('VIDEO_UNAVAILABLE');
  if (/layer.*fail|all.*layers|all 5/i.test(message)) categories.push('ALL_LAYERS_FAILED');
  if (/inner.*tube|innertube/i.test(message)) categories.push('INNERTUBE_ISSUE');
  if (/browser|playwright|chromium/i.test(message)) categories.push('BROWSER_ISSUE');
  if (/yt-dlp|youtube-dl/i.test(message)) categories.push('YTDLP_ISSUE');
  return categories.length > 0 ? categories.join(', ') : 'UNKNOWN_ERROR';
}

function appendDetailedErrorLog(videoUrl, error, segmentInfo) {
  const categories = classifyMainError(error);
  const detail = [
    `[VIDEO_FAIL] url=${videoUrl}`,
    `categories=${categories}`,
    `message=${error && error.message || error}`,
    `segment=${segmentInfo ? JSON.stringify(segmentInfo) : 'none'}`,
    `timestamp=${new Date().toISOString()}`,
  ].join(' | ');
  appendErrorLog(detail);
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config || {}, null, 2), 'utf8');
}

function getResolvedChannelUrl() {
  const urlFile = path.join(OUTPUT_DIR, 'yt-resolved-url.txt');
  if (fs.existsSync(urlFile)) {
    try {
      const resolved = fs.readFileSync(urlFile, 'utf8').trim();
      if (resolved) return resolved;
    } catch {}
  }
  return null;
}

function normalizeCookieText(value) {
  if (typeof value !== 'string') {
    return null;
  }

  return value.replace(/\r\n/g, '\n').trim();
}

function removeFileIfExists(filePath, label) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[COOKIES] Removed stale ${label} cookie file: ${filePath}`);
    }
  } catch (error) {
    console.log(`[COOKIES] Could not remove stale ${label} cookie file ${filePath}: ${error.message}`);
  }
}

function syncManagedCookieFile(targetFile, rawCookieText, label) {
  const normalized = normalizeCookieText(rawCookieText);
  if (normalized === null || !normalized) {
    if (fs.existsSync(targetFile)) {
      console.log(`[COOKIES] No server-managed ${label} cookies in config; keeping existing local fallback file: ${targetFile}`);
      return targetFile;
    }
    return null;
  }
  const fingerprint = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  fs.writeFileSync(targetFile, `${normalized}
`, 'utf8');
  console.log(`[COOKIES] Materialized ${label} cookie file: ${targetFile} fingerprint=${fingerprint} bytes=${Buffer.byteLength(normalized, 'utf8')}`);
  return targetFile;
}

function materializeManagedCookieFiles(config) {
  const runnerRoot = __dirname;
  const youtubeFile = syncManagedCookieFile(path.join(runnerRoot, 'cookies.youtube.txt'), config?.youtube_cookies, 'YouTube');
  const googlePhotosFile = syncManagedCookieFile(path.join(runnerRoot, 'cookies.google-photos.txt'), config?.google_photos_cookies, 'Google Photos');
  if (youtubeFile) process.env.YOUTUBE_COOKIES_FILE = youtubeFile;
  else delete process.env.YOUTUBE_COOKIES_FILE;
  if (googlePhotosFile) process.env.GOOGLE_PHOTOS_COOKIES_FILE = googlePhotosFile;
  else delete process.env.GOOGLE_PHOTOS_COOKIES_FILE;
}

/* LOCAL FEATURE (disabled for now)
function resolveFinalOutputDir(config) {
  const configuredPath = typeof process.env.LOCAL_OUTPUT_DIR === 'string' && process.env.LOCAL_OUTPUT_DIR.trim()
    ? process.env.LOCAL_OUTPUT_DIR.trim()
    : (typeof config?.local_output_dir === 'string' ? config.local_output_dir.trim() : '');

  const targetDir = configuredPath ? path.resolve(configuredPath) : OUTPUT_DIR;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  return targetDir;
}

function saveLocalFinalMedia(config, extensionSuffix = '.mp4', sourceFile = path.join(OUTPUT_DIR, 'processed-video.mp4')) {
  const finalOutputDir = resolveFinalOutputDir(config);
  const fileName = `final-${Date.now()}${extensionSuffix}`;
  const localPath = path.join(finalOutputDir, fileName);
  fs.copyFileSync(sourceFile, localPath);
  console.log(`[LOCAL] Saved locally: ${localPath}`);
  return localPath;
}
*/

function getVideoDuration(inputFile) {
  try {
    const output = execSync(`${FFPROBE} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputFile}"`, { encoding: "utf8" });
    return parseFloat(output.trim()) || null;
  } catch {
    return null;
  }
}

function splitVideoIntoSegments(inputFile, segmentCount, segmentDuration) {
  const segments = [];
  const videoDuration = getVideoDuration(inputFile);

  if (!videoDuration) {
    console.log('[SPLIT] Could not determine duration, returning single segment');
    return [{ start: 0, end: null, index: 0 }];
  }

  const maxSegmentsFromDuration = Math.ceil(videoDuration / segmentDuration);
  const actualSegmentCount = Math.min(segmentCount, maxSegmentsFromDuration);
  const actualSegmentLength = videoDuration / actualSegmentCount;

  console.log(`[SPLIT] Video: ${videoDuration.toFixed(1)}s → ${actualSegmentCount} segments of ${actualSegmentLength.toFixed(1)}s`);

  for (let i = 0; i < actualSegmentCount; i++) {
    segments.push({
      start: i * actualSegmentLength,
      end: (i + 1) * actualSegmentLength,
      index: i,
      duration: actualSegmentLength
    });
  }

  return segments;
}

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function deriveSegmentInfo(config) {
  if (config && typeof config.segment_info === 'object' && config.segment_info) {
    return config.segment_info;
  }

  const shortsMode = String(config?.source_shorts_mode || 'single');
  const targetDuration = parsePositiveInteger(config?.short_duration, 58);

  if (shortsMode === 'fixed_count') {
    const segmentCount = parsePositiveInteger(config?.source_shorts_max_count, 1);
    return segmentCount > 1
      ? { mode: 'fixed_count', segmentCount, segmentDuration: targetDuration }
      : null;
  }

  if (shortsMode === 'duration_based') {
    const segmentCount = Math.min(Math.max(1, Math.ceil(targetDuration / 10)), 20);
    return { mode: 'duration_based', segmentCount, segmentDuration: targetDuration };
  }

  return null;
}

function getExplicitSegments(segmentInfo) {
  if (!segmentInfo || typeof segmentInfo !== 'object' || !Array.isArray(segmentInfo.segments)) {
    return [];
  }

  return segmentInfo.segments
    .map((segment, index) => {
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      const duration = Number(segment?.duration);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
      }

      return {
        index: Number.isFinite(Number(segment?.index)) ? Number(segment.index) : index,
        start,
        end,
        duration: Number.isFinite(duration) && duration > 0 ? duration : end - start,
        hook: typeof segment?.hook === 'string' ? segment.hook.trim() : '',
        title: typeof segment?.title === 'string' ? segment.title.trim() : '',
        caption: typeof segment?.caption === 'string' ? segment.caption.trim() : '',
        hashtags: Array.isArray(segment?.hashtags)
          ? segment.hashtags.filter((item) => typeof item === 'string' && item.trim())
          : [],
      };
    })
    .filter(Boolean);
}

function normalizeSegmentForVideo(segment, videoDuration) {
  const start = Math.max(0, Number(segment.start) || 0);
  const rawEnd = Number(segment.end);
  const end = Number.isFinite(videoDuration)
    ? Math.min(rawEnd, videoDuration)
    : rawEnd;

  if (!Number.isFinite(end) || end <= start) {
    return null;
  }

  return {
    ...segment,
    start,
    end,
    duration: Math.max(1, end - start),
  };
}

function buildSegmentRuntimeConfig(baseConfig, segment) {
  const nextConfig = { ...baseConfig };
  const hook = typeof segment?.hook === 'string' ? segment.hook.trim() : '';
  const title = typeof segment?.title === 'string' ? segment.title.trim() : '';
  const caption = typeof segment?.caption === 'string' ? segment.caption.trim() : '';
  const hashtags = Array.isArray(segment?.hashtags)
    ? segment.hashtags.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const duration = Math.max(1, Math.round(Number(segment?.duration) || Number(baseConfig.short_duration) || 58));

  // NOTE: Do not override top_taglines / bottom_taglines from AI hooks.
  // Video overlay taglines must always come from the user's Tagline tab,
  // not from prompt-generated per-segment hooks. The hook is still kept in
  // prompt_active_segment below for social post metadata reference.
  if (title) {
    nextConfig.titles = [title];
  }
  if (caption) {
    nextConfig.descriptions = [caption];
  }
  if (hashtags.length > 0) {
    nextConfig.hashtags = hashtags;
  }

  nextConfig.short_duration = String(duration);
  nextConfig.prompt_active_segment = {
    index: Number(segment?.index) || 0,
    start_seconds: Number(segment?.start) || 0,
    end_seconds: Number(segment?.end) || 0,
    duration_seconds: duration,
    hook,
    title,
    caption,
    hashtags,
  };
  return nextConfig;
}

function readPostResult() {
  try {
    const postResultPath = path.join(OUTPUT_DIR, 'post_result.json');
    if (!fs.existsSync(postResultPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(postResultPath, 'utf8'));
  } catch {
    return null;
  }
}

async function tryUploadToLitterbox(filePath, label) {
  try {
    const url = await uploadToLitterbox(filePath);
    if (url) {
      console.log(`[LITTERBOX] ${label} public URL: ${url}`);
      return url;
    }
  } catch (err) {
    console.warn(`[LITTERBOX] ${label} failed: ${err.message}`);
  }
  return null;
}

function buildProcessedVideoRecord({ videoUrl, originalUrl, aspectRatio, segment = null, postResult = null, merged = false, segmentCount = null }) {
  const record = {
    video_url: videoUrl,
    original_url: originalUrl,
    aspect_ratio: aspectRatio || '9:16',
  };

  if (segment) {
    record.segment_index = Number(segment.index) || 0;
    record.segment_start = Number(segment.start) || 0;
    record.segment_end = Number(segment.end) || 0;
    record.title = segment.title || '';
    record.caption = segment.caption || '';
    record.hook = segment.hook || '';
    record.hashtags = Array.isArray(segment.hashtags) ? segment.hashtags : [];
  }

  if (merged) {
    record.merged = true;
    record.segment_count = Number(segmentCount) || 1;
  }

  if (postResult && typeof postResult === 'object') {
    if (postResult.live_post_id) {
      record.live_post_id = postResult.live_post_id;
    }
    if (postResult.draft_post_id) {
      record.draft_post_id = postResult.draft_post_id;
    }
    if (postResult.post_metadata) {
      record.post_metadata = postResult.post_metadata;
    }
  }

  return record;
}

function mergeVideoFiles(inputFiles, outputFile) {
  if (!Array.isArray(inputFiles) || inputFiles.length < 2) {
    return null;
  }

  const listFile = path.join(OUTPUT_DIR, `merge-list-${Date.now()}.txt`);
  fs.writeFileSync(
    listFile,
    inputFiles.map((file) => `file '${String(file).replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );

  try {
    execSync(`${FFMPEG} -y -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`, {
      stdio: 'inherit',
      timeout: 600000,
    });
  } catch {
    execSync(`${FFMPEG} -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -c:a aac -movflags +faststart "${outputFile}"`, {
      stdio: 'inherit',
      timeout: 600000,
    });
  } finally {
    try { fs.unlinkSync(listFile); } catch {}
  }

  return fs.existsSync(outputFile) ? outputFile : null;
}

function extractSegment(inputFile, outputFile, start, end) {
  const duration = end - start;
  console.log(`[SEGMENT] Extracting: ${start.toFixed(1)}s → ${end.toFixed(1)}s (${duration.toFixed(1)}s)`);

  let cmd = `${FFMPEG} -y -ss ${start} -i "${inputFile}" -t ${duration} -c copy "${outputFile}"`;
  try {
    execSync(cmd, { stdio: "inherit", timeout: 60000 });
  } catch {
    console.log(`[SEGMENT] Stream copy failed, trying re-encode...`);
    try {
      cmd = `${FFMPEG} -y -ss ${start} -i "${inputFile}" -t ${duration} -c copy -avoid_negative_ts make_zero "${outputFile}"`;
      execSync(cmd, { stdio: "inherit", timeout: 60000 });
    } catch {
      console.log(`[SEGMENT] avoid_negative_ts failed, trying re-encode fallback...`);
      cmd = `${FFMPEG} -y -ss ${start} -i "${inputFile}" -t ${duration} -c:v libx264 -preset ultrafast -crf 30 -c:a aac -b:a 96k -pix_fmt yuv420p -movflags +faststart "${outputFile}"`;
      execSync(cmd, { stdio: "inherit", timeout: 120000 });
    }
  }

  if (fs.existsSync(outputFile)) {
    const stats = fs.statSync(outputFile);
    console.log(`[SEGMENT] Created: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  } else {
    throw new Error(`Segment file not created: ${outputFile}`);
  }
}

function processSegmentDirect(segmentFile, duration, aspectRatio, config, segmentIndex, totalSegments) {
  const outputFile = path.join(OUTPUT_DIR, 'processed-video.mp4');
  console.log(`[SEGMENT-PROCESS] Running processor for segment ${segmentIndex + 1} (${duration}s @ ${aspectRatio})...`);

  const tryProcess = (retry) => {
    execSync('node process-video.js', {
      cwd: __dirname,
      stdio: 'inherit',
      timeout: retry ? 900000 : 600000,
      env: {
        ...process.env,
        INPUT_FILE_PATH: segmentFile,
        OUTPUT_FILE_PATH: outputFile,
        TEMP_FILE_PATH: path.join(OUTPUT_DIR, `segment-temp-${segmentIndex}.mp4`),
        SPEED_FILE_PATH: path.join(OUTPUT_DIR, `segment-speed-${segmentIndex}.mp4`),
        OUTPUT_DIR,
        SEGMENT_INDEX: String(segmentIndex),
        SEGMENT_TOTAL: String(totalSegments || 1),
        ...(retry ? { FFMPEG_FALLBACK: 'ultrafast' } : {}),
      }
    });
  };

  try {
    tryProcess(false);
  } catch (firstErr) {
    console.warn(`[SEGMENT-PROCESS] First attempt failed: ${firstErr.message}. Retrying with ultrafast...`);
    try {
      tryProcess(true);
    } catch (secondErr) {
      console.error(`[SEGMENT-PROCESS] Retry also failed: ${secondErr.message}`);
      console.log(`[SEGMENT-PROCESS] Trying copy fallback for segment ${segmentIndex + 1}...`);
      execSync(`"${process.execPath}" -e "` +
        `const fs=require('fs');` +
        `const src=${JSON.stringify(segmentFile)};` +
        `const dst=${JSON.stringify(outputFile)};` +
        `if(!fs.existsSync(src)){process.exit(1)}` +
        `fs.copyFileSync(src,dst);console.log('[SEGMENT-PROCESS] Copy fallback done')"`, { timeout: 30000 });
    }
  }

  if (!fs.existsSync(outputFile)) {
    throw new Error('Processed file not created for segment ' + segmentIndex);
  }

  const stats = fs.statSync(outputFile);
  console.log(`[SEGMENT-PROCESS] Created: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

async function runWithConcurrencyLimit(tasks, limit) {
  const results = [];
  const executing = [];
  for (const [index, task] of tasks.entries()) {
    const p = Promise.resolve().then(() => task(index));
    results.push(p);
    if (limit <= tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

async function main() {
  console.log('[MAIN] Starting...');
  const config = loadConfig();
  materializeManagedCookieFiles(config);
  writeConfig(config);
  clearFailureReport();

  console.log('[MAIN] source_shorts_mode:', config.source_shorts_mode);
  console.log('[MAIN] segment_info:', JSON.stringify(config.segment_info));
  console.log('[MAIN] video_urls:', config.video_urls?.length);

  const videos = config.video_urls || [];
  const perRun = parseInt(config.videos_per_run || '1', 10);
  const segmentInfo = deriveSegmentInfo(config);
  const explicitSegments = getExplicitSegments(segmentInfo);

  console.log(`[MAIN] URLs: ${videos.length} | Per run: ${perRun}`);
  if (segmentInfo) {
    const segmentCount = Number(segmentInfo.segmentCount)
      || (Array.isArray(segmentInfo.segments) ? segmentInfo.segments.length : 0);
    console.log(`[MAIN] SEGMENT MODE: ${segmentInfo.mode} (${segmentCount} segments)`);
  }

  if (videos.length === 0) {
    console.log('[MAIN] No URLs');
    await webhook.final(0, 0, false, null, []);
    globalThis.process.exit(0);
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const toProcess = videos.slice(0, perRun);
  let successCount = 0;
  let lastUrl = null;
  let lastPostResult = null;
  const allProcessedVideos = [];
  const failures = [];

  for (let i = 0; i < toProcess.length; i++) {
    const url = toProcess[i];
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[VIDEO ${i + 1}/${toProcess.length}] ${url}`);
    console.log('='.repeat(50));

    try {
      await withRetry(() => download(url), { maxRetries: 2, delayMs: 5000 });

      // ── Auto Content from Video Title (channel URL fallback) ──────────
      // At dispatch time, the worker can't resolve channel URLs to get the
      // video title, so AI content generation is skipped. The runner resolves
      // the channel URL during download and saves the title via ytdown.to.
      // If use_video_title_for_content is true, call the worker to generate
      // titles/descriptions/hashtags from the actual video title now.
      const videoTitleFile = path.join(OUTPUT_DIR, 'yt-video-title.txt');
      if (config.use_video_title_for_content && fs.existsSync(videoTitleFile)) {
        const videoTitle = fs.readFileSync(videoTitleFile, 'utf8').trim();
        if (videoTitle) {
          console.log(`[CONTENT] use_video_title_for_content enabled — generating AI content from: "${videoTitle.substring(0, 80)}"`);
          try {
            const workerBaseUrl = String(process.env.WORKER_WEBHOOK_URL || '').replace(/\/api\/webhook\/github\/?$/, '');
            const jobId = String(process.env.JOB_ID || '');
            const runtimeToken = String(process.env.RUNTIME_CONFIG_TOKEN || '');
            if (workerBaseUrl && jobId && runtimeToken) {
              const response = await fetch(`${workerBaseUrl}/api/github/generate-content`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'AutomationSystemRunner/1.0' },
                body: JSON.stringify({ job_id: Number(jobId), token: runtimeToken, video_title: videoTitle }),
              });
              const result = await response.json();
              if (result.success && result.data) {
                if (Array.isArray(result.data.titles) && result.data.titles.length > 0) {
                  config.titles = result.data.titles;
                }
                if (Array.isArray(result.data.descriptions) && result.data.descriptions.length > 0) {
                  config.descriptions = result.data.descriptions;
                }
                if (Array.isArray(result.data.hashtags) && result.data.hashtags.length > 0) {
                  config.hashtags = result.data.hashtags;
                }
                writeConfig(config);
                console.log(`[CONTENT] AI generated ${config.titles?.length || 0} titles, ${config.descriptions?.length || 0} descriptions, ${config.hashtags?.length || 0} hashtags`);
              } else {
                console.log(`[CONTENT] AI generation failed: ${result.error || 'unknown error'} — using fallback content from config`);
              }
            } else {
              console.log('[CONTENT] Missing WORKER_WEBHOOK_URL, JOB_ID, or RUNTIME_CONFIG_TOKEN — cannot generate AI content');
            }
          } catch (genErr) {
            console.log(`[CONTENT] AI generation error: ${genErr.message} — using fallback content from config`);
          }
          try { fs.unlinkSync(videoTitleFile); } catch {}
        }
      }

      if (explicitSegments.length > 0 || (segmentInfo && segmentInfo.segmentCount > 1)) {
        const inputFile = path.join(OUTPUT_DIR, 'input-video.mp4');
        const videoDuration = getVideoDuration(inputFile);
        const segments = explicitSegments.length > 0
          ? explicitSegments
              .map((segment) => normalizeSegmentForVideo(segment, videoDuration))
              .filter(Boolean)
          : splitVideoIntoSegments(inputFile, segmentInfo.segmentCount, segmentInfo.segmentDuration);
        const segmentOutputFiles = [];
        const shouldMergeSegments = segmentInfo && segmentInfo.mergeSegments === true && segments.length > 1;

        console.log(`[VIDEO ${i + 1}] Splitting into ${segments.length} segments`);

        const concurrencyLimit = Math.min(3, Math.max(1, os.cpus().length - 1));
        const segTasks = segments.map((seg) => async () => {
          const result = { seg, uploadUrl: null, record: null, error: null };
          try {
            console.log(`\n${'-'.repeat(40)}`);
            console.log(`[SEGMENT ${seg.index + 1}/${segments.length}] ${seg.start.toFixed(1)}s → ${seg.end.toFixed(1)}s`);
            console.log('-'.repeat(40));

            const segOutputFile = path.join(OUTPUT_DIR, `segment-${i}-${seg.index}.mp4`);
            extractSegment(inputFile, segOutputFile, seg.start, seg.end);

            const segmentConfig = buildSegmentRuntimeConfig(config, seg);
            writeConfig(segmentConfig);

            const duration = Math.max(1, Math.round(Number(seg.duration) || parseInt(segmentConfig.short_duration || "58", 10) || 58));
            const aspectRatio = segmentConfig.aspect_ratio || "9:16";
            processSegmentDirect(segOutputFile, duration, aspectRatio, segmentConfig, seg.index, segments.length);
            const processedSegmentFile = path.join(OUTPUT_DIR, `processed-segment-${i}-${seg.index}.mp4`);
            fs.copyFileSync(path.join(OUTPUT_DIR, 'processed-video.mp4'), processedSegmentFile);
            result.filePath = processedSegmentFile;

            if (!shouldMergeSegments) {
              await caption();

              let uploadUrl = null;
              uploadUrl = await withRetry(() => upload(processedSegmentFile), { maxRetries: 2, delayMs: 5000 });
              if (uploadUrl) {
                const litterboxUrl = await tryUploadToLitterbox(processedSegmentFile, `Segment ${seg.index + 1}`);
                if (litterboxUrl) uploadUrl = litterboxUrl;

                writeConfig(segmentConfig);
                try {
                  await withRetry(() => post(uploadUrl), { maxRetries: 2, delayMs: 5000 });
                } catch (postErr) {
                  console.warn(`[SEGMENT ${seg.index + 1}] Post failed (non-fatal): ${postErr.message}`);
                }
                const postResult = readPostResult();
                if (postResult && postResult.media_url) {
                  uploadUrl = postResult.media_url;
                }
                result.uploadUrl = uploadUrl;
                result.record = buildProcessedVideoRecord({
                  videoUrl: uploadUrl,
                  originalUrl: url,
                  aspectRatio,
                  segment: seg,
                  postResult,
                });
              }
            }
            console.log(`[SEGMENT ${seg.index + 1}] DONE`);
          } catch (err) {
            result.error = err;
            console.error(`[SEGMENT ${seg.index + 1}] FAILED:`, err.message);
          }
          return result;
        });

        const segResults = await runWithConcurrencyLimit(segTasks, concurrencyLimit);

        for (const result of segResults) {
          if (result.error) {
            console.error(`[SEGMENT] Skipping failed segment: ${result.error.message}`);
            continue;
          }
          if (result.filePath) segmentOutputFiles.push(result.filePath);
          if (result.uploadUrl) {
            lastUrl = result.uploadUrl;
            allProcessedVideos.push(result.record);
            await tracker.markVideoProcessed(getResolvedChannelUrl() || url);
            await tracker.sendProgressUpdate(result.record);
            successCount++;
          }
          // LOCAL FEATURE (skip_upload disabled for now)
          /* else if (config.skip_upload && result.record) {
            lastUrl = result.uploadUrl;
            allProcessedVideos.push(result.record);
            successCount++;
          } */
        }

        if (shouldMergeSegments) {
          const mergeInputFiles = segmentOutputFiles.filter((filePath) => typeof filePath === 'string' && fs.existsSync(filePath));
          if (mergeInputFiles.length <= 1) {
            throw new Error('Merge mode requested but processed segment files were not available');
          }

          const mergedFile = path.join(OUTPUT_DIR, `merged-${Date.now()}.mp4`);
          const builtMergedFile = mergeVideoFiles(mergeInputFiles, mergedFile);
          if (!builtMergedFile) {
            throw new Error('Merged video file could not be created');
          }

          let mergedUrl = null;
          writeConfig(config);
          mergedUrl = await withRetry(() => upload(builtMergedFile), { maxRetries: 2, delayMs: 5000 });
          if (mergedUrl) {
            const litterboxUrl = await tryUploadToLitterbox(builtMergedFile, 'Merge');
            if (litterboxUrl) mergedUrl = litterboxUrl;
          }
          try {
            await withRetry(() => post(mergedUrl), { maxRetries: 2, delayMs: 5000 });
          } catch (postErr) {
            console.warn(`[MERGE] Post failed (non-fatal): ${postErr.message}`);
          }
          const mergedPostResult = readPostResult();
          if (mergedPostResult) {
            lastPostResult = mergedPostResult;
            if (mergedPostResult.media_url) {
              mergedUrl = mergedPostResult.media_url;
            }
          }

          if (mergedUrl) {
            lastUrl = mergedUrl;
            const mergedRecord = buildProcessedVideoRecord({
              videoUrl: mergedUrl,
              originalUrl: url,
              aspectRatio: config.aspect_ratio || '9:16',
              postResult: lastPostResult,
              merged: true,
              segmentCount: segments.length,
            });
            allProcessedVideos.push(mergedRecord);
            await tracker.markVideoProcessed(getResolvedChannelUrl() || url);
            await tracker.sendProgressUpdate(mergedRecord);
            successCount++;
          }
        }

        writeConfig(config);
        console.log(`[VIDEO ${i + 1}] All ${segments.length} segments processed`);
      } else {
        writeConfig(config);
        await processVideo();
        await caption();
        
        let uploadUrl = null;
        uploadUrl = await withRetry(() => upload(), { maxRetries: 2, delayMs: 5000 });

        if (uploadUrl) {
          const processedFile = path.join(OUTPUT_DIR, 'processed-video.mp4');
          const litterboxUrl = await tryUploadToLitterbox(processedFile, `Video ${i + 1}`);
          if (litterboxUrl) uploadUrl = litterboxUrl;

          try {
            await withRetry(() => post(uploadUrl), { maxRetries: 2, delayMs: 5000 });
          } catch (postErr) {
            console.warn(`[VIDEO ${i + 1}] Post failed (non-fatal): ${postErr.message}`);
          }
          const postResult = readPostResult();
          if (postResult) {
            lastPostResult = postResult;
            if (postResult.media_url) {
              uploadUrl = postResult.media_url;
            }
          }

          lastUrl = uploadUrl;
          const processedVideoRecord = buildProcessedVideoRecord({
            videoUrl: uploadUrl,
            originalUrl: url,
            aspectRatio: config.aspect_ratio || '9:16',
            postResult,
          });
          allProcessedVideos.push(processedVideoRecord);

          await tracker.markVideoProcessed(getResolvedChannelUrl() || url);
          await tracker.sendProgressUpdate(processedVideoRecord);
          successCount++;
          console.log(`[VIDEO ${i + 1}] DONE`);
        }
      }
    } catch (e) {
      console.error(`[VIDEO ${i + 1}] FAILED:`, e.message);
      appendDetailedErrorLog(url, e, segmentInfo);
      const categories = classifyMainError(e);
      failures.push({
        source_url: url,
        error: e.message,
        error_categories: categories,
        failed_at: new Date().toISOString(),
      });
      if (isBlockingDownloadFailure(e)) {
        appendErrorLog(`[FAIL-FAST] Blocking auth/download failure detected; stopping remaining source downloads for this job.`);
        break;
      }
    }
  }

  console.log(`\n[SUMMARY] ${successCount} shorts processed`);
  if (successCount === 0 && failures.length > 0) {
    writeFailureReport({
      ok: false,
      type: 'video_pipeline_failed',
      failures,
      last_error: failures[failures.length - 1]?.error || 'Unknown pipeline error',
    });
  }
  writeConfig(config);
  await webhook.final(successCount, successCount, successCount > 0, lastUrl, allProcessedVideos, lastPostResult);
  console.log(`\n[DONE] ${successCount} shorts from ${toProcess.length} source videos`);
  globalThis.process.exit(successCount > 0 ? 0 : 1);
}

main().catch(async (e) => {
  const cleanMsg = isSignalAbortError(e)
    ? 'GitHub Actions step/job timeout reached or workflow was cancelled. The process was killed before completing. Increase timeout-minutes in the workflow or split the work into smaller batches.'
    : e.message;
  console.error('[MAIN] FATAL:', cleanMsg);
  appendErrorLog(`[FATAL] ${cleanMsg}`);
  writeFailureReport({
    ok: false,
    type: 'fatal',
    last_error: cleanMsg || 'Unknown fatal error',
    failed_at: new Date().toISOString(),
  });
  await webhook.final(0, 0, false, null, []);
  globalThis.process.exit(1);
});
