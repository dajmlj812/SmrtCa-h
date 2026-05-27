import type pg from 'pg';

/**
 * 0.21.x — single canonical category taxonomy.
 *
 * One list. Used by:
 *   • initial seed on every new tenant
 *   • the assistant's allowed-categories set
 *   • the AI normalizer's target labels
 *   • every category dropdown in the UI (via /api/categories)
 *   • the Schedule C / Schedule A / Schedule E grouping in tax reports
 *
 * Each leaf may carry a `taxCategory` string in the exact form the
 * tax-schedule-c.ts matcher (and the year-end report) expect, so the
 * moment a user assigns a transaction to "Office Expense" it lands
 * on Schedule C Line 18 with no extra step.
 *
 * Hard-reset semantics: callers wanting to "rebuild from canonical"
 * call resetCanonicalCategories(tenantId). Existing transactions /
 * budgets / splits keep their FKs via ON DELETE SET NULL where the
 * schema allows; on DELETE CASCADE rows (budgets) are recreated by
 * the budget wizard.
 */

export interface CanonicalCategory {
  readonly name: string;
  /**
   * Free-text tax_category label (matches the existing matcher in
   * server/src/domain/tax-schedule-c.ts). Leaves WITHOUT one are
   * pure personal-finance categories (Groceries, Pets, etc.) — they
   * don't affect tax reports.
   */
  readonly taxCategory?: string;
  readonly children?: readonly CanonicalCategory[];
}

/**
 * Federal-tax-aware canonical taxonomy.
 *
 * Sources:
 *   • Schedule C lines (1–27a) — sole proprietor / self-employment
 *   • Schedule A lines — itemized deductions
 *   • Schedule E lines — rental + royalty income/expenses
 *   • Schedule D — capital gains by holding period
 *   • Form 1040 Schedule 1 — above-the-line deductions
 *   • Schedule SE — self-employment tax
 *   • Standard personal-finance categories (no tax mapping)
 */
export const CANONICAL_CATEGORY_TREE: readonly CanonicalCategory[] = [
  // ── Income ────────────────────────────────────────────────
  {
    name: 'Income',
    children: [
      { name: 'Salary & Wages (W-2)', taxCategory: 'Form 1040 - Line 1a Wages' },
      { name: 'Bonus & Commission', taxCategory: 'Form 1040 - Line 1a Wages' },
      { name: 'Tips', taxCategory: 'Form 1040 - Line 1a Wages' },
      { name: 'Self-Employment Income', taxCategory: 'Schedule C - Line 1 Gross receipts' },
      { name: 'Freelance / 1099 Income', taxCategory: 'Schedule C - Line 1 Gross receipts' },
      { name: 'Returns & Allowances', taxCategory: 'Schedule C - Line 2 Returns and allowances' },
      { name: 'Interest Income', taxCategory: 'Schedule B - Interest' },
      { name: 'Dividend Income (Qualified)', taxCategory: 'Schedule B - Qualified dividends' },
      { name: 'Dividend Income (Ordinary)', taxCategory: 'Schedule B - Ordinary dividends' },
      { name: 'Short-Term Capital Gain', taxCategory: 'Schedule D - Short-term capital gain' },
      { name: 'Long-Term Capital Gain', taxCategory: 'Schedule D - Long-term capital gain' },
      { name: 'Cryptocurrency Gain', taxCategory: 'Schedule D - Long-term capital gain' },
      { name: 'Rental Income', taxCategory: 'Schedule E - Rental income' },
      { name: 'Royalty Income', taxCategory: 'Schedule E - Royalties' },
      { name: 'Pension & Retirement Income', taxCategory: 'Form 1040 - Line 5a Pensions' },
      { name: 'IRA Distribution', taxCategory: 'Form 1040 - Line 4a IRA distributions' },
      { name: 'Social Security Benefits', taxCategory: 'Form 1040 - Line 6a Social Security' },
      { name: 'Unemployment Compensation', taxCategory: 'Schedule 1 - Unemployment compensation' },
      { name: 'Alimony Received (pre-2019)', taxCategory: 'Schedule 1 - Alimony received' },
      { name: 'Refunds & Reimbursements' },
      { name: 'Tax Refund' },
      { name: 'Government Benefits' },
      { name: 'Other Income' },
    ],
  },

  // ── Business expenses — Schedule C ────────────────────────
  {
    name: 'Business — Schedule C',
    children: [
      { name: 'Advertising (business)', taxCategory: 'Schedule C - Line 8 Advertising' },
      { name: 'Car & Truck Expense', taxCategory: 'Schedule C - Line 9 Car and truck' },
      { name: 'Commissions & Fees Paid', taxCategory: 'Schedule C - Line 10 Commissions and fees' },
      { name: 'Contract Labor (1099 paid)', taxCategory: 'Schedule C - Line 11 Contract labor' },
      { name: 'Depletion', taxCategory: 'Schedule C - Line 12 Depletion' },
      { name: 'Depreciation (business)', taxCategory: 'Schedule C - Line 13 Depreciation' },
      { name: 'Employee Benefit Programs', taxCategory: 'Schedule C - Line 14 Employee benefits' },
      { name: 'Business Insurance', taxCategory: 'Schedule C - Line 15 Insurance' },
      { name: 'Business Mortgage Interest', taxCategory: 'Schedule C - Line 16a Mortgage interest' },
      { name: 'Business Loan Interest', taxCategory: 'Schedule C - Line 16b Other interest' },
      { name: 'Legal & Professional Services', taxCategory: 'Schedule C - Line 17 Legal and professional services' },
      { name: 'Office Expense', taxCategory: 'Schedule C - Line 18 Office expense' },
      { name: 'Pension / SEP / Solo 401(k) — employer', taxCategory: 'Schedule C - Line 19 Pension' },
      { name: 'Equipment / Vehicle Rent', taxCategory: 'Schedule C - Line 20a Rent equipment' },
      { name: 'Business Property Rent', taxCategory: 'Schedule C - Line 20b Rent' },
      { name: 'Repairs & Maintenance (business)', taxCategory: 'Schedule C - Line 21 Repairs and maintenance' },
      { name: 'Business Supplies', taxCategory: 'Schedule C - Line 22 Supplies' },
      { name: 'Business Taxes & Licenses', taxCategory: 'Schedule C - Line 23 Taxes and licenses' },
      { name: 'Business Travel', taxCategory: 'Schedule C - Line 24a Travel' },
      { name: 'Business Meals', taxCategory: 'Schedule C - Line 24b Meals' },
      { name: 'Business Utilities', taxCategory: 'Schedule C - Line 25 Utilities' },
      { name: 'Wages Paid', taxCategory: 'Schedule C - Line 26 Wages' },
      { name: 'Home Office Expense', taxCategory: 'Schedule C - Line 30 Home office' },
      { name: 'Other Business Expense', taxCategory: 'Schedule C - Line 27a Other expenses' },
    ],
  },

  // ── Itemized deductions — Schedule A ──────────────────────
  {
    name: 'Deductions — Schedule A',
    children: [
      { name: 'Medical & Dental (deductible)', taxCategory: 'Schedule A - Line 1 Medical' },
      { name: 'State & Local Income Tax Paid', taxCategory: 'Schedule A - Line 5a State and local income tax' },
      { name: 'Real Estate Tax', taxCategory: 'Schedule A - Line 5b Real estate tax' },
      { name: 'Personal Property Tax', taxCategory: 'Schedule A - Line 5c Personal property tax' },
      { name: 'Home Mortgage Interest', taxCategory: 'Schedule A - Line 8a Mortgage interest' },
      { name: 'Mortgage Points', taxCategory: 'Schedule A - Line 8c Mortgage points' },
      { name: 'Investment Interest Paid', taxCategory: 'Schedule A - Line 9 Investment interest' },
      { name: 'Charitable Donation (cash)', taxCategory: 'Schedule A - Line 11 Charity cash' },
      { name: 'Charitable Donation (property)', taxCategory: 'Schedule A - Line 12 Charity property' },
      { name: 'Casualty / Theft Loss', taxCategory: 'Schedule A - Line 15 Casualty loss' },
    ],
  },

  // ── Rental property — Schedule E ──────────────────────────
  {
    name: 'Rental — Schedule E',
    children: [
      { name: 'Rental Advertising', taxCategory: 'Schedule E - Advertising' },
      { name: 'Rental Auto & Travel', taxCategory: 'Schedule E - Auto and travel' },
      { name: 'Rental Cleaning & Maintenance', taxCategory: 'Schedule E - Cleaning and maintenance' },
      { name: 'Rental Commissions Paid', taxCategory: 'Schedule E - Commissions' },
      { name: 'Rental Insurance', taxCategory: 'Schedule E - Insurance' },
      { name: 'Rental Legal & Professional', taxCategory: 'Schedule E - Legal' },
      { name: 'Rental Management Fees', taxCategory: 'Schedule E - Management fees' },
      { name: 'Rental Mortgage Interest', taxCategory: 'Schedule E - Mortgage interest' },
      { name: 'Rental Repairs', taxCategory: 'Schedule E - Repairs' },
      { name: 'Rental Supplies', taxCategory: 'Schedule E - Supplies' },
      { name: 'Rental Taxes', taxCategory: 'Schedule E - Taxes' },
      { name: 'Rental Utilities', taxCategory: 'Schedule E - Utilities' },
      { name: 'Rental Depreciation', taxCategory: 'Schedule E - Depreciation' },
    ],
  },

  // ── Above-the-line deductions / Schedule 1 / SE ───────────
  {
    name: 'Above-the-line Deductions',
    children: [
      { name: 'Traditional IRA Contribution', taxCategory: 'Schedule 1 - IRA deduction' },
      { name: 'HSA Contribution (deductible)', taxCategory: 'Schedule 1 - HSA contribution' },
      { name: 'Self-Employed Health Insurance', taxCategory: 'Schedule 1 - SE health insurance' },
      { name: 'Self-Employed Retirement (SEP/Solo 401k)', taxCategory: 'Schedule 1 - SE retirement' },
      { name: 'Student Loan Interest Paid', taxCategory: 'Schedule 1 - Student loan interest' },
      { name: 'Educator Expenses', taxCategory: 'Schedule 1 - Educator expenses' },
      { name: 'Alimony Paid (pre-2019)', taxCategory: 'Schedule 1 - Alimony paid' },
      { name: 'Self-Employment Tax (½ deductible)', taxCategory: 'Schedule SE - Self-employment tax' },
    ],
  },

  // ── Personal finance — NO tax mapping ─────────────────────
  // 0.21.x — Food split into "at home" vs "out" so budgeting
  // these two patterns is one click each. Food Delivery counts
  // as "at home" because that's where it's consumed; Bars sit
  // under "out" with restaurants and fast food.
  {
    name: 'Food at home',
    children: [
      { name: 'Groceries' },
      { name: 'Food Delivery' },
    ],
  },
  {
    name: 'Food out',
    children: [
      { name: 'Restaurants' },
      { name: 'Fast Food' },
      { name: 'Coffee Shops' },
      { name: 'Bars & Nightlife' },
    ],
  },
  {
    name: 'Transportation',
    children: [
      { name: 'Auto Loan Payment' },
      { name: 'Auto Insurance' },
      { name: 'Gas & Fuel' },
      { name: 'Auto Service & Maintenance' },
      { name: 'Auto Parts' },
      { name: 'Vehicle Upgrades & Accessories' },
      { name: 'Parking' },
      { name: 'Tolls' },
      { name: 'Public Transit' },
      { name: 'Taxi & Rideshare' },
      { name: 'Vehicle Registration & DMV' },
    ],
  },
  {
    name: 'Shopping',
    children: [
      { name: 'Clothing & Apparel' },
      { name: 'Shoes & Accessories' },
      { name: 'Electronics' },
      { name: 'Computers & Hardware' },
      { name: 'General Merchandise' },
      { name: 'Online Shopping' },
      { name: 'Books (printed)' },
      { name: 'Office Supplies (personal)' },
    ],
  },
  {
    name: 'Entertainment',
    children: [
      { name: 'Movies & Theater' },
      { name: 'Concerts & Live Events' },
      { name: 'Sporting Events' },
      { name: 'Hobbies & Crafts' },
      { name: 'Gaming' },
      { name: 'Outdoor Recreation' },
      { name: 'Amusement & Attractions' },
    ],
  },
  {
    name: 'Bills & Utilities',
    children: [
      { name: 'Electricity' },
      { name: 'Natural Gas (utility)' },
      { name: 'Water & Sewer' },
      { name: 'Trash & Recycling' },
      { name: 'Internet' },
      { name: 'Mobile Phone' },
      { name: 'Landline Phone' },
      { name: 'Cable & Satellite' },
    ],
  },
  {
    name: 'Health & Medical',
    children: [
      { name: 'Doctor & Physician' },
      { name: 'Dentist' },
      { name: 'Vision & Optometry' },
      { name: 'Pharmacy & Prescriptions' },
      { name: 'Health Insurance Premium' },
      { name: 'Hospital & ER' },
      { name: 'Mental Health' },
      { name: 'Physical Therapy' },
      { name: 'Medical Equipment & Supplies' },
      { name: 'Supplements & Vitamins' },
    ],
  },
  {
    name: 'Travel (personal)',
    children: [
      { name: 'Airfare' },
      { name: 'Hotels & Lodging' },
      { name: 'Vacation Rentals' },
      { name: 'Rental Cars' },
      { name: 'Travel — Dining' },
      { name: 'Travel — Activities' },
      { name: 'Travel Insurance' },
      { name: 'Cruises' },
      { name: 'Luggage & Travel Gear' },
    ],
  },
  {
    name: 'Home',
    children: [
      { name: 'Rent' },
      { name: 'Mortgage Payment (principal)' },
      { name: 'HOA Fees' },
      { name: 'Home Insurance' },
      { name: 'Home Repairs & Maintenance' },
      { name: 'Home Improvement' },
      { name: 'Furnishings & Decor' },
      { name: 'Household Supplies' },
      { name: 'Lawn & Garden' },
      { name: 'Cleaning Services' },
      { name: 'Moving Expenses' },
    ],
  },
  {
    name: 'Insurance (personal)',
    children: [
      { name: 'Life Insurance' },
      { name: 'Disability Insurance' },
      { name: 'Renters Insurance' },
      { name: 'Umbrella Insurance' },
      { name: 'Other Insurance' },
    ],
  },
  {
    name: 'Education',
    children: [
      { name: 'Tuition' },
      { name: 'Textbooks & Supplies' },
      { name: 'Online Courses' },
      { name: 'Student Loan Payment (principal)' },
      { name: 'Professional Development' },
      { name: 'Certifications & Exams' },
      { name: 'School Fees' },
      { name: 'Tutoring' },
    ],
  },
  {
    name: 'Personal Care',
    children: [
      { name: 'Haircut & Salon' },
      { name: 'Spa & Massage' },
      { name: 'Cosmetics & Toiletries' },
      { name: 'Gym & Fitness' },
      { name: 'Laundry & Dry Cleaning' },
    ],
  },
  {
    name: 'Fees & Charges',
    children: [
      { name: 'Bank Fees' },
      { name: 'ATM Fees' },
      { name: 'Overdraft Fees' },
      { name: 'Wire Transfer Fees' },
      { name: 'Credit Card Interest' },
      { name: 'Credit Card Annual Fee' },
      { name: 'Late Fees' },
      { name: 'Investment Fees' },
      { name: 'Foreign Transaction Fees' },
    ],
  },
  {
    name: 'Subscriptions',
    children: [
      { name: 'Streaming Video' },
      { name: 'Streaming Music' },
      { name: 'News & Magazines (digital)' },
      { name: 'Software & Apps' },
      { name: 'Cloud Storage' },
      { name: 'Memberships' },
      { name: 'Subscription Boxes' },
      { name: 'Other Subscriptions' },
    ],
  },
  {
    name: 'Transfers',
    children: [
      { name: 'Credit Card Payment' },
      { name: 'Loan Payment' },
      { name: 'Internal Transfer' },
      { name: 'Person-to-Person Payment' },
      { name: 'Cash Withdrawal' },
    ],
  },
  {
    name: 'Taxes Paid',
    children: [
      { name: 'Federal Income Tax', taxCategory: 'Schedule A - Line 5a State and local income tax' },
      { name: 'State Income Tax', taxCategory: 'Schedule A - Line 5a State and local income tax' },
      { name: 'Local Income Tax', taxCategory: 'Schedule A - Line 5a State and local income tax' },
      { name: 'Estimated Tax Payment (federal)' },
      { name: 'Estimated Tax Payment (state)' },
      { name: 'Tax Preparation Fees' },
    ],
  },
  {
    name: 'Gifts & Donations',
    children: [
      { name: 'Religious Giving', taxCategory: 'Schedule A - Line 11 Charity cash' },
      { name: 'Gifts to Family' },
      { name: 'Gifts to Friends' },
      { name: 'Wedding & Baby Gifts' },
      { name: 'Political Donations' },
    ],
  },
  {
    name: 'Children & Family',
    children: [
      { name: 'Childcare & Daycare' },
      { name: 'Babysitting' },
      { name: 'School Activities' },
      { name: "Children's Clothing" },
      { name: 'Toys & Games' },
      { name: 'Allowance' },
      { name: 'Adoption & Family Building' },
      { name: 'Elder Care' },
    ],
  },
  {
    name: 'Pets',
    children: [
      { name: 'Pet Food' },
      { name: 'Pet Supplies' },
      { name: 'Veterinary' },
      { name: 'Pet Grooming' },
      { name: 'Pet Boarding & Daycare' },
      { name: 'Pet Training' },
      { name: 'Pet Insurance' },
    ],
  },
  {
    name: 'Savings & Investments',
    children: [
      { name: 'Savings' },
      { name: 'Emergency Fund' },
      { name: 'Retirement Contribution (post-tax)' },
      { name: 'Brokerage Deposit' },
      { name: '529 Education Savings' },
      { name: 'HSA Contribution (after-tax)' },
      { name: 'Crypto Purchase' },
    ],
  },
  { name: 'Miscellaneous' },
  { name: 'Uncategorized' },
];

// ── Derived helpers ────────────────────────────────────────────

interface FlatLeaf {
  name: string;
  parent: string | null;
  taxCategory: string | null;
}

function flatten(): FlatLeaf[] {
  const out: FlatLeaf[] = [];
  for (const group of CANONICAL_CATEGORY_TREE) {
    if (!group.children || group.children.length === 0) {
      out.push({
        name: group.name,
        parent: null,
        taxCategory: group.taxCategory ?? null,
      });
      continue;
    }
    out.push({
      name: group.name,
      parent: null,
      taxCategory: group.taxCategory ?? null,
    });
    for (const child of group.children) {
      out.push({
        name: child.name,
        parent: group.name,
        taxCategory: child.taxCategory ?? null,
      });
    }
  }
  return out;
}

export const CANONICAL_CATEGORIES_FLAT: readonly FlatLeaf[] = flatten();

export const ALL_CATEGORY_NAMES: readonly string[] =
  CANONICAL_CATEGORIES_FLAT.map((c) => c.name);

export const TOP_LEVEL_CATEGORY_NAMES: readonly string[] =
  CANONICAL_CATEGORY_TREE.map((g) => g.name);

export const DEFAULT_CATEGORIES = ALL_CATEGORY_NAMES;
export const UNCATEGORIZED = 'Uncategorized';

// ── Legacy export for backward compat with code that still does
// ── `import { CATEGORY_TREE } from './categories'`. The shape it
// ── expects is `{ name, children: string[] }[]`.
export interface CategoryGroup {
  readonly name: string;
  readonly children: readonly string[];
}
export const CATEGORY_TREE: readonly CategoryGroup[] = CANONICAL_CATEGORY_TREE.map(
  (g) => ({
    name: g.name,
    children: g.children ? g.children.map((c) => c.name) : [],
  }),
);

// ── Seeding ────────────────────────────────────────────────────

/**
 * Idempotent seed used at server startup (legacy tenants) and on
 * tenant creation. Inserts every canonical name that doesn't
 * already exist; back-fills tax_category on any existing row whose
 * name matches a canonical leaf; marks every canonical row
 * is_system = true. Does NOT delete anything — for that use
 * resetCanonicalCategories.
 *
 * Operates GLOBALLY when tenantId is null (the legacy default tenant
 * pre-0.13/Phase 8) and per-tenant otherwise.
 */
export async function seedDefaultCategories(
  executor: pg.Pool | pg.PoolClient,
  tenantId?: string | null,
): Promise<void> {
  const tid = tenantId ?? null;

  // Insert top-level groups.
  for (const group of CANONICAL_CATEGORY_TREE) {
    await executor.query(
      `INSERT INTO categories (name, parent_id, tenant_id, tax_category, is_system)
       VALUES ($1, NULL, $2, $3, true)
       ON CONFLICT DO NOTHING`,
      [group.name, tid, group.taxCategory ?? null],
    );
  }

  // Look up the resulting parent ids, scoped to this tenant.
  const parentRows = await executor.query<{ id: string; name: string }>(
    `SELECT id, name FROM categories
      WHERE parent_id IS NULL
        AND (tenant_id IS NOT DISTINCT FROM $1)`,
    [tid],
  );
  const parentIdByName = new Map<string, string>(
    parentRows.rows.map((r) => [r.name.toLowerCase(), r.id]),
  );

  // Insert children.
  for (const group of CANONICAL_CATEGORY_TREE) {
    if (!group.children || group.children.length === 0) continue;
    const parentId = parentIdByName.get(group.name.toLowerCase());
    if (!parentId) continue;
    for (const child of group.children) {
      await executor.query(
        `INSERT INTO categories (name, parent_id, tenant_id, tax_category, is_system)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT DO NOTHING`,
        [child.name, parentId, tid, child.taxCategory ?? null],
      );
    }
  }

  // Back-fill tax_category + is_system on rows that already existed
  // but weren't flagged. This catches the legacy seed where
  // tax_category was always NULL.
  for (const leaf of CANONICAL_CATEGORIES_FLAT) {
    await executor.query(
      `UPDATE categories
          SET tax_category = COALESCE(tax_category, $1),
              is_system    = true
        WHERE lower(name) = lower($2)
          AND (tenant_id IS NOT DISTINCT FROM $3)`,
      [leaf.taxCategory, leaf.name, tid],
    );
  }

  // 0.21.x — consolidate duplicates. After a taxonomy change like
  // "Groceries was top-level, now it's a child of Food at home,"
  // the seed inserts both versions because the unique index
  // includes parent_id (different parent → different unique key).
  // This pass picks the canonical-parent row for each leaf, repoints
  // every FK from any same-name duplicates to it, then deletes the
  // duplicates.
  for (const leaf of CANONICAL_CATEGORIES_FLAT) {
    if (leaf.parent === null) continue;
    const canonicalParentId = parentIdByName.get(leaf.parent.toLowerCase());
    if (!canonicalParentId) continue;

    const canonicalRow = await executor.query<{ id: string }>(
      `SELECT id FROM categories
        WHERE lower(name) = lower($1)
          AND (tenant_id IS NOT DISTINCT FROM $2)
          AND parent_id = $3
        LIMIT 1`,
      [leaf.name, tid, canonicalParentId],
    );
    if (canonicalRow.rowCount === 0) continue;
    const canonicalId = canonicalRow.rows[0]!.id;

    const dupes = await executor.query<{ id: string }>(
      `SELECT id FROM categories
        WHERE lower(name) = lower($1)
          AND (tenant_id IS NOT DISTINCT FROM $2)
          AND id <> $3`,
      [leaf.name, tid, canonicalId],
    );
    for (const dupe of dupes.rows) {
      // Repoint every FK that references the duplicate to the
      // canonical row. budgets.category_id is ON DELETE CASCADE so
      // we MUST repoint before deleting or the budget rows vanish.
      await executor.query(
        `UPDATE transactions SET category_id = $1 WHERE category_id = $2`,
        [canonicalId, dupe.id],
      );
      await executor.query(
        `UPDATE transaction_splits SET category_id = $1 WHERE category_id = $2`,
        [canonicalId, dupe.id],
      );
      await executor.query(
        `UPDATE bills SET category_id = $1 WHERE category_id = $2`,
        [canonicalId, dupe.id],
      );
      await executor.query(
        `UPDATE budgets SET category_id = $1 WHERE category_id = $2`,
        [canonicalId, dupe.id],
      );
      await executor.query(
        `UPDATE normalization_rules SET category_id = $1 WHERE category_id = $2`,
        [canonicalId, dupe.id],
      );
      await executor.query(
        `DELETE FROM categories WHERE id = $1`,
        [dupe.id],
      );
    }
  }
}

/**
 * Hard reset — wipes every non-system category for the tenant
 * (preserving canonical ones), nulls out category_id on dependent
 * rows that allow it (transactions, splits, bills,
 * normalization_rules), and re-seeds canonical.
 *
 * Budgets cascade-delete with their category; the user is expected
 * to rebuild via the budget wizard. This is documented in the UI
 * confirmation prompt.
 *
 * Returns the count of categories deleted.
 */
export async function resetCanonicalCategories(
  executor: pg.PoolClient,
  tenantId: string,
): Promise<{ deleted: number }> {
  // 1. Null out FKs that allow it on rows belonging to the target
  //    tenant's categories.
  await executor.query(
    `UPDATE transactions t
        SET category_id = NULL
       FROM accounts a, categories c
      WHERE t.category_id = c.id
        AND t.account_id = a.id
        AND a.tenant_id = $1
        AND c.tenant_id = $1`,
    [tenantId],
  );
  await executor.query(
    `UPDATE transaction_splits s
        SET category_id = NULL
       FROM categories c
      WHERE s.category_id = c.id
        AND c.tenant_id = $1`,
    [tenantId],
  );
  await executor.query(
    `UPDATE bills b
        SET category_id = NULL
       FROM categories c
      WHERE b.category_id = c.id
        AND c.tenant_id = $1`,
    [tenantId],
  );
  await executor.query(
    `UPDATE normalization_rules r
        SET category_id = NULL
       FROM categories c
      WHERE r.category_id = c.id
        AND c.tenant_id = $1`,
    [tenantId],
  );

  // 2. Delete every category in the tenant. Budgets cascade.
  const del = await executor.query(
    `DELETE FROM categories WHERE tenant_id = $1`,
    [tenantId],
  );

  // 3. Reseed canonical for this tenant.
  await seedDefaultCategories(executor, tenantId);

  return { deleted: del.rowCount ?? 0 };
}
