import type { AircraftDocumentKind } from '@flightsquare/shared';

/*
  In a module of its own, not in `client.tsx`: a value exported from a
  'use client' file reaches a server component as a client reference rather
  than as the array, so the page could not read the list it renders by.
*/

/** The types offered, in the order a pilot checks them: the AROW set first. */
export const DOCUMENT_TYPES: { kind: AircraftDocumentKind; noun: string }[] = [
  { kind: 'airworthiness', noun: 'Airworthiness certificate' },
  { kind: 'registration', noun: 'Registration' },
  { kind: 'operating_limitations', noun: 'Operating limitations' },
  { kind: 'weight_balance', noun: 'Weight and balance' },
  { kind: 'insurance', noun: 'Insurance' },
  { kind: 'other', noun: 'Other' },
];
