"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { API_BASE_URL } from "@/lib/constants";

type ApiKeyRecord = {
  id: number;
  name: string;
  key_type: string;
  permissions: string;
  description: string | null;
  scopes: string[];
  allowed_origins: string[];
  allow_production_deploy: boolean;
  allow_direct_file_write: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

type CreatedApiKey = {
  id: number;
  key: string;
  name: string;
  key_type: string;
  permissions: string;
  scopes: string[];
  expires_at: string | null;
};

type Flash = {
  type: "success" | "error";
  text: string;
};

const SCOPE_GROUPS: Array<{ title: string; description: string; scopes: Array<{ id: string; label: string }> }> = [
  {
    title: "Project Read",
    description: "AI ko project overview, docs aur logs samajhne ke liye.",
    scopes: [
      { id: "project.read", label: "Project manifest" },
      { id: "files.read", label: "Repo files read" },
      { id: "git.read", label: "Git info read" },
      { id: "logs.read", label: "Logs/audit read" },
    ],
  },
  {
    title: "Code + Git Changes",
    description: "AI ko branch, commit aur pull request banane ke liye.",
    scopes: [
      { id: "files.write", label: "Files patch/commit" },
      { id: "git.branch.create", label: "Branch create" },
      { id: "git.commit", label: "Commit changes" },
      { id: "git.pull_request.create", label: "Pull request create" },
      { id: "deploy.trigger", label: "Test/deploy workflow trigger" },
    ],
  },
  {
    title: "App Control",
    description: "Automations, settings aur third-party integrations control ke liye.",
    scopes: [
      { id: "automation.read", label: "Automations read" },
      { id: "automation.write", label: "Automations create/update/delete" },
      { id: "settings.read", label: "Masked settings read" },
      { id: "settings.write", label: "Settings update" },
      { id: "integrations.manage", label: "Integrations/webhooks manage" },
    ],
  },
  {
    title: "Full Admin",
    description: "Testing ke liye maximum access. Key leak ho to turant revoke karein.",
    scopes: [{ id: "admin.full", label: "Admin full control" }],
  },
];

const DEFAULT_SCOPES = [
  "project.read",
  "files.read",
  "files.write",
  "automation.read",
  "automation.write",
  "settings.read",
  "settings.write",
  "git.read",
  "git.branch.create",
  "git.commit",
  "git.pull_request.create",
  "logs.read",
];

const ENDPOINTS = [
  ["Manifest", "GET", "/api/ai/manifest"],
  ["Instructions", "GET", "/api/ai/instructions"],
  ["OpenAPI", "GET", "/api/ai/openapi.json"],
  ["Project Map", "GET", "/api/ai/project-map"],
  ["File Tree", "GET", "/api/ai/files/tree"],
  ["Read File", "GET", "/api/ai/files/read?path=worker/src/index.ts"],
  ["Patch Files", "POST", "/api/ai/files/patch"],
  ["Automations", "GET/POST", "/api/ai/automations"],
  ["Settings", "GET/PATCH", "/api/ai/settings"],
  ["Create Branch", "POST", "/api/ai/git/branch"],
  ["Create PR", "POST", "/api/ai/git/pr"],
  ["Run Tests", "POST", "/api/ai/tests/run"],
  ["Audit", "GET", "/api/ai/audit"],
  ["Monitor", "GET", "/api/ai/monitor"],
  ["Snapshot", "GET", "/api/ai/snapshot"],
  ["Browser Links", "GET", "/api/ai/browser-links"],
];

function formatDate(value?: string | null): string {
  if (!value) return "Never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function statusClass(key: ApiKeyRecord): string {
  if (key.revoked_at) return "border-red-500/25 bg-red-500/10 text-red-200";
  if (key.expires_at && Date.parse(key.expires_at) < Date.now()) return "border-amber-500/25 bg-amber-500/10 text-amber-200";
  return "border-emerald-500/25 bg-emerald-500/10 text-emerald-200";
}

function statusLabel(key: ApiKeyRecord): string {
  if (key.revoked_at) return "Revoked";
  if (key.expires_at && Date.parse(key.expires_at) < Date.now()) return "Expired";
  return "Active";
}

export default function AiAccessPage() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [message, setMessage] = useState<Flash | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [name, setName] = useState("AI Testing Key");
  const [description, setDescription] = useState("Temporary key for AI project audit, bug fixing and feature work.");
  const [permissions, setPermissions] = useState<"read" | "write" | "admin" | "full">("write");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [allowProductionDeploy, setAllowProductionDeploy] = useState(false);
  const [allowDirectFileWrite, setAllowDirectFileWrite] = useState(false);

  const activeKeys = useMemo(() => keys.filter((key) => !key.revoked_at).length, [keys]);
  const baseUrl = API_BASE_URL ? API_BASE_URL.replace(/\/$/, "") : "https://waqas-ai-studio.waqaskhan1437.workers.dev";

  const loadKeys = async () => {
    setLoading(true);
    try {
      const response = await api.get<ApiKeyRecord[]>("/api/keys");
      setKeys(response.data || []);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Failed to load API keys." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadKeys();
  }, []);

  const toggleScope = (scope: string) => {
    setScopes((previous) => {
      if (scope === "admin.full") {
        return previous.includes(scope) ? previous.filter((item) => item !== scope) : [scope];
      }
      const withoutAdmin = previous.filter((item) => item !== "admin.full");
      return withoutAdmin.includes(scope) ? withoutAdmin.filter((item) => item !== scope) : [...withoutAdmin, scope];
    });
  };

  const selectFullAccess = () => {
    setPermissions("full");
    setScopes(["admin.full"]);
    setAllowDirectFileWrite(true);
  };

  const selectSafeTesting = () => {
    setPermissions("write");
    setScopes(DEFAULT_SCOPES);
    setAllowDirectFileWrite(false);
    setAllowProductionDeploy(false);
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setMessage({ type: "error", text: "Key name required." });
      return;
    }

    setCreating(true);
    setMessage(null);
    setCreatedKey(null);

    try {
      const expires = Number.parseInt(expiresInDays, 10);
      const response = await api.post<CreatedApiKey>("/api/keys", {
        name: trimmedName,
        description: description.trim() || null,
        key_type: "access",
        permissions,
        scopes,
        expires_in_days: Number.isFinite(expires) && expires > 0 ? expires : undefined,
        allow_production_deploy: allowProductionDeploy,
        allow_direct_file_write: allowDirectFileWrite,
      });

      if (!response.success || !response.data?.key) {
        setMessage({ type: "error", text: response.error || "Failed to create API key." });
        return;
      }

      setCreatedKey(response.data);
      setMessage({ type: "success", text: "API key created. Copy it now; it will not be shown again." });
      await loadKeys();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Failed to create API key." });
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (label: string, value: string) => {
    const ok = await copyText(value);
    setMessage({ type: ok ? "success" : "error", text: ok ? `${label} copied.` : `Failed to copy ${label}.` });
  };

  const handleRotate = async (key: ApiKeyRecord) => {
    setActingId(key.id);
    setMessage(null);
    setCreatedKey(null);
    try {
      const response = await api.post<CreatedApiKey>(`/api/keys/${key.id}/rotate`);
      if (!response.success || !response.data?.key) {
        setMessage({ type: "error", text: response.error || "Failed to rotate key." });
        return;
      }
      setCreatedKey(response.data);
      setMessage({ type: "success", text: "Key rotated. Copy the new key now." });
      await loadKeys();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Failed to rotate key." });
    } finally {
      setActingId(null);
    }
  };

  const handleRevoke = async (key: ApiKeyRecord) => {
    const confirmed = window.confirm(`Revoke API key "${key.name}"? Any AI/tool using it will stop working.`);
    if (!confirmed) return;

    setActingId(key.id);
    setMessage(null);
    try {
      const response = await api.delete(`/api/keys/${key.id}`);
      if (!response.success) {
        setMessage({ type: "error", text: response.error || "Failed to revoke key." });
        return;
      }
      setMessage({ type: "success", text: "API key revoked." });
      await loadKeys();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Failed to revoke key." });
    } finally {
      setActingId(null);
    }
  };

  const manifestCurl = createdKey
    ? `curl -H "Authorization: Bearer ${createdKey.key}" "${baseUrl}/api/ai/manifest"`
    : `curl -H "Authorization: Bearer <API_KEY>" "${baseUrl}/api/ai/manifest"`;

  const patchExample = createdKey
    ? `curl -X POST "${baseUrl}/api/ai/files/patch" \\\n  -H "Authorization: Bearer ${createdKey.key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"branch":"ai/example-change","message":"AI example change","path":"README.md","content":"Updated by AI Developer API"}'`
    : `curl -X POST "${baseUrl}/api/ai/files/patch" \\\n  -H "Authorization: Bearer <API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"branch":"ai/example-change","message":"AI example change","path":"README.md","content":"Updated by AI Developer API"}'`;

  const browserSnapshotUrl = createdKey
    ? `${baseUrl}/api/ai/snapshot?ai_token=${createdKey.key}`
    : `${baseUrl}/api/ai/snapshot?ai_token=<API_KEY>`;

  const browserMonitorUrl = createdKey
    ? `${baseUrl}/api/ai/monitor?ai_token=${createdKey.key}`
    : `${baseUrl}/api/ai/monitor?ai_token=<API_KEY>`;

  const browserLinksUrl = createdKey
    ? `${baseUrl}/api/ai/browser-links?ai_token=${createdKey.key}`
    : `${baseUrl}/api/ai/browser-links?ai_token=<API_KEY>`;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <div className="mb-3 inline-flex rounded-full border border-[#8b5cf6]/30 bg-[#8b5cf6]/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[#c4b5fd]">
            AI Developer Access
          </div>
          <h2 className="text-3xl font-bold text-white">API Key Control System</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#a1a1aa]">
            Yahan se aap AI, Google Script ya kisi bhi third-party tool ke liye controlled API key bana sakte hain. Key repo files read/patch, automations modify, settings update, tests run aur PR create kar sakti hai.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4">
            <div className="text-xs uppercase tracking-[0.18em] text-[#71717a]">Total Keys</div>
            <div className="mt-1 text-2xl font-bold text-white">{keys.length}</div>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-5 py-4">
            <div className="text-xs uppercase tracking-[0.18em] text-emerald-200/80">Active</div>
            <div className="mt-1 text-2xl font-bold text-emerald-100">{activeKeys}</div>
          </div>
        </div>
      </div>

      {message && (
        <div className={`rounded-2xl px-4 py-3 text-sm ${message.type === "error" ? "border border-red-500/25 bg-red-500/10 text-red-200" : "border border-emerald-500/25 bg-emerald-500/10 text-emerald-200"}`}>
          {message.text}
        </div>
      )}

      {createdKey && (
        <section className="rounded-3xl border border-[#2563eb]/30 bg-[#2563eb]/10 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold text-white">New API Key Created</h3>
              <p className="mt-1 text-sm text-[#bfdbfe]">Is key ko abhi copy kar lein. Security ke liye yeh dobara plain text mein show nahi hogi.</p>
            </div>
            <button onClick={() => void handleCopy("API key", createdKey.key)} className="rounded-xl bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#1d4ed8]">
              Copy Key
            </button>
          </div>
          <code className="mt-4 block break-all rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white">{createdKey.key}</code>
          <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
            Browser/ChatGPT access ke liye Snapshot URL copy karein. Yeh GET-only monitoring link hai, is se AI manifest, automations, masked settings, logs aur project status read kar sakta hai. Write/patch actions ab bhi Authorization header ke sath rahenge.
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="mb-2 text-xs uppercase tracking-[0.16em] text-[#93c5fd]">Manifest Test</div>
              <pre className="whitespace-pre-wrap break-all text-xs leading-5 text-[#dbeafe]">{manifestCurl}</pre>
              <button onClick={() => void handleCopy("manifest curl", manifestCurl)} className="mt-3 rounded-xl border border-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/5">Copy Curl</button>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="mb-2 text-xs uppercase tracking-[0.16em] text-[#93c5fd]">ChatGPT Snapshot URL</div>
              <pre className="whitespace-pre-wrap break-all text-xs leading-5 text-[#dbeafe]">{browserSnapshotUrl}</pre>
              <button onClick={() => void handleCopy("snapshot URL", browserSnapshotUrl)} className="mt-3 rounded-xl border border-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/5">Copy Snapshot URL</button>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="mb-2 text-xs uppercase tracking-[0.16em] text-[#93c5fd]">Monitor URL</div>
              <pre className="whitespace-pre-wrap break-all text-xs leading-5 text-[#dbeafe]">{browserMonitorUrl}</pre>
              <button onClick={() => void handleCopy("monitor URL", browserMonitorUrl)} className="mt-3 rounded-xl border border-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/5">Copy Monitor URL</button>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="mb-2 text-xs uppercase tracking-[0.16em] text-[#93c5fd]">Patch Example</div>
              <pre className="whitespace-pre-wrap break-all text-xs leading-5 text-[#dbeafe]">{patchExample}</pre>
              <button onClick={() => void handleCopy("patch curl", patchExample)} className="mt-3 rounded-xl border border-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/5">Copy Curl</button>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4 lg:col-span-2">
              <div className="mb-2 text-xs uppercase tracking-[0.16em] text-[#93c5fd]">All Browser Links</div>
              <pre className="whitespace-pre-wrap break-all text-xs leading-5 text-[#dbeafe]">{browserLinksUrl}</pre>
              <button onClick={() => void handleCopy("browser links URL", browserLinksUrl)} className="mt-3 rounded-xl border border-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/5">Copy Browser Links URL</button>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-3xl border border-white/10 bg-[rgba(255,255,255,0.03)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold text-white">Create AI / Developer API Key</h3>
            <p className="mt-1 max-w-2xl text-sm text-[#a1a1aa]">Safe testing mode branch/PR flow use karta hai. Full admin mode sirf trusted AI/session ke liye use karein.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={selectSafeTesting} className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200 transition hover:bg-emerald-500/20">Safe Testing Preset</button>
            <button onClick={selectFullAccess} className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-2 text-sm text-amber-200 transition hover:bg-amber-500/20">Full Admin Preset</button>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div>
            <label className="mb-2 block text-xs uppercase tracking-[0.16em] text-[#71717a]">Key Name</label>
            <input value={name} onChange={(event) => setName(event.target.value)} className="glass-input" placeholder="ChatGPT Testing Key" />
          </div>
          <div>
            <label className="mb-2 block text-xs uppercase tracking-[0.16em] text-[#71717a]">Expiry Days</label>
            <input value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} className="glass-input" placeholder="7" />
          </div>
          <div className="lg:col-span-2">
            <label className="mb-2 block text-xs uppercase tracking-[0.16em] text-[#71717a]">Description</label>
            <input value={description} onChange={(event) => setDescription(event.target.value)} className="glass-input" placeholder="Temporary AI testing access" />
          </div>
          <div>
            <label className="mb-2 block text-xs uppercase tracking-[0.16em] text-[#71717a]">Permission Level</label>
            <select value={permissions} onChange={(event) => setPermissions(event.target.value as "read" | "write" | "admin" | "full")} className="glass-select">
              <option value="read">Read</option>
              <option value="write">Write</option>
              <option value="admin">Admin</option>
              <option value="full">Full</option>
            </select>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white">
              <input type="checkbox" checked={allowDirectFileWrite} onChange={(event) => setAllowDirectFileWrite(event.target.checked)} />
              Direct file write flag
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white">
              <input type="checkbox" checked={allowProductionDeploy} onChange={(event) => setAllowProductionDeploy(event.target.checked)} />
              Production deploy flag
            </label>
          </div>
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          {SCOPE_GROUPS.map((group) => (
            <div key={group.title} className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="mb-1 text-sm font-semibold text-white">{group.title}</div>
              <div className="mb-4 text-xs text-[#71717a]">{group.description}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.scopes.map((scope) => (
                  <label key={scope.id} className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[#d4d4d8] transition hover:bg-white/[0.07]">
                    <input type="checkbox" checked={scopes.includes(scope.id)} onChange={() => toggleScope(scope.id)} />
                    <span>{scope.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <button onClick={handleCreate} disabled={creating} className="mt-6 rounded-2xl bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
          {creating ? "Creating..." : "Create API Key"}
        </button>
      </section>

      <section className="rounded-3xl border border-white/10 bg-[rgba(255,255,255,0.03)] p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold text-white">Existing API Keys</h3>
            <p className="text-sm text-[#71717a]">Rotate ya revoke karne se connected AI/tool ka access update ho jayega.</p>
          </div>
          <button onClick={() => void loadKeys()} disabled={loading} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-white transition hover:bg-white/5 disabled:opacity-50">
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-[#71717a]">Loading keys...</p>
        ) : keys.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-8 text-center text-sm text-[#71717a]">No API keys yet.</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {keys.map((key) => (
              <div key={key.id} className="rounded-2xl border border-white/10 bg-black/20 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-base font-semibold text-white">{key.name}</h4>
                      <span className={`rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${statusClass(key)}`}>{statusLabel(key)}</span>
                    </div>
                    <p className="mt-1 text-sm text-[#a1a1aa]">{key.description || "No description"}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-[#d4d4d8]">{key.permissions}</div>
                </div>
                <div className="mt-4 grid gap-3 text-xs text-[#71717a] sm:grid-cols-2">
                  <span>Type: {key.key_type}</span>
                  <span>Created: {formatDate(key.created_at)}</span>
                  <span>Last used: {formatDate(key.last_used_at)}</span>
                  <span>Expires: {formatDate(key.expires_at)}</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {key.scopes.slice(0, 8).map((scope) => (
                    <span key={scope} className="rounded-full border border-[#6366f1]/20 bg-[#6366f1]/10 px-2.5 py-1 text-[11px] text-[#c4b5fd]">{scope}</span>
                  ))}
                  {key.scopes.length > 8 && <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-[#a1a1aa]">+{key.scopes.length - 8}</span>}
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <button onClick={() => void handleRotate(key)} disabled={actingId === key.id || Boolean(key.revoked_at)} className="rounded-xl border border-blue-500/25 bg-blue-500/10 px-4 py-2 text-sm text-blue-200 transition hover:bg-blue-500/20 disabled:opacity-50">
                    {actingId === key.id ? "Working..." : "Rotate"}
                  </button>
                  <button onClick={() => void handleRevoke(key)} disabled={actingId === key.id || Boolean(key.revoked_at)} className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-2 text-sm text-red-200 transition hover:bg-red-500/20 disabled:opacity-50">
                    {actingId === key.id ? "Working..." : "Revoke"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-white/10 bg-[rgba(255,255,255,0.03)] p-6">
        <h3 className="text-xl font-semibold text-white">AI API Endpoints</h3>
        <p className="mt-1 text-sm text-[#a1a1aa]">Kisi bhi AI ko base URL, API key aur manifest endpoint de dein. Woh baqi documentation khud fetch kar sakta hai.</p>
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {ENDPOINTS.map(([label, method, endpoint]) => (
            <div key={`${method}-${endpoint}`} className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 p-4">
              <div>
                <div className="text-sm font-semibold text-white">{label}</div>
                <code className="mt-1 block break-all text-xs text-[#a1a1aa]">{baseUrl}{endpoint}</code>
              </div>
              <span className="shrink-0 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-[#d4d4d8]">{method}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
