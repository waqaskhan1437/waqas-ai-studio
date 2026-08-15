CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  access_token_hash TEXT UNIQUE,
  runner_token_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','suspended')),
  created_by_admin INTEGER DEFAULT 1,
  last_login_at DATETIME,
  revoked_at DATETIME,
  runner_hostname TEXT,
  runner_status TEXT,
  runner_started_at DATETIME,
  runner_last_seen_at DATETIME,
  runner_platform TEXT,
  runner_version TEXT,
  tailscale_status TEXT,
  tailscale_ip TEXT,
  tailscale_dns_name TEXT,
  ssh_status TEXT,
  ssh_target TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_type TEXT NOT NULL CHECK(key_type IN ('access','runner','webhook','external')),
  permissions TEXT DEFAULT 'read' CHECK(permissions IN ('read','write','admin','full')),
  description TEXT,
  scopes TEXT DEFAULT '[]',
  allowed_origins TEXT DEFAULT '[]',
  allow_production_deploy INTEGER DEFAULT 0,
  allow_direct_file_write INTEGER DEFAULT 0,
  last_used_at DATETIME,
  expires_at DATETIME,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  api_key_id INTEGER,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  request_size INTEGER,
  response_size INTEGER,
  duration_ms INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys(revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_audit_logs_user_id ON api_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_audit_logs_api_key_id ON api_audit_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_audit_logs_created_at ON api_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_api_audit_logs_endpoint ON api_audit_logs(endpoint);

CREATE TABLE IF NOT EXISTS ai_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  api_key_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  request_payload TEXT,
  result_payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_change_requests_user ON ai_change_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_change_requests_api_key ON ai_change_requests(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_change_requests_action ON ai_change_requests(action, created_at);

CREATE TABLE IF NOT EXISTS settings_postforme (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  api_key TEXT NOT NULL,
  platforms TEXT DEFAULT '[]',
  saved_accounts TEXT DEFAULT '[]',
  default_schedule TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings_github (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  pat_token TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  runner_labels TEXT DEFAULT 'self-hosted',
  workflow_dispatch_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings_video_sources (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  bunny_api_key TEXT,
  bunny_library_id TEXT,
  youtube_cookies TEXT,
  google_photos_cookies TEXT,
  youtube_cookies_meta TEXT,
  google_photos_cookies_meta TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings_ai (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  gemini_key TEXT,
  grok_key TEXT,
  cohere_key TEXT,
  openrouter_key TEXT,
  openai_key TEXT,
  groq_key TEXT,
  elevenlabs_api_key TEXT,
  default_provider TEXT DEFAULT 'openai',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings_tailscale (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  auth_key TEXT,
  tailnet TEXT,
  device_tag TEXT,
  hostname_prefix TEXT,
  auto_install INTEGER DEFAULT 0,
  ssh_enabled INTEGER DEFAULT 1,
  unattended INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('video','image','caption','dubbing')),
  status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed','failed')),
  config TEXT NOT NULL DEFAULT '{}',
  schedule TEXT,
  next_run DATETIME,
  last_run DATETIME,
  rotation_reset_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  automation_id INTEGER,
  status TEXT DEFAULT 'queued' CHECK(status IN ('queued','pending','running','success','failed','cancelled')),
  github_run_id INTEGER,
  github_run_url TEXT,
  input_data TEXT,
  output_data TEXT,
  logs TEXT,
  error_message TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE TABLE IF NOT EXISTS video_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  postforme_id TEXT,
  draft_post_id TEXT,
  media_url TEXT,
  thumbnail_url TEXT,
  upload_status TEXT DEFAULT 'pending' CHECK(upload_status IN ('pending','uploaded','posted','failed')),
  post_status TEXT DEFAULT 'pending' CHECK(post_status IN ('pending','scheduled','posted','failed')),
  scheduled_at DATETIME,
  posted_at DATETIME,
  platforms TEXT DEFAULT '[]',
  aspect_ratio TEXT DEFAULT '9:16',
  duration INTEGER,
  file_size INTEGER,
  post_metadata TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

-- Video Queue table for sequential YouTube video processing
CREATE TABLE IF NOT EXISTS video_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  video_url TEXT NOT NULL,
  video_title TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','downloaded','uploaded','completed','failed')),
  queue_position INTEGER NOT NULL,
  litterbox_url TEXT,
  litterbox_expires_at DATETIME,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME,
  FOREIGN KEY (automation_id) REFERENCES automations(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

-- Index for fast queue lookups
CREATE INDEX IF NOT EXISTS idx_video_queue_job_id ON video_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_video_queue_automation_id ON video_queue(automation_id);
CREATE INDEX IF NOT EXISTS idx_video_queue_status ON video_queue(status);
CREATE INDEX IF NOT EXISTS idx_video_queue_position ON video_queue(job_id, queue_position);



-- Add video_url column to jobs table if not exists (for Litterbox URLs)
-- ALTER TABLE jobs ADD COLUMN video_url TEXT;
-- Note: Run this separately as Cloudflare D1 doesn't support IF NOT EXISTS for ALTER TABLE

-- Add draft_post_id column to jobs table for review queue
-- ALTER TABLE jobs ADD COLUMN draft_post_id TEXT;
-- ALTER TABLE jobs ADD COLUMN video_expires_at DATETIME;

-- Processed videos table for deduplication in multi-video runs
CREATE TABLE IF NOT EXISTS processed_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  automation_id INTEGER NOT NULL,
  video_url TEXT NOT NULL,
  video_id TEXT,
  video_title TEXT,
  job_id INTEGER,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (automation_id) REFERENCES automations(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  UNIQUE(user_id, automation_id, video_url)
);

CREATE TABLE IF NOT EXISTS runner_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  requested_by_user_id INTEGER,
  command_type TEXT NOT NULL CHECK(command_type IN ('restart_runner','run_setup','sync_runner_code','refresh_remote_access','process_image','upload_media','fetch_videos','execute_script')),
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
  result_text TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_users_access_token_hash ON users(access_token_hash);
CREATE INDEX IF NOT EXISTS idx_users_runner_token_hash ON users(runner_token_hash);
CREATE INDEX IF NOT EXISTS idx_settings_postforme_user ON settings_postforme(user_id);
CREATE INDEX IF NOT EXISTS idx_settings_github_user ON settings_github(user_id);
CREATE INDEX IF NOT EXISTS idx_settings_video_sources_user ON settings_video_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_settings_ai_user ON settings_ai(user_id);
CREATE INDEX IF NOT EXISTS idx_settings_tailscale_user ON settings_tailscale(user_id);
CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_video_uploads_user ON video_uploads(user_id);
CREATE INDEX IF NOT EXISTS idx_processed_videos_automation ON processed_videos(automation_id);
CREATE INDEX IF NOT EXISTS idx_processed_videos_url ON processed_videos(automation_id, video_url);
CREATE INDEX IF NOT EXISTS idx_runner_commands_user_status ON runner_commands(user_id, status, created_at);

-- Social accounts table for direct posting (OAuth connected accounts)
CREATE TABLE IF NOT EXISTS social_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  platform_account_id TEXT NOT NULL,
  account_name TEXT,
  access_token TEXT NOT NULL,
  token_expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, platform, platform_account_id)
);

-- Social settings table for storing app credentials (App ID, Secret etc)
CREATE TABLE IF NOT EXISTS settings_social (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  facebook_app_id TEXT,
  facebook_app_secret TEXT,
  facebook_callback_url TEXT,
  youtube_client_id TEXT,
  youtube_client_secret TEXT,
  youtube_callback_url TEXT,
  tiktok_client_key TEXT,
  tiktok_client_secret TEXT,
  tiktok_callback_url TEXT,
  twitter_api_key TEXT,
  twitter_api_secret TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_social_accounts_user ON social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_accounts_platform ON social_accounts(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_settings_social_user ON settings_social(user_id);
