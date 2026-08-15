"use client";
import { useState, useEffect } from "react";

export default function AISettings() {
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
    { id: "groq", label: "Groq (Fast)", key: groqKey, setKey: setGroqKey, placeholder: "gsk_...", color: "#e53e3e" },
    { id: "grok", label: "xAI Grok", key: grokKey, setKey: setGrokKey, placeholder: "xai-...", color: "#1a1a1a" },
    { id: "cohere", label: "Cohere", key: cohereKey, setKey: setCohereKey, placeholder: "co-...", color: "#39594d" },
    { id: "openrouter", label: "OpenRouter", key: openrouterKey, setKey: setOpenrouterKey, placeholder: "sk-or-...", color: "#8b5cf6" },
  ];

  const handleTest = async (providerId: string, apiKey: string) => {
    if (!apiKey) { setTestResults((prev) => ({ ...prev, [providerId]: { success: false, message: "API key is empty" } })); return; }
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
    } catch { setTestResults((prev) => ({ ...prev, [providerId]: { success: false, message: "Connection failed" } })); }
    setTesting(null);
  };

  const handleTestElevenLabs = async () => {
    await handleTest("elevenlabs", elevenLabsKey);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gemini_key: geminiKey, grok_key: grokKey, cohere_key: cohereKey,
          openrouter_key: openrouterKey, openai_key: openaiKey, groq_key: groqKey, elevenlabs_api_key: elevenLabsKey, default_provider: defaultProvider,
        }),
      });
      alert("AI settings saved!");
    } catch { alert("Failed to save settings"); }
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
            <button onClick={handleTestElevenLabs} disabled={testing !== null} className={`text-xs px-4 py-2 rounded-lg font-medium transition-all ${testResults.elevenlabs?.success === true ? "bg-[rgba(16,185,129,0.15)] text-[#10b981]" : testResults.elevenlabs?.success === false && testResults.elevenlabs?.message ? "bg-[rgba(239,68,68,0.15)] text-[#ef4444]" : "glass-button"}`}>
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
                  {defaultProvider === provider.id && <span className="text-[10px] bg-[rgba(99,102,241,0.15)] text-[#6366f1] px-2 py-0.5 rounded-full font-medium">Default</span>}
                </div>
              </div>
              <button onClick={() => handleTest(provider.id, provider.key)} disabled={testing !== null} className={`text-xs px-4 py-2 rounded-lg font-medium transition-all ${testResults[provider.id]?.success === true ? "bg-[rgba(16,185,129,0.15)] text-[#10b981]" : testResults[provider.id]?.success === false && testResults[provider.id]?.message ? "bg-[rgba(239,68,68,0.15)] text-[#ef4444]" : "glass-button"}`}>
                {testing === provider.id ? "Testing..." : testResults[provider.id]?.success === true ? "Connected" : testResults[provider.id]?.success === false && testResults[provider.id]?.message ? "Failed" : "Test"}
              </button>
            </div>
            <div className="flex gap-2">
              <input type="password" className="glass-input text-sm flex-1" placeholder={provider.placeholder} value={provider.key} onChange={(e) => provider.setKey(e.target.value)} />
              {provider.key && (
                <button onClick={() => setDefaultProvider(provider.id)} className={`px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap ${defaultProvider === provider.id ? "bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] text-white" : "glass-button"}`}>
                  Set Default
                </button>
              )}
            </div>
            {testResults[provider.id]?.message && <p className={`text-xs mt-2 ${testResults[provider.id]?.success ? "text-[#10b981]" : "text-[#ef4444]"}`}>{testResults[provider.id]?.message}</p>}
          </div>
        ))}
      </div>
      <div className="glass-card p-4 mt-4">
        <p className="text-sm text-[#a1a1aa]">Default Provider: <span className="text-white font-medium capitalize">{defaultProvider}</span></p>
        <p className="text-xs text-[#a1a1aa] mt-1">This provider will be used for AI-powered automation features</p>
      </div>
      <button onClick={handleSave} disabled={saving} className="glass-button-primary mt-4">
        {saving ? "Saving..." : "Save AI Settings"}
      </button>
    </div>
  );
}