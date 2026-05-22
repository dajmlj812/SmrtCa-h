import { pool } from './pool.js';
import { applyMigrations } from './migrate-runner.js';
import { seedDefaultCategories } from '../domain/categories.js';

// CLI entry point: `npm run migrate`. Applies SQL migrations and then
// idempotently seeds the default category taxonomy.
applyMigrations(pool)
  .then(async (count) => {
    await seedDefaultCategories(pool);
    console.log(
      count === 0
        ? 'Database is up to date.'
        : `Applied ${count} migration(s).`,
    );
    console.log('Default categories seeded.');
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
