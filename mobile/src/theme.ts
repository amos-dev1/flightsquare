/**
 * §11's Cool Aviation tokens, for React Native.
 *
 * The same values as the web theme, in the form this platform can use. There
 * is no second source of truth: if §11 changes, both files change together.
 *
 * White and mist dominate; navy carries text, headings and primary actions;
 * teal stays a small fraction of a screen and means interaction or
 * selection. §11 is explicit that it is never a "safe" or "airworthy"
 * signal, and that semantic warning colours are functional exceptions rather
 * than decorative accents.
 *
 * The logo artwork stays black. §14: do not globally replace every black
 * value, and the approved SVGs are not interface colour.
 */
export const color = {
  navy: '#152B3C',
  navyHover: '#203E54',
  teal: '#00C2B8',
  /** Accessible teal text on a light surface — bright teal is not. */
  tealText: '#007A74',
  /** The page canvas, so white cards separate from it without a shadow. */
  mist: '#EAF1F5',
  /** Decorative details and chart series. Not small text on white. */
  slate: '#718493',
  surface: '#FFFFFF',

  secondary: '#526675',
  line: '#D6E1E8',
  /** Hover and understated alternate surfaces. */
  subtle: '#F3F7F9',
  /** Selected navigation and controls. */
  selected: '#E0F5F3',
  onTeal: '#152B3C',
  onDark: '#FFFFFF',

  /** Where a boundary has to say where a control is; the divider will not. */
  control: '#718493',
} as const;

/** The §11 scale: 4, 8, 12, 16, 24, 32, 48. */
export const space = { xs: 4, sm: 8, md: 12, base: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radius = { control: 8, card: 12 } as const;

/**
 * Two fonts, two jobs (§11 §4).
 *
 * Inter runs the operational interface — every heading, label, table, metric
 * and control. Manrope is the brand voice and stays in the places §11 names:
 * the tagline, marketing. §11 says not to mix Manrope headings with Inter
 * body inside a working screen, so nothing in `type` below reaches for it.
 */
export const font = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  /** Brand only. */
  brand: 'Manrope_600SemiBold',
  brandRegular: 'Manrope_400Regular',
} as const;

/**
 * The §11 type scale, each entry carrying its own colour.
 *
 * React Native does not cascade text colour the way a stylesheet does: a
 * `<Text>` with no colour renders pure black, which used to coincide with the
 * old palette and no longer does. Baking navy into the scale makes the
 * default total — every style in the app spreads one of these first, so an
 * explicit `color:` after the spread still wins for muted and inverted text.
 */
export const type = {
  // 600 rather than 700: §11's scale tops out at semibold, and Inter at the
  // same weight sits heavier than Manrope did.
  pageTitle: { color: color.navy, fontFamily: font.semibold, fontSize: 28, lineHeight: 34 },
  sectionHeading: { color: color.navy, fontFamily: font.semibold, fontSize: 20, lineHeight: 26 },
  cardHeading: { color: color.navy, fontFamily: font.semibold, fontSize: 16, lineHeight: 21 },
  body: { color: color.navy, fontFamily: font.regular, fontSize: 16, lineHeight: 24 },
  bodySmall: { color: color.navy, fontFamily: font.regular, fontSize: 14, lineHeight: 21 },
  input: { color: color.navy, fontFamily: font.regular, fontSize: 16 },
  label: { color: color.navy, fontFamily: font.medium, fontSize: 14 },
  button: { color: color.navy, fontFamily: font.semibold, fontSize: 14 },
  supporting: { color: color.navy, fontFamily: font.medium, fontSize: 13, lineHeight: 18 },
  metric: { color: color.navy, fontFamily: font.semibold, fontSize: 30, lineHeight: 36 },
  /** The tagline, and nothing inside a working screen. */
  tagline: { color: color.navy, fontFamily: font.brandRegular, fontSize: 14, lineHeight: 21 },
} as const;

/** §11 asks for at least 44 x 44. */
export const CONTROL_HEIGHT = 48;
