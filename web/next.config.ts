import type { NextConfig } from 'next';

const config: NextConfig = {
  // packages/shared is consumed with `import type` and erases at compile, but
  // naming it here keeps that true if a value ever crosses the boundary.
  transpilePackages: ['@flightsquare/shared'],
  reactStrictMode: true,
};

export default config;
