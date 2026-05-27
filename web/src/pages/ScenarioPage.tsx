import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SCENARIOS, findScenario } from '../scenarios/registry';
import { CATEGORY_LABEL, CATEGORY_ORDER, type ScenarioCategory, type ScenarioDef } from '../scenarios/types';

/**
 * 0.24.0 — Scenario hub.
 *
 * Left rail: scenario picker (grouped by category). Right pane: the
 * picked scenario's Form + Result. The URL query string carries the
 * selected scenario id so a refresh or shared link lands on the same
 * scenario (`/scenarios?type=fire-date`).
 *
 * Input state lives per-scenario inside the hub component (Map keyed
 * by scenario id). Switching scenarios preserves the inputs you
 * already typed into the other one, so users can flip back and
 * forth comparing answers.
 */
export function ScenarioPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const initialId =
    new URLSearchParams(location.search).get('type') ?? SCENARIOS[0]!.id;
  const [selectedId, setSelectedId] = useState<string>(
    findScenario(initialId) ? initialId : SCENARIOS[0]!.id,
  );

  // Per-scenario input store. Each scenario manages its own shape;
  // we keep them all here keyed by id so switching scenarios
  // doesn't wipe what you typed into the other one.
  const [inputsById, setInputsById] = useState<Record<string, unknown>>(() => {
    const map: Record<string, unknown> = {};
    for (const s of SCENARIOS) map[s.id] = s.defaults;
    return map;
  });

  const selected = useMemo(
    () => findScenario(selectedId) ?? SCENARIOS[0]!,
    [selectedId],
  );

  function pick(id: string) {
    setSelectedId(id);
    const p = new URLSearchParams(location.search);
    p.set('type', id);
    navigate(`/scenarios?${p.toString()}`, { replace: true });
  }

  function resetCurrent() {
    setInputsById((prev) => ({ ...prev, [selected.id]: selected.defaults }));
  }

  // Group registry by category in declared order.
  const byCategory = new Map<ScenarioCategory, ScenarioDef[]>();
  for (const s of SCENARIOS) {
    const arr = byCategory.get(s.category) ?? [];
    arr.push(s);
    byCategory.set(s.category, arr);
  }

  const SelectedForm = selected.Form;
  const SelectedResult = selected.Result;
  const currentInputs = inputsById[selected.id] ?? selected.defaults;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>What-if scenarios</h1>
          <div className="subtitle">
            Concrete answers to "should I…?" — debt payoff math, wealth
            projections, and life-event impact, all in one place.
          </div>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(220px, 280px) 1fr',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <nav
          aria-label="Scenario picker"
          style={{
            position: 'sticky',
            top: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          {CATEGORY_ORDER.map((cat) => {
            const list = byCategory.get(cat);
            if (!list || list.length === 0) return null;
            return (
              <div key={cat}>
                <div
                  className="muted"
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    marginBottom: 4,
                  }}
                >
                  {CATEGORY_LABEL[cat]}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {list.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => pick(s.id)}
                      className={s.id === selected.id ? 'btn' : 'btn secondary'}
                      style={{
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        padding: '8px 10px',
                        fontWeight: s.id === selected.id ? 600 : 400,
                      }}
                    >
                      {s.icon && <span style={{ marginRight: 6 }}>{s.icon}</span>}
                      {s.title}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 6,
              }}
            >
              <h2 style={{ margin: 0 }}>
                {selected.icon && <span style={{ marginRight: 6 }}>{selected.icon}</span>}
                {selected.title}
              </h2>
              <button
                type="button"
                className="btn-link"
                onClick={resetCurrent}
                title="Reset this scenario's inputs to their defaults"
              >
                Reset to defaults
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 0 }}>
              {selected.subtitle}
            </p>
            <SelectedForm
              inputs={currentInputs}
              onChange={(next: unknown) =>
                setInputsById((prev) => ({ ...prev, [selected.id]: next }))
              }
            />
          </div>
          <SelectedResult inputs={currentInputs} />
        </div>
      </div>
    </div>
  );
}
