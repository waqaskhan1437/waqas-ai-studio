import type { AISettings, Env } from "../types";

import { getCloudflareVisualCatalog, type CloudflareVisualCatalog } from "./cloudflare-ai";

export type SupportedAIProvider =
  | "openai"
  | "gemini"
  | "grok"
  | "cohere"
  | "openrouter"
  | "groq";

export interface AIModelOption {
  id: string;
  label: string;
  description?: string;
  tier?: "free" | "paid" | "unknown";
  contextWindow?: number | null;
}

export interface AIProviderCatalogItem {
  id: SupportedAIProvider;
  label: string;
  models: AIModelOption[];
  error?: string;
}

export interface AIRuntimeConfig {
  geminiBridgeUrl?: string | null;
  geminiBridgeUrls?: string[] | null;
  geminiBridgeSecret?: string | null;
  authToken?: string | null;
}

interface GenerationMessages {
  system: string;
  user: string;
}

interface GenerateTaglinesInput {
  topic: string;
  count: number;
}

interface GenerateSocialInput {
  topic: string;
  platform: string;
  count: number;
  focusKeyword?: string;
  brief?: string;
}

interface PlatformContentSpec {
  titleMaxChars: number;
  descWordsMin: number;
  descWordsMax: number;
}

// Platform-aware length targets for titles/descriptions.
// Titles are hard-capped at titleMaxChars; descriptions target the word range
// (broad, never artificially short) and are only trimmed at the platform max.
const PLATFORM_CONTENT_SPECS: Record<string, PlatformContentSpec> = {
  youtube: { titleMaxChars: 100, descWordsMin: 150, descWordsMax: 350 },
  facebook: { titleMaxChars: 120, descWordsMin: 80, descWordsMax: 200 },
  tiktok: { titleMaxChars: 150, descWordsMin: 30, descWordsMax: 100 },
  instagram: { titleMaxChars: 150, descWordsMin: 40, descWordsMax: 120 },
  twitter: { titleMaxChars: 100, descWordsMin: 20, descWordsMax: 60 },
};

function getPlatformContentSpec(platform: string): PlatformContentSpec {
  const key = String(platform || "").trim().toLowerCase();
  return PLATFORM_CONTENT_SPECS[key] || PLATFORM_CONTENT_SPECS.youtube;
}

// Generous output budget so broad descriptions and large title/description/hashtag
// sets are never truncated by a small provider default.
const AI_MAX_OUTPUT_TOKENS = 4096;

// Trim a title to a hard character cap on a word boundary (no mid-word cut).
function truncateTitleToChars(title: string, maxChars: number): string {
  const trimmed = String(title || "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  const slice = trimmed.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trim();
}

interface PromptPlanSegmentResult {
  hook: string;
  title: string;
  caption: string;
  hashtags: string[];
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
}

interface GenerateShortPromptPlanInput {
  prompt: string;
}

const PROVIDER_LABELS: Record<SupportedAIProvider, string> = {
  openai: "OpenAI",
  gemini: "Google Gemini",
  grok: "xAI Grok",
  cohere: "Cohere",
  openrouter: "OpenRouter",
  groq: "Groq",
};

const PROVIDER_ORDER: SupportedAIProvider[] = [
  "openai",
  "gemini",
  "grok",
  "cohere",
  "openrouter",
  "groq",
];

const GEMINI_DEFAULT_TEXT_MODELS = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-2.5-pro",
];

const PROVIDER_DEFAULT_MODELS: Record<SupportedAIProvider, string[]> = {
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

function uniqueModels(models: AIModelOption[]): AIModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function compareModels(a: AIModelOption, b: AIModelOption): number {
  if (a.tier === "free" && b.tier !== "free") return -1;
  if (b.tier === "free" && a.tier !== "free") return 1;
  return a.label.localeCompare(b.label);
}

function parseContextWindow(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeBridgeUrl(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getAuthTokenFromHeader(value: string | null | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isWorkerLikeOrigin(value: string | null | undefined): boolean {
  const normalized = normalizeBridgeUrl(value);
  if (!normalized) return false;

  try {
    const url = new URL(normalized);
    return url.hostname.endsWith(".workers.dev");
  } catch {
    return normalized.includes("workers.dev");
  }
}

function tryParseOrigin(value: string | null | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

function resolveGeminiBridgeUrls(runtimeConfig?: AIRuntimeConfig): string[] {
  const direct = normalizeBridgeUrl(runtimeConfig?.geminiBridgeUrl);
  const explicit = Array.isArray(runtimeConfig?.geminiBridgeUrls)
    ? runtimeConfig?.geminiBridgeUrls.map((value) => normalizeBridgeUrl(value)).filter(Boolean)
    : [];

  const combined = [...explicit, direct].filter(Boolean);
  return Array.from(new Set(combined));
}

async function callSingleGeminiBridge(
  bridgeUrl: string,
  runtimeConfig: AIRuntimeConfig | undefined,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(bridgeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(runtimeConfig?.authToken
        ? { Authorization: `Bearer ${runtimeConfig.authToken}` }
        : {}),
      ...(runtimeConfig?.geminiBridgeSecret
        ? { "x-gemini-bridge-secret": runtimeConfig.geminiBridgeSecret }
        : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = (await response.text()).trim();
    throw new Error(
      errorText
        ? `Gemini bridge failed: ${response.status} ${errorText}`
        : `Gemini bridge failed: ${response.status}`
    );
  }

  const data = await response.json() as Record<string, unknown>;
  return data && typeof data === "object" ? data : {};
}

async function callGeminiBridge(
  runtimeConfig: AIRuntimeConfig | undefined,
  payload: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const bridgeUrls = resolveGeminiBridgeUrls(runtimeConfig);
  if (bridgeUrls.length === 0) {
    return null;
  }

  let lastError: Error | null = null;
  for (const bridgeUrl of bridgeUrls) {
    try {
      return await callSingleGeminiBridge(bridgeUrl, runtimeConfig, payload);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError || new Error("Gemini bridge failed");
}

async function readProviderError(prefix: string, response: Response): Promise<never> {
  const errorText = (await response.text()).trim();
  throw new Error(errorText ? `${prefix}: ${response.status} ${errorText}` : `${prefix}: ${response.status}`);
}

function getModelTierFromPricing(pricing: unknown, id: string): "free" | "paid" | "unknown" {
  if (id.includes(":free")) return "free";
  if (!pricing || typeof pricing !== "object") return "unknown";

  const values = Object.values(pricing as Record<string, unknown>)
    .map((value) => Number.parseFloat(String(value)))
    .filter((value) => Number.isFinite(value));

  if (values.length === 0) return "unknown";
  return values.every((value) => value === 0) ? "free" : "paid";
}

function isOpenAITextModel(id: string): boolean {
  const lower = id.toLowerCase();
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

  // Filter out non-text models that can't handle text input
  if (
    lower.includes("clipboard") ||
    lower.includes("image") ||
    lower.includes("vision") ||
    lower.includes("embed") ||
    lower.includes("tts") ||
    lower.includes("whisper") ||
    lower.includes("audio") ||
    lower.includes("transcribe")
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

function isGroqTextModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !(
    lower.includes("whisper") ||
    lower.includes("tts") ||
    lower.includes("guard") ||
    lower.includes("vision-preview")
  );
}

function isGrokTextModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !(lower.includes("image") || lower.includes("tts") || lower.includes("vision"));
}

function isGeminiTextModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (!lower.startsWith("gemini-")) {
    return false;
  }

  if (GEMINI_DEPRECATED_MODEL_IDS.has(lower)) {
    return false;
  }

  return !GEMINI_EXCLUDED_MODEL_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function getGeminiModelPriority(id: string): number {
  const exactIndex = GEMINI_DEFAULT_TEXT_MODELS.indexOf(id);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const lower = id.toLowerCase();
  if (lower.startsWith("gemini-3")) return 100;
  if (lower.startsWith("gemini-2.5")) return 200;
  if (lower.startsWith("gemini-2.0")) return 300;
  if (lower.startsWith("gemini-1.5")) return 400;
  return 500;
}

function compareGeminiModels(a: AIModelOption, b: AIModelOption): number {
  const priorityDelta = getGeminiModelPriority(a.id) - getGeminiModelPriority(b.id);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return compareModels(a, b);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Fall through to object extraction.
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Could not parse JSON object from provider response");
  }

  const parsed = JSON.parse(match[0]);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Provider JSON response was not an object");
  }

  return parsed as Record<string, unknown>;
}

function cleanStringList(value: unknown, limit: number, hashtagMode = false): string[] {
  if (!Array.isArray(value)) return [];

  function normalize(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isDuplicate(newItem: string, existing: string[]): boolean {
    const normalizedNew = normalize(newItem);
    return existing.some((item) => normalize(item) === normalizedNew);
  }

  const seen: string[] = [];
  const items = value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => (hashtagMode ? (item.startsWith("#") ? item : `#${item.replace(/^#+/, "")}`) : item))
    .filter((item) => !isDuplicate(item, seen))
    .slice(0, limit)
    .forEach((item) => seen.push(item));

  return seen;
}

function cleanTextBlock(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\r\n?/g, "\n").trim();
}

function parseTimestampSeconds(value: unknown): number | null {
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

// Detect concrete contact references the user actually wrote into the prompt.
// We pass these to the LLM as an explicit "allow list" so it knows it has no
// permission to invent any other domain/handle/number on its own. The same
// extractor is reused server-side to strip fabricated URLs from the response.
function extractAllowedReferences(topic: string): {
  domains: string[];
  urls: string[];
  phones: string[];
  handles: string[];
  hasAny: boolean;
} {
  const text = String(topic || "");

  // Domains: capture word.word(.word)+ with a TLD-shaped tail. Generous on
  // length to allow shop.example.co.uk style. Lowercased and deduped.
  const domainRe = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;
  const urlRe = /\bhttps?:\/\/[^\s<>"']+/gi;
  const phoneRe = /(?:\+?\d[\d\s().-]{6,}\d)/g;
  const handleRe = /(?:^|[^a-z0-9_])@([a-z0-9_.]{2,32})\b/gi;

  const domains = Array.from(new Set(
    (text.match(domainRe) || []).map((d) => d.toLowerCase()),
  ));
  const urls = Array.from(new Set(text.match(urlRe) || []));
  const phones = Array.from(new Set((text.match(phoneRe) || []).map((p) => p.trim())));

  const handles: string[] = [];
  let handleMatch: RegExpExecArray | null;
  while ((handleMatch = handleRe.exec(text)) !== null) {
    const h = `@${handleMatch[1]}`;
    if (!handles.includes(h)) handles.push(h);
  }

  return {
    domains,
    urls,
    phones,
    handles,
    hasAny: domains.length + urls.length + phones.length + handles.length > 0,
  };
}

function buildTaglinesPrompt({ topic, count }: GenerateTaglinesInput): GenerationMessages {
  const allowed = extractAllowedReferences(topic);

  const allowedSummary = allowed.hasAny
    ? [
        "ALLOWED contact references the user explicitly provided (you may ONLY use these — nothing else):",
        allowed.domains.length ? `  • Domains: ${allowed.domains.join(", ")}` : "",
        allowed.urls.length ? `  • URLs: ${allowed.urls.join(", ")}` : "",
        allowed.phones.length ? `  • Phone numbers: ${allowed.phones.join(", ")}` : "",
        allowed.handles.length ? `  • Social handles: ${allowed.handles.join(", ")}` : "",
      ].filter(Boolean).join("\n")
    : [
        "ALLOWED contact references the user explicitly provided: NONE.",
        "Because the user did NOT provide any website / domain / URL / phone / handle, your bottom taglines MUST NOT contain any of these. No '.com', no '.in', no '.net', no '.co', no '.pk', no '.io', no slash URLs, no '@handle', no phone numbers. Write a plain action or curiosity CTA instead.",
      ].join("\n");

  return {
    system: [
      "You create short-form video overlay copy. Return valid JSON only — no markdown, no prose, no code fences.",
      "Follow the user's prompt LITERALLY. You are only allowed to use a website, domain, URL, phone number, social handle, brand name, or any other contact reference if it appears character-for-character in the user's prompt.",
      "Inventing, guessing, fabricating, modifying, abbreviating, hallucinating, or stitching together any website / domain / URL / phone / handle that is not literally present in the user's prompt is FORBIDDEN — not even in examples, not even as a placeholder, not even if it 'sounds plausible'.",
      "When the user provides no contact references, your bottom taglines must contain ZERO domains, ZERO URLs, ZERO '.com'/'.in'/'.net'/'.co'/'.pk'/'.io' style strings, ZERO '@handles', and ZERO phone numbers.",
      "Never generate duplicate taglines — even if they differ slightly in wording, they must be meaningfully different.",
    ].join(" "),
    user: [
      `Generate exactly ${count} TOP taglines and exactly ${count} BOTTOM taglines for a short-form video.`,
      `Topic / user prompt: ${topic}`,
      "",
      allowedSummary,
      "",
      "TOP TAGLINES (curiosity hooks that describe or tease the video):",
      "- Describe WHAT is happening, or create curiosity / surprise / a question.",
      "- Short, punchy phrases that make viewers stop scrolling and watch.",
      "- Never include any link, domain, phone, or social handle in TOP taglines — ever.",
      "- Style examples (do NOT copy verbatim, just match the energy): 'What he did next will shock you', 'This is not what it looks like', 'She never expected this'.",
      "",
      "BOTTOM TAGLINES — pick the ONE rule below that matches what the user actually provided:",
      "",
      "  Rule A — User's prompt contains a website / domain / URL:",
      "    • Use ONLY that exact domain, character-for-character. Strip 'https://' and 'www.' but do NOT change anything else.",
      "    • If the user wrote 'shop.example.in', use 'shop.example.in' — do not shorten it to 'example.in', do not change '.in' to '.com'.",
      "    • Format the CTA naturally around that domain: 'Order on <domain>', 'Available at <domain>', 'Get yours on <domain>'.",
      "    • Vary the verb across the bottom taglines, but the domain itself must be identical in every one.",
      "",
      "  Rule B — User's prompt contains a phone number:",
      "    • Use that exact phone number, formatted naturally. Example: 'Call 0300-1234567', 'WhatsApp 0300-1234567'.",
      "    • Do NOT invent a domain alongside it.",
      "",
      "  Rule C — User's prompt contains a social handle / Instagram / TikTok / brand username:",
      "    • Reference that exact handle. Example: 'Follow @brand', 'Find us @brand on Instagram'.",
      "    • Do NOT invent a domain alongside it.",
      "",
      "  Rule D — User's prompt contains NONE of the above (no website, no domain, no phone, no handle):",
      "    • Your bottom taglines must contain ZERO link-like text. No '.com', no '.in', no '.net', no '.co', no '.pk', no '.io', no URLs, no '@handles', no phone numbers, no 'visit our website', no 'check link in bio', no 'DM us', no 'tap the link'.",
      "    • Write a plain action / curiosity / urgency CTA instead.",
      "    • GOOD examples (no link): 'You have to see the ending', 'Watch till the last second', 'Try it before it sells out', 'Wait for the twist', 'This one is worth the watch'.",
      "    • BAD examples (forbidden — these invent fake links): 'Order on pranks.com', 'Get yours at storehub.com', 'Shop now at funnyvideos.in', 'Visit puzzlebooks.net', 'Find it on shop.com'.",
      "",
      "- Keep every bottom tagline short and punchy.",
      "- Avoid generic clichés like 'Follow for more', 'Like and subscribe', 'Don't forget to share'.",
      "",
      "GLOBAL RULES:",
      "- The ALLOWED references list above is the COMPLETE set of contact info you may reference. If it says NONE, then NONE means ZERO links of any kind.",
      "- Never invent a domain, phone number, handle, or contact info that is not literally in the user's prompt.",
      "- Never generate duplicate taglines — each must be unique in meaning AND wording.",
      "- Top and bottom taglines should complement each other, not overlap.",
      "- Avoid emojis entirely.",
      "- Each tagline should work alone but pair well with the other section.",
      "",
      'Return JSON with this exact shape: {"top":["..."],"bottom":["..."]}',
    ].join("\n"),
  };
}

function buildSocialPrompt({ topic, platform, count, focusKeyword, brief }: GenerateSocialInput): GenerationMessages {
  const hashtagCount = Math.min(Math.max(count * 3, 10), 40);
  const spec = getPlatformContentSpec(platform);
  const keyword = String(focusKeyword || "").trim();
  const briefText = String(brief || "").trim();

  const lines: string[] = [
    `Generate social media metadata for ${platform}.`,
    `Topic: ${topic}`,
  ];

  if (keyword) {
    lines.push(`Focus keyword: ${keyword}`);
  }
  if (briefText) {
    lines.push(`Brief / angle (MUST be fully covered, do not ignore or narrow it): ${briefText}`);
  }

  lines.push(
    "",
    `Create exactly ${count} titles.`,
    `Create exactly ${count} descriptions.`,
    `Create exactly ${hashtagCount} hashtags.`,
    "",
    "TITLE rules:",
    `- Catchy, ${platform}-native, and specific to the topic — never generic filler.`,
    `- Each title must be at most ${spec.titleMaxChars} characters (the ${platform} limit).`,
    ...(keyword ? [`- Naturally include the focus keyword "${keyword}" in every title.`] : []),
    "",
    "DESCRIPTION rules:",
    `- Write broad, detailed, complete descriptions — NOT short. Target ${spec.descWordsMin}-${spec.descWordsMax} words each.`,
    "- Fully cover the topic" + (briefText ? " and the brief/angle above" : "") + "; be informative and engaging, not a one-line caption.",
    ...(keyword ? [`- Use the focus keyword "${keyword}" exactly TWICE in each description, placed naturally.`] : []),
    "- Each description must read as a finished, publishable caption — never cut off mid-thought.",
    "",
    "HASHTAG rules:",
    "- Unique, relevant to the topic, no duplicates, no spaces inside a tag.",
    "",
    'Return JSON with this exact shape: {"titles":["..."],"descriptions":["..."],"hashtags":["#..."]}',
  );

  return {
    system: [
      "You are an expert social media copywriter and SEO strategist.",
      "Think broadly and creatively: cover the FULL topic and brief, explore angles, and write substantive copy.",
      "Follow the length, keyword, and platform rules in the user message exactly.",
      "Never produce generic, repetitive, or artificially short filler.",
      "Return valid JSON only. No markdown, no prose, no code fences.",
    ].join("\n"),
    user: lines.join("\n"),
  };
}

function buildShortPromptPlanMessages({ prompt }: GenerateShortPromptPlanInput): GenerationMessages {
  return {
    system:
      "You convert pasted short-video planning text into structured JSON. Return valid JSON only. No markdown, no prose, no code fences.",
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

async function parseTextResponse(response: Response): Promise<string> {
  const payload = await response.json() as Record<string, unknown>;

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (Array.isArray(payload.output)) {
    const text = (payload.output as Array<Record<string, unknown>>)
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
    const text = (payload.choices as Array<Record<string, unknown>>)
      .map((choice) => {
        const message = choice.message as Record<string, unknown> | undefined;
        if (typeof message?.content === "string") return message.content;
        return "";
      })
      .join("\n");

    if (text.trim()) return text;
  }

  throw new Error("Provider returned no usable text");
}

async function generateWithOpenAI(
  apiKey: string,
  model: string,
  messages: GenerationMessages
): Promise<string> {
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
      max_output_tokens: AI_MAX_OUTPUT_TOKENS,
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
      max_tokens: AI_MAX_OUTPUT_TOKENS,
    }),
  });

  if (!fallback.ok) {
    const errorText = await fallback.text();
    throw new Error(`OpenAI request failed: ${fallback.status} ${errorText}`);
  }

  return parseTextResponse(fallback);
}

async function generateWithOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: GenerationMessages,
  extraHeaders?: Record<string, string>
): Promise<string> {
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
      max_tokens: AI_MAX_OUTPUT_TOKENS,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Provider request failed: ${response.status} ${errorText}`);
  }

  return parseTextResponse(response);
}

async function generateWithGemini(
  apiKey: string,
  model: string,
  messages: GenerationMessages,
  runtimeConfig?: AIRuntimeConfig
): Promise<string> {
  const bridged = await callGeminiBridge(runtimeConfig, {
    action: "generate",
    apiKey,
    model,
    messages,
  });
  if (bridged) {
    const text = typeof bridged.text === "string" ? bridged.text : "";
    if (!text.trim()) {
      throw new Error("Gemini bridge returned no usable text");
    }
    return text;
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `${messages.system}\n\n${messages.user}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
          maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no usable text");
  return text;
}

async function generateWithCohere(
  apiKey: string,
  model: string,
  messages: GenerationMessages
): Promise<string> {
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
      max_tokens: AI_MAX_OUTPUT_TOKENS,
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
        max_tokens: AI_MAX_OUTPUT_TOKENS,
      }),
    });

    if (!fallback.ok) {
      const errorText = await fallback.text();
      throw new Error(`Cohere request failed: ${fallback.status} ${errorText}`);
    }

    const payload = await fallback.json() as {
      message?: { content?: Array<{ text?: string }> };
    };

    const text = payload.message?.content?.find((item) => typeof item.text === "string")?.text;
    if (!text) throw new Error("Cohere returned no usable text");
    return text;
  }

  const payload = await response.json() as {
    message?: { content?: Array<{ text?: string }> };
  };
  const text = payload.message?.content?.find((item) => typeof item.text === "string")?.text;
  if (!text) throw new Error("Cohere returned no usable text");
  return text;
}

async function fetchOpenAIModels(apiKey: string): Promise<AIModelOption[]> {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    await readProviderError("OpenAI models failed", response);
  }

  const payload = await response.json() as { data?: Array<{ id: string }> };
  return uniqueModels(
    (payload.data || [])
      .filter((model) => model?.id && isOpenAITextModel(model.id))
      .map((model) => ({
        id: model.id,
        label: model.id,
        tier: "paid" as const,
      }))
      .sort(compareModels)
  );
}

async function fetchGeminiModels(apiKey: string): Promise<AIModelOption[]> {
  return fetchGeminiModelsWithRuntime(apiKey);
}

async function fetchGeminiModelsWithRuntime(
  apiKey: string,
  runtimeConfig?: AIRuntimeConfig
): Promise<AIModelOption[]> {
  const bridged = await callGeminiBridge(runtimeConfig, {
    action: "models",
    apiKey,
  });
  if (bridged) {
    const models = Array.isArray(bridged.models) ? bridged.models : [];
    return uniqueModels(
      models
        .filter((model): model is Record<string, unknown> => Boolean(model && typeof model === "object"))
        .map((model) => ({
          id: String(model.id || "").trim(),
          label: String(model.label || model.id || "").trim(),
          description: typeof model.description === "string" ? model.description : undefined,
          contextWindow: parseContextWindow(model.contextWindow ?? model.context_window),
          tier: "paid" as const,
        }))
        .filter((model) => model.id && isGeminiTextModel(model.id))
        .sort(compareGeminiModels)
    );
  }

  const params = new URLSearchParams({ key: apiKey.trim() });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`);
  if (!response.ok) {
    await readProviderError("Gemini models failed", response);
  }

  const payload = await response.json() as {
    models?: Array<{
      name: string;
      displayName?: string;
      description?: string;
      supportedGenerationMethods?: string[];
      inputTokenLimit?: number;
    }>;
  };

  return uniqueModels(
    (payload.models || [])
      .filter((model) => (model.supportedGenerationMethods || []).includes("generateContent"))
      .map((model) => {
        const id = model.name.replace(/^models\//, "");
        return {
          id,
          label: model.displayName || id,
          description: model.description,
          contextWindow: parseContextWindow(model.inputTokenLimit),
          tier: "paid" as const,
        };
      })
      .filter((model) => isGeminiTextModel(model.id))
      .sort(compareGeminiModels)
  );
}

async function fetchGrokModels(apiKey: string): Promise<AIModelOption[]> {
  const response = await fetch("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    await readProviderError("xAI models failed", response);
  }

  const payload = await response.json() as {
    data?: Array<{
      id: string;
      created?: number;
    }>;
  };

  return uniqueModels(
    (payload.data || [])
      .filter((model) => model?.id && isGrokTextModel(model.id))
      .map((model) => ({
        id: model.id,
        label: model.id,
        tier: "paid" as const,
      }))
      .sort(compareModels)
  );
}

async function fetchCohereModels(apiKey: string): Promise<AIModelOption[]> {
  const response = await fetch("https://api.cohere.com/v1/models?endpoint=chat&page_size=1000", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    await readProviderError("Cohere models failed", response);
  }

  const payload = await response.json() as {
    models?: Array<{
      name: string;
      is_deprecated?: boolean;
      endpoints?: string[];
      features?: string[];
      context_length?: number;
    }>;
  };

  return uniqueModels(
    (payload.models || [])
      .filter((model) => !model.is_deprecated)
      .filter((model) => {
        const endpoints = model.endpoints || [];
        const features = model.features || [];
        return endpoints.includes("chat") || features.includes("chat-completions");
      })
      .map((model) => ({
        id: model.name,
        label: model.name,
        contextWindow: parseContextWindow(model.context_length),
        tier: "paid" as const,
      }))
      .sort(compareModels)
  );
}

async function fetchOpenRouterModels(apiKey: string): Promise<AIModelOption[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    await readProviderError("OpenRouter models failed", response);
  }

  const payload = await response.json() as {
    data?: Array<{
      id: string;
      name?: string;
      description?: string;
      pricing?: Record<string, unknown>;
      context_length?: number;
      architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
      };
      top_provider?: {
        context_length?: number;
      };
    }>;
  };

  return uniqueModels(
    (payload.data || [])
      .filter((model) => {
        const outputModalities = model.architecture?.output_modalities || [];
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
            model.top_provider?.context_length ?? model.context_length
          ),
        };
      })
      .sort(compareModels)
  );
}

async function fetchGroqModels(apiKey: string): Promise<AIModelOption[]> {
  const response = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    await readProviderError("Groq models failed", response);
  }

  const payload = await response.json() as {
    data?: Array<{ id: string }>;
  };

  return uniqueModels(
    (payload.data || [])
      .filter((model) => model?.id && isGroqTextModel(model.id))
      .map((model) => ({
        id: model.id,
        label: model.id,
        tier: "paid" as const,
      }))
      .sort(compareModels)
  );
}

async function fetchProviderModels(
  provider: SupportedAIProvider,
  apiKey: string,
  runtimeConfig?: AIRuntimeConfig
): Promise<AIModelOption[]> {
  switch (provider) {
    case "openai":
      return fetchOpenAIModels(apiKey);
    case "gemini":
      return fetchGeminiModelsWithRuntime(apiKey, runtimeConfig);
    case "grok":
      return fetchGrokModels(apiKey);
    case "cohere":
      return fetchCohereModels(apiKey);
    case "openrouter":
      return fetchOpenRouterModels(apiKey);
    case "groq":
      return fetchGroqModels(apiKey);
  }
}

function fallbackModels(provider: SupportedAIProvider): AIModelOption[] {
  return PROVIDER_DEFAULT_MODELS[provider].map((id) => ({
    id,
    label: id,
    tier: id.includes(":free") ? "free" : "unknown",
  }));
}

export function getProviderApiKey(
  settings: AISettings,
  provider: SupportedAIProvider
): string {
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
  }
}

export function getConfiguredProviderIds(settings: AISettings): SupportedAIProvider[] {
  return PROVIDER_ORDER.filter((provider) => Boolean(getProviderApiKey(settings, provider)));
}

export async function buildAiCatalog(settings: AISettings): Promise<{
  default_provider: SupportedAIProvider | null;
  providers: AIProviderCatalogItem[];
  cloudflare_visual: CloudflareVisualCatalog;
}>;
export async function buildAiCatalog(
  settings: AISettings,
  runtimeConfig: AIRuntimeConfig
): Promise<{
  default_provider: SupportedAIProvider | null;
  providers: AIProviderCatalogItem[];
  cloudflare_visual: CloudflareVisualCatalog;
}>;
export async function buildAiCatalog(
  settings: AISettings,
  runtimeConfig?: AIRuntimeConfig
): Promise<{
  default_provider: SupportedAIProvider | null;
  providers: AIProviderCatalogItem[];
  cloudflare_visual: CloudflareVisualCatalog;
}> {
  const configuredProviders = getConfiguredProviderIds(settings);
  const providers = await Promise.all(
    configuredProviders.map(async (provider) => {
      const apiKey = getProviderApiKey(settings, provider);
      try {
        const models = await fetchProviderModels(provider, apiKey, runtimeConfig);
        return {
          id: provider,
          label: PROVIDER_LABELS[provider],
          models: models.length > 0 ? models : fallbackModels(provider),
        } satisfies AIProviderCatalogItem;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to fetch models";
        return {
          id: provider,
          label: PROVIDER_LABELS[provider],
          models: fallbackModels(provider),
          error: message,
        } satisfies AIProviderCatalogItem;
      }
    })
  );

  const defaultProvider = configuredProviders.includes(settings.default_provider as SupportedAIProvider)
    ? (settings.default_provider as SupportedAIProvider)
    : configuredProviders[0] || null;

  return {
    default_provider: defaultProvider,
    providers,
    cloudflare_visual: getCloudflareVisualCatalog(),
  };
}

export function resolveModelForProvider(
  provider: SupportedAIProvider,
  preferredModel: string | undefined,
  catalog: AIProviderCatalogItem[]
): string {
  const providerModels = catalog.find((item) => item.id === provider)?.models || [];
  if (preferredModel && providerModels.some((model) => model.id === preferredModel)) {
    return preferredModel;
  }

  const configuredDefault = PROVIDER_DEFAULT_MODELS[provider].find((id) =>
    providerModels.some((model) => model.id === id)
  );
  if (configuredDefault) return configuredDefault;

  return providerModels[0]?.id || PROVIDER_DEFAULT_MODELS[provider][0];
}

export async function generateAiJson(
  settings: AISettings,
  provider: SupportedAIProvider,
  model: string,
  messages: GenerationMessages,
  runtimeConfig?: AIRuntimeConfig
): Promise<Record<string, unknown>> {
  const apiKey = getProviderApiKey(settings, provider);
  if (!apiKey) {
    throw new Error(`No API key saved for ${PROVIDER_LABELS[provider]}`);
  }

  let rawText = "";
  switch (provider) {
    case "openai":
      rawText = await generateWithOpenAI(apiKey, model, messages);
      break;
    case "gemini":
      rawText = await generateWithGemini(apiKey, model, messages, runtimeConfig);
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
          "HTTP-Referer": "https://frontend-nine-jet-27.vercel.app",
          "X-Title": "Automation Frontend",
        }
      );
      break;
    case "groq":
      rawText = await generateWithOpenAICompatible(
        "https://api.groq.com/openai/v1",
        apiKey,
        model,
        messages
      );
      break;
  }

  return parseJsonObject(rawText);
}

export async function testGeminiApiKey(
  apiKey: string,
  runtimeConfig?: AIRuntimeConfig
): Promise<void> {
  await fetchGeminiModelsWithRuntime(apiKey, runtimeConfig);
}

export function buildAiRuntimeConfig(
  env: Pick<Env, "FRONTEND_URL" | "GEMINI_BRIDGE_URL" | "GEMINI_BRIDGE_SECRET">,
  options?: {
    request?: Request | null;
    authHeader?: string | null;
    authToken?: string | null;
  }
): AIRuntimeConfig {
  const frontendUrl = normalizeBridgeUrl(env.FRONTEND_URL);
  const directBridgeUrl = normalizeBridgeUrl(env.GEMINI_BRIDGE_URL);
  const requestOrigin = tryParseOrigin(options?.request?.headers.get("origin"));
  const refererOrigin = tryParseOrigin(options?.request?.headers.get("referer"));
  const authToken = String(
    options?.authToken
    || getAuthTokenFromHeader(options?.authHeader)
    || getAuthTokenFromHeader(options?.request?.headers.get("authorization"))
    || ""
  ).trim();

  const candidates = [
    directBridgeUrl,
    requestOrigin ? `${requestOrigin}/api/internal/gemini` : "",
    refererOrigin ? `${refererOrigin}/api/internal/gemini` : "",
    frontendUrl ? `${frontendUrl}/api/internal/gemini` : "",
  ]
    .map((value) => normalizeBridgeUrl(value))
    .filter(Boolean)
    .filter((value) => !isWorkerLikeOrigin(value));

  return {
    geminiBridgeUrl: candidates[0] || "",
    geminiBridgeUrls: Array.from(new Set(candidates)),
    geminiBridgeSecret: String(env.GEMINI_BRIDGE_SECRET || "").trim(),
    authToken,
  };
}

// Last line of defence. Even with the most carefully worded prompt, LLMs
// (especially smaller open-weight ones) will still occasionally invent a
// '.com' CTA when the user did not provide one. This filter runs over every
// generated tagline and removes any URL / domain / email / phone / handle
// that is not on the allow-list derived from the user's original prompt.
//
// If sanitising the tagline would leave it empty or stub-like, we replace it
// with a clean no-link fallback so the UI never shows a fabricated link.
function sanitizeTaglineAgainstAllowList(
  text: string,
  allowed: ReturnType<typeof extractAllowedReferences>,
  fallback: string,
): string {
  let out = String(text || "").trim();
  if (!out) return fallback;

  const allowedDomainSet = new Set(allowed.domains);
  const allowedHandleSet = new Set(allowed.handles.map((h) => h.toLowerCase()));
  const allowedPhoneDigits = new Set(allowed.phones.map((p) => p.replace(/\D+/g, "")));

  // 1) Strip http(s) URLs that aren't in the allow-list.
  out = out.replace(/\bhttps?:\/\/\S+/gi, (match) => {
    if (allowed.urls.includes(match)) return match;
    try {
      const host = new URL(match).hostname.toLowerCase().replace(/^www\./, "");
      if (allowedDomainSet.has(host)) return host;
    } catch {}
    return "";
  });

  // 2) Strip bare domain mentions (foo.com / shop.bar.co.uk) that aren't allowed.
  out = out.replace(/\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi, (match) => {
    const lower = match.toLowerCase().replace(/^www\./, "");
    return allowedDomainSet.has(lower) ? lower : "";
  });

  // 3) Strip @handles that aren't allowed.
  out = out.replace(/(^|[^a-z0-9_])@([a-z0-9_.]{2,32})\b/gi, (match, lead, handle) => {
    return allowedHandleSet.has(`@${handle.toLowerCase()}`) ? match : lead;
  });

  // 4) Strip phone-number-shaped runs that aren't allowed.
  out = out.replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, (match) => {
    const digits = match.replace(/\D+/g, "");
    return allowedPhoneDigits.has(digits) ? match : "";
  });

  // 5) Strip standalone email addresses that aren't allowed.
  out = out.replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}\b/gi, (match) => {
    const host = match.split("@")[1]?.toLowerCase();
    return host && allowedDomainSet.has(host) ? match : "";
  });

  // Tidy up dangling connectors left behind by the strips ("Order on " → "Order").
  out = out
    .replace(/\s+/g, " ")
    .replace(/[\s,;:.!?-]+(?:on|at|via|from|to|@)\s*$/i, "")
    .replace(/^\s*(?:on|at|via|from|to|@)[\s,;:.!?-]+/i, "")
    .replace(/[\s,;:.!?-]+$/g, "")
    .trim();

  // Common "visit our website" / "check link in bio" placeholders the model
  // sometimes substitutes when forbidden from inventing a URL.
  if (
    /^(?:visit\s+our\s+website|check\s+(?:the\s+)?link\s+in\s+bio|dm\s+us|tap\s+the\s+link|link\s+in\s+bio)\b/i.test(out)
    || out.length < 3
  ) {
    return fallback;
  }

  // If the strip left only a verb-stub ("Order", "Get yours", "Shop now",
  // "Available"…) the tagline is meaningless without its target — fall back
  // to a clean no-link CTA instead of shipping the fragment.
  const verbStubRe = /^(?:order|shop(?:\s+now)?|get(?:\s+yours)?|available|find\s+us|find\s+it|grab\s+yours?|visit|check|follow|call|whatsapp|text|dm)\s*$/i;
  if (verbStubRe.test(out) || out.split(/\s+/).filter(Boolean).length < 2) {
    return fallback;
  }

  return out;
}

const NO_LINK_FALLBACK_BOTTOM_TAGLINES = [
  "You have to see this",
  "Watch till the very end",
  "Wait for the twist",
  "This one is worth the watch",
  "Try it before it sells out",
  "Don't miss the ending",
  "Save this for later",
  "Trust me, watch the end",
];

export function normalizeTaglinesResult(
  payload: Record<string, unknown>,
  count: number,
  topic?: string,
): { top: string[]; bottom: string[] } {
  const top = cleanStringList(payload.top, count);
  const bottom = cleanStringList(payload.bottom, count);

  if (top.length === 0 || bottom.length === 0) {
    throw new Error("Provider response did not include valid top/bottom taglines");
  }

  // Top taglines must never contain any link / handle / phone regardless
  // of what the user provided — the schema reserves bottom for the CTA.
  const emptyAllowed = extractAllowedReferences("");
  const cleanedTop = top.map((line, idx) => {
    const fallback = top[(idx + 1) % top.length] || "Watch this until the end";
    return sanitizeTaglineAgainstAllowList(line, emptyAllowed, fallback);
  });

  const allowed = extractAllowedReferences(topic || "");
  const cleanedBottom = bottom.map((line, idx) => {
    const fallback = NO_LINK_FALLBACK_BOTTOM_TAGLINES[idx % NO_LINK_FALLBACK_BOTTOM_TAGLINES.length];
    return sanitizeTaglineAgainstAllowList(line, allowed, fallback);
  });

  return { top: cleanedTop, bottom: cleanedBottom };
}

export function normalizeSocialResult(
  payload: Record<string, unknown>,
  count: number,
  platform?: string
): { titles: string[]; descriptions: string[]; hashtags: string[] } {
  const spec = getPlatformContentSpec(platform || "youtube");
  const titles = cleanStringList(payload.titles, count).map((title) => truncateTitleToChars(title, spec.titleMaxChars));
  // Descriptions are intentionally NOT word-truncated (broad is the goal);
  // only guard against absurdly long output beyond a generous char ceiling.
  const descCharCeiling = Math.max(600, spec.descWordsMax * 9);
  const descriptions = cleanStringList(payload.descriptions, count).map((desc) =>
    desc.length > descCharCeiling ? desc.slice(0, descCharCeiling).trim() : desc
  );
  const hashtags = cleanStringList(payload.hashtags, Math.min(Math.max(count * 3, 10), 40), true);

  if (titles.length === 0 || descriptions.length === 0 || hashtags.length === 0) {
    throw new Error("Provider response did not include valid titles, descriptions, and hashtags");
  }

  return { titles, descriptions, hashtags };
}

export function normalizeShortPromptPlanResult(payload: Record<string, unknown>): {
  overview: string;
  recommended_merge: boolean;
  segments: PromptPlanSegmentResult[];
  titles: string[];
  descriptions: string[];
  hashtags: string[];
} {
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
  const segments = rawSegments
    .map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const record = item as Record<string, unknown>;
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
    .filter((item): item is PromptPlanSegmentResult => Boolean(item));

  if (segments.length === 0) {
    throw new Error("Provider response did not include valid timestamp segments");
  }

  const socialSetCount = Math.max(segments.length, 1);
  const titles = cleanStringList(payload.titles, socialSetCount);
  const descriptions = cleanStringList(payload.descriptions, socialSetCount);
  const hashtags = cleanStringList(payload.hashtags, Math.min(Math.max(socialSetCount * 3, 3), 40), true);
  const overview = cleanTextBlock(payload.overview, `Prompt-based short plan with ${segments.length} segment(s).`);
  const recommendedMerge = payload.recommended_merge === true;

  return {
    overview,
    recommended_merge: recommendedMerge,
    segments,
    titles: titles.length > 0 ? titles : segments.map((segment) => segment.title),
    descriptions: descriptions.length > 0 ? descriptions : segments.map((segment) => segment.caption),
    hashtags: hashtags.length > 0
      ? hashtags
      : Array.from(new Set(segments.flatMap((segment) => segment.hashtags))).slice(0, 40),
  };
}

export function getTaglinesMessages(input: GenerateTaglinesInput): GenerationMessages {
  return buildTaglinesPrompt(input);
}

export function getSocialMessages(input: GenerateSocialInput): GenerationMessages {
  return buildSocialPrompt(input);
}

export function getShortPromptPlanMessages(input: GenerateShortPromptPlanInput): GenerationMessages {
  return buildShortPromptPlanMessages(input);
}
