"use client";
import { useState, useEffect } from "react";
import UserTokensSettings from "@/components/settings/UserTokensSettings";
import VideoSourceSettings from "@/components/settings/VideoSourceSettings";
import { useSessionUser } from "@/components/layout/ClientWrapper";

type Tab = "users" | "postforme" | "github" | "video" | "ai" | "social";

export default function SettingsPage() {
  const sessionUser = useSessionUser();
  const isAdmin = sessionUser?.is_admin === true;
  const [activeTab, setActiveTab] = useState<Tab>(isAdmin ? "users" : "postforme");

  useEffect(() => {
    setActiveTab(isAdmin ? "users" : "postforme");
  }, [isAdmin]);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "social", label: "Social Accounts", icon: "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" },
    { id: "postforme", label: "Postforme API", icon: "M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" },
    { id: "github", label: "GitHub Runner", icon: "M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2m-2-4h.01M17 16h.01" },
    { id: "video", label: "Video Sources", icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" },
    { id: "ai", label: "AI Settings", icon: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
  ];
  const visibleTabs = isAdmin
    ? [{ id: "users" as Tab, label: "Users", icon: "M17 20h5V4H2v16h5m10 0v-2a4 4 0 00-4-4H11a4 4 0 00-4 4v2m10 0H7m8-10a3 3 0 11-6 0 3 3 0 016 0z" }, ...tabs]
    : tabs;

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-3xl font-bold">Settings</h2>
        <p className="text-[#a1a1aa] mt-1">Configure your automation system</p>
      </div>

      <div className="flex gap-2 mb-6">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-5 py-3 rounded-xl font-medium text-sm transition-all ${
              activeTab === tab.id
                ? "bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] text-white"
                : "glass-button"
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
            </svg>
            {tab.label}
          </button>
        ))}
      </div>

      <div className="glass-card p-8">
        {activeTab === "users" && isAdmin && <UserTokensSettings />}
        {activeTab === "social" && <SocialAccountsSettings />}
        {activeTab === "postforme" && <PostformeSettings />}
        {activeTab === "github" && <GithubSettings />}
        {activeTab === "video" && <VideoSourceSettings />}
        {activeTab === "ai" && <AISettings />}
      </div>
    </div>
  );
}

function PostformeSettings() {
  const [apiKey, setApiKey] = useState("");
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncedAccounts, setSyncedAccounts] = useState<Array<{ platform: string; username: string; connected: boolean }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings/postforme")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.data) {
          setApiKey(data.data.api_key || "");
          try {
            const plats = JSON.parse(data.data.platforms || "[]");
            if (Array.isArray(plats)) setPlatforms(plats);
          } catch {}
          try {
            const accounts = JSON.parse(data.data.saved_accounts || "[]");
            if (Array.isArray(accounts)) setSyncedAccounts(accounts);
          } catch {}
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const allPlatforms = [
    { id: "instagram", label: "Instagram", color: "#E1306C" },
    { id: "youtube", label: "YouTube", color: "#FF0000" },
    { id: "tiktok", label: "TikTok", color: "#000000" },
    { id: "facebook", label: "Facebook", color: "#1877F2" },
    { id: "x", label: "X (Twitter)", color: "#1DA1F2" },
  ];

  const togglePlatform = (id: string) => {
    setPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const handleTest = async () => {
    if (!apiKey) {
      setTestResult({ success: false, message: "API key is empty" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/postforme/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
      });
      const data = await res.json();
      setTestResult({ success: data.success, message: data.message || data.error });
    } catch {
      setTestResult({ success: false, message: "Connection failed" });
    }
    setTesting(false);
  };

  const handleSync = async () => {
    if (!apiKey) {
      setTestResult({ success: false, message: "API key is empty" });
      return;
    }
    setSyncing(true);
    setSyncedAccounts([]);
    try {
      const res = await fetch("/api/settings/postforme/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        setSyncedAccounts(data.data);
        const connectedPlatforms = data.data.filter((a: { connected: boolean }) => a.connected).map((a: { platform: string }) => a.platform);
        setPlatforms(connectedPlatforms);
        const saveRes = await fetch("/api/settings/postforme", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            platforms: JSON.stringify(connectedPlatforms),
            saved_accounts: JSON.stringify(data.data),
          }),
        });
        const saveData = await saveRes.json().catch(() => ({ success: false, error: "Failed to save Postforme settings" }));
        if (!saveData.success) {
          setTestResult({ success: false, message: saveData.error || "Accounts synced but could not be saved locally" });
          return;
        }
        setTestResult({ success: true, message: `Found ${data.data.length} account(s)` });
      } else {
        setTestResult({ success: false, message: data.error || "Sync failed" });
      }
    } catch {
      setTestResult({ success: false, message: "Sync failed" });
    }
    setSyncing(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/postforme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          platforms: JSON.stringify(platforms),
        }),
      });
      const data = await res.json().catch(() => ({ success: false, error: "Failed to save settings" }));
      setTestResult({ success: Boolean(data.success), message: data.message || data.error || "Failed to save settings" });
    } catch (err) {
      setTestResult({ success: false, message: "Failed to save settings" });
    }
    setSaving(false);
  };

  return (
    <div>
      <h3 className="text-xl font-semibold mb-6">Postforme API Settings</h3>

      <div className="space-y-6">
        <div>
          <label className="block text-sm text-[#a1a1aa] mb-2">API Key</label>
          <input
            type="password"
            className="glass-input"
            placeholder="Enter your Postforme API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleTest}
            disabled={testing}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              testResult?.success === true
                ? "bg-[rgba(16,185,129,0.15)] text-[#10b981]"
                : testResult?.success === false && testResult?.message
                ? "bg-[rgba(239,68,68,0.15)] text-[#ef4444]"
                : "glass-button"
            }`}
          >
            {testing ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : testResult?.success === true ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : testResult?.success === false && testResult?.message ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            {testing ? "Testing..." : "Test API"}
          </button>

          <button
            onClick={handleSync}
            disabled={syncing}
            className="glass-button flex items-center gap-2 text-sm font-medium"
          >
            {syncing ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            {syncing ? "Syncing..." : "Sync Accounts"}
          </button>
        </div>

        {testResult && (
          <div className={`glass-card p-3 ${testResult.success ? "border-[rgba(16,185,129,0.3)]" : "border-[rgba(239,68,68,0.3)]"}`}>
            <p className={`text-sm ${testResult.success ? "text-[#10b981]" : "text-[#ef4444]"}`}>
              {testResult.message}
            </p>
          </div>
        )}

        {/* Synced Accounts */}
        {syncedAccounts.length > 0 && (
          <div className="glass-card p-5">
            <p className="text-sm font-medium mb-3">Synced Accounts</p>
            <div className="space-y-2">
              {syncedAccounts.map((account, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-[rgba(255,255,255,0.03)]">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${
                      account.platform === "instagram" ? "bg-[#E1306C]" :
                      account.platform === "youtube" ? "bg-[#FF0000]" :
                      account.platform === "tiktok" ? "bg-white" :
                      account.platform === "facebook" ? "bg-[#1877F2]" :
                      "bg-[#1DA1F2]"
                    }`} />
                    <span className="text-sm font-medium capitalize">{account.platform}</span>
                    <span className="text-xs text-[#a1a1aa]">@{account.username}</span>
                  </div>
                  <span className={`badge ${account.connected ? "badge-success" : "badge-failed"}`}>
                    {account.connected ? "Connected" : "Disconnected"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="glass-button-primary mt-4"
        >
          {saving ? "Saving..." : "Save Postforme Settings"}
        </button>
      </div>
    </div>
  );
}

function GithubSettings() {
  const [patToken, setPatToken] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [runnerLabels, setRunnerLabels] = useState("self-hosted");
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/github")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.data) {
          setPatToken(data.data.pat_token || "");
          setRepoOwner(data.data.repo_owner || "");
          setRepoName(data.data.repo_name || "");
          setRunnerLabels(data.data.runner_labels || "self-hosted");
        }
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pat_token: patToken,
          repo_owner: repoOwner,
          repo_name: repoName,
          runner_labels: runnerLabels,
        }),
      });
      alert("Settings saved!");
    } catch (err) {
      alert("Failed to save settings");
    }
    setSaving(false);
  };

  return (
    <div>
      <h3 className="text-xl font-semibold mb-6">GitHub Runner Configuration</h3>

      <div className="space-y-6">
        <div>
          <label className="block text-sm text-[#a1a1aa] mb-2">Personal Access Token (PAT)</label>
          <input
            type="password"
            className="glass-input"
            placeholder="ghp_xxxxxxxxxxxx"
            value={patToken}
            onChange={(e) => setPatToken(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#a1a1aa] mb-2">Repository Owner</label>
            <input
              type="text"
              className="glass-input"
              placeholder="username or org"
              value={repoOwner}
              onChange={(e) => setRepoOwner(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm text-[#a1a1aa] mb-2">Repository Name</label>
            <input
              type="text"
              className="glass-input"
              placeholder="repo-name"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-[#a1a1aa] mb-2">Runner Labels</label>
          <input
            type="text"
            className="glass-input"
            placeholder="self-hosted, linux, x64"
            value={runnerLabels}
            onChange={(e) => setRunnerLabels(e.target.value)}
          />
          <p className="text-xs text-[#a1a1aa] mt-1">Comma-separated labels for runner selection</p>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="glass-button-primary mt-4"
        >
          {saving ? "Saving..." : "Save GitHub Settings"}
        </button>
      </div>
    </div>
  );
}

/* ========== AI SETTINGS ========== */
function AISettings() {
  const [geminiKey, setGeminiKey] = useState("");
  const [grokKey, setGrokKey] = useState("");
  const [cohereKey, setCohereKey] = useState("");
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [defaultProvider, setDefaultProvider] = useState("openai");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  useEffect(() => {
    fetch("/api/settings/ai")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.data) {
          setGeminiKey(data.data.gemini_key || "");
          setGrokKey(data.data.grok_key || "");
          setCohereKey(data.data.cohere_key || "");
          setOpenrouterKey(data.data.openrouter_key || "");
          setOpenaiKey(data.data.openai_key || "");
          setGroqKey(data.data.groq_key || "");
          setElevenLabsKey(data.data.elevenlabs_api_key || "");
          setDefaultProvider(data.data.default_provider || "openai");
        }
      })
      .catch(() => {});
  }, []);

  const providers = [
    { id: "openai", label: "OpenAI", key: openaiKey, setKey: setOpenaiKey, placeholder: "sk-...", color: "#10a37f" },
    { id: "gemini", label: "Google Gemini", key: geminiKey, setKey: setGeminiKey, placeholder: "AIza...", color: "#4285f4" },
    { id: "grok", label: "xAI Grok", key: grokKey, setKey: setGrokKey, placeholder: "xai-...", color: "#1a1a1a" },
    { id: "cohere", label: "Cohere", key: cohereKey, setKey: setCohereKey, placeholder: "co-...", color: "#39594d" },
    { id: "openrouter", label: "OpenRouter", key: openrouterKey, setKey: setOpenrouterKey, placeholder: "sk-or-...", color: "#8b5cf6" },
    { id: "groq", label: "Groq (Fast)", key: groqKey, setKey: setGroqKey, placeholder: "gsk_...", color: "#f55036" },
  ];

  const handleTest = async (providerId: string, apiKey: string) => {
    if (!apiKey) {
      setTestResults((prev) => ({ ...prev, [providerId]: { success: false, message: "API key is empty" } }));
      return;
    }
    setTesting(providerId);
    setTestResults((prev) => ({ ...prev, [providerId]: { success: false, message: "" } }));
    try {
      const res = await fetch("/api/settings/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, api_key: apiKey }),
      });
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, [providerId]: { success: data.success, message: data.message || data.error } }));
    } catch {
      setTestResults((prev) => ({ ...prev, [providerId]: { success: false, message: "Connection failed" } }));
    }
    setTesting(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gemini_key: geminiKey,
          grok_key: grokKey,
          cohere_key: cohereKey,
          openrouter_key: openrouterKey,
          openai_key: openaiKey,
          groq_key: groqKey,
          elevenlabs_api_key: elevenLabsKey,
          default_provider: defaultProvider,
        }),
      });
      alert("AI settings saved!");
    } catch (err) {
      alert("Failed to save settings");
    }
    setSaving(false);
  };

  return (
    <div>
      <h3 className="text-xl font-semibold mb-2">AI Provider Settings</h3>
      <p className="text-sm text-[#a1a1aa] mb-6">Configure API keys for AI services used in automation</p>

      <div className="space-y-4">
        <div className="glass-card p-5 border border-cyan-400/15">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="font-medium text-sm">ElevenLabs Voice-over</p>
              <p className="mt-1 text-xs text-[#a1a1aa]">AI Video Generator ke Urdu, Hindi aur multilingual narration ke liye.</p>
            </div>
            <button
              onClick={() => handleTest("elevenlabs", elevenLabsKey)}
              disabled={testing !== null}
              className={`text-xs px-4 py-2 rounded-lg font-medium transition-all ${testResults.elevenlabs?.success === true ? "bg-[rgba(16,185,129,0.15)] text-[#10b981]" : testResults.elevenlabs?.success === false && testResults.elevenlabs?.message ? "bg-[rgba(239,68,68,0.15)] text-[#ef4444]" : "glass-button"}`}
            >
              {testing === "elevenlabs" ? "Testing..." : testResults.elevenlabs?.success === true ? "Connected" : testResults.elevenlabs?.success === false && testResults.elevenlabs?.message ? "Failed" : "Test"}
            </button>
          </div>
          <input type="password" className="glass-input text-sm w-full" placeholder="ElevenLabs API key" value={elevenLabsKey} onChange={(e) => setElevenLabsKey(e.target.value)} />
          {testResults.elevenlabs?.message && <p className={`text-xs mt-2 ${testResults.elevenlabs.success ? "text-[#10b981]" : "text-[#ef4444]"}`}>{testResults.elevenlabs.message}</p>}
        </div>
        {providers.map((provider) => (
          <div key={provider.id} className="glass-card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${provider.color}20` }}>
                  <svg className="w-4 h-4" fill="none" stroke={provider.color} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <p className="font-medium text-sm">{provider.label}</p>
                  {defaultProvider === provider.id && (
                    <span className="text-[10px] bg-[rgba(99,102,241,0.15)] text-[#6366f1] px-2 py-0.5 rounded-full font-medium">Default</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleTest(provider.id, provider.key)}
                disabled={testing !== null}
                className={`text-xs px-4 py-2 rounded-lg font-medium transition-all ${
                  testResults[provider.id]?.success === true
                    ? "bg-[rgba(16,185,129,0.15)] text-[#10b981]"
                    : testResults[provider.id]?.success === false && testResults[provider.id]?.message
                    ? "bg-[rgba(239,68,68,0.15)] text-[#ef4444]"
                    : "glass-button"
                }`}
              >
                {testing === provider.id ? (
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Testing...
                  </span>
                ) : testResults[provider.id]?.success === true ? (
                  "Connected"
                ) : testResults[provider.id]?.success === false && testResults[provider.id]?.message ? (
                  "Failed"
                ) : (
                  "Test"
                )}
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="password"
                className="glass-input text-sm flex-1"
                placeholder={provider.placeholder}
                value={provider.key}
                onChange={(e) => provider.setKey(e.target.value)}
              />
              {provider.key && (
                <button
                  onClick={() => setDefaultProvider(provider.id)}
                  className={`px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap ${
                    defaultProvider === provider.id ? "bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] text-white" : "glass-button"
                  }`}
                >
                  Set Default
                </button>
              )}
            </div>

            {testResults[provider.id]?.message && (
              <p className={`text-xs mt-2 ${testResults[provider.id]?.success ? "text-[#10b981]" : "text-[#ef4444]"}`}>
                {testResults[provider.id]?.message}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="glass-card p-4 mt-4">
        <p className="text-sm text-[#a1a1aa]">
          Default Provider: <span className="text-white font-medium capitalize">{defaultProvider}</span>
        </p>
        <p className="text-xs text-[#a1a1aa] mt-1">This provider will be used for AI-powered automation features</p>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="glass-button-primary mt-4"
      >
        {saving ? "Saving..." : "Save AI Settings"}
      </button>
    </div>
  );
}

function SocialAccountsSettings() {
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [accounts, setAccounts] = useState<Array<{ id: number; platform_account_id: string; account_name: string; created_at: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings();
    loadAccounts();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await fetch("/api/oauth/facebook/settings");
      const data = await res.json();
      if (data.success && data.data) {
        setAppId(data.data.facebook_app_id || "");
        setAppSecret(data.data.facebook_app_secret || "");
      }
    } catch {}
  };

  const loadAccounts = async () => {
    try {
      const res = await fetch("/api/oauth/facebook/accounts");
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setAccounts(data.data);
      }
    } catch {}
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/oauth/facebook/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facebook_app_id: appId, facebook_app_secret: appSecret }),
      });
      const data = await res.json();
      if (data.success) {
        alert("Facebook settings saved");
      } else {
        alert(data.error || "Failed to save");
      }
    } catch {
      alert("Failed to save");
    }
    setSaving(false);
  };

  const handleConnect = async () => {
    try {
      const res = await fetch("/api/oauth/facebook/url");
      const data = await res.json();
      if (data.success && data.data?.url) {
        window.location.href = data.data.url;
      } else {
        alert(data.error || "Failed to generate OAuth URL");
      }
    } catch {
      alert("Failed to connect");
    }
  };

  const handleDisconnect = async (id: number) => {
    if (!confirm("Disconnect this account?")) return;
    try {
      const res = await fetch(`/api/oauth/facebook/accounts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        loadAccounts();
      }
    } catch {}
  };

  return (
    <div>
      <div className="mb-8">
        <h3 className="text-xl font-semibold mb-1">Social Accounts</h3>
        <p className="text-sm text-[#a1a1aa]">Connect your social media accounts via OAuth for direct posting (no Postforme needed)</p>
      </div>

      <div className="mb-8 p-4 rounded-xl bg-[rgba(99,102,241,0.1)] border border-[#6366f1]/30">
        <p className="text-sm text-[#c4c4f0]">
          <strong>Abhi:</strong> Facebook OAuth setup karein. Baad mein YouTube, TikTok, Twitter add honge.
        </p>
      </div>

      <div className="mb-8">
        <h4 className="text-lg font-medium mb-4">Facebook App Credentials</h4>
        <p className="text-sm text-[#a1a1aa] mb-4">
          Facebook Developers se App ID aur App Secret lain. Redirect URL settings mein dalna: <code className="text-[#6366f1]">{typeof window !== "undefined" ? window.location.origin : ""}/api/oauth/facebook/callback</code>
        </p>

        <div className="grid gap-4 max-w-md mb-4">
          <div>
            <label className="block text-sm text-[#a1a1aa] mb-2">Facebook App ID</label>
            <input
              type="text"
              className="glass-input w-full"
              placeholder="1234567890"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm text-[#a1a1aa] mb-2">Facebook App Secret</label>
            <input
              type="password"
              className="glass-input w-full"
              placeholder="••••••••"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button onClick={handleSave} disabled={saving} className="glass-button-primary">
            {saving ? "Saving..." : "Save Credentials"}
          </button>
          <button
            onClick={handleConnect}
            disabled={!appId || !appSecret}
            className="glass-button"
          >
            Connect Facebook
          </button>
        </div>
      </div>

      <div>
        <h4 className="text-lg font-medium mb-4">Connected Facebook Pages</h4>
        {loading ? (
          <p className="text-[#a1a1aa]">Loading...</p>
        ) : accounts.length === 0 ? (
          <div className="text-center py-8 text-[#a1a1aa]">
            <p>No Facebook pages connected yet</p>
            <p className="text-sm mt-1">Save App ID/Secret and click "Connect Facebook"</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {accounts.map((acc) => (
              <div key={acc.id} className="flex items-center justify-between p-4 rounded-xl bg-[rgba(255,255,255,0.03)] border border-white/5">
                <div>
                  <p className="font-medium">{acc.account_name || acc.platform_account_id}</p>
                  <p className="text-sm text-[#a1a1aa]">Facebook Page</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="badge badge-success">Connected</span>
                  <button onClick={() => handleDisconnect(acc.id)} className="text-red-400 hover:text-red-300 text-sm">
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
