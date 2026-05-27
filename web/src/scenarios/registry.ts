import type { ScenarioDef } from './types';
import cashFlowStress from './cash-flow-stress';
import investMonthly from './invest-monthly';
import bump401k from './bump-401k';
import windfallSplit from './windfall-split';
import fireDate from './fire-date';
import extraPayment from './extra-payment';
import balanceTransfer from './balance-transfer';
import debtConsolidation from './debt-consolidation';
import biweeklyMortgage from './biweekly-mortgage';
import haveKid from './have-kid';
import buyHouse from './buy-house';
import jobChange from './job-change';
import sabbatical from './sabbatical';
import recession from './recession';

/**
 * 0.24.0 — All registered scenarios. Order here drives picker order
 * within each category (the page groups by category first).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SCENARIOS: ScenarioDef<any>[] = [
  cashFlowStress,
  // Wealth
  investMonthly,
  bump401k,
  windfallSplit,
  fireDate,
  // Debt
  extraPayment,
  balanceTransfer,
  debtConsolidation,
  biweeklyMortgage,
  // Life events
  haveKid,
  buyHouse,
  jobChange,
  sabbatical,
  recession,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findScenario(id: string): ScenarioDef<any> | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
