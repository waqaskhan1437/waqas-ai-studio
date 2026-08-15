"use client";

import { ApiError, api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Clapperboard,
  FileText,
  Languages,
  Loader2,
  MessageSquareText,
  Mic2,
  Play,
  Sparkles,
  Wand2,
} from "lucide-react";

type LanguageCode = "ur" | "hi" | "en" | "ar" | "es" | "bn" | "ta";
type VisualMode = "unique_scenes" | "economy_reuse";
type ScriptStatus = "idle" | "generating" | "ready" | "error";

type ScriptSegment = {
  id: string;
  kind: "hook" | "soft_cta" | "explanation" | "cta";
  caption_text: string;
  tts_text: string;
  visual_prompt: string;
  start_seconds: number;
  end_seconds: number;
};

type ScriptManifest = {
  language: LanguageCode;
  caption_text: string;
  tts_text: string;
  segments: ScriptSegment[];
  word_count: {
    caption: number;
    tts: number;
    target: number;
    min: number;
    max: number;
  };
};

const LANGUAGE_OPTIONS: Array<{
  value: LanguageCode;
  label: string;
  native: string;
  wpm: number;
  note: string;
}> = [
  { value: "ur", label: "Urdu", native: "اردو", wpm: 120, note: "Nastaleeq captions + Devanagari phonetic TTS" },
  { value: "hi", label: "Hindi", native: "हिन्दी", wpm: 120, note: "Devanagari captions and narration" },
  { value: "en", label: "English", native: "English", wpm: 130, note: "Same narration text becomes captions" },
  { value: "ar", label: "Arabic", native: "العربية", wpm: 120, note: "Same narration text becomes captions" },
  { value: "es", label: "Spanish", native: "Español", wpm: 130, note: "Same narration text becomes captions" },
  { value: "bn", label: "Bengali", native: "বাংলা", wpm: 120, note: "Same narration text becomes captions" },
  { value: "ta", label: "Tamil", native: "தமிழ்", wpm: 120, note: "Same narration text becomes captions" },
];

const VISUAL_STYLES = [
  "Cinematic documentary",
  "Fast social explainer",
  "Minimal educational",
  "Luxury product story",
  "Newsroom / current affairs",
  "Warm human storytelling",
];

const SAMPLE_URDU_MANIFEST: ScriptManifest = {
  language: "ur",
  caption_text: "کیا آپ جانتے ہیں کہ چھوٹی سی عادت آپ کی پوری زندگی بدل سکتی ہے؟",
  tts_text: "Kya aap jaante hain ke chhoti si aadat aap ki poori zindagi badal sakti hai?",
  segments: [
    {
      id: "hook",
      kind: "hook",
      caption_text: "کیا آپ جانتے ہیں کہ چھوٹی سی عادت آپ کی پوری زندگی بدل سکتی ہے؟",
      tts_text: "Kya aap jaante hain ke chhoti si aadat aap ki poori zindagi badal sakti hai?",
      visual_prompt: "Close-up of a person opening a journal at sunrise, cinematic vertical composition, subtle camera push-in",
      start_seconds: 0,
      end_seconds: 3,
    },
    {
      id: "hook_cta",
      kind: "soft_cta",
      caption_text: "آخر تک دیکھیں، طریقہ بہت آسان ہے۔",
      tts_text: "Aakhir tak dekhein, tareeqa bohat aasaan hai.",
      visual_prompt: "Quick hopeful transition from the journal to a clean daily routine montage",
      start_seconds: 3,
      end_seconds: 8,
    },
    {
      id: "body-001",
      kind: "explanation",
      caption_text: "روز صرف پانچ منٹ اپنے اہم کام کے لیے مختص کریں۔ جب یہ عمل مسلسل دہرایا جاتا ہے تو دماغ اسے مشکل کام نہیں سمجھتا، بلکہ ایک قدرتی معمول بنا لیتا ہے۔",
      tts_text: "Roz sirf paanch minute apne aham kaam ke liye mukhtas karein. Jab yeh amal musalsal dohraya jata hai to dimagh ise mushkil kaam nahin samajhta, balke aik fitri mamool bana leta hai.",
      visual_prompt: "A calm five-minute timer beside a notebook, hands completing one focused task, natural daylight, gentle motion",
      start_seconds: 8,
      end_seconds: 52,
    },
    {
      id: "cta",
      kind: "cta",
      caption_text: "آج ہی پانچ منٹ سے شروع کریں، اور یہ ویڈیو کسی ایسے شخص کے ساتھ شیئر کریں جو اپنی زندگی بدلنا چاہتا ہے۔",
      tts_text: "Aaj hi paanch minute se shuru karein, aur yeh video kisi aisay shakhs ke saath share karein jo apni zindagi badalna chahta hai.",
      visual_prompt: "Person checking off a small goal, warm ending frame, clean space for final CTA text",
      start_seconds: 52,
      end_seconds: 60,
    },
  ],
  word_count: { caption: 42, tts: 42, target: 120, min: 108, max: 126 },
};

function countWords(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
}

function segmentLabel(kind: ScriptSegment["kind"]): string {
  return {
    hook: "Hook",
    soft_cta: "Soft CTA",
    explanation: "Explanation",
    cta: "Final CTA",
  }[kind];
}

export default function AiVideoGeneratorPage() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [instructions, setInstructions] = useState("");
  const [language, setLanguage] = useState<LanguageCode>("ur");
  const [durationMinutes, setDurationMinutes] = useState(1);
  const [visualStyle, setVisualStyle] = useState(VISUAL_STYLES[0]);
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [visualMode, setVisualMode] = useState<VisualMode>("economy_reuse");
  const [videoModel, setVideoModel] = useState("bytedance/seedance-2.0");
  const [ttsModel, setTtsModel] = useState("eleven_v3");
  const [voiceId, setVoiceId] = useState("");
  const [script, setScript] = useState<ScriptManifest | null>(null);
  const [scriptStatus, setScriptStatus] = useState<ScriptStatus>("idle");
  const [scriptError, setScriptError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [jobMessage, setJobMessage] = useState("");
  const [openSegment, setOpenSegment] = useState<string | null>("hook");

  const languageInfo = useMemo(
    () => LANGUAGE_OPTIONS.find((option) => option.value === language) || LANGUAGE_OPTIONS[0],
    [language]
  );
  const targetWords = Math.floor((durationMinutes * languageInfo.wpm));
  const minWords = Math.floor(targetWords * 0.9);
  const maxWords = Math.ceil(targetWords * 1.05);
  const estimatedScenes = Math.ceil((durationMinutes * 60) / 10);
  const isUrdu = language === "ur";
  const activeManifest = script || (isUrdu && !topic ? SAMPLE_URDU_MANIFEST : null);
  const visibleCaptionWords = activeManifest ? countWords(activeManifest.caption_text) : 0;
  const visibleTtsWords = activeManifest ? countWords(activeManifest.tts_text) : 0;

  function applySample(): void {
    setTopic("چھوٹی عادتیں زندگی کیسے بدلتی ہیں؟");
    setInstructions("سادہ، قدرتی اور امید دینے والا انداز رکھیں۔ آخر میں نرم CTA شامل کریں۔");
    setScript(SAMPLE_URDU_MANIFEST);
    setScriptStatus("ready");
    setScriptError("");
  }

  async function generateScript(): Promise<void> {
    if (!topic.trim()) {
      setScriptError("Pehle topic ya brief likhein.");
      return;
    }
    setScriptStatus("generating");
    setScriptError("");
    setJobMessage("");
    try {
      const response = await api.post<ScriptManifest>("/api/video-generation/script", {
        topic: topic.trim(),
        instructions: instructions.trim(),
        language,
        duration_seconds: durationMinutes * 60,
        target_words: targetWords,
        speech_rate_wpm: languageInfo.wpm,
        visual_style: visualStyle,
        hook_seconds: 3,
        soft_cta_after_hook: true,
        final_cta: true,
      }, { timeout: 120000 });
      if (!response.success || !response.data) {
        throw new Error(response.error || "Script generation failed");
      }
      setScript(response.data);
      setOpenSegment(response.data.segments[0]?.id || null);
      setScriptStatus("ready");
    } catch (error) {
      setScriptStatus("error");
      setScriptError(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Script generation failed");
    }
  }

  async function createVideoJob(): Promise<void> {
    if (!topic.trim() && !script) {
      setScriptError("Topic ya generated script zaroori hai.");
      return;
    }
    setSubmitting(true);
    setJobMessage("");
    setScriptError("");
    try {
      const response = await api.post<{ job_id: number }>("/api/video-generation/jobs", {
        topic: topic.trim(),
        instructions: instructions.trim(),
        language,
        duration_seconds: durationMinutes * 60,
        target_words: targetWords,
        min_words: minWords,
        max_words: maxWords,
        speech_rate_wpm: languageInfo.wpm,
        visual_style: visualStyle,
        aspect_ratio: aspectRatio,
        visual_mode: visualMode,
        video_model: videoModel,
        tts_model: ttsModel,
        voice_id: voiceId.trim() || null,
        script: script || null,
        caption_font: isUrdu ? "Noto Nastaliq Urdu" : "default",
        caption_text_mode: isUrdu ? "nastaliq" : "same_as_tts",
        tts_text_mode: isUrdu ? "devanagari_phonetic_urdu" : "same_as_caption",
        hook_seconds: 3,
        soft_cta_after_hook: true,
        final_cta: true,
        estimated_scenes: estimatedScenes,
      }, { timeout: 30000 });
      if (!response.success || !response.data?.job_id) {
        throw new Error(response.error || "Video job could not be queued");
      }
      setJobMessage(`Job #${response.data.job_id} queue ho gaya hai. Voice-over, scenes aur captions runner par process honge.`);
    } catch (error) {
      setScriptError(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Video job could not be queued");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(99,102,241,0.16)] text-indigo-300 shadow-[0_0_28px_rgba(99,102,241,0.1)]">
              <Clapperboard className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300/80">Creator Studio</p>
              <h2 className="mt-1 text-3xl font-bold tracking-tight">AI Video Generator</h2>
              <p className="mt-1 max-w-2xl text-sm text-[#a1a1aa]">Prompt se structured script, natural voice-over, visual scenes aur captions ek hi pipeline mein.</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <button onClick={applySample} className="glass-button flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Load Urdu sample
          </button>
          <button
            onClick={() => router.push("/jobs")}
            className="glass-button flex items-center gap-2"
          >
            <Clock3 className="h-4 w-4" />
            View jobs
          </button>
        </div>
      </div>

      {(scriptError || jobMessage) && (
        <div className={`rounded-2xl border p-4 text-sm ${scriptError ? "border-red-400/25 bg-red-500/10 text-red-100" : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"}`}>
          {scriptError || jobMessage}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(420px,0.9fr)]">
        <div className="space-y-6">
          <section className="glass-card no-hover p-6">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MessageSquareText className="h-5 w-5 text-indigo-300" />
                <h3 className="text-lg font-semibold">Brief & script direction</h3>
              </div>
              <span className="rounded-full border border-indigo-400/20 bg-indigo-400/10 px-3 py-1 text-[11px] text-indigo-200">Hook → Explain → CTA</span>
            </div>
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium">Topic / prompt</label>
                <textarea
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  className="glass-input min-h-28 resize-y"
                  placeholder="Misal: chhoti habits productivity aur confidence ko kaise improve karti hain?"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">Creative direction <span className="font-normal text-[#71717a]">(optional)</span></label>
                <textarea
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  className="glass-input min-h-24 resize-y"
                  placeholder="Tone, audience, examples, prohibited claims, CTA ya brand style…"
                />
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-[#a1a1aa]">
                <span className="rounded-lg bg-white/[0.04] px-3 py-2">2–3 sec hook</span>
                <span className="rounded-lg bg-white/[0.04] px-3 py-2">Natural soft CTA after hook</span>
                <span className="rounded-lg bg-white/[0.04] px-3 py-2">Final CTA at the end</span>
              </div>
            </div>
          </section>

          <section className="glass-card no-hover p-6">
            <div className="mb-5 flex items-center gap-2">
              <Clock3 className="h-5 w-5 text-cyan-300" />
              <h3 className="text-lg font-semibold">Language & duration</h3>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium">Narration language</label>
                <select value={language} onChange={(event) => setLanguage(event.target.value as LanguageCode)} className="glass-select">
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.native} — {option.label}</option>
                  ))}
                </select>
                <p className="mt-2 text-xs leading-5 text-[#a1a1aa]">{languageInfo.note}</p>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label className="text-sm font-medium">Video duration</label>
                  <span className="rounded-lg bg-cyan-400/10 px-3 py-1 text-sm font-semibold text-cyan-200">{formatDuration(durationMinutes)}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={120}
                  step={1}
                  value={durationMinutes}
                  onChange={(event) => setDurationMinutes(Number(event.target.value))}
                  className="w-full accent-cyan-400"
                />
                <div className="mt-2 flex justify-between text-[11px] text-[#71717a]"><span>1 min</span><span>30 min</span><span>1 hour</span><span>2 hours</span></div>
              </div>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.06] p-3">
                <p className="text-[11px] uppercase tracking-wider text-cyan-200/70">Target words</p>
                <p className="mt-1 text-xl font-bold text-cyan-100">{targetWords.toLocaleString()}</p>
                <p className="mt-1 text-[11px] text-[#a1a1aa]">{languageInfo.wpm} WPM narration</p>
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
                <p className="text-[11px] uppercase tracking-wider text-[#a1a1aa]">Allowed range</p>
                <p className="mt-1 text-xl font-bold">{minWords.toLocaleString()}–{maxWords.toLocaleString()}</p>
                <p className="mt-1 text-[11px] text-[#71717a]">Natural pauses included</p>
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
                <p className="text-[11px] uppercase tracking-wider text-[#a1a1aa]">Visual scenes</p>
                <p className="mt-1 text-xl font-bold">{estimatedScenes.toLocaleString()}</p>
                <p className="mt-1 text-[11px] text-[#71717a]">~10 seconds per clip</p>
              </div>
            </div>
            {durationMinutes > 30 && (
              <div className="mt-4 flex gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-xs leading-5 text-amber-100/80">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                Long videos may require many scene generations. Economy mode reuses compatible visual scenes to reduce processing time and provider usage.
              </div>
            )}
          </section>

          <section className="glass-card no-hover p-6">
            <div className="mb-5 flex items-center gap-2">
              <Wand2 className="h-5 w-5 text-fuchsia-300" />
              <h3 className="text-lg font-semibold">Voice & visual engine</h3>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium">Voice model</label>
                <select value={ttsModel} onChange={(event) => setTtsModel(event.target.value)} className="glass-select">
                  <option value="eleven_v3">Eleven v3 — expressive multilingual</option>
                  <option value="eleven_multilingual_v2">Multilingual v2 — stable long-form</option>
                  <option value="eleven_flash_v2_5">Flash v2.5 — fast generation</option>
                </select>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">Voice ID <span className="font-normal text-[#71717a]">(optional)</span></label>
                <input value={voiceId} onChange={(event) => setVoiceId(event.target.value)} className="glass-input" placeholder="ElevenLabs voice ID" />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">Visual model</label>
                <select value={videoModel} onChange={(event) => setVideoModel(event.target.value)} className="glass-select">
                  <option value="bytedance/seedance-2.0">Seedance 2.0 — text to video</option>
                  <option value="xai/grok-imagine-video-1.5-preview">Grok Imagine Video — preview</option>
                </select>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">Visual mode</label>
                <select value={visualMode} onChange={(event) => setVisualMode(event.target.value as VisualMode)} className="glass-select">
                  <option value="economy_reuse">Economy — reuse compatible scenes</option>
                  <option value="unique_scenes">Unique — generate every scene</option>
                </select>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">Aspect ratio</label>
                <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} className="glass-select">
                  <option value="9:16">9:16 — Shorts / Reels</option>
                  <option value="16:9">16:9 — YouTube landscape</option>
                  <option value="1:1">1:1 — Square</option>
                </select>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">Visual style</label>
                <select value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} className="glass-select">
                  {VISUAL_STYLES.map((style) => <option key={style} value={style}>{style}</option>)}
                </select>
              </div>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="glass-card no-hover sticky top-6 p-6">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-emerald-300" />
                <h3 className="text-lg font-semibold">Script preview</h3>
              </div>
              <span className={`rounded-full px-3 py-1 text-[11px] ${scriptStatus === "ready" ? "bg-emerald-400/10 text-emerald-200" : scriptStatus === "generating" ? "bg-cyan-400/10 text-cyan-200" : "bg-white/[0.05] text-[#a1a1aa]"}`}>
                {scriptStatus === "ready" ? "Ready" : scriptStatus === "generating" ? "Generating…" : "Draft"}
              </span>
            </div>

            {activeManifest ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-white/[0.035] p-3"><p className="text-[11px] text-[#71717a]">Caption words</p><p className="mt-1 text-lg font-semibold">{visibleCaptionWords.toLocaleString()}</p></div>
                  <div className="rounded-xl bg-white/[0.035] p-3"><p className="text-[11px] text-[#71717a]">TTS words</p><p className="mt-1 text-lg font-semibold">{visibleTtsWords.toLocaleString()}</p></div>
                </div>
                {isUrdu && (
                  <div className="rounded-xl border border-indigo-400/20 bg-indigo-400/[0.06] p-3 text-xs leading-5 text-indigo-100/80">
                    <div className="flex items-center gap-2 font-semibold text-indigo-200"><Languages className="h-4 w-4" /> Urdu pairing locked</div>
                    <p className="mt-1">Caption layer Nastaleeq mein rahega; voice ke liye Urdu talaffuz wala Devanagari text use hoga. Dono same segment structure se generate honge.</p>
                  </div>
                )}
                <div className="space-y-2">
                  {activeManifest.segments.map((segment) => {
                    const expanded = openSegment === segment.id;
                    return (
                      <div key={segment.id} className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.025]">
                        <button onClick={() => setOpenSegment(expanded ? null : segment.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
                          <span className="flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-indigo-300" />{segmentLabel(segment.kind)}</span>
                          <span className="flex items-center gap-2 text-[11px] text-[#71717a]">{segment.start_seconds}s–{segment.end_seconds}s <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></span>
                        </button>
                        {expanded && (
                          <div className="space-y-3 border-t border-white/[0.06] px-4 py-4">
                            <div>
                              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">Caption</p>
                              <p dir={isUrdu ? "rtl" : "auto"} className={`text-sm leading-7 text-[#e4e4e7] ${isUrdu ? "font-[\"Noto_Nastaliq_Urdu\"]" : ""}`}>{segment.caption_text}</p>
                            </div>
                            {isUrdu && <div><p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">TTS phonetic text</p><p className="text-sm leading-6 text-cyan-100">{segment.tts_text}</p></div>}
                            <div><p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">Visual prompt</p><p className="text-xs leading-5 text-[#a1a1aa]">{segment.visual_prompt}</p></div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex min-h-[360px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.12] bg-white/[0.02] p-8 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-400/10 text-indigo-300"><Mic2 className="h-7 w-7" /></div>
                <p className="font-medium">Script yahan preview hoga</p>
                <p className="mt-2 max-w-xs text-xs leading-5 text-[#71717a]">Topic likh kar Generate Script dabayein. Urdu mein visible captions aur TTS text alag, magar aligned fields mein nazar aayenge.</p>
              </div>
            )}

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button onClick={() => void generateScript()} disabled={scriptStatus === "generating" || !topic.trim()} className="glass-button-primary flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
                {scriptStatus === "generating" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                {scriptStatus === "generating" ? "Generating…" : "Generate script"}
              </button>
              <button onClick={() => void createVideoJob()} disabled={submitting || (!topic.trim() && !script)} className="glass-button flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {submitting ? "Queueing…" : "Generate video"}
              </button>
            </div>
            <div className="mt-4 flex items-start gap-2 text-[11px] leading-5 text-[#71717a]"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" /> Voice-over aur captions ek hi approved segment manifest se banenge, is liye Urdu caption/TTS mismatch nahi hona chahiye.</div>
          </section>
        </div>
      </div>
    </div>
  );
}
