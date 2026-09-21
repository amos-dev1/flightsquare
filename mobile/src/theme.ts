/**
 * §11's tokens, for React Native.
 *
 * The same values as the web theme, in the form this platform can use. There
 * is no second source of truth: if §11 changes, both files change together.
 *
 * ~95% monochrome. Teal is emphasis — a selected control, an active tab — and
 * never a button fill, a large surface, or a claim about airworthiness.
 */
export const color = {
  brandBlack: '#000000',
  surface: '#FFFFFF',
  secondary: '#6B6B6B',
  subtle: '#F4F4F4',
  line: '#E5E5E5',
  accent: '#00C2B8',
  accentInk: '#007A74',
  onAccent: '#000000',
  /** Controls need a darker boundary than the decorative border token. */
  control: '#8A8A8A',
} as const;

/** The §11 scale: 4, 8, 12, 16, 24, 32, 48. */
export const space = { xs: 4, sm: 8, md: 12, base: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radius = { control: 8, card: 12 } as const;

export const font = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
} as const;

export const type = {
  pageTitle: { fontFamily: font.bold, fontSize: 28, lineHeight: 34 },
  sectionHeading: { fontFamily: font.semibold, fontSize: 20, lineHeight: 26 },
  cardHeading: { fontFamily: font.semibold, fontSize: 16, lineHeight: 21 },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 24 },
  bodySmall: { fontFamily: font.regular, fontSize: 14, lineHeight: 21 },
  input: { fontFamily: font.regular, fontSize: 16 },
  label: { fontFamily: font.semibold, fontSize: 14 },
  button: { fontFamily: font.semibold, fontSize: 14 },
  supporting: { fontFamily: font.medium, fontSize: 13, lineHeight: 18 },
  metric: { fontFamily: font.semibold, fontSize: 30, lineHeight: 36 },
} as const;

/** §11 asks for at least 44 x 44. */
export const CONTROL_HEIGHT = 48;
