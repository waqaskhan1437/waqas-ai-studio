import { AISettings, AuthContext, Env, GithubSettings } from "../types";
import { jsonResponse, safeRequestJson } from "../utils";
import {
  buildAiCatalog,
  generateAiJson,
  getConfiguredProviderIds,
  resolveModelForProvider,
  SupportedAIProvider,
} from "../services/ai";
import { getScopedSettings } from "../services/user-settings";
import { verifyWorkflowRuntimeConfigToken } from "../services/github";
import { AutomationRunResult, triggerAutomationRun } from "../services/automation-scheduler";

const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_PROMPT_CHARS = 4000;
const MAX_BLOCK_WORDS = 900;
const DEFAULT_VIDEO_MODEL = "bytedance/seedance-2.0";
const DEFAULT_TTS_MODEL = "eleven_v3";

const LANGUAGE_WPM: Record<string, number> = {
  ur: 120,
  hi: 120,
  ar: 120,
  bn: 120,
  ta: 120,
  en: 130,
  es: 130,
};

type ScriptKind = "hook" | "soft_cta" | "explanation" | "cta";

type VideoSegment = {
  id: string;
  kind: ScriptKind;
  caption_text: string;
  tts_text: string;
  visual_prompt: string;
  start_seconds: number;
  end_seconds: number;
};

type ScriptManifest = {
  language: string;
  caption_text: string;
  tts_text: string;
  segments: VideoSegment[];
  word_count: {
    caption: number;
    tts: number;
    target: number;
    min: number;
    max: number;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function countWords(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

function languageWpm(language: string): number {
  return LANGUAGE_WPM[language] || 130;
}

function normalizeKind(value: unknown, index: number, total: number): ScriptKind {
  const kind = readString(value).toLowerCase();
  if (kind === "hook" || kind === "soft_cta" || kind === "explanation" || kind === "cta") return kind;
  if (index === 0) return "hook";
  if (index === total - 1) return "cta";
  return "explanation";
}

function normalizeTextPair(record: Record<string, unknown>, language: string): { caption: string; tts: string } {
  const caption = readString(record.caption_text || record.caption || record.text || record.script);
  const rawTts = readString(record.tts_text || record.tts || record.narration || record.voice_text);
  if (language === "ur") {
    if (!caption || !rawTts) throw new Error("Urdu segment must contain both caption_text and tts_text");
    return { caption, tts: rawTts };
  }
  const text = caption || rawTts;
  if (!text) throw new Error("Script segment text is missing");
  return { caption: text, tts: text };
}

function normalizeSegments(payload: Record<string, unknown>, language: string, requireHook: boolean, requireCta: boolean): VideoSegment[] {
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
  const segments = rawSegments.map((item, index) => {
    const record = asRecord(item);
    const pair = normalizeTextPair(record, language);
    return {
      id: readString(record.id, `segment-${index + 1}`),
      kind: normalizeKind(record.kind, index, rawSegments.length),
      caption_text: pair.caption,
      tts_text: pair.tts,
      visual_prompt: readString(record.visual_prompt || record.visual || record.video_prompt, "Cinematic visual scene matching the narration"),
      start_seconds: 0,
      end_seconds: 0,
    } satisfies VideoSegment;
  }).filter((segment) => segment.caption_text && segment.tts_text);

  if (segments.length === 0) throw new Error("Provider response did not include valid script segments");
  if (requireHook && !segments.some((segment) => segment.kind === "hook")) segments[0].kind = "hook";
  if (requireCta && !segments.some((segment) => segment.kind === "cta")) segments[segments.length - 1].kind = "cta";
  return segments;
}

function allocateTimings(segments: VideoSegment[], startSeconds: number, durationSeconds: number, wpm: number): VideoSegment[] {
  const rawWeights = segments.map((segment) => Math.max(1, countWords(segment.tts_text) / Math.max(wpm, 60) * 60));
  const minimums = segments.map((segment) => segment.kind === "hook" ? 3 : segment.kind === "soft_cta" ? 4 : 2);
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0);
  const usableDuration = Math.max(minimumTotal, durationSeconds);
  const weightTotal = rawWeights.reduce((sum, value) => sum + value, 0) || segments.length;
  let cursor = startSeconds;

  return segments.map((segment, index) => {
    const proportional = usableDuration * (rawWeights[index] / weightTotal);
    const remaining = usableDuration - (cursor - startSeconds);
    const minForRemaining = minimums.slice(index + 1).reduce((sum, value) => sum + value, 0);
    const segmentDuration = index === segments.length - 1
      ? Math.max(minimums[index], remaining)
      : Math.max(minimums[index], Math.min(proportional, remaining - minForRemaining));
    const next = cursor + segmentDuration;
    const timed = { ...segment, start_seconds: Number(cursor.toFixed(2)), end_seconds: Number(next.toFixed(2)) };
    cursor = next;
    return timed;
  });
}

function manifestFromBlocks(language: string, targetWords: number, durationSeconds: number, blocks: VideoSegment[][]): ScriptManifest {
  const flat = blocks.flat();
  const wpm = languageWpm(language);
  const timed = allocateTimings(flat, 0, durationSeconds, wpm);
  const captionText = timed.map((segment) => segment.caption_text).join(" ").trim();
  const ttsText = timed.map((segment) => segment.tts_text).join(" ").trim();
  const target = Math.max(1, targetWords);
  return {
    language,
    caption_text: captionText,
    tts_text: ttsText,
    segments: timed,
    word_count: {
      caption: countWords(captionText),
      tts: countWords(ttsText),
      target,
      min: Math.floor(target * 0.9),
      max: Math.ceil(target * 1.05),
    },
  };
}

function buildScriptMessages(input: {
  topic: string;
  instructions: string;
  language: string;
  targetWords: number;
  durationSeconds: number;
  blockIndex: number;
  blockCount: number;
  blockWords: number;
  isFirst: boolean;
  isLast: boolean;
}): { system: string; user: string } {
  const isUrdu = input.language === "ur";
  const structure = input.isFirst && input.isLast
    ? "Start with a 2-3 second hook, then a natural soft CTA, then explanation, then a final CTA."
    : input.isFirst
      ? "Start with a 2-3 second hook and a short natural soft CTA, then explanation. Do not add the final CTA yet."
      : input.isLast
        ? "Continue the explanation naturally and finish with one useful, non-generic final CTA. Do not add another hook."
        : "Continue the explanation naturally. Do not add a hook or final CTA in this block.";

  const jsonShape = isUrdu
    ? `Every segment must contain id, kind, caption_text in Urdu Nastaleeq script, tts_text in Urdu vocabulary written phonetically with Devanagari letters, and visual_prompt. caption_text and tts_text must express the same sentence and remain in the same segment order.`
    : `Every segment must contain id, kind, caption_text, tts_text equal to caption_text, and visual_prompt.`;

  return {
    system: `You are a senior multilingual short-form video scriptwriter. Return JSON only, with no markdown. The complete requested narration is ${input.targetWords} words for ${input.durationSeconds} seconds at ${languageWpm(input.language)} words per minute. You are writing block ${input.blockIndex + 1} of ${input.blockCount}, targeting approximately ${input.blockWords} words. ${structure} ${jsonShape} Keep language natural, conversational, precise, and easy to caption. Never invent facts that are not supported by the topic or instructions.`,
    user: JSON.stringify({
      topic: input.topic,
      instructions: input.instructions,
      language: input.language,
      block_index: input.blockIndex,
      block_count: input.blockCount,
      target_block_words: input.blockWords,
      required_kinds: input.isFirst && input.isLast ? ["hook", "soft_cta", "explanation", "cta"] : input.isFirst ? ["hook", "soft_cta", "explanation"] : input.isLast ? ["explanation", "cta"] : ["explanation"],
      output_schema: {
        segments: [{ id: "string", kind: "hook|soft_cta|explanation|cta", caption_text: "string", tts_text: "string", visual_prompt: "string" }],
      },
    }),
  };
}

async function generateScriptManifest(env: Env, userId: number, input: {
  topic: string;
  instructions: string;
  language: string;
  targetWords: number;
  durationSeconds: number;
}): Promise<ScriptManifest> {
  const aiSettings = await getScopedSettings<AISettings>(env.DB, "ai", userId);
  if (!aiSettings) throw new Error("AI settings are not configured. Add an AI provider in Settings first.");
  const configured = getConfiguredProviderIds(aiSettings);
  if (configured.length === 0) throw new Error("No AI provider API key is configured. Add one in Settings first.");
  const preferred = readString(aiSettings.default_provider) as SupportedAIProvider;
  const provider = configured.includes(preferred) ? preferred : configured[0];
  const catalog = await buildAiCatalog(aiSettings);
  const model = resolveModelForProvider(provider, undefined, catalog.providers);
  const blockCount = Math.max(1, Math.ceil(input.targetWords / MAX_BLOCK_WORDS));
  const blocks: VideoSegment[][] = [];

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const remainingWords = input.targetWords - blocks.flat().reduce((sum, segment) => sum + countWords(segment.tts_text), 0);
    const blockWords = Math.max(80, Math.min(MAX_BLOCK_WORDS, remainingWords));
    const messages = buildScriptMessages({
      ...input,
      blockIndex,
      blockCount,
      blockWords,
      isFirst: blockIndex === 0,
      isLast: blockIndex === blockCount - 1,
    });
    const payload = await generateAiJson(aiSettings, provider, model, messages);
    const segments = normalizeSegments(payload, input.language, blockIndex === 0, blockIndex === blockCount - 1);
    blocks.push(segments);
  }

  const manifest = manifestFromBlocks(input.language, input.targetWords, input.durationSeconds, blocks);
  if (manifest.word_count.tts < Math.floor(input.targetWords * 0.65)) {
    throw new Error(`Generated narration is too short (${manifest.word_count.tts} words; target ${input.targetWords}). Try a more detailed brief.`);
  }
  return manifest;
}

function normalizeIncomingManifest(value: unknown, language: string, targetWords: number, durationSeconds: number): ScriptManifest {
  const payload = asRecord(value);
  const segments = normalizeSegments(payload, language, true, true);
  const manifest = manifestFromBlocks(language, targetWords, durationSeconds, [segments]);
  if (manifest.word_count.tts > Math.ceil(targetWords * 1.3)) {
    throw new Error(`Provided script is above the duration budget (${manifest.word_count.tts} words; target ${targetWords})`);
  }
  return manifest;
}

function validateVideoModel(value: unknown): string {
  const model = readString(value, DEFAULT_VIDEO_MODEL);
  return model === "xai/grok-imagine-video-1.5-preview" ? model : DEFAULT_VIDEO_MODEL;
}

function validateAspectRatio(value: unknown): string {
  const ratio = readString(value, "9:16");
  return ["9:16", "16:9", "1:1", "4:3", "3:4"].includes(ratio) ? ratio : "9:16";
}

async function generateVideoScene(env: Env, body: Record<string, unknown>): Promise<Response> {
  if (!env.AI) return jsonResponse({ success: false, error: "Cloudflare AI binding is not configured" }, 503);
  const prompt = readString(body.prompt);
  if (!prompt) return jsonResponse({ success: false, error: "prompt is required" }, 400);
  const duration = clampInteger(body.duration_seconds, 4, 12, 10);
  const model = validateVideoModel(body.video_model);

  try {
    const result = await env.AI.run(model, {
      prompt: prompt.slice(0, 2000),
      duration,
      aspect_ratio: validateAspectRatio(body.aspect_ratio),
      resolution: readString(body.resolution, "720p"),
      fps: 24,
      generate_audio: false,
      watermark: false,
    });
    const record = asRecord(result);
    const nested = asRecord(record.result);
    const video = readString(nested.video || record.video);
    if (!video) return jsonResponse({ success: false, error: "Video model did not return a video URL" }, 502);
    return jsonResponse({ success: true, data: { video_url: video, model, duration_seconds: duration } });
  } catch (error) {
    return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Video scene generation failed" }, 502);
  }
}

export async function handleVideoGenerationSceneRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  const body = await safeRequestJson<Record<string, unknown>>(request);
  if (!body) return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  const jobId = clampInteger(body.job_id, 1, Number.MAX_SAFE_INTEGER, 0);
  const token = readString(body.token);
  if (!jobId || !token) return jsonResponse({ success: false, error: "job_id and token are required" }, 400);
  const job = await env.DB.prepare("SELECT id, user_id FROM jobs WHERE id = ? LIMIT 1").bind(jobId).first<{ id: number; user_id: number }>();
  if (!job?.id || !job.user_id) return jsonResponse({ success: false, error: "Job not found" }, 404);
  const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", job.user_id);
  if (!githubSettings?.pat_token || !(await verifyWorkflowRuntimeConfigToken(job.id, token, githubSettings.pat_token))) {
    return jsonResponse({ success: false, error: "Invalid or expired runner token" }, 403);
  }
  return generateVideoScene(env, body);
}

export async function handleVideoGenerationRoutes(request: Request, env: Env, path: string, auth: AuthContext): Promise<Response> {
  const userId = auth.userId;
  const method = request.method;

  if (path === "/api/video-generation/script" && method === "POST") {
    const body = await safeRequestJson<Record<string, unknown>>(request);
    if (!body) return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    const topic = readString(body.topic);
    if (!topic) return jsonResponse({ success: false, error: "topic is required" }, 400);
    if (topic.length > MAX_PROMPT_CHARS) return jsonResponse({ success: false, error: "topic is too long" }, 400);
    const language = readString(body.language, "en").toLowerCase();
    const durationSeconds = clampInteger(body.duration_seconds, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, 60);
    const targetWords = clampInteger(body.target_words, 60, 20000, Math.floor(durationSeconds / 60 * languageWpm(language)));

    try {
      const manifest = await generateScriptManifest(env, userId, {
        topic,
        instructions: readString(body.instructions).slice(0, MAX_PROMPT_CHARS),
        language,
        targetWords,
        durationSeconds,
      });
      return jsonResponse({ success: true, data: manifest });
    } catch (error) {
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Script generation failed" }, 500);
    }
  }

  if (path === "/api/video-generation/jobs" && method === "POST") {
    const body = await safeRequestJson<Record<string, unknown>>(request);
    if (!body) return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    const topic = readString(body.topic, "AI Video");
    const language = readString(body.language, "en").toLowerCase();
    const durationSeconds = clampInteger(body.duration_seconds, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, 60);
    const targetWords = clampInteger(body.target_words, 60, 20000, Math.floor(durationSeconds / 60 * languageWpm(language)));

    try {
      const manifest = body.script
        ? normalizeIncomingManifest(body.script, language, targetWords, durationSeconds)
        : await generateScriptManifest(env, userId, {
          topic,
          instructions: readString(body.instructions).slice(0, MAX_PROMPT_CHARS),
          language,
          targetWords,
          durationSeconds,
        });

      const jobConfig: Record<string, unknown> = {
        workflow: "video_generation",
        video_generation: true,
        topic,
        instructions: readString(body.instructions).slice(0, MAX_PROMPT_CHARS),
        language,
        duration_seconds: durationSeconds,
        target_words: targetWords,
        min_words: clampInteger(body.min_words, 1, 30000, Math.floor(targetWords * 0.9)),
        max_words: clampInteger(body.max_words, 1, 30000, Math.ceil(targetWords * 1.05)),
        speech_rate_wpm: languageWpm(language),
        visual_style: readString(body.visual_style, "Cinematic documentary"),
        aspect_ratio: validateAspectRatio(body.aspect_ratio),
        visual_mode: readString(body.visual_mode, "economy_reuse") === "unique_scenes" ? "unique_scenes" : "economy_reuse",
        video_model: validateVideoModel(body.video_model),
        tts_model: readString(body.tts_model, DEFAULT_TTS_MODEL),
        voice_id: readString(body.voice_id) || null,
        caption_font: language === "ur" ? "Noto Nastaliq Urdu" : "default",
        caption_text_mode: language === "ur" ? "nastaliq" : "same_as_tts",
        tts_text_mode: language === "ur" ? "devanagari_phonetic_urdu" : "same_as_caption",
        hook_seconds: 3,
        soft_cta_after_hook: true,
        final_cta: true,
        estimated_scenes: Math.ceil(durationSeconds / 10),
        script_manifest: manifest,
        video_urls: [],
        videos_per_run: 1,
      };

      const automationName = `AI Video: ${topic.slice(0, 70)}`;
      const automationResult = await env.DB.prepare(
        "INSERT INTO automations (user_id, name, type, status, config, schedule, next_run) VALUES (?, ?, 'video', 'active', ?, NULL, NULL)"
      ).bind(userId, automationName, JSON.stringify(jobConfig)).run();
      const automationId = Number(automationResult.meta.last_row_id);
      if (!automationId) throw new Error("Could not create video automation");

      const automation = {
        id: automationId,
        user_id: userId,
        name: automationName,
        type: "video" as const,
        status: "active" as const,
        config: JSON.stringify(jobConfig),
        schedule: null,
        next_run: null,
        last_run: null,
      };
      const run: AutomationRunResult = await triggerAutomationRun(env, automation, userId, { replaceExistingLocalRun: false });
      if (!run.success) {
        await env.DB.prepare("UPDATE automations SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").bind(automationId, userId).run();
        return jsonResponse({ success: false, error: run.error || "Video job dispatch failed", data: { automation_id: automationId, job_id: run.jobId || null } }, 500);
      }

      return jsonResponse({
        success: true,
        data: {
          job_id: run.jobId,
          automation_id: automationId,
          github_run_id: run.githubRunId,
          execution_mode: run.executionMode,
          script: manifest,
        },
        message: run.message || "Video generation job queued",
      }, 201);
    } catch (error) {
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Video job creation failed" }, 500);
    }
  }

  if (path === "/api/video-generation/scene" && method === "POST") {
    return generateVideoScene(env, await safeRequestJson<Record<string, unknown>>(request) || {});
  }

  return jsonResponse({ success: false, error: "Video generation route not found" }, 404);
}
