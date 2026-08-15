import { AISettings, Automation, Env, GithubSettings, PostformeSettings, VideoSourceSettings } from "../types";
import { buildWorkflowInputs, buildWorkflowRuntimeConfigToken, dispatchWorkflow, getWorkflowRunStatus } from "./github";
import { getImageAspectRatio, prepareImageAutomationRunConfig } from "./image-automation";
import { buildStoredPostMetadata, parseSavedPostformeAccounts, resolveScheduledAccounts } from "./post-metadata";
import { getScopedSettings } from "./user-settings";
import { parseGhazalTimestamps, createVideoMetadata, processGhazalVideo } from "./ghazal-timestamps";
import { extractYoutubeDownloadUrl } from "./ytdown-proxy";
import { generateAiJson, getSocialMessages, normalizeSocialResult } from "./ai";


type ScheduleType = "minutes" | "hourly" | "daily" | "weekly";

interface ScheduleRule {
  type: ScheduleType;
  label: string;
  intervalMinutes?: number;
  time?: string;
  timezone?: string;
  weekdays?: number[];
}

interface WorkflowDispatchConfig {
  workflowName: string;
  inputs: Record<string, string>;
}

interface TimeParts {
  hour: number;
  minute: number;
  normalized: string;
}

interface ZonedDateParts {
  weekday: number;
  hour: number;
  minute: number;
}

function serializeRunnerLabels(value: string | null | undefined): string {
  const labels = String(value || "")
    .split(/[\n,]/)
    .map((label) => label.trim())
    .filter(Boolean);

  return JSON.stringify(labels.length > 0 ? labels : ["ubuntu-latest"]);
}

export interface AutomationRunResult {
  success: boolean;
  jobId?: number;
  githubRunId?: number | null;
  executionMode?: "github" | "local" | "direct";
  error?: string;
  inProgress?: boolean;
  message?: string;
}

interface YoutubePlatformConfig {
  title: string;
  description?: string;
  tags?: string[];
  privacyStatus?: string;
  selfDeclaredMadeForKids?: boolean;
  defaultLanguage?: string;
  categoryId?: string;
}

interface PostformeContentSelection {
  title: string;
  description: string;
  hashtags: string[];
  caption: string;
  topTagline: string;
  bottomTagline: string;
  platformConfigurations: Record<string, { title: string; tags?: string[] } | YoutubePlatformConfig>;
  platformConfigurationMetadata: Array<{ platform: string; title: string; caption: string }>;
}

interface TriggerAutomationRunOptions {
  replaceExistingLocalRun?: boolean;
  inputData?: Record<string, unknown>;
}

const weekdayIndexByName: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const weekdayLabelByIndex = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function shuffleArray<T>(items: T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function splitHttpLines(value: unknown): string[] {
  const raw = readString(value);
  return raw
    .split(/\r?\n|,/g)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

function firstHttpUrl(value: unknown): string {
  return splitHttpLines(value)[0] || "";
}

function normalizeHttpUrlText(value: unknown): string {
  return splitHttpLines(value).join("\n");
}

function getGooglePhotosSourceUrls(config: Record<string, unknown>): { text: string; migratedFromAlbumUrl: boolean } {
  const linksText = normalizeHttpUrlText(config.google_photos_links);
  if (linksText) return { text: linksText, migratedFromAlbumUrl: false };
  const albumText = normalizeHttpUrlText(config.google_photos_album_url);
  if (albumText && splitHttpLines(albumText).some(isGooglePhotosUrl)) return { text: albumText, migratedFromAlbumUrl: true };
  return { text: "", migratedFromAlbumUrl: false };
}

function isYoutubeUrl(value: string): boolean {
  return /(^|\.)youtube\.com\/|youtu\.be\//i.test(value);
}

function isGooglePhotosUrl(value: string): boolean {
  return /photos\.google\.com|photos\.app\.goo\.gl/i.test(value);
}

function normalizePromptSourceType(value: unknown, fallback = "youtube"): "youtube" | "direct" | "local_file" {
  const source = readString(value, fallback).trim();
  if (source === "direct" || source === "local_file" || source === "youtube") {
    return source;
  }
  return fallback === "local_file" ? "local_file" : "youtube";
}

function inferRemoteSourceFromUrl(url: string): "youtube" | "direct" | "google_photos" | "" {
  if (!url) return "";
  if (isYoutubeUrl(url)) return "youtube";
  if (isGooglePhotosUrl(url)) return "google_photos";
  if (/^https?:\/\//i.test(url)) return "direct";
  return "";
}

function recoverSourceMismatch(
  config: Record<string, unknown>,
  requestedVideoSource: string,
  promptSource: { videoSource: string; singleSource: string; error: string | null },
): { videoSource: string; singleSourceOverride: string; reason: string | null } {
  const promptMode = readString(config.short_generation_mode, "normal") === "prompt";
  const googlePhotoBundle = getGooglePhotosSourceUrls(config);
  const googlePhotoLinks = googlePhotoBundle.text;
  const googlePhotoAlbum = googlePhotoBundle.migratedFromAlbumUrl ? googlePhotoBundle.text : normalizeHttpUrlText(config.google_photos_album_url);
  const promptUrl = firstHttpUrl(config.prompt_video_url);
  const normalUrl = firstHttpUrl(config.video_url);
  const candidateUrl = promptSource.singleSource || (promptMode ? promptUrl || normalUrl : normalUrl || promptUrl);
  const inferredSource = inferRemoteSourceFromUrl(candidateUrl);

  if (!requestedVideoSource && inferredSource) {
    return { videoSource: inferredSource, singleSourceOverride: candidateUrl, reason: "missing_video_source_inferred_from_url" };
  }

  if (requestedVideoSource === "google_photos" && !googlePhotoLinks && !googlePhotoAlbum && inferredSource && inferredSource !== "google_photos") {
    return { videoSource: inferredSource, singleSourceOverride: candidateUrl, reason: "google_photos_source_mismatch_recovered_from_url" };
  }

  if (promptMode && candidateUrl && inferredSource && promptSource.videoSource !== inferredSource) {
    return { videoSource: inferredSource, singleSourceOverride: candidateUrl, reason: "prompt_source_type_inferred_from_prompt_url" };
  }

  return { videoSource: requestedVideoSource, singleSourceOverride: "", reason: null };
}

function readBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

interface PromptPlanSegmentConfig {
  hook: string;
  title: string;
  caption: string;
  hashtags: string[];
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
}

function normalizePromptPlanSegments(config: Record<string, unknown>): PromptPlanSegmentConfig[] {
  const mode = readString(config.short_generation_mode, "normal");
  if (mode !== "prompt") {
    return [];
  }

  const plan = asRecord(config.prompt_short_plan);
  const segments = Array.isArray(plan.segments) ? plan.segments : [];

  return segments
    .map((item, index) => {
      const record = asRecord(item);
      const start = typeof record.start_seconds === "number" ? record.start_seconds : Number(record.start_seconds);
      const end = typeof record.end_seconds === "number" ? record.end_seconds : Number(record.end_seconds);
      const duration = typeof record.duration_seconds === "number"
        ? record.duration_seconds
        : Number(record.duration_seconds);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
      }

      const hashtags = Array.isArray(record.hashtags)
        ? record.hashtags.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];

      return {
        hook: readString(record.hook) || readString(record.title) || `Segment ${index + 1}`,
        title: readString(record.title) || readString(record.hook) || `Short ${index + 1}`,
        caption: readString(record.caption) || readString(record.title) || readString(record.hook),
        hashtags,
        start_seconds: start,
        end_seconds: end,
        duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : end - start,
      };
    })
    .filter((item): item is PromptPlanSegmentConfig => Boolean(item));
}

function buildPromptPlanOverrides(config: Record<string, unknown>): {
  segmentInfo: Record<string, unknown> | null;
  metadata: Partial<Record<string, unknown>>;
} {
  const segments = normalizePromptPlanSegments(config);
  if (segments.length === 0) {
    return { segmentInfo: null, metadata: {} };
  }

  const aggregateTitles = segments.map((segment) => segment.title).filter(Boolean);
  const aggregateDescriptions = segments.map((segment) => segment.caption).filter(Boolean);
  const aggregateHashtags = Array.from(new Set(segments.flatMap((segment) => segment.hashtags))).slice(0, 40);

  return {
    segmentInfo: {
      mode: "explicit_segments",
      segmentCount: segments.length,
      segmentDuration: Math.max(1, Math.round(segments[0]?.duration_seconds || 60)),
      mergeSegments: readBoolean(config.prompt_merge_generated_shorts),
      segments: segments.map((segment, index) => ({
        index,
        start: segment.start_seconds,
        end: segment.end_seconds,
        duration: segment.duration_seconds,
        hook: segment.hook,
        title: segment.title,
        caption: segment.caption,
        hashtags: segment.hashtags,
      })),
    },
    metadata: {
      titles: aggregateTitles,
      descriptions: aggregateDescriptions,
      hashtags: aggregateHashtags,
      // Video overlay taglines come exclusively from the user's Tagline tab,
      // never from AI-generated per-segment hooks.
    },
  };
}

function resolvePromptModeSource(
  config: Record<string, unknown>,
  executionMode: "github" | "local" | "direct",
): {
  videoSource: string;
  singleSource: string;
  error: string | null;
} {
  const mode = readString(config.short_generation_mode, "normal");
  if (mode !== "prompt") {
    return {
      videoSource: readString(config.video_source),
      singleSource: "",
      error: null,
    };
  }

  const defaultSource = executionMode === "local" ? "local_file" : "youtube";
  const sourceType = normalizePromptSourceType(config.prompt_source_type, defaultSource);

  if (sourceType === "local_file") {
    if (executionMode !== "local") {
      return {
        videoSource: "prompt_local_file",
        singleSource: "",
        error: "Short with Prompt local file source is only available for local runner users.",
      };
    }

    const localPath = readString(config.prompt_local_file_path).trim();
    return {
      videoSource: "prompt_local_file",
      singleSource: localPath,
      error: localPath ? null : "Short with Prompt ke liye local video file path required hai.",
    };
  }

  if (sourceType === "direct") {
    const directUrl = readString(config.prompt_video_url).trim();
    return {
      videoSource: "direct",
      singleSource: directUrl,
      error: directUrl ? null : "Short with Prompt ke liye direct video URL required hai.",
    };
  }

  const youtubeUrl = readString(config.prompt_video_url).trim();
  return {
    videoSource: "youtube",
    singleSource: youtubeUrl,
    error: youtubeUrl ? null : "Short with Prompt ke liye YouTube video URL required hai.",
  };
}

function resolveConfiguredVideoSourceForStatus(config: Record<string, unknown>): {
  videoSource: string;
  singleSource: string;
} {
  const mode = readString(config.short_generation_mode, "normal");
  if (mode !== "prompt") {
    return {
      videoSource: readString(config.video_source),
      singleSource: "",
    };
  }

  const sourceType = normalizePromptSourceType(config.prompt_source_type, "youtube");
  if (sourceType === "local_file") {
    return {
      videoSource: "prompt_local_file",
      singleSource: readString(config.prompt_local_file_path).trim(),
    };
  }

  return {
    videoSource: sourceType === "direct" ? "direct" : "youtube",
    singleSource: readString(config.prompt_video_url).trim(),
  };
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function normalizeMediaUrls(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];

  const seen = new Set<string>();
  const urls: string[] = [];

  for (const item of rawItems) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();
    if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
      continue;
    }

    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    urls.push(trimmed);
  }

  return urls;
}

function normalizeCursorValue(value: unknown): number {
  const parsed = parsePositiveInteger(value);
  return parsed === null ? 0 : Math.max(0, parsed);
}

function getUploadMediaUrls(upload: {
  media_url?: string | null;
  job_input_data?: string | null;
  job_output_data?: string | null;
}): string[] {
  const inputData = parseJsonRecord(upload.job_input_data);
  const outputData = parseJsonRecord(upload.job_output_data);

  const outputMediaUrls = normalizeMediaUrls(outputData.media_urls);
  if (outputMediaUrls.length > 0) {
    return outputMediaUrls;
  }

  const sourceMediaUrls = normalizeMediaUrls(inputData.source_image_urls || inputData.source_image_url);
  if (sourceMediaUrls.length > 0) {
    return sourceMediaUrls;
  }

  const singleMediaCandidates = normalizeMediaUrls([
    typeof outputData.media_url === "string" ? outputData.media_url : "",
    typeof outputData.video_url === "string" ? outputData.video_url : "",
    upload.media_url || "",
  ]);

  return singleMediaCandidates;
}

function parseTimeValue(value: unknown): TimeParts | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return {
    hour,
    minute,
    normalized: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function formatTimeLabel(time: string): string {
  const parts = parseTimeValue(time);
  if (!parts) {
    return time;
  }

  const hour12 = parts.hour % 12 || 12;
  const meridiem = parts.hour < 12 ? "AM" : "PM";
  return `${hour12}:${String(parts.minute).padStart(2, "0")} ${meridiem}`;
}

function normalizeTimezone(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    return "UTC";
  }
}

function getWeekdays(value: unknown): number[] {
  const days = Array.isArray(value) ? value : [];
  const unique = new Set<number>();

  for (const day of days) {
    if (typeof day !== "string") {
      continue;
    }
    const normalized = day.trim().toLowerCase();
    if (normalized in weekdayIndexByName) {
      unique.add(weekdayIndexByName[normalized]);
    }
  }

  return Array.from(unique).sort((left, right) => left - right);
}

function getZonedFormatter(timezone: string): Intl.DateTimeFormat {
  const cacheKey = timezone;
  const existing = zonedFormatterCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  zonedFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const formattedParts = getZonedFormatter(timezone).formatToParts(date);
  const parts = Object.fromEntries(formattedParts.map((part) => [part.type, part.value]));
  const weekday = weekdayIndexByName[(parts.weekday || "").toLowerCase()] ?? 0;

  return {
    weekday,
    hour: Number.parseInt(parts.hour || "0", 10),
    minute: Number.parseInt(parts.minute || "0", 10),
  };
}

function roundUpToNextMinute(date: Date): Date {
  const next = new Date(date);
  next.setUTCSeconds(0, 0);
  if (next.getTime() <= date.getTime()) {
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  return next;
}

function findNextCalendarSlot(baseTime: Date, rule: ScheduleRule): Date {
  const timezone = rule.timezone || "UTC";
  const targetTime = parseTimeValue(rule.time) || { hour: 13, minute: 0, normalized: "13:00" };
  const maxSearchMinutes = rule.type === "weekly" ? 60 * 24 * 14 : 60 * 24 * 3;
  let candidate = roundUpToNextMinute(baseTime);

  for (let minuteOffset = 0; minuteOffset <= maxSearchMinutes; minuteOffset += 1) {
    const zonedParts = getZonedDateParts(candidate, timezone);
    const matchesTime = zonedParts.hour === targetTime.hour && zonedParts.minute === targetTime.minute;
    const matchesWeekday = rule.type !== "weekly" || (rule.weekdays || []).includes(zonedParts.weekday);

    if (matchesTime && matchesWeekday) {
      return candidate;
    }

    candidate = new Date(candidate.getTime() + 60_000);
  }

  return roundUpToNextMinute(new Date(baseTime.getTime() + 24 * 60 * 60_000));
}

export function parseAutomationConfig(configText: string): Record<string, unknown> {
  const parsed = JSON.parse(configText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid automation config");
  }
  return parsed as Record<string, unknown>;
}

export function getScheduleRule(config: Record<string, unknown>): ScheduleRule | null {
  const scheduleType = typeof config.schedule_type === "string" ? config.schedule_type.trim().toLowerCase() : "";

  switch (scheduleType) {
    case "minutes": {
      const minutes = Math.max(1, parsePositiveInteger(config.schedule_minutes) ?? 30);
      return {
        type: "minutes",
        intervalMinutes: minutes,
        label: `Every ${minutes} minute${minutes === 1 ? "" : "s"}`,
      };
    }
    case "hourly": {
      const hours = Math.max(1, parsePositiveInteger(config.schedule_hours) ?? 1);
      return {
        type: "hourly",
        intervalMinutes: hours * 60,
        label: `Every ${hours} hour${hours === 1 ? "" : "s"}`,
      };
    }
    case "daily": {
      const legacyScheduleHour = (() => {
        if (typeof config.schedule_hour === "number" && Number.isFinite(config.schedule_hour)) {
          return config.schedule_hour;
        }
        if (typeof config.schedule_hour === "string" && config.schedule_hour.trim()) {
          const parsed = Number.parseInt(config.schedule_hour, 10);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      })();
      const time = parseTimeValue(config.schedule_run_time)?.normalized
        || (() => {
          return legacyScheduleHour !== null && legacyScheduleHour >= 0 && legacyScheduleHour <= 23
            ? `${String(legacyScheduleHour).padStart(2, "0")}:00`
            : "13:00";
        })();
      const timezone = normalizeTimezone(config.schedule_timezone);
      return {
        type: "daily",
        time,
        timezone,
        label: `Daily at ${formatTimeLabel(time)}`,
      };
    }
    case "weekly": {
      const time = parseTimeValue(config.schedule_run_time)?.normalized || "13:00";
      const timezone = normalizeTimezone(config.schedule_timezone);
      const weekdays = getWeekdays(config.schedule_weekdays);
      const normalizedWeekdays = weekdays.length > 0 ? weekdays : [0];
      const dayLabel = normalizedWeekdays.map((day) => weekdayLabelByIndex[day]).join(", ");
      return {
        type: "weekly",
        time,
        timezone,
        weekdays: normalizedWeekdays,
        label: `Weekly on ${dayLabel} at ${formatTimeLabel(time)}`,
      };
    }
    default:
      return null;
  }
}

export function parseDatabaseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDatabaseDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function computeNextRunDate(rule: ScheduleRule, baseTime: Date): Date {
  if (rule.type === "daily" || rule.type === "weekly") {
    return findNextCalendarSlot(baseTime, rule);
  }

  const targetTime = baseTime.getTime() + (rule.intervalMinutes || 60) * 60_000;
  const nextRun = new Date(targetTime);
  nextRun.setUTCSeconds(0, 0);

  if (nextRun.getTime() < targetTime) {
    nextRun.setUTCMinutes(nextRun.getUTCMinutes() + 1);
  }

  return nextRun;
}

function extractLinksFromConfig(config: Record<string, unknown>): string[] {
  const promptSource = resolveConfiguredVideoSourceForStatus(config);
  const source = promptSource.videoSource || readString(config.video_source);
  console.log(`[extractLinksFromConfig] source: "${source}"`);
  const links: string[] = [];

  if (source === "prompt_local_file") {
    if (promptSource.singleSource) {
      links.push(promptSource.singleSource);
    }
  } else if (source === "manual_links") {
    const raw = readString(config.manual_links);
    if (raw) {
      const allManualLinks = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      links.push(...allManualLinks);
    }
  } else if (source === "google_photos") {
    const raw = readString(config.google_photos_links);
    if (raw) {
      const allGooglePhotosLinks = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      links.push(...allGooglePhotosLinks);
    } else {
      const raw = readString(config.video_url);
      if (raw) {
        const allVideoLinks = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
        links.push(...allVideoLinks);
      }
    }
  } else {
    const raw = readString(config.short_generation_mode, "normal") === "prompt"
      ? promptSource.singleSource
      : readString(config.video_url);
    if (raw) {
      const allVideoLinks = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
      links.push(...allVideoLinks);
    }
  }

  return links;
}

async function getProcessedLinkCount(env: Env, automationId: number): Promise<number> {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM jobs WHERE automation_id = ? AND status IN ('success', 'running', 'queued')"
  ).bind(automationId).first<{ cnt: number }>();
  return result?.cnt || 0;
}

export async function getLinkQueueStatus(env: Env, automationId: number, userId: number): Promise<{
  totalLinks: number;
  processedLinks: number;
  currentIndex: number;
  remainingLinks: number;
  allCompleted: boolean;
  links: string[];
}> {
  const automation = await env.DB.prepare("SELECT * FROM automations WHERE id = ? AND user_id = ?").bind(automationId, userId).first<Automation>();
  if (!automation) {
    return { totalLinks: 0, processedLinks: 0, currentIndex: 0, remainingLinks: 0, allCompleted: false, links: [] };
  }

  // Ensure rotation_reset_at column exists (migration might not have been run)
  try {
    await env.DB.prepare("ALTER TABLE automations ADD COLUMN rotation_reset_at DATETIME").run();
  } catch (error) {
    // Column might already exist, ignore error
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name|already exists|no such column/i.test(message)) {
      throw error;
    }
  }

  let config: Record<string, unknown>;
  try {
    config = parseAutomationConfig(automation.config);
    console.log(`[getLinkQueueStatus] raw config: ${JSON.stringify(config).substring(0, 200)}`);
  } catch {
    return { totalLinks: 0, processedLinks: 0, currentIndex: 0, remainingLinks: 0, allCompleted: false, links: [] };
  }

  const configLinks = extractLinksFromConfig(config);
  const promptSource = resolveConfiguredVideoSourceForStatus(config);
  const trackedLinks = toStringArray(config.source_urls);
  const links = trackedLinks.length > 0 ? trackedLinks : configLinks;
  const totalLinks = links.length;
  console.log(`[getLinkQueueStatus] automation ${automationId}: video_source="${promptSource.videoSource || config.video_source}", totalLinks=${totalLinks}, links=${JSON.stringify(links)}`);

  if (totalLinks === 0) {
    return { totalLinks: 0, processedLinks: 0, currentIndex: 0, remainingLinks: 0, allCompleted: false, links: [] };
  }

  const processedUrls = await getProcessedSourceUrls(env, automationId, userId);
  const processedLinks = links.filter((url) => processedUrls.has(url)).length;

  console.log(`[getLinkQueueStatus] processed_videos matched URLs: ${processedLinks}, total config links: ${totalLinks}`);

  const currentIndex = Math.min(processedLinks, Math.max(0, totalLinks - 1));
  const remainingLinks = Math.max(0, totalLinks - processedLinks);
  const allCompleted = processedLinks >= totalLinks;

  console.log(`[getLinkQueueStatus] Final: totalLinks=${totalLinks}, processedLinks=${processedLinks}, remainingLinks=${remainingLinks}, allCompleted=${allCompleted}`);

  return { totalLinks, processedLinks, currentIndex, remainingLinks, allCompleted, links };
}

async function hasInProgressJob(env: Env, automationId: number): Promise<boolean> {
  const existing = await env.DB.prepare(
    "SELECT id FROM jobs WHERE automation_id = ? AND status IN ('pending', 'queued', 'running') ORDER BY id DESC LIMIT 1"
  ).bind(automationId).first<{ id: number }>();

  return Boolean(existing?.id);
}

async function hasInProgressGithubJobForUser(env: Env, userId: number): Promise<boolean> {
  const existing = await env.DB.prepare(
    `SELECT id
     FROM jobs
     WHERE user_id = ?
       AND status IN ('pending', 'queued', 'running')
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).bind(userId).first<{ id: number }>();

  return Boolean(existing?.id);
}

async function getProcessedSourceUrls(env: Env, automationId: number, userId: number): Promise<Set<string>> {
  // Ensure rotation_reset_at column exists (migration might not have been run)
  try {
    await env.DB.prepare("ALTER TABLE automations ADD COLUMN rotation_reset_at DATETIME").run();
  } catch (error) {
    // Column might already exist, ignore error
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name|already exists|no such column/i.test(message)) {
      throw error;
    }
  }

  const automation = await env.DB.prepare(
    "SELECT rotation_reset_at FROM automations WHERE id = ? AND user_id = ?"
  ).bind(automationId, userId).first<{ rotation_reset_at: string | null }>();
  const rotationResetAt = parseDatabaseDate(automation?.rotation_reset_at || null);

  const processedRows = await env.DB.prepare(
    rotationResetAt
      ? "SELECT video_url FROM processed_videos WHERE automation_id = ? AND user_id = ? AND processed_at > ?"
      : "SELECT video_url FROM processed_videos WHERE automation_id = ? AND user_id = ?"
  ).bind(
    automationId,
    userId,
    ...(rotationResetAt ? [formatDatabaseDate(rotationResetAt)] : [])
  ).all<{ video_url: string }>();

  const processedUrls = new Set(
    (processedRows.results || [])
      .map((row) => typeof row.video_url === "string" ? row.video_url.trim() : "")
      .filter(Boolean)
  );

  const successfulJobs = await env.DB.prepare(
    `SELECT input_data, output_data
     FROM jobs
     WHERE automation_id = ?
       AND user_id = ?
       AND status = 'success'
       ${rotationResetAt ? "AND COALESCE(completed_at, created_at) > ?" : ""}
     ORDER BY created_at DESC`
  ).bind(
    automationId,
    userId,
    ...(rotationResetAt ? [formatDatabaseDate(rotationResetAt)] : [])
  ).all<{ input_data: string | null; output_data: string | null }>();

  for (const job of successfulJobs.results || []) {
    const outputData = parseJsonRecord(job.output_data);
    const processedVideos = Array.isArray(outputData.processed_videos) ? outputData.processed_videos : [];

    for (const item of processedVideos) {
      const record = asRecord(item);
      const originalUrl = readString(record.original_url).trim();
      if (originalUrl) {
        processedUrls.add(originalUrl);
      }
    }

    const inputData = parseJsonRecord(job.input_data);
    const sourceUrls = normalizeMediaUrls(inputData.source_urls || inputData.video_urls || inputData.video_url);
    const outputVideoUrl = readString(outputData.video_url).trim();
    if (sourceUrls.length === 1 && outputVideoUrl) {
      processedUrls.add(sourceUrls[0]);
    }
  }

  return processedUrls;
}

async function getInProgressLocalJobs(env: Env, userId: number): Promise<Array<{ id: number }>> {
  const result = await env.DB.prepare(
    `SELECT id
     FROM jobs
     WHERE user_id = ?
       AND github_run_id IS NULL
       AND status IN ('pending', 'queued', 'running')
     ORDER BY created_at DESC, id DESC`
  ).bind(userId).all<{ id: number }>();

  return result.results || [];
}

async function cancelInProgressLocalJobs(env: Env, userId: number, reason: string): Promise<number> {
  const activeJobs = await getInProgressLocalJobs(env, userId);
  if (activeJobs.length === 0) {
    return 0;
  }

  const placeholders = activeJobs.map(() => "?").join(", ");
  const jobIds = activeJobs.map((job) => job.id);

  const result = await env.DB.prepare(
    `UPDATE jobs
     SET status = 'cancelled',
         error_message = ?,
         completed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?
       AND github_run_id IS NULL
       AND status IN ('pending', 'queued', 'running')
       AND id IN (${placeholders})`
  ).bind(reason, userId, ...jobIds).run();

  return Number(result.meta.changes || 0);
}

async function getLatestCompletedAt(env: Env, automationId: number): Promise<string | null> {
  const latest = await env.DB.prepare(
    "SELECT completed_at FROM jobs WHERE automation_id = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC, id DESC LIMIT 1"
  ).bind(automationId).first<{ completed_at: string | null }>();

  return latest?.completed_at || null;
}

export async function getSchedulePersistenceValues(
  env: Env,
  configText: string,
  status: Automation["status"],
  lastRunText: string | null,
  automationId?: number
): Promise<{ schedule: string | null; nextRun: string | null }> {
  const config = parseAutomationConfig(configText);
  const rule = getScheduleRule(config);
  const schedule = rule?.label || null;

  if (!rule || status !== "active") {
    return { schedule, nextRun: null };
  }

  let baseTime = parseDatabaseDate(lastRunText);
  if (!baseTime && automationId) {
    const latestCompletedAt = await getLatestCompletedAt(env, automationId);
    baseTime = parseDatabaseDate(latestCompletedAt);
  }
  if (!baseTime) {
    baseTime = new Date();
  }

  return {
    schedule,
    nextRun: formatDatabaseDate(computeNextRunDate(rule, baseTime)),
  };
}

function buildImageWorkflowInputs(
  jobId: number,
  automationId: number
): WorkflowDispatchConfig {
  return {
    workflowName: "image-automation.yml",
    inputs: { ...buildWorkflowInputs(jobId, automationId) },
  };
}

function buildWorkflowDispatch(
  automation: Automation,
  jobId: number,
  config: Record<string, unknown>
): WorkflowDispatchConfig {
  if (automation.type === "image") {
    return buildImageWorkflowInputs(jobId, automation.id as number);
  }
  return {
    workflowName: "video-automation.yml",
    inputs: { ...buildWorkflowInputs(jobId, automation.id as number) },
  };
}

function buildJobLogs(stage: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      at: new Date().toISOString(),
      stage,
      level: "error",
      message,
      ...extra,
    },
  ]);
}

async function createFailedAutomationJob(
  env: Env,
  automation: Automation,
  userId: number,
  config: Record<string, unknown>,
  errorMessage: string,
  stage: string,
  extra: Record<string, unknown> = {}
): Promise<number | null> {
  if (!automation.id) {
    return null;
  }

  const failedAt = formatDatabaseDate(new Date());
  const inputData = JSON.stringify({
    ...config,
    failure_stage: stage,
    failure_context: extra,
  });

  const result = await env.DB.prepare(
    `INSERT INTO jobs (
       user_id,
       automation_id,
       status,
       input_data,
       logs,
       error_message,
       started_at,
       completed_at,
       updated_at
     ) VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(
    userId,
    automation.id,
    inputData,
    buildJobLogs(stage, errorMessage, extra),
    errorMessage,
    failedAt,
    failedAt
  ).run();

  return Number(result.meta.last_row_id);
}

async function failExistingAutomationJob(
  env: Env,
  jobId: number,
  errorMessage: string,
  stage: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs
     SET status = 'failed',
         error_message = ?,
         logs = ?,
         completed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(errorMessage, buildJobLogs(stage, errorMessage, extra), jobId).run();
}

async function completeDirectImageAutomationRun(
  env: Env,
  automation: Automation,
  userId: number,
  config: Record<string, unknown>
): Promise<AutomationRunResult> {
  const sourceImageUrls = normalizeMediaUrls(config.source_image_urls || config.source_image_url || config.image_url);
  const sourceImageUrl = sourceImageUrls[0] || readString(config.source_image_url || config.image_url);
  if (!sourceImageUrl.startsWith("http://") && !sourceImageUrl.startsWith("https://")) {
    return { success: false, error: "A valid source image URL is required." };
  }

  const aspectRatio = getImageAspectRatio(config);
  const resolution = readString(config.output_resolution, "1080x1350");
  const completedAt = new Date();
  const completedAtText = formatDatabaseDate(completedAt);
  const outputData = JSON.stringify({
    media_kind: "image",
    render_mode: "source_url",
    aspect_ratio: aspectRatio,
    resolution,
    media_url: sourceImageUrl,
    media_urls: sourceImageUrls.length > 0 ? sourceImageUrls : [sourceImageUrl],
    media_count: sourceImageUrls.length > 0 ? sourceImageUrls.length : 1,
    video_url: sourceImageUrl,
  });

  const jobResult = await env.DB.prepare(
    `INSERT INTO jobs (
       user_id,
       automation_id,
       status,
       input_data,
       output_data,
       video_url,
       started_at,
       completed_at
     ) VALUES (?, ?, 'success', ?, ?, ?, ?, ?)`
  ).bind(
    userId,
    automation.id,
    JSON.stringify(config),
    outputData,
    sourceImageUrl,
    completedAtText,
    completedAtText
  ).run();

  const jobId = Number(jobResult.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO video_uploads (
       user_id,
       job_id,
       postforme_id,
       media_url,
       upload_status,
       post_status,
       aspect_ratio
     ) VALUES (?, ?, NULL, ?, 'uploaded', 'pending', ?)`
  ).bind(userId, jobId, sourceImageUrl, aspectRatio).run();

  await markAutomationRunCompleted(env, jobId, completedAt);

  return {
    success: true,
    jobId,
    githubRunId: null,
    executionMode: "direct",
    message: `${sourceImageUrls.length > 1 ? `${sourceImageUrls.length} source images` : "Source image"} queued for publishing.`,
  };
}

export async function triggerAutomationRun(
  env: Env,
  automation: Automation,
  userId: number,
  options: TriggerAutomationRunOptions = {}
): Promise<AutomationRunResult> {
  if (!automation.id) {
    return { success: false, error: "Automation ID is required" };
  }

  let config: Record<string, unknown>;
  try {
    config = parseAutomationConfig(automation.config);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Invalid automation config",
    };
  }

  const userRecord = await env.DB.prepare(
    "SELECT role FROM users WHERE id = ? LIMIT 1"
  ).bind(userId).first<{ role: string | null }>();
  const executionMode = readString(config.workflow) === "video_generation"
    ? "github"
    : (userRecord?.role === "admin" ? "github" : "local");

  if (readString(config.workflow) === "video_generation") {
    const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
    const jobResult = await env.DB.prepare(
      "INSERT INTO jobs (user_id, automation_id, status, input_data, started_at) VALUES (?, ?, 'queued', ?, CURRENT_TIMESTAMP)"
    ).bind(userId, automation.id, JSON.stringify(config)).run();
    const jobId = Number(jobResult.meta.last_row_id);

    if (!githubSettings) {
      const error = "GitHub settings not configured. Go to Settings -> GitHub Runner";
      await failExistingAutomationJob(env, jobId, error, "dispatch.github_settings", { execution_mode: executionMode });
      return { success: false, jobId, executionMode, error };
    }

    const workflow = buildWorkflowDispatch(automation, jobId, config);
    workflow.inputs.runtime_config_token = await buildWorkflowRuntimeConfigToken(jobId, githubSettings.pat_token);
    workflow.inputs.runner_labels = serializeRunnerLabels(githubSettings.runner_labels);
    const dispatchResult = await dispatchWorkflow(githubSettings, workflow.inputs, workflow.workflowName);

    if (!dispatchResult.success) {
      const error = dispatchResult.error || "Workflow dispatch failed";
      await failExistingAutomationJob(env, jobId, error, "dispatch.github_api", {
        workflow: workflow.workflowName,
        dispatch_status: dispatchResult.dispatchStatus,
        payload_bytes: dispatchResult.payloadBytes,
        dispatch_nonce: dispatchResult.dispatchNonce,
      });
      return { success: false, jobId, executionMode, error };
    }

    await env.DB.prepare(
      "UPDATE jobs SET status = 'running', github_run_id = ?, github_run_url = ?, logs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(
      dispatchResult.runId,
      dispatchResult.runUrl,
      dispatchResult.warning ? JSON.stringify([{ at: new Date().toISOString(), stage: "dispatch.run_lookup", level: "warning", message: dispatchResult.warning, dispatch_nonce: dispatchResult.dispatchNonce }]) : null,
      jobId
    ).run();

    return {
      success: true,
      jobId,
      githubRunId: dispatchResult.runId,
      executionMode,
      message: "AI video generation dispatched to the remote runner.",
    };
  }

  if (executionMode === "local") {
    const activeLocalJobs = await getInProgressLocalJobs(env, userId);
    if (activeLocalJobs.length > 0) {
      if (!options.replaceExistingLocalRun) {
        return {
          success: false,
          inProgress: true,
          error: "Another local automation is already running",
        };
      }

      await cancelInProgressLocalJobs(
        env,
        userId,
        "Cancelled because a newer local automation run was started."
      );
    }
  } else if (await hasInProgressGithubJobForUser(env, userId)) {
    if (!options.replaceExistingLocalRun) {
      return {
        success: false,
        inProgress: true,
        error: "Another admin automation is already running",
      };
    }
    // Cancel previous Github jobs so new trigger can proceed
    await env.DB.prepare(
      `UPDATE jobs SET status = 'cancelled',
          error_message = 'Superseded by a newer GitHub run',
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
         AND status IN ('pending', 'queued', 'running')`
    ).bind(userId).run();
  }

  // ── Pre-fetch video URLs before GitHub trigger ───────────────────────
  if (automation.type === "image") {
    const imageJobConfig = await prepareImageAutomationRunConfig(env, userId, automation.name, config);
    const imageMode = readString(imageJobConfig.image_mode || imageJobConfig.image_source, "html_banner");

    if (imageMode === "source_url") {
      return completeDirectImageAutomationRun(env, automation, userId, imageJobConfig);
    }

    const jobInputData = JSON.stringify(imageJobConfig);
    const jobResult = await env.DB.prepare(
      "INSERT INTO jobs (user_id, automation_id, status, input_data, started_at) VALUES (?, ?, 'queued', ?, CURRENT_TIMESTAMP)"
    ).bind(userId, automation.id, jobInputData).run();
    const jobId = Number(jobResult.meta.last_row_id);

    if (executionMode === "local") {
      const rule = getScheduleRule(config);
      if (rule && automation.status === "active") {
        await env.DB.prepare(
          "UPDATE automations SET schedule = ?, next_run = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(rule.label, automation.id).run();
      }

      return {
        success: true,
        jobId,
        githubRunId: null,
        executionMode: "local",
        message: "Image render queued for the local runner.",
      };
    }

    const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
    if (!githubSettings) {
      const error = "GitHub settings not configured. Go to Settings -> GitHub Runner";
      await failExistingAutomationJob(env, jobId, error, "dispatch.github_settings", { execution_mode: executionMode });
      return { success: false, jobId, executionMode, error };
    }

    const workflow = buildWorkflowDispatch(automation, jobId, imageJobConfig);
    workflow.inputs.runtime_config_token = await buildWorkflowRuntimeConfigToken(jobId, githubSettings.pat_token);
    workflow.inputs.runner_labels = serializeRunnerLabels(githubSettings.runner_labels);
    const dispatchResult = await dispatchWorkflow(githubSettings, workflow.inputs, workflow.workflowName);

    if (!dispatchResult.success) {
      const error = dispatchResult.error || "Workflow dispatch failed";
      await failExistingAutomationJob(env, jobId, error, "dispatch.github_api", {
        workflow: workflow.workflowName,
        dispatch_status: dispatchResult.dispatchStatus,
        payload_bytes: dispatchResult.payloadBytes,
        dispatch_nonce: dispatchResult.dispatchNonce,
      });

      return { success: false, jobId, executionMode, error };
    }

    await env.DB.prepare(
      "UPDATE jobs SET status = 'running', github_run_id = ?, github_run_url = ?, logs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(
      dispatchResult.runId,
      dispatchResult.runUrl,
      dispatchResult.warning ? JSON.stringify([{ at: new Date().toISOString(), stage: "dispatch.run_lookup", level: "warning", message: dispatchResult.warning, dispatch_nonce: dispatchResult.dispatchNonce }]) : null,
      jobId
    ).run();

    const rule = getScheduleRule(config);
    if (rule && automation.status === "active") {
      await env.DB.prepare(
        "UPDATE automations SET schedule = ?, next_run = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(rule.label, automation.id).run();
    }

    return {
      success: true,
      jobId,
      githubRunId: dispatchResult.runId,
      executionMode: "github",
      message: "Image render dispatched to GitHub Actions.",
    };
  }

  const promptSource = resolvePromptModeSource(config, executionMode);
  if (promptSource.error) {
    const jobId = await createFailedAutomationJob(env, automation, userId, config, promptSource.error, "preflight.prompt_source", {
      short_generation_mode: readString(config.short_generation_mode, "normal"),
      prompt_source_type: readString(config.prompt_source_type),
      execution_mode: executionMode,
    });
    return { success: false, jobId: jobId || undefined, executionMode, error: promptSource.error };
  }

  const requestedVideoSource = promptSource.videoSource || readString(config.video_source);
  const recoveredSource = recoverSourceMismatch(config, requestedVideoSource, promptSource);
  const videoSource = recoveredSource.videoSource;
  const singleSourceOverride = recoveredSource.singleSourceOverride;
  if (recoveredSource.reason) {
    console.warn(`[TRIGGER] Source mismatch recovered: ${requestedVideoSource || "<empty>"} -> ${videoSource} (${recoveredSource.reason})`);
  }
  const localFolderPath = readString(config.local_folder_path);
  const videosPerRun = parsePositiveInteger(config.videos_per_run) ?? 1;
  let videoUrls: string[] = [];
  let videoCaptions: string[] = [];
  let ghazalTimestamps: any[] = [];
  let fetchStats = { total: 0, unprocessed: 0, to_process: 0, processed_already: 0 };

  if (videoSource === "local_folder" && executionMode === "github") {
    const error = "Local folder source is only available for local runner users.";
    const jobId = await createFailedAutomationJob(env, automation, userId, config, error, "preflight.video_source", { video_source: videoSource, execution_mode: executionMode });
    return { success: false, jobId: jobId || undefined, executionMode, error };
  }

  if (videoSource === "local_folder" && !localFolderPath) {
    const error = "Local folder path is required.";
    const jobId = await createFailedAutomationJob(env, automation, userId, config, error, "preflight.video_source", { video_source: videoSource });
    return { success: false, jobId: jobId || undefined, executionMode, error };
  }

  const videoSourceSettings = await getScopedSettings<VideoSourceSettings>(env.DB, "video-sources", userId);
  const youtubeCookiesConfigured = Boolean(readString(videoSourceSettings?.youtube_cookies).trim());
  const isYoutubeSource =
    videoSource === "youtube" ||
    videoSource === "youtube_channel" ||
    (readString(config.short_generation_mode, "normal") === "prompt" && readString(config.prompt_source_type) === "youtube");

  // YouTube + GitHub runner + cookies warning (non-blocking)
  // The 5-layer fallback (yt-dlp → InnerTube API → Playwright) can handle
  // public YouTube videos without cookies even on GitHub runners.
  // Cookies are passed as best-effort; they may not work due to IP binding.
  if (executionMode === "github" && isYoutubeSource && youtubeCookiesConfigured) {
    console.warn(
      "[WARN] YouTube cookies configured but running on GitHub runner — " +
      "cookies may not work due to IP binding. The 5-layer fallback chain will " +
      "attempt download via InnerTube API / Playwright if cookies fail."
    );
  }

  // Handle video sources based on type
  switch (videoSource) {
    case "manual_links": {
      const raw = readString(config.manual_links);
      if (raw) {
        videoUrls = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
        console.log(`[TRIGGER] manual_links: ${videoUrls.length} URLs`);
        fetchStats = { total: videoUrls.length, unprocessed: videoUrls.length, to_process: Math.min(videoUrls.length, videosPerRun), processed_already: 0 };
      }
      break;
    }

    case "direct":
    case "youtube": {
      const raw = singleSourceOverride || (readString(config.short_generation_mode, "normal") === "prompt"
        ? promptSource.singleSource
        : readString(config.video_url));
      if (raw) {
        videoUrls = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
        if (videoUrls.length === 0 && raw.trim().startsWith("http")) videoUrls = [raw.trim()];
        console.log(`[TRIGGER] ${videoSource}: ${videoUrls.length} URLs`);
        fetchStats = { total: videoUrls.length, unprocessed: videoUrls.length, to_process: Math.min(videoUrls.length, videosPerRun), processed_already: 0 };
      }
      break;
    }

    case "prompt_local_file": {
      if (promptSource.singleSource) {
        videoUrls = [promptSource.singleSource];
        console.log(`[TRIGGER] prompt_local_file: ${promptSource.singleSource}`);
        fetchStats = { total: 1, unprocessed: 1, to_process: 1, processed_already: 0 };
      }
      break;
    }

    case "local_file": {
      const raw = readString(config.source_value);
      if (raw) {
        videoUrls = [raw];
        console.log(`[TRIGGER] local_file: ${raw}`);
        fetchStats = { total: 1, unprocessed: 1, to_process: 1, processed_already: 0 };
      }
      break;
    }

    case "youtube_channel": {
      const channelUrl = readString(config.youtube_channel_url);
      if (channelUrl) {
        console.log(`[TRIGGER] youtube_channel: ${channelUrl}`);
        const preFetched = readString(config.video_url);
        if (preFetched) {
          videoUrls = preFetched.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
        }
        fetchStats = { total: videoUrls.length, unprocessed: videoUrls.length, to_process: Math.min(videoUrls.length, videosPerRun), processed_already: 0 };
      } else {
        console.log(`[TRIGGER] youtube_channel: No channel URL configured`);
      }
      break;
    }

    case "google_photos": {
      const googleSource = getGooglePhotosSourceUrls(config);
      if (googleSource.text) {
        const shareLinks = splitHttpLines(googleSource.text).filter(isGooglePhotosUrl);
        videoUrls = shareLinks;
        console.log(`[TRIGGER] google_photos: queued ${shareLinks.length} source URL(s) for runner-side resolution${googleSource.migratedFromAlbumUrl ? " (migrated from legacy google_photos_album_url)" : ""}`);
        fetchStats = { total: shareLinks.length, unprocessed: shareLinks.length, to_process: Math.min(shareLinks.length, videosPerRun), processed_already: 0 };
      } else {
        const preFetched = normalizeHttpUrlText(config.video_url);
        if (preFetched) {
          videoUrls = splitHttpLines(preFetched).filter((url) => url.startsWith("http"));
          fetchStats = { total: videoUrls.length, unprocessed: videoUrls.length, to_process: Math.min(videoUrls.length, videosPerRun), processed_already: 0 };
        }
      }
      break;
    }

    case "local_folder": {
      console.log(`[TRIGGER] local_folder: ${localFolderPath}`);
      fetchStats = { total: 0, unprocessed: 0, to_process: videosPerRun, processed_already: 0 };
      break;
    }

    default: {
      const raw = readString(config.video_url);
      if (raw) {
        videoUrls = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
        if (videoUrls.length === 0 && raw.trim().startsWith("http")) videoUrls = [raw.trim()];
        console.log(`[TRIGGER] default (${videoSource}): ${videoUrls.length} URLs`);
        fetchStats = { total: videoUrls.length, unprocessed: videoUrls.length, to_process: Math.min(videoUrls.length, videosPerRun), processed_already: 0 };
      }
      break;
    }
  }

  // Apply ShortsPerSource settings
  const shortsMode = readString(config.source_shorts_mode) || "single";
  const shortsMaxCount = parsePositiveInteger(config.source_shorts_max_count) ?? 3;
  const targetDuration = parsePositiveInteger(config.short_duration) ?? 60;
  const promptPlanOverride = buildPromptPlanOverrides(config);
  console.log(`[TRIGGER] Shorts mode: ${shortsMode}, max count: ${shortsMaxCount}, target duration: ${targetDuration}s`);

  // Calculate segment info for multi-short extraction
  let segmentInfo = null;
  if (promptPlanOverride.segmentInfo) {
    segmentInfo = promptPlanOverride.segmentInfo;
    const promptSegmentCount = Array.isArray(asRecord(segmentInfo).segments) ? (asRecord(segmentInfo).segments as unknown[]).length : 0;
    console.log(`[TRIGGER] Using prompt-driven segment plan with ${promptSegmentCount} segment(s)`);
    console.log(`[TRIGGER] segment_info created:`, JSON.stringify(segmentInfo));
  } else if (shortsMode === "fixed_count" && shortsMaxCount > 1) {
    segmentInfo = {
      mode: "fixed_count",
      segmentCount: shortsMaxCount,
      segmentDuration: targetDuration,
    };
    console.log(`[TRIGGER] Will split videos into ${shortsMaxCount} segments of ~${targetDuration}s each`);
    console.log(`[TRIGGER] segment_info created:`, JSON.stringify(segmentInfo));
  } else if (shortsMode === "duration_based") {
    const estimatedSegments = Math.max(1, Math.ceil(targetDuration / 10));
    segmentInfo = {
      mode: "duration_based",
      segmentCount: Math.min(estimatedSegments, 20),
      segmentDuration: targetDuration,
    };
    console.log(`[TRIGGER] Will extract ~${segmentInfo.segmentCount} segments for ${targetDuration}s target`);
    console.log(`[TRIGGER] segment_info created:`, JSON.stringify(segmentInfo));
  } else {
    console.log(`[TRIGGER] Shorts mode: ${shortsMode}, shortsMaxCount: ${shortsMaxCount} - NOT creating segment_info`);
  }

  // Filter out already processed videos (for supported sources)
  if (["manual_links", "direct", "youtube", "ftp", "youtube_channel", "google_photos", "prompt_local_file", "local_file"].includes(videoSource || "")) {
    const rotationEnabled = config.rotation_enabled !== false;
    const rotationShuffle = config.rotation_shuffle === true;
    const rotationAutoReset = config.rotation_auto_reset === true;
    const allUrls = [...videoUrls];
    let pendingUrls = [...allUrls];

    if (rotationEnabled) {
      const processedSet = await getProcessedSourceUrls(env, automation.id, userId);
      pendingUrls = allUrls.filter((url) => !processedSet.has(url));

      if (pendingUrls.length === 0 && allUrls.length > 0 && rotationAutoReset) {
        await env.DB.prepare(
          "UPDATE automations SET rotation_reset_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
        ).bind(automation.id, userId).run();
        await env.DB.prepare(
          "DELETE FROM processed_videos WHERE automation_id = ? AND user_id = ?"
        ).bind(automation.id, userId).run();
        pendingUrls = [...allUrls];
        fetchStats.processed_already = 0;
        console.log("[TRIGGER] Rotation auto-reset cleared processed video history");
      } else {
        fetchStats.processed_already = allUrls.length - pendingUrls.length;
      }
    } else {
      fetchStats.processed_already = 0;
    }

    if (rotationShuffle) {
      pendingUrls = shuffleArray(pendingUrls);
      console.log("[TRIGGER] Rotation shuffle applied to source queue");
    }

    fetchStats.unprocessed = pendingUrls.length;
    fetchStats.to_process = Math.min(pendingUrls.length, videosPerRun);
    videoUrls = pendingUrls.slice(0, videosPerRun);
    console.log(`[TRIGGER] Queue: ${fetchStats.processed_already} processed, ${fetchStats.unprocessed} remaining, sending ${videoUrls.length}`);
  }

  // Best-effort ytdown.to extraction for YouTube URLs at dispatch time
  // Runner will use this pre-extracted download URL via curl, bypassing the unreliable 5-layer chain
  let ytDownloadUrl: string | null = null;
  let ytDownloadUrlExpiresAt: number | null = null;
  let ytDownloadMapped: Record<string, string> | undefined;
  let firstVideoTitle: string | undefined;
  if ((videoSource === "youtube" || videoSource === "youtube_channel") && videoUrls.length > 0) {
    const mapped: Record<string, string> = {};
    for (const ytUrl of videoUrls) {
      try {
        console.log(`[TRIGGER] Extracting download URL via ytdown.to for ${ytUrl.substring(0, 60)}...`);
        const ytdownResult = await extractYoutubeDownloadUrl(ytUrl);
        if (ytdownResult.verified) {
          mapped[ytUrl] = ytdownResult.downloadUrl;
          if (!ytDownloadUrl) {
            ytDownloadUrl = ytdownResult.downloadUrl;
            ytDownloadUrlExpiresAt = ytdownResult.expiresAt;
            firstVideoTitle = ytdownResult.title;
            console.log(`[TRIGGER] ytdown.to: extracted verified download URL for ${ytUrl.substring(0, 50)} (expires at ${ytdownResult.expiresAt})`);
          }
        } else {
          console.log(`[TRIGGER] ytdown.to: extracted URL for ${ytUrl.substring(0, 50)} but verification failed — runner will use fallback`);
          mapped[ytUrl] = ytdownResult.downloadUrl;
        }
        if (!firstVideoTitle) {
          firstVideoTitle = ytdownResult.title;
        }
      } catch (ytdownErr) {
        console.log(`[TRIGGER] ytdown.to extraction failed for ${ytUrl.substring(0, 50)}: ${ytdownErr instanceof Error ? ytdownErr.message : String(ytdownErr)}`);
      }
    }
    if (Object.keys(mapped).length > 0) {
      ytDownloadMapped = mapped;
    }
  }

  // ── Auto Content from Video Title ──────────────────────────────────────
  // When use_video_title_for_content is true, generate AI content using the
  // extracted YouTube video title, overriding social tab content.
  let generatedTitles: string[] | undefined;
  let generatedDescriptions: string[] | undefined;
  let generatedHashtags: string[] | undefined;
  if (config.use_video_title_for_content && firstVideoTitle) {
    try {
      console.log(`[TRIGGER] use_video_title_for_content enabled — generating AI content from video title: "${firstVideoTitle.substring(0, 80)}"`);
      const aiSettings = await getScopedSettings<AISettings>(env.DB, "ai", userId);
      if (aiSettings) {
        const provider = String(config.social_ai_provider || aiSettings.default_provider || "gemini");
        const model = String(config.social_ai_model || "");
        const platform = String(config.social_platform || "youtube");
        const count = Math.min(Math.max(Number(config.social_count || 10), 1), 50);
        const messages = getSocialMessages({
          topic: firstVideoTitle,
          platform,
          count,
          focusKeyword: undefined,
          brief: undefined,
        });
        const raw = await generateAiJson(aiSettings, provider as any, model, messages);
        const normalized = normalizeSocialResult(raw, count, platform);
        generatedTitles = normalized.titles;
        generatedDescriptions = normalized.descriptions;
        generatedHashtags = normalized.hashtags;
        console.log(`[TRIGGER] AI generated ${generatedTitles.length} titles, ${generatedDescriptions.length} descriptions, ${generatedHashtags.length} hashtags from video title`);
      } else {
        console.log(`[TRIGGER] No AI settings found — cannot generate content from video title`);
      }
    } catch (aiErr) {
      console.log(`[TRIGGER] AI content generation failed: ${aiErr instanceof Error ? aiErr.message : String(aiErr)}`);
    }
  }

  // Add config for job
  const jobConfig = {
    ...config,
    ...promptPlanOverride.metadata,
    video_source: videoSource,
    ...(videoSource === "youtube" || videoSource === "direct" ? { video_url: (singleSourceOverride || promptSource.singleSource || readString(config.video_url)).trim() } : {}),
    video_urls: videoUrls.map((url) => url.trim()),
    source_urls: videoUrls.map((url) => url.trim()),
    fetch_stats: fetchStats,
    segment_info: segmentInfo,
    ...(videoSource === "youtube" || videoSource === "youtube_channel"
      ? {
          youtube_cookies: readString(videoSourceSettings?.youtube_cookies).trim(),
          youtube_cookies_meta: videoSourceSettings?.youtube_cookies_meta || null,
          cookie_synced_at: new Date().toISOString(),
        }
      : {}),
    ...(videoSource === "google_photos"
      ? {
          google_photos_cookies: readString(videoSourceSettings?.google_photos_cookies).trim(),
          google_photos_links: getGooglePhotosSourceUrls(config).text,
          google_photos_migrated_from_album_url: getGooglePhotosSourceUrls(config).migratedFromAlbumUrl,
        }
      : {}),
    source_detection: {
      requested_video_source: requestedVideoSource,
      effective_video_source: videoSource,
      recovery_reason: recoveredSource.reason,
      prompt_source_type: readString(config.prompt_source_type),
      short_generation_mode: readString(config.short_generation_mode, "normal"),
    },
    ...(ytDownloadUrl
      ? {
          yt_download_url: ytDownloadUrl,
          yt_download_url_expires_at: ytDownloadUrlExpiresAt,
        }
      : {}),
    ...(ytDownloadMapped
      ? {
          yt_download_url_mapped: ytDownloadMapped,
        }
      : {}),
    processed_source_urls: (videoSource === "youtube_channel" || videoSource === "youtube")
      ? Array.from(await getProcessedSourceUrls(env, automation.id, userId))
      : [],
    whisper_enabled: readString(config.whisper_enabled) === "true",
    whisper_language: readString(config.whisper_language, "en"),
    caption_font_size: readString(config.caption_font_size, "medium"),
    caption_text_color: readString(config.caption_text_color, "#FFFFFF"),
    caption_bg_opacity: readString(config.caption_bg_opacity, "0.5"),
    caption_position: readString(config.caption_position, "bottom"),
    execution_mode: executionMode,
    ...(generatedTitles ? { titles: generatedTitles } : {}),
    ...(generatedDescriptions ? { descriptions: generatedDescriptions } : {}),
    ...(generatedHashtags ? { hashtags: generatedHashtags } : {}),
  };

  // Validate: If no videos found, return error
  if (videoSource !== "local_folder" && videoUrls.length === 0) {
    const errorMsg = fetchStats.processed_already > 0 && fetchStats.total > 0
      ? `All ${fetchStats.total} videos already processed`
      : ({
          "manual_links": "No valid video URLs found in manual_links",
          "direct": "No valid video URLs found in direct URLs",
          "youtube": "No valid YouTube URLs found",
          "youtube_channel": "No videos found for YouTube channel",
          "google_photos": "No valid Google Photos source URLs found",
          "prompt_local_file": "No valid local file selected for Short with Prompt",
        } as Record<string, string>)[videoSource || ""] || "No video URL provided";

    const jobId = await createFailedAutomationJob(env, automation, userId, jobConfig, errorMsg, "preflight.no_source_videos", {
      requested_video_source: requestedVideoSource,
      effective_video_source: videoSource,
      recovery_reason: recoveredSource.reason,
      fetch_stats: fetchStats,
      short_generation_mode: readString(config.short_generation_mode, "normal"),
      prompt_source_type: readString(config.prompt_source_type),
      google_photos_links_count: splitHttpLines(config.google_photos_links).length,
      google_photos_album_url_count: splitHttpLines(config.google_photos_album_url).length,
    });
    return { success: false, jobId: jobId || undefined, executionMode, error: errorMsg };
  }

  // ── GitHub trigger ───────────────────────────────────────────────────
  const jobInputData = JSON.stringify(jobConfig);
  const jobResult = await env.DB.prepare(
    "INSERT INTO jobs (user_id, automation_id, status, input_data, started_at) VALUES (?, ?, 'queued', ?, CURRENT_TIMESTAMP)"
  ).bind(userId, automation.id, jobInputData).run();
  const jobId = Number(jobResult.meta.last_row_id);

  if (executionMode === "local") {
    const rule = getScheduleRule(config);
    if (rule && automation.status === "active") {
      await env.DB.prepare(
        "UPDATE automations SET schedule = ?, next_run = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(rule.label, automation.id).run();
    }

    return {
      success: true,
      jobId,
      githubRunId: null,
      executionMode: "local",
    };
  }

  const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", userId);
  if (!githubSettings) {
    const error = "GitHub settings not configured. Go to Settings -> GitHub Runner";
    await failExistingAutomationJob(env, jobId, error, "dispatch.github_settings", { execution_mode: executionMode });
    return { success: false, jobId, executionMode, error };
  }

  const workflow = buildWorkflowDispatch(automation, jobId, jobConfig);
  workflow.inputs.runtime_config_token = await buildWorkflowRuntimeConfigToken(jobId, githubSettings.pat_token);
  workflow.inputs.runner_labels = serializeRunnerLabels(githubSettings.runner_labels);

  const workflowInputsForLog = {
    ...workflow.inputs,
    ...(workflow.inputs.runtime_config_token ? { runtime_config_token: "[redacted]" } : {}),
  };
  console.log("[triggerAutomationRun] Dispatching workflow:", workflow.workflowName, "with inputs:", JSON.stringify(workflowInputsForLog).substring(0, 200));
  const dispatchResult = await dispatchWorkflow(githubSettings, workflow.inputs, workflow.workflowName);
  console.log("[triggerAutomationRun] Dispatch result:", JSON.stringify(dispatchResult));

  if (!dispatchResult.success) {
    const error = dispatchResult.error || "Workflow dispatch failed";
    await failExistingAutomationJob(env, jobId, error, "dispatch.github_api", {
      workflow: workflow.workflowName,
      dispatch_status: dispatchResult.dispatchStatus,
      payload_bytes: dispatchResult.payloadBytes,
      dispatch_nonce: dispatchResult.dispatchNonce,
    });

    return { success: false, jobId, executionMode, error };
  }

  await env.DB.prepare(
    "UPDATE jobs SET status = 'running', github_run_id = ?, github_run_url = ?, logs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(
    dispatchResult.runId,
    dispatchResult.runUrl,
    dispatchResult.warning ? JSON.stringify([{ at: new Date().toISOString(), stage: "dispatch.run_lookup", level: "warning", message: dispatchResult.warning, dispatch_nonce: dispatchResult.dispatchNonce }]) : null,
    jobId
  ).run();

  const rule = getScheduleRule(config);
  if (rule && automation.status === "active") {
    await env.DB.prepare(
      "UPDATE automations SET schedule = ?, next_run = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(rule.label, automation.id).run();
  }

  return {
    success: true,
    jobId,
    githubRunId: dispatchResult.runId,
    executionMode: "github",
  };
}

export async function markAutomationRunCompleted(env: Env, jobId: number, completedAt: Date): Promise<void> {
  const automation = await env.DB.prepare(
    "SELECT a.* FROM automations a INNER JOIN jobs j ON j.automation_id = a.id WHERE j.id = ?"
  ).bind(jobId).first<Automation>();

  if (!automation?.id) {
    return;
  }

  const completedAtText = formatDatabaseDate(completedAt);

  // Get config
  let config: Record<string, unknown>;
  try {
    config = parseAutomationConfig(automation.config);
  } catch {
    config = {};
  }

  const jobRecord = await env.DB.prepare(
    "SELECT status, input_data, output_data FROM jobs WHERE id = ?"
  ).bind(jobId).first<{ status: string; input_data: string | null; output_data: string | null }>();

  if (jobRecord?.status === "success") {
    const outputData = parseJsonRecord(jobRecord.output_data);
    const contentCursorNext = outputData.content_cursor_next;

    if (automation.type === "image") {
      const inputData = parseJsonRecord(jobRecord.input_data);
      const nextRotationState = asRecord(inputData.rotation_state_next);

      if (Object.keys(nextRotationState).length > 0) {
        config = {
          ...config,
          rotation_state: {
            source_cursor: normalizeCursorValue(nextRotationState.source_cursor),
            branding_cursor: normalizeCursorValue(nextRotationState.branding_cursor),
            branding_image_cursor: normalizeCursorValue(nextRotationState.branding_image_cursor),
            content_cursor: normalizeCursorValue(nextRotationState.content_cursor),
            post_content_cursor: normalizeCursorValue(nextRotationState.post_content_cursor),
          },
        };
      }
    }

    // Persist post_content_cursor for video automations (Issue 1 fix)
    // Runner sends content_cursor_next in post_result.json → webhook output_data
    if (contentCursorNext !== undefined && contentCursorNext !== null && automation.type !== "image") {
      const cursorValue = normalizeCursorValue(contentCursorNext);
      const existingRotationState = (config.rotation_state && typeof config.rotation_state === "object" && !Array.isArray(config.rotation_state))
        ? config.rotation_state as Record<string, unknown>
        : {};
      config = {
        ...config,
        rotation_state: {
          ...existingRotationState,
          post_content_cursor: cursorValue,
        },
      };
    }
  }

  const nextConfigText = JSON.stringify(config);

  const source = resolveConfiguredVideoSourceForStatus(config).videoSource || readString(config.video_source);
  const rule = getScheduleRule(config);

  // Check if all titles are used for image automation — mark completed
  if (automation.type === "image" && jobRecord?.status === "success") {
    const inputData = parseJsonRecord(jobRecord.input_data);
    const nextRotationState = asRecord(inputData.rotation_state_next);
    if (nextRotationState.all_titles_used === true) {
      const completedAtText = formatDatabaseDate(completedAt);
      await env.DB.prepare(
        "UPDATE automations SET config = ?, status = 'completed', last_run = ?, next_run = NULL, schedule = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(nextConfigText, completedAtText, "All titles used", automation.id).run();
      return;
    }
  }

  // If there's a schedule (daily, weekly) → always keep automation active with next_run
  if (rule) {
    const { schedule, nextRun } = await getSchedulePersistenceValues(
      env,
      nextConfigText,
      automation.status,
      completedAtText,
      automation.id
    );
    await env.DB.prepare(
      "UPDATE automations SET config = ?, status = 'active', schedule = ?, last_run = ?, next_run = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(nextConfigText, schedule, completedAtText, nextRun, automation.id).run();
    return;
  }

  // No schedule: Check all_links_processed from runner webhook for multi-link sources
  const finiteSources = ["manual_links", "direct", "youtube", "ftp", "youtube_channel", "google_photos", "local_folder", "prompt_local_file"];
  if (finiteSources.includes(source || "") && !rule) {
    const job = jobRecord || await env.DB.prepare(
      "SELECT status, input_data, output_data FROM jobs WHERE id = ?"
    ).bind(jobId).first<{ status: string; input_data: string | null; output_data: string | null }>();
    let allLinksProcessed = false;
    let completionLabel = source === "local_folder" ? "All local folder videos processed" : "All links completed";
    if (job?.output_data) {
      try {
        const outputData = JSON.parse(job.output_data) as Record<string, unknown>;
        allLinksProcessed =
          outputData.all_links_processed === true ||
          outputData.all_source_videos_processed === true;
        if (typeof outputData.completion_label === "string" && outputData.completion_label.trim()) {
          completionLabel = outputData.completion_label.trim();
        }
      } catch {
        // ignore parse error
      }
    }

    if (allLinksProcessed) {
      // All links processed, no schedule → mark completed
      await env.DB.prepare(
        "UPDATE automations SET config = ?, status = 'completed', last_run = ?, next_run = NULL, schedule = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(nextConfigText, completedAtText, completionLabel, automation.id).run();
    } else {
      // Some links remain — explicitly set active so user can trigger next run
      await env.DB.prepare(
        "UPDATE automations SET config = ?, status = 'active', last_run = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(nextConfigText, completedAtText, automation.id).run();
    }
    return;
  }

  // Fallback: update last_run and ensure status is active
  await env.DB.prepare(
    "UPDATE automations SET config = ?, status = 'active', last_run = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(nextConfigText, completedAtText, automation.id).run();
}

export async function backfillScheduledAutomations(env: Env, userId?: number): Promise<void> {
  const automations = await env.DB.prepare(
    userId
      ? "SELECT * FROM automations WHERE user_id = ? AND status = 'active' AND next_run IS NULL"
      : "SELECT * FROM automations WHERE status = 'active' AND next_run IS NULL"
  ).bind(...(userId ? [userId] : [])).all<Automation>();

  for (const automation of automations.results || []) {
    if (!automation.id) {
      continue;
    }

    let config: Record<string, unknown>;
    try {
      config = parseAutomationConfig(automation.config);
    } catch {
      continue;
    }

    const rule = getScheduleRule(config);
    if (!rule) {
      if (automation.schedule) {
        await env.DB.prepare(
          "UPDATE automations SET schedule = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(automation.id).run();
      }
      continue;
    }

    if (await hasInProgressJob(env, automation.id)) {
      await env.DB.prepare(
        "UPDATE automations SET schedule = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(rule.label, automation.id).run();
      continue;
    }

    const { schedule, nextRun } = await getSchedulePersistenceValues(
      env,
      automation.config,
      automation.status,
      automation.last_run,
      automation.id
    );

    await env.DB.prepare(
      "UPDATE automations SET schedule = ?, next_run = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(schedule, nextRun, automation.id).run();
  }
}

export async function processDueAutomations(env: Env): Promise<void> {
  await backfillScheduledAutomations(env);

  const dueAutomations = await env.DB.prepare(
    "SELECT * FROM automations WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= CURRENT_TIMESTAMP ORDER BY next_run ASC LIMIT 20"
  ).all<Automation>();

  for (const automation of dueAutomations.results || []) {
    if (!automation.id) {
      continue;
    }

    const result = await triggerAutomationRun(env, automation, automation.user_id as number);
    if (!result.success) {
      if (result.inProgress) {
        await env.DB.prepare(
          "UPDATE automations SET next_run = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(automation.id).run();
      }
      console.error(`Scheduled automation ${automation.id} failed`, result.error || "Unknown error");
    }
  }
}

export async function processPendingUploads(env: Env): Promise<void> {
  // Get pending uploads
  const pendingUploads = await env.DB.prepare(
    `SELECT vu.id as upload_id, vu.job_id, vu.media_url, j.automation_id, j.user_id, a.config, j.input_data AS job_input_data, j.output_data AS job_output_data
     FROM video_uploads vu
     INNER JOIN jobs j ON j.id = vu.job_id
     INNER JOIN automations a ON a.id = j.automation_id
     WHERE vu.upload_status = 'uploaded' AND vu.post_status = 'pending'
     ORDER BY vu.created_at ASC
     LIMIT 20`
  ).all<{
    upload_id: number;
    job_id: number;
    media_url: string;
    automation_id: number;
    config: string;
    user_id: number;
    job_input_data: string | null;
    job_output_data: string | null;
  }>();

  if (!pendingUploads.results?.length) {
    return;
  }

  // Get PostForMe settings
  for (const upload of pendingUploads.results) {
    try {
      const postformeSettings = await getScopedSettings<PostformeSettings>(env.DB, "postforme", upload.user_id);
      if (!postformeSettings?.api_key) {
        // No API key configured. Mark as failed because "skipped" is not a valid DB enum.
        await env.DB.prepare(
          "UPDATE video_uploads SET post_status = 'failed', error_message = 'Postforme API key not configured', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(upload.upload_id).run();
        continue;
      }

      // Parse automation config
      let config: Record<string, unknown>;
      try {
        config = {
          ...parseJsonRecord(upload.config),
          ...parseJsonRecord(upload.job_input_data),
        };
      } catch {
        config = {};
      }

      const rotationState = config.rotation_state && typeof config.rotation_state === "object" && !Array.isArray(config.rotation_state)
        ? config.rotation_state as Record<string, unknown>
        : {};
      const postContentCursor = typeof rotationState.post_content_cursor === "number" && rotationState.post_content_cursor >= 0
        ? rotationState.post_content_cursor
        : 0;

      const autoPublish = config.auto_publish === true;
      const publishMode = config.publish_mode as string || "immediate";
      const socialAccounts = Array.isArray(config.postforme_account_ids) ? config.postforme_account_ids : [];
      // Handle custom delay or regular delay
      let delayMinutes = parsePositiveInteger(config.delay_minutes) || 60;
      if (config.delay_minutes === "custom" && config.delay_minutes_custom) {
        delayMinutes = Math.min(1440, Math.max(1, parsePositiveInteger(config.delay_minutes_custom) || 60));
      }
      const staggerMinutes = parsePositiveInteger(config.post_stagger_minutes) || 15;
      const accountStaggerEnabled = config.postforme_account_stagger_enabled === true;
      const scheduleDate = config.schedule_date as string || "";
      const scheduleTime = config.schedule_time as string || "";
      const content = buildPostformeContentSelection(config, socialAccounts, postformeSettings.saved_accounts, postContentCursor);
      const caption = content.caption;

      const titles = Array.isArray(config.titles) ? config.titles.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
      const descriptions = Array.isArray(config.descriptions) ? config.descriptions.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
      const maxContentCount = Math.max(titles.length, descriptions.length, 1);
      const allTitlesUsedForPosting = content.nextPostContentCursor >= maxContentCount;

      const mediaUrls = getUploadMediaUrls(upload);
      if (mediaUrls.length === 0 || mediaUrls.some((url) => !url.startsWith("https://"))) {
        console.error(`Invalid media URLs for upload ${upload.upload_id}`);
        continue;
      }
      const mediaUrl = mediaUrls[0];

      // Create draft post (always) for review queue
      const draftPost = await createPostformePost(
        postformeSettings.api_key, mediaUrls, caption, [], null, true
      );
      const draftPostId = draftPost?.id || draftPost?.data?.id;

      // Try to update job with draft_post_id (may fail if column doesn't exist)
      try {
        await env.DB.prepare(
          "UPDATE jobs SET draft_post_id = ? WHERE id = ?"
        ).bind(draftPostId, upload.job_id).run();
      } catch (e) {
        console.log(`[DB] Could not update jobs draft_post_id: ${e}`);
      }

      // Update video_uploads with postforme_id and post_status
      try {
        await env.DB.prepare(
          "UPDATE video_uploads SET postforme_id = ?, post_status = 'posted', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(draftPostId, upload.upload_id).run();
      } catch (e) {
        // Fallback for missing draft_post_id column
        console.log(`[DB] Trying update without draft_post_id: ${e}`);
        await env.DB.prepare(
          "UPDATE video_uploads SET postforme_id = ?, post_status = 'posted', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(draftPostId, upload.upload_id).run();
      }

      // Persist post_content_cursor to automation config
      const updatedRotationState = {
        ...rotationState,
        post_content_cursor: content.nextPostContentCursor,
      };
      const updatedConfig = {
        ...config,
        rotation_state: updatedRotationState,
      };
      await env.DB.prepare(
        "UPDATE automations SET config = ? WHERE id = ?"
      ).bind(JSON.stringify(updatedConfig), upload.automation_id).run();

      // Check if all titles used for posting — mark automation completed
      if (allTitlesUsedForPosting) {
        await env.DB.prepare(
          "UPDATE automations SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(upload.automation_id).run();
      }

      // If auto_publish enabled, create live post
      if (autoPublish && socialAccounts.length > 0) {
        let scheduledAt: string | null = null;
        let postStatus = "posted";
        
        // Handle different scheduling modes
        if (publishMode === "scheduled" && scheduleDate && scheduleTime) {
          // Specific date/time scheduling
          scheduledAt = new Date(`${scheduleDate}T${scheduleTime}:00`).toISOString();
          postStatus = "scheduled";
        } else if (publishMode === "delay") {
          // Delay after processing
          const delayMs = delayMinutes * 60 * 1000;
          const delayDate = new Date(Date.now() + delayMs);
          scheduledAt = delayDate.toISOString();
          postStatus = "scheduled";
          console.log(`[POST] Scheduling ${delayMinutes} minutes from now: ${scheduledAt}`);
        } else if (publishMode === "stagger" && socialAccounts.length > 1) {
          // Stagger multiple posts (handled below per account)
          const delayMs = staggerMinutes * 60 * 1000;
          const delayDate = new Date(Date.now() + delayMs);
          scheduledAt = delayDate.toISOString();
          postStatus = "scheduled";
          console.log(`[POST] Staggered scheduling: ${staggerMinutes} min between posts`);
        }
        
        // Handle stagger mode - create separate posts for each account with time gap
        if (publishMode === "stagger" && accountStaggerEnabled && socialAccounts.length > 1) {
          console.log(`[POST] Creating ${socialAccounts.length} staggered posts with ${staggerMinutes}min gap`);
          const scheduledAccountDetails: Array<{ id: string; scheduled_at: string; postforme_id: string | null }> = [];
          
          for (let i = 0; i < socialAccounts.length; i++) {
            const accountId = socialAccounts[i];
            const postScheduledAt = new Date(Date.now() + (i * staggerMinutes * 60 * 1000)).toISOString();
            
            const staggeredPost = await createPostformePost(
              postformeSettings.api_key,
              mediaUrls,
              caption,
              [accountId],
              postScheduledAt,
              false,
              content.platformConfigurations
            );
            const staggeredPostId = staggeredPost?.id || staggeredPost?.data?.id || null;
            scheduledAccountDetails.push({
              id: accountId,
              scheduled_at: postScheduledAt,
              postforme_id: staggeredPostId,
            });
            console.log(`[POST] Staggered post ${i + 1}/${socialAccounts.length} for account ${accountId} at ${postScheduledAt}`);
          }

          const storedMetadata = JSON.stringify(buildStoredPostMetadata({
            title: content.title,
            description: content.description,
            hashtags: content.hashtags,
            caption,
            top_tagline: content.topTagline,
            bottom_tagline: content.bottomTagline,
            schedule_mode: publishMode,
            scheduled_accounts: resolveScheduledAccounts(
              socialAccounts,
              postformeSettings.saved_accounts,
              scheduledAccountDetails.map((account) => ({
                platform: "",
                username: "",
                scheduled_at: account.scheduled_at,
                postforme_id: account.postforme_id,
              }))
            ),
            platform_configurations: content.platformConfigurationMetadata,
          }));
          
          // Update upload status as scheduled
          try {
            await env.DB.prepare(
              "UPDATE video_uploads SET post_status = 'scheduled', scheduled_at = ?, postforme_id = ?, post_metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
            ).bind(scheduledAt, scheduledAccountDetails[0]?.postforme_id || null, storedMetadata, upload.upload_id).run();
          } catch (e) {
            // Fallback
            console.log(`[DB] Scheduled update fallback: ${e}`);
            await env.DB.prepare(
              "UPDATE video_uploads SET post_status = 'scheduled', postforme_id = ?, post_metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
            ).bind(scheduledAccountDetails[0]?.postforme_id || null, storedMetadata, upload.upload_id).run();
          }
        } else if (socialAccounts.length > 0) {
          // Regular post (immediate or scheduled)
          const livePost = await createPostformePost(
            postformeSettings.api_key,
            mediaUrls,
            caption,
            socialAccounts,
            scheduledAt,
            false,
            content.platformConfigurations
          );
          const livePostId = livePost?.id || livePost?.data?.id;
          console.log(`Live post created: ${livePostId}, scheduled: ${scheduledAt}, status: ${postStatus}`);
          const storedMetadata = JSON.stringify(buildStoredPostMetadata({
            title: content.title,
            description: content.description,
            hashtags: content.hashtags,
            caption,
            top_tagline: content.topTagline,
            bottom_tagline: content.bottomTagline,
            schedule_mode: publishMode,
            scheduled_accounts: resolveScheduledAccounts(
              socialAccounts,
              postformeSettings.saved_accounts,
              socialAccounts.map(() => ({
                scheduled_at: scheduledAt,
                postforme_id: typeof livePostId === "string" ? livePostId : null,
              }))
            ),
            platform_configurations: content.platformConfigurationMetadata,
          }));
          
          // Update upload with correct status and scheduled time
          try {
            await env.DB.prepare(
              "UPDATE video_uploads SET postforme_id = ?, post_status = ?, scheduled_at = ?, post_metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
            ).bind(livePostId, postStatus, scheduledAt, storedMetadata, upload.upload_id).run();
          } catch (e) {
            // Fallback without scheduled_at if column missing
            console.log(`[DB] Trying update without scheduled_at: ${e}`);
            await env.DB.prepare(
              "UPDATE video_uploads SET postforme_id = ?, post_status = ?, post_metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
            ).bind(livePostId, postStatus, storedMetadata, upload.upload_id).run();
          }
        }
      }

    } catch (err) {
      console.error(`Failed to process upload ${upload.upload_id}:`, err);
      try {
        await env.DB.prepare(
          "UPDATE video_uploads SET post_status = 'failed', error_message = ? WHERE id = ?"
        ).bind(err instanceof Error ? err.message : "Unknown error", upload.upload_id).run();
      } catch (e2) {
        console.log(`[DB] Failed to update error status: ${e2}`);
      }
    }
  }
}

const POSTFORME_TITLE_PLATFORMS = new Set(["tiktok", "tiktok_business", "youtube"]);

function cleanPostformeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePostformeHashtags(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [];

  return items
    .map((item) => cleanPostformeText(item))
    .map((item) => {
      if (!item) {
        return "";
      }

      const normalized = item.replace(/\s+/g, "").replace(/^#+/, "");
      return normalized ? `#${normalized}` : "";
    })
    .filter((item, index, array) => Boolean(item) && array.indexOf(item) === index);
}

function pickRandomPostformeText(values: unknown): string {
  const items = Array.isArray(values) ? values.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  if (items.length === 0) {
    return "";
  }

  return items[Math.floor(Math.random() * items.length)].trim();
}

function ensureCaptionBranding(text: string, brandingUrl: string): string {
  const trimmed = text.trim();
  if (!brandingUrl) {
    return trimmed;
  }
  if (!trimmed) {
    return brandingUrl;
  }
  if (trimmed.includes(brandingUrl)) {
    return trimmed;
  }
  return `${trimmed}\n\n${brandingUrl}`;
}

function getSelectedPostformePlatforms(accountIds: string[], savedAccountsRaw: string | null | undefined): string[] {
  const savedAccounts = parseSavedPostformeAccounts(savedAccountsRaw);
  const platforms = accountIds
    .map((accountId) => savedAccounts.find((account) => account.id === accountId)?.platform || "")
    .filter(Boolean);

  return Array.from(new Set(platforms));
}

function sanitizeYoutubeTags(tags: string[]): string[] {
  const cleanTags = tags.map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
  let totalLen = 0;
  const result: string[] = [];
  for (const tag of cleanTags) {
    if (totalLen + tag.length + 1 > 500) break;
    result.push(tag);
    totalLen += tag.length + 1;
  }
  return result;
}

function buildPostformePlatformConfigurations(
  accountIds: string[],
  savedAccountsRaw: string | null | undefined,
  title: string,
  description?: string,
  hashtags?: string[]
): PostformeContentSelection["platformConfigurations"] {
  if (!title) {
    return {};
  }

  const platforms = getSelectedPostformePlatforms(accountIds, savedAccountsRaw);
  const tags = (Array.isArray(hashtags) ? hashtags : []).filter(Boolean);
  return platforms.reduce<PostformeContentSelection["platformConfigurations"]>((accumulator, platform) => {
    if (!POSTFORME_TITLE_PLATFORMS.has(platform)) {
      return accumulator;
    }

    const baseConfig: { title: string; tags?: string[] } = { title };
    if (tags.length > 0) {
      baseConfig.tags = tags;
    }

    if (platform === "youtube") {
      const ytConfig: YoutubePlatformConfig = {
        title,
        tags: tags.length > 0 ? sanitizeYoutubeTags(tags) : undefined,
        description: description || title,
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
        defaultLanguage: "en",
        categoryId: "22",
      };
      accumulator[platform] = ytConfig;
    } else {
      accumulator[platform] = baseConfig;
    }
    if (platform === "tiktok") {
      accumulator.tiktok_business = { title, tags };
    }
    return accumulator;
  }, {});
}

function buildPostformePlatformConfigurationMetadata(
  platformConfigurations: PostformeContentSelection["platformConfigurations"],
  caption: string
): PostformeContentSelection["platformConfigurationMetadata"] {
  return Object.entries(platformConfigurations).map(([platform, configuration]) => ({
    platform,
    title: cleanPostformeText(configuration.title),
    caption,
  }));
}

function pickPostformeTextByCursor(values: unknown, cursor: number): { text: string; cursorUsed: number } {
  const items = Array.isArray(values) ? values.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  if (items.length === 0) {
    return { text: "", cursorUsed: cursor };
  }

  const index = Math.min(cursor, items.length - 1);
  return { text: items[index].trim(), cursorUsed: cursor };
}

function buildPostformeContentSelection(
  config: Record<string, unknown>,
  socialAccounts: string[],
  savedAccountsRaw: string | null | undefined,
  postContentCursor: number
): PostformeContentSelection & { nextPostContentCursor: number; postContentCursor: number } {
  const brandingUrl = cleanPostformeText(config.branding_url);
  const titles = Array.isArray(config.titles) ? config.titles.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const descriptions = Array.isArray(config.descriptions) ? config.descriptions.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const maxContentCount = Math.max(titles.length, descriptions.length, 1);

  const clampedCursor = Math.min(postContentCursor, maxContentCount - 1);
  const titleResult = pickPostformeTextByCursor(config.titles, clampedCursor);
  const descResult = pickPostformeTextByCursor(config.descriptions, clampedCursor);
  const title = titleResult.text;
  const description = ensureCaptionBranding(descResult.text, brandingUrl);
  const topTagline = pickRandomPostformeText(config.top_taglines);
  const bottomTagline = pickRandomPostformeText(config.bottom_taglines);
  const hashtags = normalizePostformeHashtags(config.hashtags);
  const hashtagsText = hashtags.join(" ");
  const caption = ensureCaptionBranding(
    [topTagline, title, description, hashtagsText, bottomTagline]
    .filter(Boolean)
    .join("\n\n"),
    brandingUrl
  );

  const platformConfigurations = buildPostformePlatformConfigurations(
    socialAccounts,
    savedAccountsRaw,
    title,
    description,
    hashtags
  );

  const nextPostContentCursor = postContentCursor + 1;

  return {
    title,
    description,
    hashtags,
    caption,
    topTagline,
    bottomTagline,
    platformConfigurations,
    platformConfigurationMetadata: buildPostformePlatformConfigurationMetadata(platformConfigurations, caption),
    nextPostContentCursor,
    postContentCursor: clampedCursor,
  };
}

// Helper function to create a post via PostForMe API
async function createPostformePost(
  apiKey: string,
  mediaUrls: string[],
  caption: string,
  socialAccounts: string[],
  scheduledAt: string | null,
  isDraft: boolean,
  platformConfigurations?: Record<string, { title: string }>
): Promise<{ id?: string; data?: { id?: string } }> {
  const normalizedMediaUrls = normalizeMediaUrls(mediaUrls);
  if (normalizedMediaUrls.length === 0) {
    throw new Error("At least one public media URL is required");
  }

  const postBody: Record<string, unknown> = {
    caption,
    media: normalizedMediaUrls.map((url) => ({ url })),
    social_accounts: socialAccounts,
    isDraft,
  };
  if (scheduledAt && !isDraft) {
    postBody.scheduled_at = scheduledAt;
  }
  if (platformConfigurations && Object.keys(platformConfigurations).length > 0 && socialAccounts.length > 0) {
    postBody.platform_configurations = platformConfigurations;
  }

  const response = await fetch("https://api.postforme.dev/v1/social-posts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(postBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create post: ${errorText}`);
  }

  return await response.json();
}

const STALE_JOB_TIMEOUT_MINUTES = 45;

/**
 * Sync stale "running" jobs by polling GitHub Actions for their actual status.
 * This is a safety net for when the webhook callback fails or is never received.
 * Called every minute by the cron handler.
 */
export async function syncStaleRunningJobs(env: Env): Promise<void> {
  // ── Auto-fail jobs stuck beyond timeout ──────────────────────────────
  const timeoutMinutes = STALE_JOB_TIMEOUT_MINUTES;
  const timedOutJobs = await env.DB.prepare(
    `SELECT j.id, j.user_id, j.github_run_id
     FROM jobs j
     WHERE j.status = 'running'
       AND j.started_at <= datetime('now', '-' || ? || ' minutes')
     ORDER BY j.started_at ASC
     LIMIT 10`
  ).bind(timeoutMinutes).all<{ id: number; user_id: number; github_run_id: number | null }>();

  if (timedOutJobs.results?.length) {
    for (const job of timedOutJobs.results) {
      console.log(`[syncStaleRunningJobs] Job ${job.id} timed out (>${timeoutMinutes} min). Auto-failing.`);
      await env.DB.prepare(
        "UPDATE jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'"
      ).bind(`Timed out after ${timeoutMinutes} minutes`, job.id).run();
      await markAutomationRunCompleted(env, job.id, new Date());
    }
    return;
  }

  // ── Sync GitHub jobs stuck >5 min but <timeout ───────────────────────
  const staleJobs = await env.DB.prepare(
    `SELECT j.id, j.github_run_id, j.user_id, j.automation_id, j.started_at
     FROM jobs j
     WHERE j.status = 'running'
       AND j.github_run_id IS NOT NULL
       AND j.started_at <= datetime('now', '-5 minutes')
       AND j.started_at > datetime('now', '-' || ? || ' minutes')
     ORDER BY j.started_at ASC
     LIMIT 10`
  ).bind(timeoutMinutes).all<{ id: number; github_run_id: number; user_id: number; automation_id: number; started_at: string }>();

  if (!staleJobs.results?.length) {
    return;
  }

  const firstJob = staleJobs.results[0];
  const githubSettings = await getScopedSettings<GithubSettings>(env.DB, "github", firstJob.user_id);
  if (!githubSettings?.pat_token || !githubSettings.repo_owner || !githubSettings.repo_name) {
    return;
  }

  for (const job of staleJobs.results) {
    try {
      const runStatus = await getWorkflowRunStatus(githubSettings as GithubSettings, job.github_run_id);
      if (!runStatus) {
        continue;
      }

      if (runStatus.status !== "completed") {
        continue;
      }

      const isSuccess = runStatus.conclusion === "success";
      const newStatus = isSuccess ? "success" : "failed";
      const errorMessage = isSuccess ? null : `GitHub Actions conclusion: ${runStatus.conclusion}`;
      const completedAt = formatDatabaseDate(new Date());

      console.log(`[syncStaleRunningJobs] Job ${job.id} (run ${job.github_run_id}): GitHub=${runStatus.status}/${runStatus.conclusion} -> updating to ${newStatus}`);

      const videoUrl = isSuccess ? `https://waqas-ai-studio.waqaskhan1437.workers.dev/api/output/${job.id}` : null;
      const outputData = isSuccess ? JSON.stringify({ video_url: videoUrl, synced_from_github: true }) : null;

      await env.DB.prepare(
        "UPDATE jobs SET status = ?, completed_at = ?, error_message = ?, video_url = COALESCE(video_url, ?), output_data = COALESCE(output_data, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'"
      ).bind(newStatus, completedAt, errorMessage, videoUrl, outputData, job.id).run();

      await markAutomationRunCompleted(env, job.id, new Date());
    } catch (err) {
      console.error(`[syncStaleRunningJobs] Error syncing job ${job.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // ── Mark runners offline if heartbeat missing >10 min ────────────────
  await markStaleRunnersOffline(env);
}

async function markStaleRunnersOffline(env: Env): Promise<void> {
  try {
    const staleRunners = await env.DB.prepare(
      `SELECT id FROM users
       WHERE runner_status IN ('online', 'processing')
         AND runner_last_seen_at <= datetime('now', '-10 minutes')
       LIMIT 50`
    ).all<{ id: number }>();

    if (staleRunners.results?.length) {
      for (const runner of staleRunners.results) {
        console.log(`[heartbeat] Runner user ${runner.id} last seen >10 min ago. Marking offline.`);
        await env.DB.prepare(
          "UPDATE users SET runner_status = 'offline', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND runner_status IN ('online', 'processing')"
        ).bind(runner.id).run();
      }
    }
  } catch (err) {
    console.error('[heartbeat] Error marking runners offline:', err instanceof Error ? err.message : String(err));
  }
}
