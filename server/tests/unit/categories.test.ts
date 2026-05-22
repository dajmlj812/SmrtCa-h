import { describe, it, expect } from 'vitest';
import {
  ALL_CATEGORY_NAMES,
  CATEGORY_TREE,
  TOP_LEVEL_CATEGORY_NAMES,
  UNCATEGORIZED,
} from '../../src/domain/categories.js';

describe('CATEGORY_TREE', () => {
  it('has the expected top-level groups', () => {
    const names = TOP_LEVEL_CATEGORY_NAMES;
    expect(names).toContain('Income');
    expect(names).toContain('Transportation');
    expect(names).toContain('Subscriptions');
    expect(names).toContain('Pets');
    expect(names).toContain('Children & Family');
    expect(names).toContain('Uncategorized');
  });

  it('places Gas & Fuel under Transportation, not at the top level', () => {
    const transportation = CATEGORY_TREE.find(
      (g) => g.name === 'Transportation',
    );
    expect(transportation).toBeDefined();
    expect(transportation!.children).toContain('Gas & Fuel');
    expect(transportation!.children).toContain('Vehicle Upgrades & Accessories');
    expect(TOP_LEVEL_CATEGORY_NAMES).not.toContain('Gas & Fuel');
  });

  it('exposes Uncategorized as a leaf top-level', () => {
    const uncat = CATEGORY_TREE.find((g) => g.name === UNCATEGORIZED);
    expect(uncat).toBeDefined();
    expect(uncat!.children).toEqual([]);
  });

  it('has no duplicate category names across the flat list', () => {
    const seen = new Set<string>();
    for (const name of ALL_CATEGORY_NAMES) {
      const key = name.toLowerCase();
      expect(seen.has(key), `Duplicate category name: ${name}`).toBe(false);
      seen.add(key);
    }
  });

  it('combines into a comprehensive list of 150+ categories', () => {
    expect(ALL_CATEGORY_NAMES.length).toBeGreaterThanOrEqual(150);
  });
});
