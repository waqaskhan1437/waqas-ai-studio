export interface Env {
  DB: D1Database;
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  ENVIRONMENT: string;
  FRONTEND_URL?: string;
  GEMINI_BRIDGE_URL?: string;
  GEMINI_BRIDGE_SECRET?: string;
  ADMIN_KEY?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
}

export interface User {
  id: number;
  name: string;
  email: string | null;
  role?: "admin" | "user";
  access_token_hash: string | null;
  runner_token_hash: string | null;
  status: "active" | "revoked" | "suspended";
  created_by_admin: number;
  last_login_at: string | null;
  revoked_at: string | null;
  runner_hostname?: string | null;
  runner_status?: string | null;
  runner_started_at?: string | null;
  runner_last_seen_at?: string | null;
  runner_platform?: string | null;
  runner_version?: string | null;
  tailscale_status?: string | null;
  tailscale_ip?: string | null;
  tailscale_dns_name?: string | null;
  ssh_status?: string | null;
  ssh_target?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AuthContext {
  userId: number;
  user: User;
  isAdmin: boolean;
  token: string;
  apiKeyId?: number;
  apiKeyType?: 'access' | 'runner' | 'webhook' | 'external';
  apiKeyPermissions?: string;
  apiKeyName?: string;
  apiKeyScopes?: string[];
  apiKeyScopesRaw?: string | null;
  apiKeyAllowProductionDeploy?: boolean;
  apiKeyAllowDirectFileWrite?: boolean;
}

export interface ApiKeyRecord {
  id: number;
  user_id: number;
  name: string;
  key_prefix: string;
  key_type: 'access' | 'runner' | 'webhook' | 'external';
  permissions: 'read' | 'write' | 'admin' | 'full';
  description?: string | null;
  scopes?: string | null;
  allowed_origins?: string | null;
  allow_production_deploy?: number | boolean | null;
  allow_direct_file_write?: number | boolean | null;
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PostformeSettings {
  id?: number;
  user_id?: number | null;
  api_key: string;
  platforms: string;
  saved_accounts: string;
  default_schedule: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface GithubSettings {
  id?: number;
  user_id?: number | null;
  pat_token: string;
  repo_owner: string;
  repo_name: string;
  runner_labels: string;
  workflow_dispatch_url: string;
  created_at?: string;
  updated_at?: string;
}

export interface VideoSourceSettings {
  id?: number;
  user_id?: number | null;
  bunny_api_key: string | null;
  bunny_library_id: string | null;
  youtube_cookies: string | null;
  google_photos_cookies: string | null;
  youtube_cookies_meta?: string | null;
  google_photos_cookies_meta?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AISettings {
  id?: number;
  user_id?: number | null;
  gemini_key: string | null;
  grok_key: string | null;
  cohere_key: string | null;
  openrouter_key: string | null;
  openai_key: string | null;
  groq_key: string | null;
  elevenlabs_api_key: string | null;
  default_provider: string;
  created_at?: string;
  updated_at?: string;
}

export interface TailscaleSettings {
  id?: number;
  user_id?: number | null;
  auth_key: string | null;
  tailnet: string | null;
  device_tag: string | null;
  hostname_prefix: string | null;
  auto_install: number | boolean;
  ssh_enabled: number | boolean;
  unattended: number | boolean;
  created_at?: string;
  updated_at?: string;
}

export interface WorkflowInputs {
  job_id: string;
  automation_id: string;
  dispatch_nonce?: string;
  worker_webhook_url: string;
  runtime_config_token?: string;
  runner_labels?: string;
}

export interface Automation {
  id?: number;
  user_id?: number;
  name: string;
  type: "dubbing" | "video" | "image" | "caption";
  status: "active" | "paused" | "completed" | "failed";
  config: string;
  schedule: string | null;
  next_run: string | null;
  last_run: string | null;
  rotation_reset_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Job {
  id?: number;
  user_id?: number;
  automation_id: number;
  automation_name?: string | null;
  status: "queued" | "pending" | "running" | "success" | "failed" | "cancelled";
  github_run_id: number | null;
  github_run_url: string | null;
  input_data: string | null;
  output_data: string | null;
  logs: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at?: string;
  video_url?: string | null;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  partial?: boolean;
}

export interface VideoUpload {
  id?: number;
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
  created_at?: string;
  updated_at?: string;
}

export interface RunnerCommand {
  id?: number;
  user_id: number;
  requested_by_user_id?: number | null;
  command_type: "restart_runner" | "run_setup" | "sync_runner_code" | "refresh_remote_access";
  payload: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result_text?: string | null;
  error_message?: string | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string;
}

export interface SocialAccount {
  id?: number;
  user_id: number;
  platform: string;
  platform_account_id: string;
  account_name: string | null;
  access_token: string;
  token_expires_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface SocialSettings {
  id?: number;
  user_id?: number | null;
  facebook_app_id: string | null;
  facebook_app_secret: string | null;
  facebook_callback_url: string | null;
  youtube_client_id: string | null;
  youtube_client_secret: string | null;
  youtube_callback_url: string | null;
  tiktok_client_key: string | null;
  tiktok_client_secret: string | null;
  tiktok_callback_url: string | null;
  twitter_api_key: string | null;
  twitter_api_secret: string | null;
  created_at?: string;
  updated_at?: string;
}
