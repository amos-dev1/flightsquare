import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// 128 * N * r = 16 MiB per hash, comfortably inside Node's default maxmem.
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

/**
 * scrypt from node:crypto rather than a native argon2 binding: no build step,
 * no install-script approval, and it is a real memory-hard KDF rather than a
 * fast hash. The stored format carries its own parameters so they can be
 * raised later without invalidating existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    `N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}`,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const params: Record<string, number> = {};
  for (const pair of (parts[1] ?? '').split(',')) {
    const [key, value] = pair.split('=');
    if (key && value) params[key] = Number(value);
  }
  const N = params.N;
  const r = params.r;
  const p = params.p;
  if (!N || !r || !p) return false;

  const salt = Buffer.from(parts[2] ?? '', 'base64');
  const expected = Buffer.from(parts[3] ?? '', 'base64');
  const derived = await scryptAsync(password, salt, expected.length, { N, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
