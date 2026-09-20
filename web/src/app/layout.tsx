import type { Metadata } from 'next';
import { Manrope } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

/*
 * §11 asks for the actual Manrope, not a fallback that looks close. next/font
 * self-hosts it, so there is no runtime request to a font CDN and no layout
 * shift while it arrives.
 */
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
    <html lang="en" className={manrope.variable}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
