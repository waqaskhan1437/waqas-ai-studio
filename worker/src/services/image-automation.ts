import type { AISettings, Env } from "../types";
import {
  type AIRuntimeConfig,
  buildAiRuntimeConfig,
  generateAiJson,
  getConfiguredProviderIds,
  normalizeSocialResult,
  type SupportedAIProvider,
} from "./ai";
import { getScopedSettings } from "./user-settings";
import { resolveCloudflareImageModel } from "./cloudflare-ai";

type ImageMode = "source_url" | "html_banner";
type ImageLayout = "portrait" | "landscape";
export type ImageBannerFormat = "how_it_works" | "product_info" | "personalized_video" | "three_step_offer";
type ImageRotationState = {
  source_cursor: number;
  branding_cursor: number;
  branding_image_cursor: number;
  content_cursor: number;
  post_content_cursor: number;
};

export interface BannerSpec {
  accent_label: string;
  headline: string;
  supporting_text: string;
  steps: string[];
  cta: string;
  format?: ImageBannerFormat;
  preview_label?: string;
  illustration_hint?: string;
}

interface BannerInput {
  automationName: string;
  brandName: string;
  brandingUrl: string;
  bannerTitle: string;
  bannerPrompt: string;
  bannerProductSummary: string;
  bannerFormat: ImageBannerFormat;
  layout: ImageLayout;
}

const RESOLUTION_PRESETS: Record<ImageLayout, string> = {
  portrait: "1080x1350",
  landscape: "1920x1080",
};

const DEFAULT_AI_MODELS: Record<SupportedAIProvider, string> = {
  openai: "gpt-5-mini",
  gemini: "gemini-3-flash-preview",
  grok: "grok-4-fast-reasoning",
  cohere: "command-r-plus",
  openrouter: "google/gemini-2.5-flash",
  groq: "openai/gpt-oss-20b",
};

const BANNER_FORMAT_PRESETS: Record<ImageBannerFormat, {
  label: string;
  accent: string;
  focus: string;
  ctaPrefix: string;
}> = {
  how_it_works: {
    label: "How It Works",
    accent: "How It Works",
    focus: "Explain the product in 3 simple steps with clear instructional copy.",
    ctaPrefix: "Start",
  },
  product_info: {
    label: "Product Info",
    accent: "Product Info",
    focus: "Describe what the product does, who it helps, and the result.",
    ctaPrefix: "See",
  },
  personalized_video: {
    label: "Custom Video",
    accent: "Custom Video",
    focus: "Emphasize the personalized video outcome and authenticity.",
    ctaPrefix: "Create",
  },
  three_step_offer: {
    label: "3-Step CTA",
    accent: "3 Simple Steps",
    focus: "Keep it conversion-led while still teaching the 3-step flow.",
    ctaPrefix: "Choose",
  },
};

const OCCASION_HINTS: Array<{ keywords: string[]; label: string }> = [
  { keywords: ["birthday", "bday"], label: "birthday video" },
  { keywords: ["anniversary"], label: "anniversary video" },
  { keywords: ["wedding"], label: "wedding video" },
  { keywords: ["mother", "mom"], label: "Mother's Day video" },
  { keywords: ["father", "dad"], label: "Father's Day video" },
  { keywords: ["love", "romantic", "valentine"], label: "love video" },
  { keywords: ["baby", "kid", "child"], label: "kids video" },
];

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function toUniqueStringArray(value: unknown, limit = 10): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const items: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    items.push(trimmed);

    if (items.length >= limit) {
      break;
    }
  }

  return items;
}

function toUniqueUrlArray(value: unknown, limit = 200): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];

  const seen = new Set<string>();
  const items: string[] = [];

  for (const item of rawItems) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      continue;
    }

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    items.push(trimmed);

    if (items.length >= limit) {
      break;
    }
  }

  return items;
}

function toNonNegativeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return 0;
}

function normalizeRotationState(value: unknown): ImageRotationState {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return {
    source_cursor: toNonNegativeInteger(record.source_cursor),
    branding_cursor: toNonNegativeInteger(record.branding_cursor),
    branding_image_cursor: toNonNegativeInteger(record.branding_image_cursor),
    content_cursor: toNonNegativeInteger(record.content_cursor),
    post_content_cursor: toNonNegativeInteger(record.post_content_cursor),
  };
}

function pickSequentialItems(items: string[], cursor: number, requestedCount: number): {
  items: string[];
  nextCursor: number;
} {
  if (items.length === 0) {
    return {
      items: [],
      nextCursor: 0,
    };
  }

  const safeCursor = cursor % items.length;
  const count = Math.max(1, Math.min(requestedCount, items.length));
  const selection: string[] = [];

  for (let index = 0; index < count; index += 1) {
    selection.push(items[(safeCursor + index) % items.length]);
  }

  return {
    items: selection,
    nextCursor: (safeCursor + count) % items.length,
  };
}

function normalizeImageMode(value: unknown): ImageMode | "cloudflare_ai" {
  const raw = readString(value).toLowerCase();
  if (raw === "source_url" || raw === "source" || raw === "url") {
    return "source_url";
  }
  if (raw === "cloudflare_ai" || raw === "ai_generated" || raw === "workers_ai") {
    return "cloudflare_ai";
  }
  return "html_banner";
}

function normalizeImageLayout(value: unknown): ImageLayout {
  return readString(value).toLowerCase() === "landscape" ? "landscape" : "portrait";
}

export function normalizeBannerFormat(value: unknown): ImageBannerFormat {
  const raw = readString(value).toLowerCase();
  if (raw === "product_info") {
    return "product_info";
  }
  if (raw === "personalized_video") {
    return "personalized_video";
  }
  if (raw === "three_step_offer") {
    return "three_step_offer";
  }
  return "how_it_works";
}

function normalizeImageFormat(value: unknown): "png" | "jpeg" | "webp" {
  const raw = readString(value).toLowerCase();
  if (raw === "jpeg" || raw === "jpg") {
    return "jpeg";
  }
  if (raw === "webp") {
    return "webp";
  }
  return "png";
}

function normalizeResolution(value: unknown, layout: ImageLayout): string {
  const raw = readString(value);
  if (/^\d{3,5}x\d{3,5}$/.test(raw)) {
    return raw;
  }
  return RESOLUTION_PRESETS[layout];
}

function toAspectRatio(resolution: string): string {
  const match = resolution.match(/^(\d+)x(\d+)$/);
  if (!match) {
    return "4:5";
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "4:5";
  }

  if (width === height) {
    return "1:1";
  }

  const ratio = width / height;
  if (ratio >= 1.7) {
    return "16:9";
  }
  if (ratio <= 0.6) {
    return "9:16";
  }

  return width > height ? "16:9" : "4:5";
}

function ensureHashtag(value: string): string {
  const normalized = value.replace(/^#+/, "").replace(/\s+/g, "");
  return normalized ? `#${normalized}` : "";
}

function normalizeDomainLabel(rawUrl: string): string {
  if (!rawUrl) {
    return "";
  }

  try {
    const url = new URL(rawUrl);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return rawUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

function clipText(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function buildFallbackHashtags(brandingUrl: string, brandName: string): string[] {
  const domain = normalizeDomainLabel(brandingUrl).split(".")[0];
  return toUniqueStringArray(
    [brandName, domain, `${domain}workflow`, "brandstory", "socialpost"]
      .map((item) => ensureHashtag(String(item || "").replace(/[^a-z0-9]+/gi, ""))),
    8
  );
}

function ensureBrandingInDescriptions(descriptions: string[], brandingUrl: string): string[] {
  if (!brandingUrl) {
    return descriptions;
  }

  return descriptions.map((description) => {
    if (description.includes(brandingUrl)) {
      return description;
    }

    return clipText(`${description} ${brandingUrl}`.trim(), 220);
  });
}

function readRecordArray(value: unknown, limit = 10): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .slice(0, limit);
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isPrankwishContext(input: Pick<BannerInput, "brandName" | "brandingUrl" | "bannerTitle" | "bannerPrompt" | "bannerProductSummary">): boolean {
  const haystack = [
    input.brandName,
    input.brandingUrl,
    input.bannerTitle,
    input.bannerPrompt,
    input.bannerProductSummary,
  ].join(" ").toLowerCase();

  return haystack.includes("prankwish");
}

function detectOfferLabel(input: Pick<BannerInput, "bannerTitle" | "bannerPrompt" | "bannerProductSummary" | "brandName" | "brandingUrl">): string {
  const haystack = [
    input.bannerTitle,
    input.bannerPrompt,
    input.bannerProductSummary,
    input.brandName,
    input.brandingUrl,
  ].join(" ").toLowerCase();

  for (const occasion of OCCASION_HINTS) {
    if (occasion.keywords.some((keyword) => haystack.includes(keyword))) {
      return occasion.label;
    }
  }

  if (haystack.includes("video")) {
    return "custom video";
  }
  if (haystack.includes("gift")) {
    return "personalized gift";
  }
  if (isPrankwishContext(input)) {
    return "personalized video";
  }

  return "custom result";
}

function deriveIllustrationHint(input: Pick<BannerInput, "bannerTitle" | "bannerPrompt" | "bannerProductSummary" | "brandName" | "brandingUrl" | "bannerFormat">): string {
  const offerLabel = detectOfferLabel(input);
  if (/video|film|clip/.test(offerLabel)) return "video";
  if (/gift|present/.test(offerLabel)) return "gift";
  if (/birthday|celebrat|party|anniversary/.test(offerLabel)) return "celebration";

  switch (input.bannerFormat) {
    case "personalized_video": return "video";
    case "product_info": return "product";
    case "three_step_offer": return "steps";
    default: return "generic";
  }
}

function buildDefaultProductSummary(input: BannerInput): string {
  if (input.bannerProductSummary) {
    return clipText(input.bannerProductSummary, 90);
  }

  const offerLabel = detectOfferLabel(input);
  if (isPrankwishContext(input)) {
    return clipText(
      `Choose a style, fill the form, add the recipient photo/details, and get a real personalized ${offerLabel} made to your requirements.`,
      90
    );
  }

  return clipText(
    `Choose the product, add your details, and get the final ${offerLabel} through a simple branded workflow.`,
    90
  );
}

function buildDefaultWorkflowSteps(input: BannerInput): string[] {
  const offerLabel = detectOfferLabel(input);

  if (isPrankwishContext(input)) {
    return [
      "Choose your style",
      "Fill form + add photo",
      clipText(`Get custom ${offerLabel}`, 34),
    ];
  }

  return [
    "Choose the product",
    "Add details or media",
    clipText(`Get the ${offerLabel}`, 34),
  ];
}

function buildFallbackHeadline(input: BannerInput, format: ImageBannerFormat): string {
  const offerLabel = detectOfferLabel(input);
  const productLabel = input.brandName || normalizeDomainLabel(input.brandingUrl) || input.automationName || "Your product";
  const requestedTitle = clipText(input.bannerTitle || input.bannerPrompt, 58);

  if (requestedTitle) {
    return requestedTitle;
  }

  switch (format) {
    case "product_info":
      return clipText(`${productLabel} creates a ${offerLabel}`, 58);
    case "personalized_video":
      return clipText(`Create a real ${offerLabel}`, 58);
    case "three_step_offer":
      return clipText(`Get your ${offerLabel} in 3 steps`, 58);
    case "how_it_works":
    default:
      return clipText(`How to get a ${offerLabel}`, 58);
  }
}

function buildFallbackSupportingText(input: BannerInput, format: ImageBannerFormat): string {
  const offerLabel = detectOfferLabel(input);
  const baseSummary = buildDefaultProductSummary(input);

  switch (format) {
    case "product_info":
      return baseSummary;
    case "personalized_video":
      return clipText(`Choose a style, add details, and receive a real ${offerLabel} tailored to your request.`, 90);
    case "three_step_offer":
      return clipText(`A simple 3-step flow to order your ${offerLabel} without generic marketing fluff.`, 90);
    case "how_it_works":
    default:
      return clipText(`Follow the 3-step method to create your ${offerLabel} from the brand workflow.`, 90);
  }
}

function buildFallbackCta(input: BannerInput, format: ImageBannerFormat): string {
  const offerLabel = toTitleCase(detectOfferLabel(input));

  switch (format) {
    case "product_info":
      return clipText(`See ${offerLabel}`, 36);
    case "personalized_video":
      return clipText(`Create Your ${offerLabel}`, 36);
    case "three_step_offer":
      return clipText("Choose Your Style", 36);
    case "how_it_works":
    default:
      return clipText(`Start ${offerLabel}`, 36);
  }
}

function buildFallbackBannerSpec(input: BannerInput, formatOverride?: ImageBannerFormat): BannerSpec {
  const format = formatOverride || input.bannerFormat;
  const preset = BANNER_FORMAT_PRESETS[format];

  return {
    accent_label: clipText(preset.accent, 22),
    headline: buildFallbackHeadline(input, format),
    supporting_text: buildFallbackSupportingText(input, format),
    steps: buildDefaultWorkflowSteps(input),
    cta: buildFallbackCta(input, format),
    format,
    preview_label: preset.label,
    illustration_hint: deriveIllustrationHint({ ...input, bannerFormat: format }),
  };
}

function buildFallbackBannerPreviewSpecs(input: BannerInput, count: number): BannerSpec[] {
  const orderedFormats = ([input.bannerFormat, "how_it_works", "product_info", "personalized_video", "three_step_offer"] as ImageBannerFormat[])
    .filter((format, index, values) => values.indexOf(format) === index)
    .slice(0, Math.max(1, count));

  return orderedFormats.map((format) => buildFallbackBannerSpec(input, format));
}

function normalizeBannerSpec(payload: Record<string, unknown>, fallback: BannerSpec): BannerSpec {
  const steps = toUniqueStringArray(payload.steps, 3)
    .map((step) => clipText(step, 34))
    .slice(0, 3);

  const format = normalizeBannerFormat(payload.format || fallback.format);

  const VALID_ILLUSTRATIONS = ["gift", "video", "celebration", "steps", "product", "generic"];
  const rawHint = readString(payload.illustration_hint, fallback.illustration_hint || "");
  const illustrationHint = VALID_ILLUSTRATIONS.includes(rawHint) ? rawHint : (fallback.illustration_hint || "generic");

  return {
    accent_label: clipText(readString(payload.accent_label, fallback.accent_label) || fallback.accent_label, 22),
    headline: clipText(readString(payload.headline, fallback.headline) || fallback.headline, 58),
    supporting_text: clipText(
      readString(payload.supporting_text, fallback.supporting_text) || fallback.supporting_text,
      90
    ),
    steps: steps.length > 0 ? steps : fallback.steps,
    cta: clipText(readString(payload.cta, fallback.cta) || fallback.cta, 36),
    format,
    preview_label: clipText(
      readString(payload.preview_label, fallback.preview_label || BANNER_FORMAT_PRESETS[format].label) || BANNER_FORMAT_PRESETS[format].label,
      22
    ),
    illustration_hint: illustrationHint,
  };
}

function normalizeBannerPreviewPayload(payload: Record<string, unknown>, fallbacks: BannerSpec[]): BannerSpec[] {
  const items = readRecordArray(payload.specs || payload.banners || payload.options, fallbacks.length);
  if (items.length === 0) {
    return fallbacks;
  }

  return fallbacks.map((fallback, index) => normalizeBannerSpec(items[index] || {}, fallback));
}

function buildBannerMessages(input: BannerInput): { system: string; user: string } {
  const domain = normalizeDomainLabel(input.brandingUrl) || "the brand";
  const fallback = buildFallbackBannerSpec(input);
  const preset = BANNER_FORMAT_PRESETS[input.bannerFormat];
  const productSummary = buildDefaultProductSummary(input);
  const workflowSteps = buildDefaultWorkflowSteps(input);
  const offerLabel = detectOfferLabel(input);

  return {
    system: [
      "You create concise HTML banner copy for social image automations.",
      "Every banner must explain what the product does and how it works.",
      "Use educational product-copy, not generic hype, not greetings, and not vague design prompts.",
      "Return valid JSON only. No markdown, no prose, no code fences.",
      "Keep text minimal, workflow-focused, readable on a single social banner, and tied to a real product flow.",
      "Never produce long paragraphs.",
    ].join(" "),
    user: [
      `Create branded copy for a ${input.layout} social banner.`,
      `Automation name: ${input.automationName || "Image automation"}`,
      `Brand name: ${input.brandName || domain}`,
      `Branding URL: ${input.brandingUrl || "not provided"}`,
      `Selected format: ${preset.label}`,
      `Format goal: ${preset.focus}`,
      `Headline topic: ${input.bannerTitle || fallback.headline}`,
      `Product summary: ${productSummary}`,
      `Creative brief: ${input.bannerPrompt || "No extra instructions"}`,
      `Required steps: ${workflowSteps.join(" | ")}`,
      `Primary result: ${offerLabel}`,
      "Rules:",
      "- output one short accent label",
      "- output one headline under 58 characters",
      "- output one supporting_text under 90 characters",
      "- output exactly 3 steps, each under 34 characters",
      "- output one CTA under 36 characters",
      "- supporting_text must explain what the product does or why it is useful",
      "- steps must describe the real workflow, not abstract marketing phrases",
      "- CTA should invite the user to start, choose, or create the product",
      "- do not write generic greetings, generic birthday wishes, or generic ad slogans",
      "- do not mention design words like modern, clean, premium, marketing banner",
      "- no emojis",
      '- output one illustration_hint: one of "gift", "video", "celebration", "steps", "product", or "generic" — pick based on the topic',
      '- return JSON with shape: {"accent_label":"...","headline":"...","supporting_text":"...","steps":["...","...","..."],"cta":"...","illustration_hint":"..."}',
    ].join("\n"),
  };
}

function buildBannerPreviewMessages(input: BannerInput, fallbacks: BannerSpec[]): { system: string; user: string } {
  const productSummary = buildDefaultProductSummary(input);
  const workflowSteps = buildDefaultWorkflowSteps(input);

  return {
    system: [
      "You create concise HTML banner copy previews for social image automations.",
      "Each preview must explain what the product does and how it works.",
      "Return valid JSON only. No markdown, no prose, no code fences.",
    ].join(" "),
    user: [
      `Create exactly ${fallbacks.length} preview banner options for a ${input.layout} social banner.`,
      `Brand name: ${input.brandName || normalizeDomainLabel(input.brandingUrl) || "the brand"}`,
      `Branding URL: ${input.brandingUrl || "not provided"}`,
      `Headline topic: ${input.bannerTitle || buildFallbackHeadline(input, input.bannerFormat)}`,
      `Product summary: ${productSummary}`,
      `Creative brief: ${input.bannerPrompt || "No extra instructions"}`,
      `Required steps: ${workflowSteps.join(" | ")}`,
      "Preview format order:",
      ...fallbacks.map((fallback, index) => `- Option ${index + 1}: ${fallback.preview_label || BANNER_FORMAT_PRESETS[fallback.format || input.bannerFormat].label}`),
      "Rules:",
      "- every option must stay in product-info / how-it-works mode",
      "- every option must keep the same 3-step workflow",
      "- vary headlines and supporting copy without changing the product behavior",
      "- do not use generic marketing-banner language",
      "- no emojis",
      '- return JSON with shape: {"specs":[{"accent_label":"...","headline":"...","supporting_text":"...","steps":["...","...","..."],"cta":"...","format":"how_it_works","preview_label":"How It Works"}]}',
    ].join("\n"),
  };
}

function buildSocialMessages(input: {
  prompt: string;
  platform: string;
  count: number;
  brandingUrl: string;
  banner: BannerSpec;
}): { system: string; user: string } {
  const hashtagCount = Math.min(Math.max(input.count * 3, 8), 24);
  const bannerFormatLabel = input.banner.format ? BANNER_FORMAT_PRESETS[input.banner.format].label : "How It Works";

  return {
    system: [
      "You create concise social metadata for branded image posts.",
      "Return valid JSON only. No markdown, no prose, no code fences.",
      "Descriptions must stay short, clear, and grounded in the product workflow.",
    ].join(" "),
    user: [
      `Generate social content for ${input.platform}.`,
      `Prompt: ${input.prompt || input.banner.headline}`,
      `Banner format: ${bannerFormatLabel}`,
      `Banner headline: ${input.banner.headline}`,
      `Banner steps: ${input.banner.steps.join(" | ")}`,
      `Banner CTA: ${input.banner.cta}`,
      `Branding URL: ${input.brandingUrl || "not provided"}`,
      `Create exactly ${input.count} titles.`,
      `Create exactly ${input.count} descriptions.`,
      `Create exactly ${hashtagCount} hashtags.`,
      "Rules:",
      "- titles should be catchy but concise",
      "- descriptions should be short captions for an image post",
      "- descriptions should naturally fit the banner workflow and describe the product clearly",
      "- if a branding URL is provided, work it into the description naturally",
      "- hashtags must be unique and relevant",
      "- no emojis unless explicitly required by the prompt",
      '- return JSON with shape: {"titles":["..."],"descriptions":["..."],"hashtags":["#..."]}',
    ].join("\n"),
  };
}

async function resolveImageAiSelection(
  env: Env,
  userId: number,
  providerValue: unknown,
  modelValue: unknown
): Promise<{ settings: AISettings | null; provider: SupportedAIProvider | null; model: string | null }> {
  const settings = await getScopedSettings<AISettings>(env.DB, "ai", userId);
  if (!settings) {
    return { settings: null, provider: null, model: null };
  }

  const configuredProviders = getConfiguredProviderIds(settings);
  if (configuredProviders.length === 0) {
    return { settings, provider: null, model: null };
  }

  const requestedProvider = readString(providerValue) as SupportedAIProvider;
  const provider = configuredProviders.includes(requestedProvider)
    ? requestedProvider
    : (
        configuredProviders.includes(settings.default_provider as SupportedAIProvider)
          ? settings.default_provider as SupportedAIProvider
          : configuredProviders[0]
      );

  if (!provider) {
    return { settings, provider: null, model: null };
  }

  return {
    settings,
    provider,
    model: readString(modelValue) || DEFAULT_AI_MODELS[provider] || null,
  };
}

async function generateBannerSpec(
  env: Env,
  userId: number,
  input: BannerInput & {
    providerValue: unknown;
    modelValue: unknown;
  },
  runtimeConfig?: AIRuntimeConfig
): Promise<{ spec: BannerSpec; provider: string | null; model: string | null }> {
  const fallback = buildFallbackBannerSpec(input);
  const selection = await resolveImageAiSelection(env, userId, input.providerValue, input.modelValue);

  if (!selection.settings || !selection.provider || !selection.model) {
    return { spec: fallback, provider: null, model: null };
  }

  try {
    const payload = await generateAiJson(
      selection.settings,
      selection.provider,
      selection.model,
      buildBannerMessages(input),
      runtimeConfig || buildAiRuntimeConfig(env)
    );
    return {
      spec: normalizeBannerSpec(payload, fallback),
      provider: selection.provider,
      model: selection.model,
    };
  } catch {
    return {
      spec: fallback,
      provider: selection.provider,
      model: selection.model,
    };
  }
}

export async function generateImageBannerPreviewSpecs(
  env: Env,
  userId: number,
  input: BannerInput & {
    providerValue: unknown;
    modelValue: unknown;
    count?: number;
  },
  runtimeConfig?: AIRuntimeConfig
): Promise<{ specs: BannerSpec[]; provider: string | null; model: string | null }> {
  const fallbacks = buildFallbackBannerPreviewSpecs(input, Math.min(Math.max(input.count || 3, 1), 4));
  const selection = await resolveImageAiSelection(env, userId, input.providerValue, input.modelValue);

  if (!selection.settings || !selection.provider || !selection.model) {
    return { specs: fallbacks, provider: null, model: null };
  }

  try {
    const payload = await generateAiJson(
      selection.settings,
      selection.provider,
      selection.model,
      buildBannerPreviewMessages(input, fallbacks),
      runtimeConfig || buildAiRuntimeConfig(env)
    );
    return {
      specs: normalizeBannerPreviewPayload(payload, fallbacks),
      provider: selection.provider,
      model: selection.model,
    };
  } catch {
    return {
      specs: fallbacks,
      provider: selection.provider,
      model: selection.model,
    };
  }
}

async function generateSocialContent(
  env: Env,
  userId: number,
  input: {
    prompt: string;
    platform: string;
    count: number;
    brandingUrl: string;
    banner: BannerSpec;
    providerValue: unknown;
    modelValue: unknown;
  },
  runtimeConfig?: AIRuntimeConfig
): Promise<{ titles: string[]; descriptions: string[]; hashtags: string[]; provider: string | null; model: string | null }> {
  const fallbackTitles = [
    clipText(input.banner.headline, 70),
    clipText(`${input.banner.accent_label} workflow`, 70),
    clipText(input.banner.cta, 70),
  ].filter(Boolean);
  const fallbackDescriptions = ensureBrandingInDescriptions(
    [
      clipText(input.prompt || input.banner.supporting_text, 160),
      clipText(`${input.banner.supporting_text} ${input.banner.cta}`, 160),
    ].filter(Boolean),
    input.brandingUrl
  );
  const fallbackTagList = buildFallbackHashtags(input.brandingUrl, input.banner.accent_label);
  const selection = await resolveImageAiSelection(env, userId, input.providerValue, input.modelValue);

  if (!selection.settings || !selection.provider || !selection.model) {
    return {
      titles: fallbackTitles,
      descriptions: fallbackDescriptions,
        hashtags: fallbackTagList,
      provider: null,
      model: null,
    };
  }

  try {
    const payload = await generateAiJson(
      selection.settings,
      selection.provider,
      selection.model,
      buildSocialMessages(input),
      runtimeConfig || buildAiRuntimeConfig(env)
    );
    const normalized = normalizeSocialResult(payload, input.count);
    return {
      titles: normalized.titles,
      descriptions: ensureBrandingInDescriptions(normalized.descriptions, input.brandingUrl),
        hashtags: normalized.hashtags.length > 0 ? normalized.hashtags : fallbackTagList,
      provider: selection.provider,
      model: selection.model,
    };
  } catch {
    return {
      titles: fallbackTitles,
      descriptions: fallbackDescriptions,
        hashtags: fallbackTagList,
      provider: selection.provider,
      model: selection.model,
    };
  }
}

export async function prepareImageAutomationRunConfig(
  env: Env,
  userId: number,
  automationName: string,
  config: Record<string, unknown>,
  runtimeConfig?: AIRuntimeConfig
): Promise<Record<string, unknown>> {
  const imageMode = normalizeImageMode(config.image_mode || config.image_source);
  const layout = normalizeImageLayout(config.image_layout);
  const outputResolution = normalizeResolution(config.output_resolution, layout);
  const rotationState = normalizeRotationState(config.rotation_state);
  const sourceImagePool = toUniqueUrlArray(config.source_image_urls || config.source_image_url || config.image_url);
  const brandingUrlPool = toUniqueUrlArray(config.branding_urls || config.branding_url);
  const brandingImagePool = toUniqueUrlArray(config.branding_image_urls || config.branding_image_url);
  const requestedImagesPerPost = Math.min(Math.max(readPositiveInteger(config.images_per_post, 1), 1), 10);
  const selectedSourceImages = pickSequentialItems(sourceImagePool, rotationState.source_cursor, requestedImagesPerPost);
  const selectedBrandingUrls = pickSequentialItems(brandingUrlPool, rotationState.branding_cursor, 1);
  const selectedBrandingImages = pickSequentialItems(brandingImagePool, rotationState.branding_image_cursor, 1);
  const brandingUrl = selectedBrandingUrls.items[0] || readString(config.branding_url);
  const brandingImageUrl = selectedBrandingImages.items[0] || readString(config.branding_image_url);
  const selectedSourceImageUrls = selectedSourceImages.items.length > 0
    ? selectedSourceImages.items
    : toUniqueUrlArray(readString(config.source_image_url || config.image_url), requestedImagesPerPost);
  const primarySourceImageUrl = selectedSourceImageUrls[0] || readString(config.source_image_url || config.image_url);
  const socialPrompt = readString(
    config.ai_prompt || config.social_prompt || config.banner_product_summary || config.banner_title || config.banner_prompt || automationName
  );
  const socialPlatform = readString(config.social_platform, "instagram");
  const socialCount = Math.min(Math.max(readPositiveInteger(config.social_count, 5), 1), 10);

  // Check if user already generated titles/descriptions in Content tab — reuse them
  const existingTitles = Array.isArray(config.titles) ? (config.titles as string[]).filter((t: string) => typeof t === "string" && t.trim()) : [];
  const existingDescriptions = Array.isArray(config.descriptions) ? (config.descriptions as string[]).filter((d: string) => typeof d === "string" && d.trim()) : [];
  const existingHashtags = Array.isArray(config.hashtags) ? (config.hashtags as string[]).filter((h: string) => typeof h === "string" && h.trim()) : [];
  const hasPregeneratedContent = existingTitles.length > 0;

  // If Content tab titles exist, use the cursor-positioned title as banner headline source
  const contentCursor = rotationState.content_cursor || 0;
  const contentTitle = hasPregeneratedContent ? existingTitles[contentCursor % existingTitles.length] : "";
  const brandName = readString(config.brand_name);
  const bannerProductSummary = readString(config.banner_product_summary);
  const bannerPrompt = readString(config.banner_prompt);
  const bannerFormat = normalizeBannerFormat(config.banner_format);
  const bannerTitle = readString(contentTitle || config.banner_title || automationName);

  const bannerInput: BannerInput = {
    automationName,
    brandName,
    brandingUrl,
    bannerTitle,
    bannerPrompt,
    bannerProductSummary,
    bannerFormat,
    layout,
  };
  const fallbackBanner = buildFallbackBannerSpec(bannerInput);
  const bannerResult = imageMode === "html_banner"
    ? await generateBannerSpec(env, userId, {
        ...bannerInput,
        providerValue: config.social_ai_provider,
        modelValue: config.social_ai_model,
      }, runtimeConfig)
    : { spec: fallbackBanner, provider: null, model: null };

  // Only generate new social content if user hasn't pre-generated titles in Content tab
  const socialResult = hasPregeneratedContent
    ? { titles: existingTitles, descriptions: existingDescriptions, hashtags: existingHashtags, provider: null, model: null }
    : await generateSocialContent(env, userId, {
        prompt: socialPrompt,
        platform: socialPlatform,
        count: socialCount,
        brandingUrl,
        banner: bannerResult.spec,
        providerValue: config.social_ai_provider,
        modelValue: config.social_ai_model,
      }, runtimeConfig);

  // Rotate titles/descriptions into image_render_spec so each run produces a different image
  const titles = socialResult.titles;
  const descriptions = socialResult.descriptions;
  const titleCount = titles.length;
  const descCount = descriptions.length;
  const maxCount = Math.max(titleCount, descCount, 1);

  const clampedCursor = Math.min(contentCursor, maxCount - 1);
  const selectedTitle = titleCount > 0 ? titles[clampedCursor % titleCount] : bannerResult.spec.headline;
  const selectedDesc = descCount > 0 ? descriptions[clampedCursor % descCount] : bannerResult.spec.supporting_text;
  const nextContentCursor = (titleCount > 0 || descCount > 0) ? contentCursor + 1 : 0;
  const allTitlesUsed = nextContentCursor >= maxCount;

  return {
    ...config,
    image_mode: imageMode,
    cloudflare_image_model: resolveCloudflareImageModel(config.cloudflare_image_model),
    image_layout: layout,
    output_resolution: outputResolution,
    output_format: normalizeImageFormat(config.output_format),
    output_quality: readString(config.output_quality, "high"),
    images_per_post: Math.max(1, selectedSourceImageUrls.length || requestedImagesPerPost),
    source_image_url: primarySourceImageUrl || null,
    source_image_urls: selectedSourceImageUrls,
    source_image_pool: sourceImagePool,
    source_image_pool_size: sourceImagePool.length,
    branding_url: brandingUrl || null,
    branding_urls: brandingUrlPool,
    branding_url_pool_size: brandingUrlPool.length,
    branding_image_url: brandingImageUrl || null,
    branding_image_urls: brandingImagePool,
    branding_image_pool_size: brandingImagePool.length,
    brand_name: brandName || null,
    banner_title: bannerTitle || null,
    banner_product_summary: bannerProductSummary || null,
    banner_format: bannerFormat,
    banner_prompt: bannerPrompt || null,
    social_prompt: socialPrompt,
    social_platform: socialPlatform,
    social_count: socialCount,
    social_ai_provider: socialResult.provider || bannerResult.provider || readString(config.social_ai_provider) || null,
    social_ai_model: socialResult.model || bannerResult.model || readString(config.social_ai_model) || null,
    rotation_state_next: {
      source_cursor: selectedSourceImages.nextCursor,
      branding_cursor: selectedBrandingUrls.nextCursor,
      branding_image_cursor: selectedBrandingImages.nextCursor,
      content_cursor: nextContentCursor,
      post_content_cursor: contentCursor,
      all_titles_used: allTitlesUsed,
    },
    rotation_selection: {
      source_image_urls: selectedSourceImageUrls,
      branding_url: brandingUrl || null,
      branding_image_url: brandingImageUrl || null,
    },
    titles,
    descriptions,
    hashtags: socialResult.hashtags,
    top_taglines: [bannerResult.spec.headline],
    bottom_taglines: [bannerResult.spec.cta],
    image_render_spec: {
      ...bannerResult.spec,
      headline: selectedTitle || bannerResult.spec.headline,
      supporting_text: selectedDesc || bannerResult.spec.supporting_text,
      layout,
      resolution: outputResolution,
      aspect_ratio: toAspectRatio(outputResolution),
      branding_url: brandingUrl || null,
      branding_image_url: brandingImageUrl || null,
      brand_name: brandName || normalizeDomainLabel(brandingUrl) || automationName,
    },
  };
}

export function getImageAspectRatio(config: Record<string, unknown>): string {
  const layout = normalizeImageLayout(config.image_layout);
  const resolution = normalizeResolution(config.output_resolution, layout);
  return toAspectRatio(resolution);
}
