import type { Metadata, Viewport } from 'next';
import { Inter, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';

import { EnvBanner } from '@/components/env-banner';

import './globals.css';

/*
 * Two fonts, two jobs (§11 §4).
 *
 * Inter is the operational interface: every heading, label, table, metric
 * and control. Manrope is the brand voice and is kept to the places §11
 * names — the tagline, marketing headlines — never inside a working screen.
 *
 * next/font self-hosts both, so there is no runtime request to a font CDN
 * and no layout shift while they arrive.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FlightSquare',
  description: 'Aircraft management, simplified.',
  applicationName: 'FlightSquare',
  /*
    iOS reads the web manifest from 16.4, and `apple-mobile-web-app-capable`
    for everything before it. Both are cheap and only one of them is new, so
    an older phone added to the home screen still opens without Safari's
    chrome rather than in a browser tab pretending to be an app.

    `statusBarStyle: 'default'` and not 'black-translucent': translucent puts
    the page *under* the clock and the battery, which would slide the sticky
    environment banner beneath them — the one element that must never be
    obscured.
  */
  appleWebApp: {
    capable: true,
    title: 'FlightSquare',
    statusBarStyle: 'default',
  },
};

/*
  The colour the phone paints around the window in standalone — the status bar
  on iOS, the task switcher and system bars on Android. §11's navy, matching
  the manifest, so the installed app reads as one surface rather than a web
  page in a frame someone forgot to colour.
*/
export const viewport: Viewport = {
  themeColor: '#152B3C',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${manrope.variable}`}>
      {/*
        The banner is first in the body, above every route — the app, sign-in,
        sign-up, the error and not-found pages. Putting it in the root layout
        rather than the (app) layout is deliberate: the page most likely to be
        mistaken for production is the one you land on before signing in.
      */}
      <body className="min-h-screen font-sans antialiased">
        <EnvBanner />
        {children}
      </body>
    </html>
  );
}
