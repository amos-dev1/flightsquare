import type { NextConfig } from 'next';

const config: NextConfig = {
  // packages/shared is consumed with `import type` and erases at compile, but
  // naming it here keeps that true if a value ever crosses the boundary.
  transpilePackages: ['@flightsquare/shared'],
  reactStrictMode: true,

  /**
   * The dev server's origin check, and the reason every button in the app
   * was dead.
   *
   * Next serves `/_next/*` to its own origin only, which it takes to be
   * `localhost`. The README documents this app as `127.0.0.1:3001` — matching
   * the API line right above it — and those are different origins, so the
   * client bundle was refused and **the page never hydrated**. Server-rendered
   * HTML still arrived, and `<form action={serverAction}>` still posted
   * without JavaScript, so the app looked entirely healthy while every
   * `onClick` control silently did nothing.
   *
   * It fails that quietly because it is a dev-only safety check, not an
   * error. The only sign is one warning line in the dev server's own output.
   */
  allowedDevOrigins: ['127.0.0.1'],
};

export default config;
