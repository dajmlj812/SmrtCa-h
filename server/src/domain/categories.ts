import type pg from 'pg';

/**
 * The default category taxonomy — single source of truth used both to seed
 * the database in production (`npm run migrate`) and to re-seed the test
 * database after every `resetDb()`.
 *
 * Shape: top-level **groups** (no parent) each containing zero or more
 * **children**. Groups with `children: []` are themselves the leaf — they
 * appear as a direct selectable option in the UI. Groups with children show
 * as an `<optgroup>` whose first item is the group itself (for users who
 * want to assign at the broader level) followed by the more specific leaves.
 *
 * The 20 original Phase 1/2 top-level names are preserved exactly — no
 * renames, so existing `transactions.category_id` references continue to
 * resolve.
 */
export interface CategoryGroup {
  readonly name: string;
  readonly children: readonly string[];
}

export const CATEGORY_TREE: readonly CategoryGroup[] = [
  {
    name: 'Income',
    children: [
      'Salary & Wages',
      'Bonus & Commission',
      'Self-Employment Income',
      'Freelance & Side Income',
      'Tips',
      'Interest Income',
      'Dividend Income',
      'Capital Gains',
      'Rental Income',
      'Refunds & Reimbursements',
      'Tax Refund',
      'Government Benefits',
      'Pension & Retirement Income',
      'Other Income',
    ],
  },
  { name: 'Groceries', children: [] },
  {
    name: 'Dining & Restaurants',
    children: [
      'Restaurants',
      'Fast Food',
      'Coffee Shops',
      'Food Delivery',
      'Bars & Nightlife',
    ],
  },
  {
    name: 'Transportation',
    children: [
      'Auto Loan Payment',
      'Auto Insurance',
      'Gas & Fuel',
      'Auto Service & Maintenance',
      'Auto Parts',
      'Vehicle Upgrades & Accessories',
      'Parking',
      'Tolls',
      'Public Transit',
      'Taxi & Rideshare',
      'Vehicle Registration & DMV',
    ],
  },
  {
    name: 'Shopping',
    children: [
      'Clothing & Apparel',
      'Shoes & Accessories',
      'Electronics',
      'Computers & Hardware',
      'General Merchandise',
      'Online Shopping',
      'Books (printed)',
      'Office Supplies',
    ],
  },
  {
    name: 'Entertainment',
    children: [
      'Movies & Theater',
      'Concerts & Live Events',
      'Sporting Events',
      'Hobbies & Crafts',
      'Gaming',
      'Outdoor Recreation',
      'Amusement & Attractions',
    ],
  },
  {
    name: 'Bills & Utilities',
    children: [
      'Electricity',
      'Natural Gas (utility)',
      'Water & Sewer',
      'Trash & Recycling',
      'Internet',
      'Mobile Phone',
      'Landline Phone',
      'Cable & Satellite',
    ],
  },
  {
    name: 'Health & Medical',
    children: [
      'Doctor & Physician',
      'Dentist',
      'Vision & Optometry',
      'Pharmacy & Prescriptions',
      'Health Insurance Premium',
      'Hospital & ER',
      'Mental Health',
      'Physical Therapy',
      'Medical Equipment & Supplies',
      'Supplements & Vitamins',
    ],
  },
  {
    name: 'Travel',
    children: [
      'Airfare',
      'Hotels & Lodging',
      'Vacation Rentals',
      'Rental Cars',
      'Travel — Dining',
      'Travel — Activities',
      'Travel Insurance',
      'Cruises',
      'Luggage & Travel Gear',
    ],
  },
  {
    name: 'Home',
    children: [
      'Rent',
      'Mortgage Payment',
      'Property Tax',
      'HOA Fees',
      'Home Insurance',
      'Home Repairs & Maintenance',
      'Home Improvement',
      'Furnishings & Decor',
      'Household Supplies',
      'Lawn & Garden',
      'Cleaning Services',
      'Moving Expenses',
    ],
  },
  {
    name: 'Insurance',
    children: [
      'Life Insurance',
      'Disability Insurance',
      'Renters Insurance',
      'Umbrella Insurance',
      'Other Insurance',
    ],
  },
  {
    name: 'Education',
    children: [
      'Tuition',
      'Textbooks & Supplies',
      'Online Courses',
      'Student Loan Payment',
      'Professional Development',
      'Certifications & Exams',
      'School Fees',
      'Tutoring',
    ],
  },
  {
    name: 'Personal Care',
    children: [
      'Haircut & Salon',
      'Spa & Massage',
      'Cosmetics & Toiletries',
      'Gym & Fitness',
      'Laundry & Dry Cleaning',
    ],
  },
  {
    name: 'Fees & Charges',
    children: [
      'Bank Fees',
      'ATM Fees',
      'Overdraft Fees',
      'Wire Transfer Fees',
      'Credit Card Interest',
      'Credit Card Annual Fee',
      'Late Fees',
      'Investment Fees',
      'Foreign Transaction Fees',
    ],
  },
  {
    name: 'Subscriptions',
    children: [
      'Streaming Video',
      'Streaming Music',
      'News & Magazines (digital)',
      'Software & Apps',
      'Cloud Storage',
      'Memberships',
      'Subscription Boxes',
      'Other Subscriptions',
    ],
  },
  {
    name: 'Transfers',
    children: [
      'Credit Card Payment',
      'Loan Payment',
      'Internal Transfer',
      'Person-to-Person Payment',
      'Cash Withdrawal',
    ],
  },
  {
    name: 'Taxes',
    children: [
      'Federal Income Tax',
      'State Income Tax',
      'Local Income Tax',
      'Self-Employment Tax',
      'Estimated Tax Payments',
      'Tax Preparation Fees',
      'IRS Payments',
      'State Tax Payments',
    ],
  },
  {
    name: 'Gifts & Donations',
    children: [
      'Charitable Donations',
      'Religious Giving',
      'Gifts to Family',
      'Gifts to Friends',
      'Wedding & Baby Gifts',
      'Political Donations',
    ],
  },
  // ── New top-level groups added in 0.2.1 ──────────────────────────
  {
    name: 'Children & Family',
    children: [
      'Childcare & Daycare',
      'Babysitting',
      'School Activities',
      "Children's Clothing",
      'Toys & Games',
      'Allowance',
      'Adoption & Family Building',
      'Elder Care',
    ],
  },
  {
    name: 'Pets',
    children: [
      'Pet Food',
      'Pet Supplies',
      'Veterinary',
      'Pet Grooming',
      'Pet Boarding & Daycare',
      'Pet Training',
      'Pet Insurance',
    ],
  },
  {
    name: 'Business Expenses',
    children: [
      'Business Travel',
      'Business Meals',
      'Office Supplies (business)',
      'Marketing & Advertising',
      'Professional Services',
      'Business Equipment',
      'Business Subscriptions',
      'Business Phone & Internet',
    ],
  },
  {
    name: 'Savings & Investments',
    children: [
      'Emergency Fund',
      'Retirement Contribution',
      'Brokerage Deposit',
      '529 Education Savings',
      'HSA Contribution',
      'Crypto Purchase',
    ],
  },
  { name: 'Uncategorized', children: [] },
];

/** Every category name (groups + leaves), used as the AI's allowed set. */
export const ALL_CATEGORY_NAMES: readonly string[] = CATEGORY_TREE.flatMap(
  (group) =>
    group.children.length === 0
      ? [group.name]
      : [group.name, ...group.children],
);

/**
 * The set of distinct *group* names — the original Phase 1/2 top-level
 * categories. Kept for backward compatibility with code that uses the small
 * coarse-grained taxonomy (e.g. the rules normalizer's keyword targets).
 */
export const TOP_LEVEL_CATEGORY_NAMES: readonly string[] = CATEGORY_TREE.map(
  (g) => g.name,
);

/** Backward-compatible alias — the full allowed list. */
export const DEFAULT_CATEGORIES = ALL_CATEGORY_NAMES;

/** The catch-all category every normalizer must be able to fall back to. */
export const UNCATEGORIZED = 'Uncategorized';

/**
 * Idempotently seed the full category taxonomy. Safe to call on every
 * startup and after every test-db reset:
 *  1. Inserts each top-level group (parent_id = NULL).
 *  2. Looks up the resulting parent ids.
 *  3. Inserts each child under its parent.
 *
 * Relies on the unique index on `(lower(name), coalesce(parent_id, sentinel))`,
 * so collisions are silently skipped.
 */
export async function seedDefaultCategories(
  executor: pg.Pool | pg.PoolClient,
): Promise<void> {
  // 1. Insert (or no-op) every top-level group.
  for (const group of CATEGORY_TREE) {
    await executor.query(
      `INSERT INTO categories (name) VALUES ($1) ON CONFLICT DO NOTHING`,
      [group.name],
    );
  }

  // 2. Snapshot the current top-level rows so we can look up parent ids
  //    and also detect *legacy* top-levels that should now be children.
  const topRows = await executor.query<{ id: string; name: string }>(
    'SELECT id, name FROM categories WHERE parent_id IS NULL',
  );
  const topIdByName = new Map<string, string>(
    topRows.rows.map((r) => [r.name.toLowerCase(), r.id]),
  );
  const groupNames = new Set<string>(
    CATEGORY_TREE.map((g) => g.name.toLowerCase()),
  );

  // 3. For each declared child:
  //    a) If a legacy top-level row with the same name exists (and that
  //       name isn't itself a declared group), re-parent it — this keeps
  //       any existing `transactions.category_id` pointing at the SAME
  //       row, so historical assignments survive the move.
  //    b) Otherwise insert it fresh under its parent.
  for (const group of CATEGORY_TREE) {
    if (group.children.length === 0) continue;
    const parentId = topIdByName.get(group.name.toLowerCase());
    if (!parentId) continue;

    for (const child of group.children) {
      const childKey = child.toLowerCase();
      const legacyId = topIdByName.get(childKey);
      if (legacyId && !groupNames.has(childKey)) {
        // Legacy top-level row gets re-parented (idempotent — guarded by
        // parent_id IS NULL so a second run does nothing).
        await executor.query(
          `UPDATE categories SET parent_id = $1
            WHERE id = $2 AND parent_id IS NULL`,
          [parentId, legacyId],
        );
      } else {
        await executor.query(
          `INSERT INTO categories (name, parent_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [child, parentId],
        );
      }
    }
  }
}
