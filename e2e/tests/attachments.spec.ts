import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const CREDIT_CARD_FIXTURE = fileURLToPath(
  new URL(
    '../../server/tests/fixtures/chase-credit-card.csv',
    import.meta.url,
  ),
);

// 1×1 transparent PNG — smallest valid receipt-ish image.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function importTransactions(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Account' }).click();
  const accountName = `E2E Attachments ${Date.now()}`;
  await page.getByLabel('Name').fill(accountName);
  await page.getByLabel('Type').selectOption('credit_card');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByText(accountName)).toBeVisible();

  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page
    .getByLabel('Import into account')
    .selectOption({ label: accountName });
  await page
    .getByLabel('Choose a .csv or .xlsx file to import')
    .setInputFiles(CREDIT_CARD_FIXTURE);
  await page.getByRole('button', { name: /Import \d+ transaction/ }).click();
  await expect(page.getByText(/Import complete/)).toBeVisible();
}

test('attach a receipt to a transaction and delete it', async ({ page }) => {
  await importTransactions(page);

  // Go to Transactions, open the modal on the first row.
  await page.getByRole('link', { name: 'Transactions', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Transactions' }),
  ).toBeVisible();

  // Wait until the table has rendered.
  await expect(
    page.getByText('AUTOMATIC PAYMENT - THANK').first(),
  ).toBeVisible();

  // The first attach button on the page is on the first transaction row.
  await page.locator('button.attach-btn').first().click();

  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole('heading', { name: 'Receipts & attachments' }),
  ).toBeVisible();

  // Upload via the hidden file input inside the dropzone.
  await modal.locator('input[type="file"]').setInputFiles({
    name: 'receipt.png',
    mimeType: 'image/png',
    buffer: Buffer.from(TINY_PNG_BASE64, 'base64'),
  });

  // The attachment card should appear with the filename.
  await expect(modal.getByText('receipt.png')).toBeVisible();
  // AI provider is rules in e2e, so OCR is skipped — the card shows the
  // skipped state.
  await expect(modal.getByText(/No OCR/i)).toBeVisible();

  // Delete it via window.confirm + Delete button.
  page.once('dialog', (d) => void d.accept());
  await modal.getByRole('button', { name: 'Delete' }).click();

  // The attachment card disappears.
  await expect(modal.getByText('receipt.png')).toHaveCount(0);
  await expect(
    modal.getByText('No attachments yet — drop a receipt above.'),
  ).toBeVisible();
});
