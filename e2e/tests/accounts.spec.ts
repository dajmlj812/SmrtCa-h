import { test, expect } from '@playwright/test';

test('create an account and see it in the list', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Account' }).click();

  const name = `E2E Checking ${Date.now()}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Type').selectOption('checking');
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page.getByText(name)).toBeVisible();
});

test('open an account detail page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Account' }).click();

  const name = `E2E Savings ${Date.now()}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Type').selectOption('savings');
  await page.getByRole('button', { name: 'Create Account' }).click();

  await page.getByText(name).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('Balance')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
});
