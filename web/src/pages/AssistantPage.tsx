import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  api,
  type AssistantClientMessage,
  type AssistantToolCall,
} from '../api';

/**
 * Phase 9.1 (0.12.1) — AI assistant chat page.
 *
 * Multi-turn chat against the server's tool-use loop. The server
 * handles tool execution; the client just sends the conversation
 * history + renders the response.
 *
 * Each round-trip shows what tools the assistant called inline as
 * small chips so the user can see exactly what happened — especially
 * important since write tools (update_transaction_category, etc.)
 * autonomously change data.
 *
 * The /assistant nav link is only rendered if /api/assistant/status
 * reports available=true (i.e. AI_PROVIDER=claude is configured).
 */

interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: AssistantToolCall[];
  iterations?: number;
  stopReason?: string;
}

export function AssistantPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .assistantStatus()
      .then((s) => {
        setAvailable(s.available);
        setUnavailableReason(s.reason ?? null);
      })
      .catch(() => {
        setAvailable(false);
        setUnavailableReason('Failed to load assistant status');
      });
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    const next: DisplayMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);

    const wire: AssistantClientMessage[] = next.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const res = await api.assistantChat(wire);
      setMessages((cur) => [
        ...cur,
        {
          role: 'assistant',
          content: res.reply,
          toolCalls: res.toolCalls,
          iterations: res.iterations,
          stopReason: res.stopReason,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assistant request failed');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (available === null) {
    return (
      <div>
        <div className="page-header">
          <h1>Assistant</h1>
        </div>
        <p className="empty">Loading…</p>
      </div>
    );
  }

  if (!available) {
    return (
      <div>
        <div className="page-header">
          <h1>Assistant</h1>
        </div>
        <div className="banner info">
          The AI assistant isn't available right now.
          {unavailableReason && (
            <>
              <br />
              <span className="muted">{unavailableReason}</span>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="assistant-page">
      <div className="page-header">
        <div>
          <h1>Assistant</h1>
          <div className="subtitle">
            Ask questions or give instructions in plain English. The
            assistant can read your data <em>and</em> make changes
            (categorize, budget, mark bills paid). Every change is
            recorded in the audit log.
          </div>
        </div>
        {messages.length > 0 && (
          <button
            className="btn secondary"
            type="button"
            onClick={() => {
              if (confirm('Clear this conversation?')) setMessages([]);
            }}
            disabled={busy}
          >
            New chat
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="muted">Try one of these:</p>
            <div className="chat-suggestions">
              {[
                'How much did I spend on coffee last month?',
                'What are my upcoming bills this week?',
                'Show me the biggest spending categories last quarter',
                'Set my Dining budget to $400 for this month',
              ].map((s) => (
                <button
                  key={s}
                  className="btn small secondary"
                  onClick={() => setInput(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-msg-${m.role}`}>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div className="chat-tools">
                {m.toolCalls.map((tc, j) => (
                  <span
                    key={j}
                    className={`chat-tool-chip ${tc.error ? 'err' : tc.kind}`}
                    title={JSON.stringify(tc.input)}
                  >
                    {tc.kind === 'write' ? '✎ ' : '🔍 '}
                    {tc.name}
                    {tc.error ? ' (error)' : ''}
                  </span>
                ))}
              </div>
            )}
            <div className="chat-bubble">{m.content || <em>(no text)</em>}</div>
            {m.stopReason === 'tool_use_loop_cap' && (
              <div className="muted" style={{ fontSize: 12 }}>
                Stopped at the iteration cap — ask a follow-up if needed.
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-bubble">
              <em>Thinking…</em>
            </div>
          </div>
        )}
      </div>

      <form className="chat-form" onSubmit={onSubmit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything about your finances…"
          rows={2}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy || !input.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
