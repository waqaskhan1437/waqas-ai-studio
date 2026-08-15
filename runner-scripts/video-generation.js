const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OUTPUT_DIR } = require('./lib/paths');

function resolveBinary(name) {
  const candidates = [
    path.resolve(__dirname, '..', 'local-runner', 'tools', 'ffmpeg', 'bin', name),
    path.resolve(__dirname, 'tools', 'ffmpeg', 'bin', name),
    name,
  ];
  for (const candidate of candidates) {
    if (candidate === name || fs.existsSync(candidate)) return candidate;
  }
  return name;
}

const FFMPEG = resolveBinary(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FFPROBE = resolveBinary(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

function loadConfig() {
  const file = path.join(__dirname, 'automation-config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function seconds(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function shellDuration(file) {
  try {
    const output = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8', timeout: 120000 });
    const value = Number.parseFloat(output.trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function fmtSrtTime(value) {
  const totalMs = Math.max(0, Math.round(Number(value || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function resolveWorkerBaseUrl() {
  return String(process.env.WORKER_WEBHOOK_URL || '').replace(/\/api\/webhook\/github\/?$/, '');
}

async function fetchJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'WaqasAIStudioVideoRunner/1.0' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }
  return payload.data || {};
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { headers: { 'User-Agent': 'WaqasAIStudioVideoRunner/1.0' } });
  if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`Downloaded media is unexpectedly small (${bytes.length} bytes)`);
  fs.writeFileSync(destination, bytes);
}

function chunkSegmentsForScenes(segments, visualMode) {
  const output = [];
  let index = 0;
  for (const segment of segments) {
    const start = seconds(segment.start_seconds);
    const end = Math.max(start + 0.2, seconds(segment.end_seconds, start + 10));
    const segmentDuration = Math.max(0.2, end - start);
    const unique = visualMode === 'unique_scenes';
    const clipCount = unique ? Math.max(1, Math.ceil(segmentDuration / 10)) : 1;
    for (let clipIndex = 0; clipIndex < clipCount; clipIndex += 1) {
      const clipStart = unique ? start + clipIndex * 10 : start;
      const clipDuration = unique ? Math.min(10, end - clipStart) : segmentDuration;
      if (clipDuration <= 0) continue;
      output.push({
        index: index++,
        segment,
        start: clipStart,
        duration: clipDuration,
        prompt: `${segment.visual_prompt}. Visual continuity with a ${segment.kind} narration segment; no subtitles, no logos, no readable text in the generated scene.`,
      });
    }
  }
  return output;
}

async function renderScenes(config, manifest, sceneDir) {
  const baseUrl = resolveWorkerBaseUrl();
  const jobId = Number(process.env.JOB_ID || 0);
  const token = String(process.env.RUNTIME_CONFIG_TOKEN || '');
  if (!baseUrl || !jobId || !token) throw new Error('Runner scene generation requires WORKER_WEBHOOK_URL, JOB_ID, and RUNTIME_CONFIG_TOKEN');

  const scenes = chunkSegmentsForScenes(manifest.segments || [], config.visual_mode || 'economy_reuse');
  if (scenes.length === 0) throw new Error('Script manifest has no visual scenes');
  const files = [];
  const cache = new Map();
  for (const scene of scenes) {
    const cacheKey = `${scene.segment.id}:${config.video_model}:${config.aspect_ratio}`;
    let sourceUrl = cache.get(cacheKey);
    if (!sourceUrl) {
      const result = await fetchJson(`${baseUrl}/api/video-generation/scene`, {
        job_id: jobId,
        token,
        prompt: scene.prompt,
        duration_seconds: Math.max(4, Math.min(12, Math.round(scene.duration))),
        video_model: config.video_model,
        aspect_ratio: config.aspect_ratio || '9:16',
        resolution: config.video_resolution || '720p',
      });
      sourceUrl = result.video_url;
      if (config.visual_mode !== 'unique_scenes') cache.set(cacheKey, sourceUrl);
    }

    const sourceFile = path.join(sceneDir, `source-${String(scene.index).padStart(5, '0')}.mp4`);
    const outputFile = path.join(sceneDir, `scene-${String(scene.index).padStart(5, '0')}.mp4`);
    await downloadFile(sourceUrl, sourceFile);
    const inputArgs = config.visual_mode === 'unique_scenes'
      ? ['-i', sourceFile]
      : ['-stream_loop', '-1', '-i', sourceFile];
    execFileSync(FFMPEG, [
      '-y', ...inputArgs,
      '-t', String(scene.duration),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24,format=yuv420p',
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', outputFile,
    ], { stdio: 'inherit', timeout: 600000 });
    files.push(outputFile);
  }
  return { files, scenes };
}

function writeConcatList(files, filePath) {
  const lines = files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function splitTextForTts(text, maxChars) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];
  const sentences = normalized.split(/(?<=[.!?؟۔])\s+/u);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (sentence.length <= maxChars) {
      current = sentence;
      continue;
    }
    for (let offset = 0; offset < sentence.length; offset += maxChars) {
      chunks.push(sentence.slice(offset, offset + maxChars).trim());
    }
    current = '';
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

async function renderVoice(config, manifest, audioDir) {
  const apiKey = String(config.elevenlabs_api_key || '').trim();
  const voiceId = String(config.voice_id || '').trim();
  if (!apiKey) throw new Error('ElevenLabs API key is missing. Add it in Settings > AI Provider Settings.');
  if (!voiceId) throw new Error('ElevenLabs voice ID is missing. Select or enter a voice ID in AI Video Generator.');

  const files = [];
  const timing = [];
  let cursor = 0;
  let fileIndex = 0;
  for (let index = 0; index < manifest.segments.length; index += 1) {
    const segment = manifest.segments[index];
    const text = String(segment.tts_text || '').trim();
    if (!text) continue;
    const maxChars = config.tts_model === 'eleven_v3' ? 4500 : config.tts_model === 'eleven_flash_v2_5' ? 38000 : 9000;
    const chunks = splitTextForTts(text, maxChars);
    const segmentStart = cursor;
    for (const chunk of chunks) {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: chunk,
          model_id: config.tts_model || 'eleven_v3',
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
        }),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`ElevenLabs TTS failed (${response.status}): ${errorText.slice(0, 400)}`);
      }
      const file = path.join(audioDir, `voice-${String(fileIndex++).padStart(5, '0')}.mp3`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      const duration = shellDuration(file);
      if (!duration) throw new Error(`Could not measure ElevenLabs audio for segment ${segment.id}`);
      cursor += duration;
      files.push(file);
    }
    timing.push({ segment, start: segmentStart, end: cursor });
  }

  if (files.length === 0) throw new Error('No TTS audio was generated');
  return { files, timing, duration: cursor };
}

function writeSrt(timing, filePath, targetDuration) {
  const entries = timing.map((item, index) => {
    const end = Math.min(targetDuration, item.end);
    if (end <= item.start) return '';
    const caption = String(item.segment.caption_text || '').trim();
    if (!caption) return '';
    return `${index + 1}\n${fmtSrtTime(item.start)} --> ${fmtSrtTime(end)}\n${caption}\n`;
  }).filter(Boolean);
  fs.writeFileSync(filePath, `${entries.join('\n')}\n`, 'utf8');
}

function concatAudio(files, outputFile) {
  const listFile = `${outputFile}.txt`;
  writeConcatList(files, listFile);
  execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-b:a', '128k', outputFile], { stdio: 'inherit', timeout: 600000 });
  return outputFile;
}

function muxAndCaption(sceneFiles, audioFile, srtFile, config, targetDuration, outputFile) {
  const listFile = path.join(OUTPUT_DIR, 'video-generation-scenes.txt');
  writeConcatList(sceneFiles, listFile);
  const captionFile = path.join(OUTPUT_DIR, 'video-generation-captioned.mp4');
  const fontName = config.language === 'ur' ? 'Noto Nastaliq Urdu' : 'DejaVu Sans';
  const fontSize = config.caption_font_size === 'large' ? 28 : config.caption_font_size === 'small' ? 20 : 24;
  const subtitleStyle = `FontName=${fontName},FontSize=${fontSize},PrimaryColour=&H00FFFFFF&,OutlineColour=&H99000000&,BorderStyle=3,Outline=1,Shadow=0,MarginV=70,Alignment=2`;
  execFileSync(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-i', audioFile,
    '-t', String(targetDuration), '-map', '0:v:0', '-filter_complex', `[1:a:0]apad=whole_dur=${targetDuration}[a]`, '-map', '[a]',
    '-vf', `subtitles=${srtFile}:force_style='${subtitleStyle}'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', captionFile,
  ], { stdio: 'inherit', timeout: 1800000 });
  fs.copyFileSync(captionFile, outputFile);
  return outputFile;
}

async function generateVideo() {
  const config = loadConfig();
  const manifest = config.script_manifest;
  if (!manifest || !Array.isArray(manifest.segments) || manifest.segments.length === 0) throw new Error('script_manifest is missing or empty');
  const targetDuration = Math.max(60, Number(config.duration_seconds || 60));
  ensureDir(OUTPUT_DIR);
  const workDir = path.join(OUTPUT_DIR, 'video-generation');
  const sceneDir = path.join(workDir, 'scenes');
  const audioDir = path.join(workDir, 'audio');
  ensureDir(sceneDir);
  ensureDir(audioDir);

  console.log(`[VIDEO-GENERATION] Rendering ${manifest.segments.length} script segments for ${targetDuration}s`);
  const sceneResult = await renderScenes(config, manifest, sceneDir);
  const voiceResult = await renderVoice(config, manifest, audioDir);
  const voiceFile = concatAudio(voiceResult.files, path.join(workDir, 'voiceover.mp3'));
  const srtFile = path.join(workDir, 'captions.srt');
  writeSrt(voiceResult.timing, srtFile, targetDuration);
  const outputFile = path.join(OUTPUT_DIR, 'processed-video.mp4');
  muxAndCaption(sceneResult.files, voiceFile, srtFile, config, targetDuration, outputFile);

  const manifestOutput = {
    workflow: 'video_generation',
    duration_seconds: targetDuration,
    scene_count: sceneResult.files.length,
    audio_duration_seconds: voiceResult.duration,
    caption_file: srtFile,
    output_file: outputFile,
    language: config.language,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'video-generation-result.json'), JSON.stringify(manifestOutput, null, 2), 'utf8');
  return { outputFile, result: manifestOutput };
}

module.exports = { generateVideo };
