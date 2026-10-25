// ElevenLabs text-to-speech and speech-to-text for the website chat.
// The API key lives only in this process (ELEVENLABS_API_KEY in .env). The browser talks to our routes in web-api.ts, never to ElevenLabs.
// Message text and audio are personal, so nothing here is logged except status codes.

export class VoiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const MAX_TTS_CHARS = 2_000;                 // longer replies are trimmed before they are spoken
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;     // about two minutes of compressed speech, far more than the 60 s the page records
export const MIN_AUDIO_BYTES = 400;                 // anything smaller can't hold speech
const TIMEOUT_MS = 20_000;

// Premade voice "Rachel". Change it with ELEVENLABS_VOICE_ID. Models can be changed with ELEVENLABS_TTS_MODEL / ELEVENLABS_STT_MODEL.
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const settings = () => ({
  key: (process.env.ELEVENLABS_API_KEY ?? "").trim(),
  base: (process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io").replace(/\/+$/, ""),   // only changed in tests
  voice: (process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE).trim(),
  ttsModel: (process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2").trim(),
  sttModel: (process.env.ELEVENLABS_STT_MODEL || "scribe_v2").trim(),
});

/** What the website may offer. Both features share one key, so they are on or off together. */
export const voiceStatus = () => { const on = settings().key.length > 0; return { tts: on, stt: on }; };

/** Plain speakable text: no markdown marks, bullets or macro formatting characters, and a sane length. */
export function speakable(text: string): string {
  return text.replace(/\*\*|__|`|#+\s*/g, "").replace(/^\s*[-•*]\s+/gm, "").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim().slice(0, MAX_TTS_CHARS);
}

async function call(path: string, init: RequestInit): Promise<Response> {
  const s = settings();
  if (!s.key) throw new VoiceError(503, "Voice isn't set up on the assistant yet.");
  let res: Response;
  try {
    res = await fetch(s.base + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "xi-api-key": s.key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new VoiceError(504, "The voice service took too long. Try again.");
    throw new VoiceError(502, "Couldn't reach the voice service. Try again in a moment.");
  }
  if (res.ok) return res;
  // The body is only inspected for the kind of failure, never printed (it can echo the request).
  const detail = await res.json().catch(() => ({})) as { detail?: unknown };
  const tag = JSON.stringify(detail.detail ?? "").toLowerCase();
  const code = typeof (detail.detail as { status?: unknown } | undefined)?.status === "string" ? ` (${(detail.detail as { status: string }).status})` : "";   // e.g. quota_exceeded; a short code, never the message text
  console.error(`🔊 ElevenLabs answered ${res.status}${code}`);
  if (res.status === 429 || tag.includes("quota") || tag.includes("limit")) throw new VoiceError(429, "The voice limit has been reached. Try again later.");
  if (res.status === 401 || res.status === 403) throw new VoiceError(503, "Voice isn't set up correctly on the assistant.");   // bad key or plan: the owner must fix it
  if (res.status === 400 || res.status === 422) throw new VoiceError(400, "The voice service couldn't use that request.");
  throw new VoiceError(502, "The voice service had a problem. Try again in a moment.");
}

/** Text to MP3 bytes. */
export async function synthesize(text: string): Promise<Uint8Array> {
  const clean = speakable(text);
  if (!clean) throw new VoiceError(400, "There is nothing to read aloud.");
  const s = settings();
  const res = await call(`/v1/text-to-speech/${encodeURIComponent(s.voice)}?output_format=mp3_44100_128`, {
    method: "POST", headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: clean, model_id: s.ttsModel }),
  });
  const audio = new Uint8Array(await res.arrayBuffer());
  if (!audio.length) throw new VoiceError(502, "The voice service returned no audio.");
  return audio;
}

/** Recorded audio to text. An empty string means no speech was recognised. */
export async function transcribe(audio: Uint8Array, mime: string): Promise<string> {
  if (audio.length < MIN_AUDIO_BYTES) throw new VoiceError(400, "That recording was too short.");
  if (audio.length > MAX_AUDIO_BYTES) throw new VoiceError(413, "That recording is too long.");
  const type = /^audio\/[a-z0-9.+-]+/i.exec(mime)?.[0] ?? "audio/webm";
  const form = new FormData();
  form.set("model_id", settings().sttModel);
  form.set("file", new Blob([audio], { type }), "speech." + (type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm"));
  const res = await call("/v1/speech-to-text", { method: "POST", body: form });
  const data = await res.json().catch(() => ({})) as { text?: unknown };
  return typeof data.text === "string" ? data.text.trim().slice(0, 2_000) : "";
}
