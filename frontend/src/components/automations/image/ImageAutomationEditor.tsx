"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Automation } from "../types";
import type { AIModelCatalogResponse, CloudflareVisualModel } from "@/lib/types";
import { getAvailableProviders, normalizeAiCatalog, resolveModelSelection, resolveProviderSelection } from "@/lib/ai";
import ImageBasicTab from "./ImageBasicTab";
import ImageSocialContentTab from "./ImageSocialContentTab";
import PublishTab from "../PublishTab";
import {
  DEFAULT_IMAGE_AUTOMATION_CONFIG,
  IMAGE_AUTOMATION_TABS,
  normalizeImageAutomationConfig,
  type ImageAutomationTabId,
} from "./config";

interface Props {
  editData: Automation | null;
  onSaved: () => void;
  onClose?: () => void;
}

const TabButton = memo(function TabButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
        active
          ? "bg-gradient-to-r from-[#f59e0b] to-[#ef4444] text-white shadow-lg"
          : "text-[#a1a1aa] hover:text-white hover:bg-[rgba(255,255,255,0.05)]"
      }`}
    >
      <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
      </svg>
      <span>{label}</span>
    </button>
  );
});

export default function ImageAutomationEditor({ editData, onSaved, onClose }: Props) {
  const initialConfig = useMemo(() => {
    if (!editData?.config) {
      return normalizeImageAutomationConfig(DEFAULT_IMAGE_AUTOMATION_CONFIG);
    }

    try {
      return normalizeImageAutomationConfig(JSON.parse(editData.config));
    } catch {
      return normalizeImageAutomationConfig(DEFAULT_IMAGE_AUTOMATION_CONFIG);
    }
  }, [editData?.config]);

  const [activeTab, setActiveTab] = useState<ImageAutomationTabId>("basic");
  const [name, setName] = useState(editData?.name || "");
  const [data, setData] = useState<Record<string, unknown>>(initialConfig);
  const [saving, setSaving] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [aiCatalog, setAiCatalog] = useState<AIModelCatalogResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [socialGenerating, setSocialGenerating] = useState(false);
  const [socialGenResult, setSocialGenResult] = useState("");

  useEffect(() => {
    if (!editData) {
      setName("");
      setData(normalizeImageAutomationConfig(DEFAULT_IMAGE_AUTOMATION_CONFIG));
      return;
    }

    setInitializing(true);
    const timer = setTimeout(() => {
      try {
        const parsed = editData.config ? JSON.parse(editData.config) : {};
        setData(normalizeImageAutomationConfig(parsed));
        setName(editData.name);
      } catch {
        setData(normalizeImageAutomationConfig(DEFAULT_IMAGE_AUTOMATION_CONFIG));
        setName(editData.name);
      }
      setInitializing(false);
    }, 40);

    return () => clearTimeout(timer);
  }, [editData?.id, initialConfig]);

  const loadAiCatalog = useCallback(async () => {
    setAiLoading(true);
    try {
      const res = await fetch("/api/settings/ai/models");
      const result = await res.json();
      if (result.success) {
        setAiCatalog(normalizeAiCatalog(result.data || { default_provider: null, providers: [] }));
      } else {
        setAiCatalog({ default_provider: null, providers: [] });
      }
    } catch {
      setAiCatalog({ default_provider: null, providers: [] });
    }
    setAiLoading(false);
  }, []);

  useEffect(() => {
    loadAiCatalog();
  }, [loadAiCatalog]);

  const onChange = useCallback((key: string, value: unknown) => {
    setData((current) => ({ ...current, [key]: value }));
  }, []);

  useEffect(() => {
    const providers = getAvailableProviders(aiCatalog);
    if (providers.length === 0) return;

    setData((prev) => {
      const next = { ...prev };

      const socialProvider = resolveProviderSelection(aiCatalog, prev.social_ai_provider as string | undefined);
      const socialModel = resolveModelSelection(aiCatalog, socialProvider, prev.social_ai_model as string | undefined);

      let changed = false;

      if (socialProvider && prev.social_ai_provider !== socialProvider) {
        next.social_ai_provider = socialProvider;
        changed = true;
      }
      if (socialModel && prev.social_ai_model !== socialModel) {
        next.social_ai_model = socialModel;
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [aiCatalog]);

  const handleSocialProviderChange = useCallback((provider: string) => {
    const nextModel = resolveModelSelection(aiCatalog, provider, undefined);
    setData((prev) => ({
      ...prev,
      social_ai_provider: provider,
      social_ai_model: nextModel,
    }));
  }, [aiCatalog]);

  const handleSocialModelChange = useCallback((model: string) => {
    onChange("social_ai_model", model);
  }, [onChange]);

  const cloudflareImageModels: CloudflareVisualModel[] = aiCatalog?.cloudflare_visual?.image_models || [];

  useEffect(() => {
    if (cloudflareImageModels.length === 0) return;
    setData((prev) => {
      const currentModel = typeof prev.cloudflare_image_model === "string" ? prev.cloudflare_image_model : "";
      if (currentModel && cloudflareImageModels.some((model) => model.id === currentModel)) return prev;
      return { ...prev, cloudflare_image_model: cloudflareImageModels[0].id };
    });
  }, [cloudflareImageModels]);

  const handleGenerateSocial = useCallback(async () => {
    const topic = String(data.ai_prompt || "").trim();
    const platform = String(data.social_platform || "instagram");
    const count = Number.parseInt(String(data.social_count || "10"), 10);
    const provider = String(data.social_ai_provider || "");
    const model = String(data.social_ai_model || "");

    if (!topic) {
      setSocialGenResult("AI Prompt enter karein, phir content generate karein.");
      return;
    }
    if (!provider || !model) {
      setSocialGenResult("AI provider/model available nahi hai. Settings me API key save karein.");
      return;
    }

    setSocialGenerating(true);
    setSocialGenResult("");

    try {
      const res = await fetch("/api/settings/ai/generate", {
        method: "POST",
        signal: AbortSignal.timeout(60000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "social",
          provider,
          model,
          topic,
          platform,
          count: Number.isFinite(count) ? count : 10,
        }),
      });
      const result = await res.json();
      if (result.success && result.data) {
        onChange("titles", result.data.titles || []);
        onChange("descriptions", result.data.descriptions || []);
        onChange("hashtags", result.data.hashtags || []);
        setSocialGenResult(`Generated social content with ${result.data.provider} - ${result.data.model}`);
      } else {
        setSocialGenResult(result.error || "Social content generation failed");
      }
    } catch {
      setSocialGenResult("Social content generation failed");
    }

    setSocialGenerating(false);
  }, [data, onChange]);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      alert("Automation name is required");
      return;
    }

    setSaving(true);
    try {
      const payload = normalizeImageAutomationConfig(data);
      const url = editData ? `/api/automations/${editData.id}` : "/api/automations";
      const method = editData ? "PUT" : "POST";
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          type: "image",
          config: JSON.stringify(payload),
          schedule: null,
        }),
      });
      const result = await response.json();
      if (result.success) {
        onSaved();
      } else {
        alert(`Failed: ${result.error}`);
      }
    } catch {
      alert("Failed to save image automation");
    }
    setSaving(false);
  }, [data, editData, name, onSaved]);

  const tabIndex = IMAGE_AUTOMATION_TABS.findIndex((tab) => tab.id === activeTab);

  const renderTabContent = () => {
    if (initializing) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="w-8 h-8 border-2 border-orange-500/30 border-t-orange-500 rounded-full animate-spin" />
          <span className="ml-3 text-[#a1a1aa]">Loading...</span>
        </div>
      );
    }

    if (activeTab === "basic") {
      return <ImageBasicTab data={data} onChange={onChange} />;
    }

    if (activeTab === "social") {
      return (
        <ImageSocialContentTab
          data={data}
          onChange={onChange}
          aiProviders={getAvailableProviders(aiCatalog)}
          generating={socialGenerating || aiLoading}
          genResult={socialGenResult}
          onAiGenerate={handleGenerateSocial}
          onProviderChange={handleSocialProviderChange}
          onModelChange={handleSocialModelChange}
        />
      );
    }

    return <PublishTab data={data} onChange={onChange} />;
  };

  return (
    <div className="glass-card w-full h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[rgba(255,255,255,0.08)] flex-shrink-0">
        <div>
          <h3 className="text-xl font-bold">{editData ? "Edit" : "Create"} Image Automation</h3>
          <p className="text-xs text-[#a1a1aa] mt-1">Configure your image automation with Basic, Content, and Publish tabs.</p>
        </div>
        {onClose && <button onClick={onClose} className="glass-button py-1.5 px-4 text-sm">Close</button>}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-60 flex-shrink-0 border-r border-[rgba(255,255,255,0.08)] p-4 flex flex-col gap-2">
          <div className="text-[10px] font-semibold text-[#71717a] uppercase tracking-wider mb-2 px-2">
            Image Flow
          </div>
          {IMAGE_AUTOMATION_TABS.map((tab) => (
            <TabButton
              key={tab.id}
              label={tab.label}
              icon={tab.icon}
              active={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            />
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          <div className="mb-6">
            <label className="block text-sm font-medium mb-2">Automation Name *</label>
            <input
              className="glass-input w-full"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g., Branded Product Banner"
            />
          </div>

          <div className="mb-6 grid gap-4 rounded-2xl border border-indigo-400/20 bg-indigo-400/[0.05] p-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-2">Image generation mode</label>
              <select className="glass-select" value={String(data.image_mode || "html_banner")} onChange={(event) => onChange("image_mode", event.target.value)}>
                <option value="html_banner">HTML banner renderer</option>
                <option value="cloudflare_ai">Cloudflare AI image generation</option>
                <option value="source_url">Use source image URL</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Cloudflare image model</label>
              <select
                className="glass-select"
                value={String(data.cloudflare_image_model || cloudflareImageModels[0]?.id || "")}
                onChange={(event) => onChange("cloudflare_image_model", event.target.value)}
                disabled={cloudflareImageModels.length === 0}
              >
                {cloudflareImageModels.length > 0
                  ? cloudflareImageModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.experimental ? " — experimental" : ""}</option>)
                  : <option value="">Cloudflare image catalog loading…</option>}
              </select>
              <p className="mt-2 text-[11px] leading-5 text-[#a1a1aa]">The selected model is used when image generation mode is Cloudflare AI.</p>
            </div>
          </div>

          {renderTabContent()}
        </div>
      </div>

      <div className="flex justify-between px-6 py-4 border-t border-[rgba(255,255,255,0.08)] flex-shrink-0">
        <button
          onClick={() => tabIndex > 0 && setActiveTab(IMAGE_AUTOMATION_TABS[tabIndex - 1].id)}
          className={`glass-button text-sm ${tabIndex === 0 ? "opacity-30 pointer-events-none" : ""}`}
        >
          Previous
        </button>
        {tabIndex < IMAGE_AUTOMATION_TABS.length - 1 ? (
          <button onClick={() => setActiveTab(IMAGE_AUTOMATION_TABS[tabIndex + 1].id)} className="glass-button-primary text-sm">
            Next
          </button>
        ) : (
          <button onClick={handleSave} disabled={saving || !name.trim()} className="glass-button-primary text-sm">
            {saving ? "Saving..." : editData ? "Update" : "Create"}
          </button>
        )}
      </div>
    </div>
  );
}
