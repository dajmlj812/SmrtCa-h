import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const CREDIT_CARD_FIXTURE = fileURLToPath(
  new URL(
    '../../server/tests/fixtures/chase-credit-card.csv',
    import.meta.url,
  ),
);

async function createAccount(
  page: import('@playwright/test').Page,
  name: string,
): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Account' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Type').selectOption('credit_card');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByText(name)).toBeVisible();
}

test('import a statement from upload through to transactions', async ({
  page,
}) => {
  const accountName = `E2E Import ${Date.now()}`;
  await createAccount(page, accountName);

  // Go to the Import page and choose the account.
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page
    .getByLabel('Import into account')
    .selectOption({ label: accountName });

  // Upload the fixture — a preview should appear.
  await page
    .getByLabel('Choose a .csv or .xlsx file to import')
    .setInputFiles(CREDIT_CARD_FIXTURE);
  await expect(page.getByText(/Detected format/)).toBeVisible();

  // Commit the import.
  await page.getByRole('button', { name: /Import \d+ transaction/ }).click();
  await expect(page.getByText(/Import complete/)).toBeVisible();

  // The imported transactions are visible.
  await page
    .getByRole('link', { name: 'View transactions', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Transactions' }),
  ).toBeVisible();
  // Other e2e tests may have imported the same fixture earlier in the run
  // (the e2e DB is shared) — assert at-least-one match rather than uniqueness.
  await expect(
    page.getByText('AUTOMATIC PAYMENT - THANK').first(),
  ).toBeVisible();
});

test('importing the same file twice skips duplicates', async ({ page }) => {
  const accountName = `E2E Dedup ${Date.now()}`;
  await createAccount(page, accountName);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await page
      .getByLabel('Import into account')
      .selectOption({ label: accountName });
    await page
      .getByLabel('Choose a .csv or .xlsx file to import')
      .setInputFiles(CREDIT_CARD_FIXTURE);
    await page
      .getByRole('button', { name: /Import \d+ transaction/ })
      .click();
    await expect(page.getByText(/Import complete/)).toBeVisible();
  }

  // The second import reports every row skipped as a duplicate.
  await expect(page.getByText(/8 skipped as duplicates/)).toBeVisible();
});
