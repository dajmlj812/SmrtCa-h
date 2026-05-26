import { useEffect, useRef, useState } from 'react';

/**
 * 0.20.2 — voice input button (mic icon next to the assistant input).
 *
 * Uses the browser's built-in SpeechRecognition (Web Speech API).
 * Behavior per vendor:
 *   • Safari    — fully on-device on iOS 14.5+ + macOS 12+
 *   • Chrome    — routes audio through Google's servers
 *   • Edge      — routes audio through Microsoft Speech Services
 *   • Firefox   — not supported (we hide the button)
 *
 * Tap to start; tap again (or auto-stop on N seconds of silence) to
 * commit the transcript. Live interim transcript is appended to the
 * input as the user speaks.
 *
 * Future: drop in Whisper.cpp WASM for a strict "audio stays on
 * device" guarantee across all browsers — but that's a ~75 MB
 * model download we want behind a separate opt-in. This MVP gets
 * the voice-first UX in operators' hands today; the privacy
 * upgrade ships as a follow-up.
 */

// Web Speech API isn't in lib.dom yet — declare what we use.
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
    length: number;
  }>;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SRConstructor = new () => SpeechRecognitionLike;

function getSR(): SRConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: SRConstructor;
    webkitSpeechRecognition?: SRConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface Props {
  /** Append the recognized text to the existing input. */
  onTranscript: (text: string) => void;
  /** True when the parent is busy (e.g. waiting on an assistant reply). */
  disabled?: boolean;
}

export function VoiceInputButton({ onTranscript, disabled }: Props) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  // Accumulate the in-progress transcript across interim events so
  // the parent only sees the latest combined text.
  const interimRef = useRef('');
  const finalRef = useRef('');

  const Constructor = getSR();
  const supported = Constructor !== null;

  useEffect(() => {
    // Stop any running recognition on unmount.
    return () => {
      try {
        recogRef.current?.abort();
      } catch {
        /* harmless */
      }
    };
  }, []);

  function start() {
    if (!Constructor) return;
    setError(null);
    finalRef.current = '';
    interimRef.current = '';
    const recog = new Constructor();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = navigator.language || 'en-US';

    recog.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]!;
        const txt = r[0].transcript;
        if (r.isFinal) finalRef.current += txt + ' ';
        else interim += txt;
      }
      interimRef.current = interim;
      // Push the combined transcript to the parent each tick. The
      // parent treats it as authoritative; this means typing while
      // recording is overwritten. Tradeoff for simplicity.
      onTranscript((finalRef.current + interim).trim());
    };
    recog.onerror = (e: SpeechRecognitionErrorEvent) => {
      // Common: "not-allowed" (user denied mic), "no-speech" (silence)
      if (e.error === 'no-speech') {
        // Just stop quietly — not an error worth alarming the user.
        recog.stop();
        return;
      }
      setError(
        e.error === 'not-allowed'
          ? 'Microphone access denied. Enable in your browser settings.'
          : `Speech recognition error: ${e.error}`,
      );
      setRecording(false);
    };
    recog.onend = () => {
      setRecording(false);
      recogRef.current = null;
    };

    try {
      recog.start();
      recogRef.current = recog;
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recording');
    }
  }

  function stop() {
    try {
      recogRef.current?.stop();
    } catch {
      /* harmless */
    }
  }

  if (!supported) return null;

  return (
    <div className="voice-input">
      <button
        type="button"
        className={`btn-mic ${recording ? 'btn-mic-recording' : ''}`}
        disabled={disabled}
        onClick={() => (recording ? stop() : start())}
        title={recording ? 'Stop recording' : 'Voice input'}
        aria-pressed={recording}
        aria-label={recording ? 'Stop recording' : 'Start voice input'}
      >
        {recording ? '⏺' : '🎤'}
      </button>
      {error && <span className="voice-input-error">{error}</span>}
    </div>
  );
}
