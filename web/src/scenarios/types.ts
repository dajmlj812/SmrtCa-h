/**
 * 0.24.0 — Scenario type system.
 *
 * Each scenario in /scenarios is a self-contained module that
 * exports a `ScenarioDef`: an id, display metadata, default
 * inputs, a React Form component, and a React Result component.
 *
 * Calculations live inside the Result component (or in a pure
 * helper imported by it). Keeping math out of state keeps URL
 * sharing and "reset to defaults" trivial: serialize the inputs,
 * deserialize them, render.
 *
 * Result components SHOULD NOT call APIs except where they need
 * historical data (e.g. cash-flow baseline). The rest is pure
 * arithmetic on the inputs.
 */

import type { ComponentType } from 'react';

export type ScenarioCategory =
  | 'cash-flow'
  | 'wealth'
  | 'debt'
  | 'life-event';

export interface ScenarioDef<I = unknown> {
  /** Stable id used in URL params and the registry map. */
  id: string;
  /** Short label shown in the picker. */
  title: string;
  /** One-sentence explanation rendered under the title in the picker. */
  subtitle: string;
  /** Bucket the picker groups by. */
  category: ScenarioCategory;
  /** Optional emoji shown next to the title. */
  icon?: string;
  /** Initial inputs when the user picks this scenario fresh. */
  defaults: I;
  /** Controlled form. */
  Form: ComponentType<{
    inputs: I;
    onChange: (next: I) => void;
  }>;
  /** Result panel. Re-renders on every input change. */
  Result: ComponentType<{ inputs: I }>;
}

export const CATEGORY_LABEL: Record<ScenarioCategory, string> = {
  'cash-flow': 'Cash flow',
  wealth: 'Wealth building',
  debt: 'Debt payoff',
  'life-event': 'Life events',
};

export const CATEGORY_ORDER: ScenarioCategory[] = [
  'cash-flow',
  'wealth',
  'debt',
  'life-event',
];
