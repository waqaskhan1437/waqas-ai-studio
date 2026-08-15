/**
 * ============================================================================
 * AUTOMATION SYSTEM - Video Toggles Component
 * ============================================================================
 * Project: waqas-ai-studio
 * GitHub: https://github.com/waqaskhan1437/waqas-ai-studio
 * Vercel: frontend (prj_BVtIbisfUzhsuaE0iTzokA952icO)
 * 
 * This component contains the advanced audio mute feature with multiple modes:
 * - full_mute: Remove entire audio
 * - fade_out: Fade out last X seconds
 * - mute_last: Mute last X seconds
 * - mute_range: Mute between specific times
 * ============================================================================
 */

import { ToggleCard } from "@/components/ui";
import SplitAdvancedPanel, { SplitRule } from "./SplitAdvancedPanel";

interface Props {
  data: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

export default function VideoToggles({ data, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {/* Rotation */}
      <ToggleCard
        icon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
        title="Rotation"
        subtitle="Smart shuffle"
        checked={data.rotation_enabled !== false}
        onChange={v => onChange("rotation_enabled", v)}
        color="green"
      >
        <div className="flex gap-3">
          <label className="flex items-center gap-1.5 text-[10px] text-[#a1a1aa] cursor-pointer">
            <input type="checkbox" checked={data.rotation_shuffle === true} onChange={e => onChange("rotation_shuffle", e.target.checked)} className="accent-green-500 w-3 h-3" />
            Shuffle
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-[#a1a1aa] cursor-pointer">
            <input type="checkbox" checked={data.rotation_auto_reset === true} onChange={e => onChange("rotation_auto_reset", e.target.checked)} className="accent-green-500 w-3 h-3" />
            Auto Reset
          </label>
        </div>
      </ToggleCard>



      {/* Split */}
      <ToggleCard
        icon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>}
        title="Split"
        subtitle="Long video"
        checked={data.split_enabled === true}
        onChange={v => onChange("split_enabled", v)}
        color="amber"
      >
        {/* Mode toggle */}
        <div className="flex gap-1 mb-2">
          {(["chunk", "advanced"] as const).map((m) => (
            <button
              key={m}
              onClick={() => onChange("split_mode", m)}
              className={`flex-1 py-1 rounded text-[10px] font-medium transition-colors ${
                (data.split_mode || "chunk") === m
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "bg-[rgba(255,255,255,0.04)] text-[#71717a] border border-transparent hover:text-[#a1a1aa]"
              }`}
            >
              {m === "chunk" ? "Simple Chunks" : "Micro-Cut"}
            </button>
          ))}
        </div>

        {(data.split_mode || "chunk") === "chunk" ? (
          <select
            value={(data.split_duration as string) || "30"}
            onChange={e => onChange("split_duration", e.target.value)}
            className="w-full px-2 py-1.5 bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-lg text-[10px] text-white focus:border-amber-500 focus:outline-none"
          >
            <option value="15">15 sec chunks</option>
            <option value="30">30 sec chunks</option>
            <option value="60">60 sec chunks</option>
          </select>
        ) : (
          <SplitAdvancedPanel
            rules={(() => {
              try {
                const parsed = typeof data.split_rules === "string" ? JSON.parse(data.split_rules) : data.split_rules;
                return Array.isArray(parsed) && parsed.length > 0 ? parsed : [{ id: "default", mode: "jump_cut", interval: 1, remove_duration: 0.1, region: "last", region_value: 15, region_start: 0, region_end: 0 }];
              } catch { return [{ id: "default", mode: "jump_cut", interval: 1, remove_duration: 0.1, region: "last", region_value: 15, region_start: 0, region_end: 0 }]; }
            })()}
            onChange={(rules: SplitRule[]) => onChange("split_rules", JSON.stringify(rules))}
          />
        )}
      </ToggleCard>

      {/* Combine */}
      <ToggleCard
        icon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>}
        title="Combine"
        subtitle="Merge videos"
        checked={data.combine_enabled === true}
        onChange={v => onChange("combine_enabled", v)}
        color="pink"
      >
        <select
          value={(data.combine_count as string) || "3"}
          onChange={e => onChange("combine_count", e.target.value)}
          className="w-full px-2 py-1.5 bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-lg text-[10px] text-white focus:border-pink-500 focus:outline-none"
        >
          <option value="2">2 videos</option>
          <option value="3">3 videos</option>
          <option value="5">5 videos</option>
        </select>
      </ToggleCard>

      {/* Mute Audio */}
      <ToggleCard
        icon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>}
        title="Mute Audio"
        subtitle="Advanced control"
        checked={data.mute_audio === true || data.mute_mode !== "none"}
        onChange={v => {
          if (v) {
            onChange("mute_audio", true);
            onChange("mute_mode", "fade_out");
          } else {
            onChange("mute_audio", false);
            onChange("mute_mode", "none");
          }
        }}
        color="red"
      >
        <div className="space-y-2">
          {/* Mute Mode Selection */}
          <select
            value={(data.mute_mode as string) || (data.mute_audio ? "fade_out" : "none")}
              onChange={e => {
              const mode = e.target.value;
              onChange("mute_mode", mode);
              onChange("mute_audio", mode !== "none");
              // Update legacy fade duration for backward compatibility
              if (mode === "fade_out") {
                onChange("audio_fade_duration", data.audio_fade_duration || "5");
              }
            }}
            className="w-full px-2 py-1.5 bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-lg text-[10px] text-white focus:border-red-500 focus:outline-none"
          >
            <option value="none">No Muting</option>
            <option value="full_mute">Full Mute (Remove All)</option>
            <option value="fade_out">Fade Out (Last X sec)</option>
            <option value="mute_last">Mute Last X Seconds</option>
            <option value="mute_range">Mute Time Range</option>
          </select>

          {/* Fade Out Duration */}
          {(data.mute_mode as string) === "fade_out" && (
            <select
              value={(data.audio_fade_duration as string) || "5"}
              onChange={e => onChange("audio_fade_duration", e.target.value)}
              className="w-full px-2 py-1.5 bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-lg text-[10px] text-white focus:border-red-500 focus:outline-none"
            >
              <option value="1">Fade 1 sec</option>
              <option value="2">Fade 2 sec</option>
              <option value="3">Fade 3 sec</option>
              <option value="5">Fade 5 sec</option>
              <option value="10">Fade 10 sec</option>
              <option value="5">Fade 5 sec</option>
              <option value="10">Fade 10 sec</option>
            </select>
          )}

          {/* Mute Last Seconds */}
          {(data.mute_mode as string) === "mute_last" && (
            <div className="space-y-1">
              <label className="text-[9px] text-[#a1a1aa]">Mute last (seconds):</label>
              <input
                type="number"
                step="0.5"
                min="0.5"
                max="60"
                value={(data.mute_last_seconds as string) || "5"}
                onChange={e => onChange("mute_last_seconds", e.target.value)}
                className="w-full px-2 py-1.5 bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-lg text-[10px] text-white focus:border-red-500 focus:outline-none"
                placeholder="5"
              />
            </div>
          )}

          {/* Mute Range */}
          {(data.mute_mode as string) === "mute_range" && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] text-[#a1a1aa]">Start (sec):</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={(data.mute_range_start as string) || "0"}
                    onChange={e => onChange("mute_range_start", e.target.value)}
                    className="w-full px-2 py-1.5 bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-lg text-[10px] text-white focus:border-red-500 focus:outline-none"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-[#a1a1aa]">End (sec):</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={(data.mute_range_end as string) || "5"}
                    onChange={e => onChange("mute_range_end", e.target.value)}
                    className="w-full px-2 py-1.5 bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-lg text-[10px] text-white focus:border-red-500 focus:outline-none"
                    placeholder="5"
                  />
                </div>
              </div>
              <p className="text-[8px] text-[#a1a1aa]">Mutes audio between start and end times</p>
            </div>
          )}
        </div>
      </ToggleCard>
    </div>
  );
}