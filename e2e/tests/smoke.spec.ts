import { test, expect } from '@playwright/test';

test('the app loads with its navigation', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: 'Accounts', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Transactions', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Import', exact: true }),
  ).toBeVisible();
});

test('navigation moves between the main pages', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();

  await page.getByRole('link', { name: 'Transactions', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Transactions' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible();
});
