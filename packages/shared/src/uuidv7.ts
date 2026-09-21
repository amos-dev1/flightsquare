/**
 * UUIDv7, because §8.2 requires the client to generate ids.
 *
 * §6 chose v7 for the database — time-sortable, no sequence leakage across
 * tenants — and §8.2 notes that is *why* the choice matters: a phone at a
 * tiedown with no signal has to name the row it is creating before the server
 * ever hears about it. A v4 would work as an identifier and lose the
 * ordering that makes an index useful.
 *
 * Layout (RFC 9562): 48 bits of unix milliseconds, 4 bits of version, 12 bits
 * used here as a within-millisecond counter so ids minted in a tight loop
 * still sort in creation order, 2 bits of variant, 62 bits of randomness.
 */

export type RandomBytes = (length: number) => Uint8Array;

const defaultRandom: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (source?.getRandomValues) {
    source.getRandomValues(bytes);
    return bytes;
  }
  // React Native without a crypto polyfill. Weaker, and fine here: these are
  // row identifiers, not secrets — nothing is authorised by guessing one.
  // Session tokens never come from this path.
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
};

let lastMs = -1;
let counter = 0;

export function uuidv7(now: number = Date.now(), random: RandomBytes = defaultRandom): string {
  if (now === lastMs) {
    counter = (counter + 1) & 0xfff;
  } else {
    lastMs = now;
    counter = 0;
  }

  const bytes = new Uint8Array(16);

  // 48 bits of milliseconds, big-endian.
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7, then the counter in the remaining 12 bits.
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  const tail = random(8);
  bytes.set(tail, 8);
  // RFC 9562 variant: the top two bits of byte 8 are 10.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** For tests that need a fresh monotonic sequence. */
export function resetUuidv7Counter(): void {
  lastMs = -1;
  counter = 0;
}
