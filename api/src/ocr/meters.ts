import { DetectDocumentTextCommand, TextractClient, type Block } from '@aws-sdk/client-textract';

import { config } from '../config.js';

/**
 * Reading the meters off a photograph of the panel.
 *
 * A suggestion, never a reading. §3.4 records Hobbs and tach *as read*, and
 * the reader is the pilot: what comes back here fills the form's empty boxes
 * and the pilot confirms or overwrites them before anything is saved. Nothing
 * in this file writes a meter, and nothing downstream trusts it to.
 *
 * Two halves, kept apart so the hard half can be tested without AWS:
 *
 *   `TextReader`   — the photograph in, the words and where they sit out.
 *                    Textract in a deployment; a stub in tests.
 *   `readMeters`   — pure. Which number is the Hobbs and which is the tach.
 */

/** One recognised word, with its box in fractions of the image (0–1). */
export interface Word {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TextReader {
  /** The words in a JPEG or PNG. Throws when the service cannot be reached. */
  words(image: Uint8Array): Promise<Word[]>;
}

/**
 * Textract's synchronous text detection. No bucket, no job, no storage: the
 * bytes go to the service and the words come back.
 *
 * Credentials come from the SDK's provider chain — the App Runner instance role
 * when deployed, a named profile on a laptop — for the reason `storage/index.ts`
 * gives: a key nobody configured should never shadow the role that was meant
 * to be used.
 */
export function textractReader(region: string): TextReader {
  const client = new TextractClient({
    region,
    // A pilot is waiting on this with the form open. Better a quick "type it
    // in" than a spinner that outlasts their patience.
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 15_000 },
  });
  return {
    async words(image) {
      const result = await client.send(
        new DetectDocumentTextCommand({ Document: { Bytes: image } }),
      );
      return (result.Blocks ?? []).flatMap(toWord);
    },
  };
}

function toWord(block: Block): Word[] {
  const box = block.Geometry?.BoundingBox;
  if (block.BlockType !== 'WORD' || !block.Text || !box) return [];
  return [
    {
      text: block.Text,
      left: box.Left ?? 0,
      top: box.Top ?? 0,
      width: box.Width ?? 0,
      height: box.Height ?? 0,
    },
  ];
}

/** The configured reader, or null where none is — a laptop with no AWS profile. */
export function configuredReader(): TextReader | null {
  return config.ocr.provider === 'textract' ? textractReader(config.ocr.region) : null;
}

// ---------------------------------------------------------------------------

export type MeterKind = 'hobbs' | 'tach';

/**
 * What the meter faces say on them.
 *
 * Hobbs is "Hobbs" or "Airframe"; tach is "Tach", and on some panels the
 * recording tach is labelled "Flight". Matched as substrings so "HOBBS®",
 * "TACH." and "TACHOMETER" all count.
 */
const LABELS: { kind: MeterKind; pattern: RegExp }[] = [
  { kind: 'hobbs', pattern: /HOBBS|AIRFRAME|AIRFRM/i },
  { kind: 'tach', pattern: /TACH|FLIGHT/i },
];

/**
 * A number on the photograph, possibly several words long.
 *
 * Drum counters come back from OCR in pieces — "0123" and "4" with the tenths
 * wheel a different colour, or "0 1 2 3 4" one digit per wheel — so adjacent
 * digit words on one line are joined. `tenths` is set when the last piece was
 * a single digit standing apart, which on a drum counter is the tenths wheel.
 */
interface NumberGroup {
  digits: string;
  decimal: string | null;
  tenths: string | null;
  x: number;
  y: number;
  height: number;
}

const DIGITS = /^[0-9][0-9,]*(\.[0-9]+)?$/;

function groupNumbers(words: Word[]): NumberGroup[] {
  // A word with letters in it is a registration or a part number, not a
  // counter. Stray punctuation either side of digits is OCR noise.
  const numeric = words
    .filter((word) => !/[A-Za-z]/.test(word.text))
    .map((word) => ({ ...word, text: word.text.replace(/^[^0-9]+|[^0-9]+$/g, '') }))
    .filter((word) => DIGITS.test(word.text))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const groups: { pieces: Word[] }[] = [];
  for (const word of numeric) {
    const last = groups.at(-1)?.pieces.at(-1);
    const sameLine =
      last !== undefined &&
      Math.abs(last.top + last.height / 2 - (word.top + word.height / 2)) <
        Math.max(last.height, word.height) * 0.6;
    const close = last !== undefined && word.left - (last.left + last.width) < word.height * 1.5;
    if (sameLine && close && word.left > last.left && !last.text.includes('.')) {
      groups.at(-1)!.pieces.push(word);
    } else {
      groups.push({ pieces: [word] });
    }
  }

  return groups.map(({ pieces }) => {
    const first = pieces[0]!;
    const lastPiece = pieces.at(-1)!;
    const separateTenths = pieces.length > 1 && lastPiece.text.length === 1;
    const body = (separateTenths ? pieces.slice(0, -1) : pieces).map((p) => p.text).join('');
    const [whole, fraction] = body.replace(/,/g, '').split('.');
    const right = lastPiece.left + lastPiece.width;
    return {
      digits: whole ?? '',
      decimal: fraction ?? null,
      tenths: separateTenths ? lastPiece.text : null,
      x: (first.left + right) / 2,
      y: first.top + first.height / 2,
      height: Math.max(...pieces.map((p) => p.height)),
    };
  });
}

/**
 * The values a group could mean.
 *
 * "1234.5" means 1234.5. "12345" is ambiguous: a counter with no visible
 * decimal point usually has a tenths wheel, so it is 1234.5 as often as it is
 * 12345 — both are offered and the aircraft's own history picks.
 */
function interpretations(group: NumberGroup): { value: number; text: string }[] {
  if (!group.digits) return [];
  const values: number[] = [];
  if (group.decimal !== null) values.push(Number(`${group.digits}.${group.decimal}`));
  else if (group.tenths !== null) values.push(Number(`${group.digits}.${group.tenths}`));
  else {
    if (group.digits.length >= 2) values.push(Number(group.digits) / 10);
    values.push(Number(group.digits));
  }
  // One decimal place, because that is what a meter column holds and what
  // the form accepts; a digital readout's hundredths round away.
  return values
    .filter((value) => Number.isFinite(value) && value < 10_000_000)
    .map((value) => ({ value, text: value.toFixed(1) }));
}

/**
 * How believable a value is as this meter's reading, given where the aircraft
 * last stood. Meters only go forward, and a flight — or a few unlogged ones —
 * moves them by hours, not hundreds. Null means implausible.
 *
 * With no history every value is equally believable, so labels decide alone.
 */
function plausibility(value: number, current: number | null): number | null {
  if (current === null) return 0;
  const ahead = value - current;
  if (ahead < -0.05 || ahead > 300) return null;
  return ahead;
}

export interface MeterReading {
  hobbs: string | null;
  tach: string | null;
}

/**
 * Which number is which.
 *
 * Labels first: each label takes the nearest number that is believable for
 * that meter. Then history: a meter with no label on the photograph takes the
 * remaining number closest above where that meter last stood — which is how a
 * panel with two unlabelled counters still comes out right, since Hobbs and
 * tach drift apart over an aircraft's life. Where neither can decide, the box
 * is left empty: a blank the pilot fills is better than a confident wrong
 * number they might not check.
 */
export function readMeters(
  words: Word[],
  current: { hobbs: number | null; tach: number | null },
): MeterReading {
  const groups = groupNumbers(words);
  const used = new Set<NumberGroup>();
  const result: MeterReading = { hobbs: null, tach: null };

  function best(group: NumberGroup, kind: MeterKind) {
    let choice: { text: string; score: number } | null = null;
    for (const option of interpretations(group)) {
      const score = plausibility(option.value, current[kind]);
      if (score === null) continue;
      if (choice === null || score < choice.score) choice = { text: option.text, score };
    }
    return choice;
  }

  // Labels, nearest number first. Distance is in label heights, with a
  // penalty for numbers above the label: meter faces print the word on or
  // below the counter far more often than above it, but either happens.
  const labelled: { kind: MeterKind; group: NumberGroup; text: string; distance: number }[] = [];
  for (const word of words) {
    const label = LABELS.find((one) => one.pattern.test(word.text));
    if (!label) continue;
    const lx = word.left + word.width / 2;
    const ly = word.top + word.height / 2;
    for (const group of groups) {
      const reading = best(group, label.kind);
      if (!reading) continue;
      const dx = (group.x - lx) / word.height;
      const dy = (group.y - ly) / word.height;
      labelled.push({
        kind: label.kind,
        group,
        text: reading.text,
        distance: Math.hypot(dx, dy * (dy > 0 ? 1.2 : 1)),
      });
    }
  }
  labelled.sort((a, b) => a.distance - b.distance);
  for (const pair of labelled) {
    if (result[pair.kind] !== null || used.has(pair.group)) continue;
    // A label more than a few counter-widths away is labelling something else.
    if (pair.distance > 12) continue;
    result[pair.kind] = pair.text;
    used.add(pair.group);
  }

  // History, for whatever the labels left.
  for (const kind of ['hobbs', 'tach'] as const) {
    if (result[kind] !== null || current[kind] === null) continue;
    let choice: { group: NumberGroup; text: string; score: number } | null = null;
    for (const group of groups) {
      if (used.has(group)) continue;
      const reading = best(group, kind);
      if (reading && (choice === null || reading.score < choice.score)) {
        choice = { group, ...reading };
      }
    }
    if (choice) {
      result[kind] = choice.text;
      used.add(choice.group);
    }
  }

  return result;
}
