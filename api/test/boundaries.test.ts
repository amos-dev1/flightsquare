import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * packages/shared has no build step: its consumers are bundlers that compile
 * the TypeScript directly. The api workspace is not one of them — it runs on
 * Node from dist/ — so it may import types from there and nothing else.
 *
 * A value import would compile and then fail at runtime with a module it
 * cannot load, on boot, in production. That is worth a test rather than a
 * comment someone has to remember.
 */
describe('workspace boundaries', () => {
  it('leaves no runtime reference to @flightsquare/shared in the api bundle', () => {
    const dist = join(import.meta.dirname, '..', 'dist');
    const offenders = filesUnder(dist)
      .filter((path) => path.endsWith('.js'))
      .filter((path) => readFileSync(path, 'utf8').includes('@flightsquare/shared'));

    expect(offenders).toEqual([]);
  });
});
