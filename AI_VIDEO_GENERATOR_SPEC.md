# AI Video Generator — Implementation Contract

## Product behavior

The new sidebar entry is `AI Video Generator`. It opens a creator workspace where the user enters a topic, script direction, language, duration, visual style, aspect ratio, voice, and CTA preference. The user can either ask the system to generate a script or paste an approved script. The form always displays the calculated narration budget before generation.

The duration control runs from 1 minute to 120 minutes. The generator uses 120 words per minute for Urdu and Urdu-in-Devanagari phonetic narration, and 130 words per minute for other supported languages. The target is intentionally below the approximately 150 wpm conversational average because the requested output is explanatory social video with pauses, emphasis, hook timing, and captions. The UI shows both a target word count and an allowed range of 90%–105% so the system does not produce unnaturally compressed speech.

Formula: `targetWords = floor(durationSeconds / 60 * speechRateWpm)`.

Examples: Urdu/Devanagari at 120 wpm produces 120 words for 1 minute, 7,200 for 1 hour, and 14,400 for 2 hours. Other languages at 130 wpm produce 130 words for 1 minute, 7,800 for 1 hour, and 15,600 for 2 hours.

## Script contract

The script-generation response is strict JSON with the following shape:

```json
{
  "language": "ur",
  "caption_text": "Urdu Nastaleeq text",
  "tts_text": "Devanagari phonetic Urdu text",
  "segments": [
    {
      "id": "hook",
      "kind": "hook",
      "caption_text": "...",
      "tts_text": "...",
      "visual_prompt": "...",
      "start_seconds": 0,
      "end_seconds": 3
    },
    {
      "id": "hook_cta",
      "kind": "soft_cta",
      "caption_text": "...",
      "tts_text": "...",
      "visual_prompt": "...",
      "start_seconds": 3,
      "end_seconds": 8
    },
    {
      "id": "body-001",
      "kind": "explanation",
      "caption_text": "...",
      "tts_text": "...",
      "visual_prompt": "...",
      "start_seconds": 8,
      "end_seconds": 55
    },
    {
      "id": "cta",
      "kind": "cta",
      "caption_text": "...",
      "tts_text": "...",
      "visual_prompt": "...",
      "start_seconds": 55,
      "end_seconds": 60
    }
  ],
  "word_count": {
    "caption": 120,
    "tts": 120,
    "target": 120,
    "min": 108,
    "max": 126
  }
}
```

For Urdu, `caption_text` is the authoritative Nastaleeq display text and `tts_text` is the authoritative Devanagari phonetic text. The model must preserve the same sentence boundaries and meaning in both fields. The backend rejects a response when segment counts, segment IDs, or sentence alignment do not match. For languages other than Urdu, `caption_text` and `tts_text` are identical unless the selected provider requires a documented normalization step.

The default structure is 2–3 seconds of hook, a short natural soft CTA immediately after the hook, the main explanation, and a final CTA. The prompt must forbid generic repeated CTAs and must keep the soft CTA conversational rather than interruptive.

## Execution pipeline

1. The frontend sends a validated `video_generation` manifest to the backend.
2. The backend generates or validates the structured script using the configured AI model and stores the manifest in `jobs.input_data`.
3. The backend splits long narration into ElevenLabs-sized chunks at sentence or segment boundaries. It keeps the same `voice_id`, model, and voice settings across chunks and passes continuity context where supported.
4. The backend calls ElevenLabs server-side using the user’s saved secret. The recommended default is `eleven_v3` for Urdu because the official language list includes Urdu, while `eleven_multilingual_v2` is preferred for stable long-form languages that it explicitly supports. For very long jobs, the implementation uses chunking and records every request ID and audio artifact.
5. The backend creates visual scene prompts from the same segment list. Cloudflare’s current ByteDance video model accepts prompts but produces clips of only 4–12 seconds, so a 2-hour output is assembled from many short scenes; it is not a single 2-hour model request. Each scene is rendered independently and then concatenated by FFmpeg.
6. The backend queues the job for the existing remote runner. The runner downloads or receives scene assets, normalizes audio, concatenates the generated clips, muxes the ElevenLabs narration, creates a caption file from `caption_text`, and burns captions with FFmpeg.
7. Urdu captions use a bundled Noto Nastaliq Urdu font file and explicit font configuration. The Devanagari TTS text is never used as the visible caption layer.
8. The runner uploads the final MP4 and manifest artifacts through the existing job-artifact flow, and the frontend polls the existing job-status endpoint.

## Provider configuration

The existing backend receives an AI binding named `AI` in Wrangler configuration. The model name is configurable, with `bytedance/seedance-2.0` as the default visual model when available in the account. The selected visual clip duration is 10 seconds by default and is clamped to the provider’s documented 4–12 second range.

The ElevenLabs secret must be stored server-side, never in browser code or committed files. The UI exposes provider status, voice selection, model selection, and a connection test. Missing secrets produce a clear setup message rather than a partially queued job.

## Safety and cost controls

The backend enforces a maximum duration of 120 minutes, maximum prompt length, maximum number of generated visual scenes, and maximum concurrent provider requests. A 2-hour job can require up to 720 ten-second visual scenes before retries, so the UI must display an estimate and require an explicit confirmation for jobs longer than 30 minutes. The system supports a lower-cost `visual_mode` that reuses generated scenes or uses still-image motion when the user does not need a unique AI video clip for every 10 seconds.

## Sources

The narration target is based on guidance that conversational speech is around 120–150 wpm and that slower delivery improves intelligibility, especially for explanatory material [1] [2]. ElevenLabs’ documentation lists Urdu for Eleven v3, while Multilingual v2 has a narrower 29-language list and a 10,000-character per-request limit; its documentation recommends splitting long text and using continuity parameters for large conversions [3] [4]. Cloudflare’s current ByteDance video model documents a 4–12 second duration range, so long videos require scene assembly [5]. Cloudflare’s Workers AI binding is configured as `[ai] binding = "AI"` and invoked through `env.AI.run()` [6]. Noto Nastaliq Urdu is the intended caption font for the Urdu display layer [7].

[1]: https://www.voices.com/tools/words_to_time_conversion "Voices.com Words to Time Conversion"
[2]: https://tfcs.baruch.cuny.edu/speaking-rate/ "Baruch College Speaking Rate Guidance"
[3]: https://elevenlabs.io/docs/overview/models "ElevenLabs Models"
[4]: https://elevenlabs.io/docs/overview/capabilities/text-to-speech "ElevenLabs Text to Speech"
[5]: https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0/ "Cloudflare ByteDance Seedance 2.0"
[6]: https://developers.cloudflare.com/workers-ai/configuration/bindings/ "Cloudflare Workers AI Bindings"
[7]: https://fonts.google.com/noto/specimen/Noto+Nastaliq+Urdu "Google Fonts Noto Nastaliq Urdu"
