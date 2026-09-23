import type { Metadata } from 'next';
import { Inter, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';

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
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${manrope.variable}`}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
