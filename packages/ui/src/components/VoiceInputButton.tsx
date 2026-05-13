import { useEffect, useRef, useState } from "react";

// Minimal ambient types for the Web Speech API. The DOM lib doesn't ship
// these globally so we inline the subset we actually use.
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface Props {
  /** Called with the final transcript when recording stops. Appended, not replaced. */
  onTranscript: (text: string) => void;
  /** Disable the button when the surrounding form is busy. */
  disabled?: boolean;
}

/**
 * Press-and-hold mic button that uses the browser's Web Speech API.
 * Falls back to a disabled "not supported" state in browsers without the
 * API (Firefox/Safari today). The transcript is appended to the existing
 * input via `onTranscript` so the caller doesn't lose anything they typed.
 */
export function VoiceInputButton({ onTranscript, disabled }: Props) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const interimRef = useRef<string>("");

  useEffect(() => {
    const Recognition: SpeechRecognitionCtor | undefined =
      (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
    if (!Recognition) return;
    setSupported(true);
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // Already stopped.
      }
    };
  }, []);

  function start() {
    if (!supported || listening) return;
    const Recognition: SpeechRecognitionCtor | undefined =
      (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
    if (!Recognition) return;
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    interimRef.current = "";

    rec.onresult = (event: SpeechRecognitionEventLike) => {
      // Accumulate final segments; the final text is whatever the API has
      // confirmed by the time the user releases the button.
      let finalDelta = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalDelta += res[0].transcript;
      }
      if (finalDelta) interimRef.current += finalDelta;
    };

    rec.onerror = () => {
      setListening(false);
    };

    rec.onend = () => {
      setListening(false);
      const text = interimRef.current.trim();
      interimRef.current = "";
      if (text) onTranscript(text);
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // Already started or permission denied; nothing to do.
    }
  }

  function stop() {
    if (!listening) return;
    try {
      recognitionRef.current?.stop();
    } catch {
      // Already stopped.
    }
  }

  if (!supported) {
    return (
      <button
        type="button"
        className="voice-input-btn disabled"
        title="Voice input is not supported in this browser"
        disabled
        aria-label="Voice input unavailable"
      >
        🎙
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`voice-input-btn${listening ? " listening" : ""}`}
      disabled={disabled}
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={stop}
      onTouchStart={(e) => {
        e.preventDefault();
        start();
      }}
      onTouchEnd={stop}
      title={listening ? "Recording — release to stop" : "Hold to talk"}
      aria-pressed={listening}
      aria-label="Voice input"
    >
      {listening ? "⏺" : "🎙"}
    </button>
  );
}
