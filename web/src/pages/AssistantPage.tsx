import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  api,
  isUpgradeRequired,
  type AssistantClientMessage,
  type AssistantStagedBatch,
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
  // 0.20.1 — stage mode + the most-recent staged batch awaiting review.
  const [stageMode, setStageMode] = useState(false);
  const [pendingBatch, setPendingBatch] = useState<AssistantStagedBatch | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
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
      const res = await api.assistantChat(wire, {
        mode: stageMode ? 'stage' : 'auto',
      });
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
      // 0.20.1 — if the server staged write actions, fetch the
      // full batch so the preview panel can render the full list.
      if (res.staged_batch_id) {
        try {
          const batch = await api.getStagedBatch(res.staged_batch_id);
          setPendingBatch(batch);
        } catch {
          /* preview is best-effort */
        }
      }
    } catch (err) {
      if (isUpgradeRequired(err)) {
        // 0.15.4: 402 from /api/assistant/chat means either the plan
        // doesn't include the assistant OR the monthly quota is
        // exhausted. The error message carries the specific reason;
        // surface it inline so the user knows which.
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Assistant request failed');
      }
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

  // 0.20.1 — staged batch lifecycle from the panel.
  async function applyBatch() {
    if (!pendingBatch) return;
    setBatchBusy(true);
    setError(null);
    try {
      const updated = await api.commitStagedBatch(pendingBatch.id);
      setPendingBatch(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setBatchBusy(false);
    }
  }

  async function undoLatestBatch() {
    if (!pendingBatch) return;
    setBatchBusy(true);
    setError(null);
    try {
      const updated = await api.undoStagedBatch(pendingBatch.id);
      setPendingBatch(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Undo failed');
    } finally {
      setBatchBusy(false);
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

        {pendingBatch && (
          <StagedBatchPanel
            batch={pendingBatch}
            busy={batchBusy}
            onApply={() => void applyBatch()}
            onUndo={() => void undoLatestBatch()}
            onDismiss={() => setPendingBatch(null)}
          />
        )}
      </div>

      <div className="chat-stage-toggle">
        <label>
          <input
            type="checkbox"
            checked={stageMode}
            disabled={busy}
            onChange={(e) => setStageMode(e.target.checked)}
          />
          <span>Stage actions (review before applying)</span>
        </label>
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

// 0.20.1 — preview panel for a staged batch. Shows the action list,
// any "unsupported undo" warning, and Apply / Undo / Dismiss
// buttons depending on the batch's current status.
function StagedBatchPanel({
  batch,
  busy,
  onApply,
  onUndo,
  onDismiss,
}: {
  batch: AssistantStagedBatch;
  busy: boolean;
  onApply: () => void;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const unsupportedCount = batch.inverses.filter((i) => i.unsupported).length;
  return (
    <div className={`staged-batch staged-batch-${batch.status}`}>
      <header className="staged-batch-head">
        <strong>
          {batch.status === 'pending' && 'Proposed changes — review before applying'}
          {batch.status === 'applied' && '✓ Applied'}
          {batch.status === 'undone' && '↶ Undone'}
          {batch.status === 'failed' && '⚠ Failed — see error below'}
        </strong>
        <button type="button" className="btn-link" onClick={onDismiss}>
          ✕
        </button>
      </header>
      <ol className="staged-batch-list">
        {(batch.action_descriptions ?? batch.actions.map((a) => a.tool)).map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ol>
      {batch.status === 'applied' && unsupportedCount > 0 && (
        <p className="muted small">
          {unsupportedCount} action{unsupportedCount === 1 ? '' : 's'} cannot
          be undone automatically (no inverse available for that tool).
          Manual undo via the audit log if needed.
        </p>
      )}
      {batch.error && (
        <pre className="banner error" style={{ whiteSpace: 'pre-wrap' }}>
          {batch.error}
        </pre>
      )}
      <footer className="staged-batch-actions">
        {batch.status === 'pending' && (
          <>
            <button
              type="button"
              className="btn secondary"
              onClick={onDismiss}
              disabled={busy}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn"
              onClick={onApply}
              disabled={busy}
            >
              {busy ? 'Applying…' : `Apply ${batch.actions.length} action${batch.actions.length === 1 ? '' : 's'}`}
            </button>
          </>
        )}
        {batch.status === 'applied' && (
          <button
            type="button"
            className="btn secondary"
            onClick={onUndo}
            disabled={busy || unsupportedCount === batch.actions.length}
          >
            {busy ? 'Undoing…' : 'Undo this batch'}
          </button>
        )}
      </footer>
    </div>
  );
}
