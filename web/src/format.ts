/** Format integer cents as a localized USD currency string. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

/** Format an ISO 'YYYY-MM-DD' date as 'MM/DD/YYYY' without timezone drift. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

/** Human label for an account type code. */
export function accountTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    checking: 'Checking',
    savings: 'Savings',
    credit_card: 'Credit Card',
    cash: 'Cash',
    investment: 'Investment',
    loan: 'Loan',
    other: 'Other',
  };
  return labels[type] ?? type;
}
