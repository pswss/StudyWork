import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";

export type NarrationRole = "female" | "male" | "neutral";

export interface NarrationSegment {
  text: string;
  role: NarrationRole;
}

const SPEAKER = "narrator|announcer|woman|female|w|man|male|m|speaker\\s*[ab]|[ab]";
const INLINE_SPEAKER = new RegExp(`\\s+(?=(?:\\*{0,2})(?:${SPEAKER})(?:\\*{0,2})\\s*[:：])`, "gi");
const SPEAKER_LINE = new RegExp(
  `^(?:[-*]\\s*)?(?:>\\s*)?\\*{0,2}(${SPEAKER})\\*{0,2}\\s*[:：]\\s*(.+)$`,
  "i",
);

function narrationRole(label: string): NarrationRole {
  const speaker = label.toLowerCase().replace(/\s+/g, "");
  if (["woman", "female", "w", "speakera", "a"].includes(speaker)) return "female";
  if (["man", "male", "m", "speakerb", "b"].includes(speaker)) return "male";
  return "neutral";
}

function speechText(markdown: string): string {
  return markdown
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function narrationSegments(markdown: string): NarrationSegment[] {
  const lines = markdown.replace(/\r/g, "").split("\n").flatMap(line =>
    line.replace(/^\s*>\s*/, "").replace(INLINE_SPEAKER, "\n").split("\n")
  );
  const segments: NarrationSegment[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^```/.test(line) || /^\|?[\s:|-]+\|?$/.test(line)) continue;
    const match = SPEAKER_LINE.exec(line);
    const text = speechText(match?.[2] ?? line);
    if (text && /[A-Za-z]/.test(text)) {
      segments.push({ text, role: match ? narrationRole(match[1]) : "neutral" });
    }
  }
  return segments;
}

const FEMALE_VOICE = /ava|samantha|karen|moira|tessa|victoria|zira|jenny|aria|sonia|female/i;
const MALE_VOICE = /aaron|alex|daniel|evan|nathan|tom|guy|ryan|male/i;

function preferredVoice(
  voices: SpeechSynthesisVoice[],
  role: NarrationRole,
  avoid?: SpeechSynthesisVoice | null,
): SpeechSynthesisVoice | null {
  const english = voices.filter(voice => voice.lang.toLowerCase().startsWith("en"));
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -Infinity;
  for (const voice of english) {
    const name = voice.name;
    let score = voice.lang.toLowerCase() === "en-us" ? 8 : 4;
    if (/enhanced|premium|natural|neural/i.test(name)) score += 12;
    if (voice.localService) score += 3;
    if (voice.default) score += 2;
    if (role === "female" && FEMALE_VOICE.test(name)) score += 10;
    if (role === "male" && MALE_VOICE.test(name)) score += 10;
    if (/compact|novelty/i.test(name)) score -= 20;
    if (avoid && voice.voiceURI === avoid.voiceURI) score -= 8;
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

type Playback = "idle" | "playing" | "paused" | "error";

export default function TranscriptNarration({ text }: { text: string }) {
  const { t } = useI18n();
  const [playback, setPlayback] = useState<Playback>("idle");
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const utterancesRef = useRef<SpeechSynthesisUtterance[]>([]);
  const generationRef = useRef(0);
  const supported = typeof window !== "undefined"
    && "speechSynthesis" in window
    && "SpeechSynthesisUtterance" in window;

  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const loadVoices = () => { voicesRef.current = synth.getVoices(); };
    loadVoices();
    synth.addEventListener("voiceschanged", loadVoices);
    return () => {
      generationRef.current++;
      synth.cancel();
      synth.removeEventListener("voiceschanged", loadVoices);
    };
  }, [supported]);

  function start() {
    if (!supported) return;
    const synth = window.speechSynthesis;
    if (playback === "paused") {
      synth.resume();
      setPlayback("playing");
      return;
    }
    const segments = narrationSegments(text);
    if (segments.length === 0) {
      setPlayback("error");
      return;
    }

    const generation = ++generationRef.current;
    synth.cancel();
    const female = preferredVoice(voicesRef.current, "female");
    const male = preferredVoice(voicesRef.current, "male", female);
    const neutral = preferredVoice(voicesRef.current, "neutral");
    let finished = 0;
    const utterances = segments.map(segment => {
      const utterance = new SpeechSynthesisUtterance(segment.text);
      utterance.lang = "en-US";
      utterance.rate = 0.92;
      utterance.pitch = 1;
      utterance.voice = segment.role === "female" ? female : segment.role === "male" ? male : neutral;
      utterance.onend = () => {
        if (generation !== generationRef.current) return;
        finished++;
        if (finished === segments.length) {
          utterancesRef.current = [];
          setPlayback("idle");
        }
      };
      utterance.onerror = event => {
        if (generation !== generationRef.current || event.error === "canceled" || event.error === "interrupted") return;
        generationRef.current++;
        synth.cancel();
        utterancesRef.current = [];
        setPlayback("error");
      };
      return utterance;
    });
    utterancesRef.current = utterances;
    setPlayback("playing");
    utterances.forEach(utterance => synth.speak(utterance));
  }

  function pause() {
    window.speechSynthesis.pause();
    setPlayback("paused");
  }

  function stop() {
    generationRef.current++;
    window.speechSynthesis.cancel();
    utterancesRef.current = [];
    setPlayback("idle");
  }

  if (!supported) {
    return <div className="quiz-narration"><span role="status">{t("problems.mock.narrationUnavailable")}</span></div>;
  }

  const primaryKey = playback === "playing"
    ? "problems.mock.narrationPause"
    : playback === "paused"
      ? "problems.mock.narrationResume"
      : "problems.mock.narrationPlay";
  const statusKey = playback === "playing"
    ? "problems.mock.narrationPlaying"
    : playback === "paused"
      ? "problems.mock.narrationPaused"
      : playback === "error"
        ? "problems.mock.narrationError"
        : "problems.mock.narration";

  return (
    <div className="quiz-narration" aria-label={t("problems.mock.narration")}>
      <button
        type="button"
        className="btn primary sm"
        onClick={playback === "playing" ? pause : start}
        aria-pressed={playback === "playing"}
      >{t(primaryKey)}</button>
      {(playback === "playing" || playback === "paused") && (
        <button type="button" className="btn sm" onClick={stop}>
          {t("problems.mock.narrationStop")}
        </button>
      )}
      <span className="quiz-narration-status" role="status" aria-live="polite">{t(statusKey)}</span>
    </div>
  );
}
