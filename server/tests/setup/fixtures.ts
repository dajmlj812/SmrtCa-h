import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Read a fixture file from tests/fixtures as a Buffer. */
export function fixtureBuffer(name: string): Buffer {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
  );
}

/** Read a fixture file from tests/fixtures as a UTF-8 string. */
export function fixtureText(name: string): string {
  return fixtureBuffer(name).toString('utf8');
}
