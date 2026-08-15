export interface Automation {
  id: number;
  name: string;
  type: "video" | "image" | "caption";
  status: "active" | "paused" | "completed" | "failed";
  schedule: string | null;
  config: string;
  next_run: string | null;
  last_run: string | null;
  created_at: string;
  updated_at?: string;
}

export interface Job {
  id: number;
  automation_id: number;
  status: "queued" | "running" | "success" | "failed" | "cancelled" | "pending";
  github_run_id: number | null;
  github_run_url: string | null;
  input_data: string | null;
  output_data: string | null;
  logs: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  video_url?: string | null;
}

export interface PostformeSettings {
  id?: number;
  api_key: string;
  platforms: string[];
  saved_accounts?: string;
  default_schedule: string | null;
}

export interface GithubSettings {
  id?: number;
  pat_token: string;
  repo_owner: string;
  repo_name: string;
  runner_labels: string;
  workflow_dispatch_url: string | null;
}

export interface VideoSourceSettings {
  id?: number;
  bunny_api_key: string | null;
  bunny_library_id: string | null;
  youtube_cookies: string | null;
  google_photos_cookies: string | null;
  youtube_cookie_summary?: CookieStorageSummary | null;
  google_photos_cookie_summary?: CookieStorageSummary | null;
  clear_youtube_cookies?: boolean;
  clear_google_photos_cookies?: boolean;
}

export interface CookieStorageSummary {
  present: boolean;
  cookie_count: number;
  session_cookie_count: number;
  domains: string[];
  sample_cookie_names: string[];
  updated_at: string | null;
  earliest_expiry: string | null;
  latest_expiry: string | null;
  youtube_auth_likely: boolean;
  missing_recommended_youtube_cookies: string[];
  warnings: string[];
}

export interface AISettings {
  id?: number;
  gemini_key: string | null;
  grok_key: string | null;
  cohere_key: string | null;
  openrouter_key: string | null;
  openai_key: string | null;
  groq_key: string | null;
  default_provider: string;
}

export interface AIModelOption {
  id: string;
  label: string;
  description?: string;
  tier?: "free" | "paid" | "unknown";
  contextWindow?: number | null;
}

export interface AIProviderCatalog {
  id: string;
  label: string;
  models: AIModelOption[];
  error?: string;
}

export interface CloudflareVisualModel {
  id: string;
  label: string;
  task: "image" | "video";
  description?: string;
  experimental?: boolean;
}

export interface CloudflareVisualCatalog {
  provider: "cloudflare";
  image_models: CloudflareVisualModel[];
  video_models: CloudflareVisualModel[];
  image_model_count: number;
  video_model_count: number;
  source?: string;
}

export interface AIModelCatalogResponse {
  default_provider: string | null;
  providers: AIProviderCatalog[];
  cloudflare_visual?: CloudflareVisualCatalog;
}

export interface SocialAccount {
  platform: string;
  username: string;
  connected: boolean;
  id: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface SessionUser {
  id: number;
  name: string;
  email: string | null;
  status: string;
  role: "admin" | "user";
  is_admin: boolean;
}

export interface JobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number?: number;
}

export interface RunningJob {
  jobId: number;
  status: string;
  githubRunUrl: string | null;
  steps: JobStep[];
  error: string | null;
  progress: number;
}

export interface TabProps {
  data: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

export type TaglineFontFamily = "ubuntu" | "dejavu" | "liberation" | "noto" | "lato" | "nimbus";
export type TaglineFontStyle = "normal" | "bold" | "italic" | "bold_italic" | "medium" | "medium_italic";
export type TaglineFontSize = "xs" | "sm" | "md" | "lg" | "xl";
export type TaglineBackgroundType = "none" | "box" | "rounded_box";

export interface TaglineStyleConfig {
  font_family: TaglineFontFamily;
  font_style: TaglineFontStyle;
  font_size: TaglineFontSize;
  font_color: string;
  background_type: TaglineBackgroundType;
  background_color: string;
  background_opacity: number;
  char_limit: number;
  wrap_enabled: boolean;
  wrap_max_chars: number;
  random_font_color: boolean;
  random_background: boolean;
}

export const TAGLINE_FONT_SIZES: Record<TaglineFontSize, number> = {
  xs: 24,
  sm: 32,
  md: 42,
  lg: 56,
  xl: 72
};

export const TAGLINE_FONT_COLORS = [
  { name: "White", value: "#FFFFFF" },
  { name: "Black", value: "#000000" },
  { name: "Yellow", value: "#FFEB3B" },
  { name: "Red", value: "#EF4444" },
  { name: "Blue", value: "#3B82F6" },
  { name: "Green", value: "#22C55E" },
  { name: "Purple", value: "#A855F7" },
  { name: "Orange", value: "#F97316" },
  { name: "Cyan", value: "#06B6D4" },
  { name: "Pink", value: "#EC4899" },
  { name: "Lime", value: "#84CC16" },
  { name: "Custom", value: "custom" }
];

export const TAGLINE_BG_COLORS = [
  { name: "Black", value: "#000000" },
  { name: "White", value: "#FFFFFF" },
  { name: "Red", value: "#EF4444" },
  { name: "Blue", value: "#3B82F6" },
  { name: "Green", value: "#22C55E" },
  { name: "Purple", value: "#A855F7" },
  { name: "Orange", value: "#F97316" },
  { name: "Cyan", value: "#06B6D4" },
  { name: "Random", value: "random" }
];

export const TAGLINE_CHAR_LIMITS = [
  { label: "None", value: 0 },
  { label: "50", value: 50 },
  { label: "100", value: 100 },
  { label: "150", value: 150 },
  { label: "200", value: 200 },
  { label: "Custom", value: -1 }
];

export const FORMAT_MAX_CHARS: Record<string, { default: number; vertical: number; horizontal: number }> = {
  "9:16": { default: 20, vertical: 20, horizontal: 25 },
  "16:9": { default: 45, vertical: 40, horizontal: 45 },
  "1:1": { default: 32, vertical: 30, horizontal: 35 },
  "4:5": { default: 35, vertical: 32, horizontal: 38 }
};

export interface WorkflowInputs {
  job_id: string;
  automation_id: string;
  video_source: string;
  video_url: string;
  youtube_channel_url: string;
  manual_links: string;
  videos_per_run: string;
  video_days: string;
  date_from: string;
  date_to: string;
  video_selection: string;
  source_shorts_mode: string;
  source_shorts_max_count: string;
  short_duration: string;
  playback_speed: string;
  aspect_ratio: string;
  split_enabled: string;
  split_duration: string;
  combine_enabled: string;
  combine_count: string;
  rotation_enabled: string;
  rotation_shuffle: string;
  rotation_auto_reset: string;
  whisper_enabled: string;
  whisper_language: string;
  top_taglines: string;
  bottom_taglines: string;
  tagline_rotation: string;
  branding_text_top: string;
  branding_text_bottom: string;
  watermark_text: string;
  watermark_position: string;
  watermark_fontsize: string;
  titles: string;
  descriptions: string;
  hashtags: string;
  content_rotation: string;
  output_format: string;
  output_quality: string;
  output_resolution: string;
  auto_publish: string;
  publish_mode: string;
  delay_minutes: string;
  schedule_date: string;
  schedule_time: string;
  schedule_spread_minutes: string;
  postforme_account_ids: string;
  postforme_schedule_timezone: string;
  postforme_account_stagger_enabled: string;
  postforme_account_stagger_min: string;
  postforme_account_stagger_max: string;
  run_mode: string;
  api_key_id: string;
}

export interface VideoUpload {
  id: number;
  job_id: number;
  postforme_id: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  upload_status: "pending" | "uploaded" | "posted" | "failed";
  post_status: "pending" | "scheduled" | "posted" | "failed";
  scheduled_at: string | null;
  posted_at: string | null;
  platforms: string;
  aspect_ratio: string;
  duration: number | null;
  file_size: number | null;
  post_metadata?: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
