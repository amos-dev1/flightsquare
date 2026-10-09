import type { MetadataRoute } from 'next';

/**
 * Installable to a phone's home screen (§8 — members use this on a ramp).
 *
 * Served by Next at `/manifest.webmanifest` from this file, so the icon paths
 * and the app's name live in one typed place rather than in a hand-kept JSON
 * file that drifts from the metadata in the layout.
 *
 * **No service worker, and therefore no offline.** A manifest alone makes the
 * app installable and gives it a window without browser chrome; it does not
 * cache anything. That is the whole intent for now, and it is worth being
 * exact about, because an installed icon *looks* like an app that works
 * without signal and this one does not. §8.2's offline story belongs to the
 * native client, where the flight queue lives in SQLite — a cache here would
 * be a second, weaker implementation of the one thing the constitution is
 * most careful about.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'FlightSquare',
    short_name: 'FlightSquare',
    description: 'Aircraft management, simplified.',

    /*
      `/` rather than a screen, because it is the one entry that is right in
      both states: signed out it redirects to sign-in, signed in it goes to the
      fleet. A fixed `/aircraft` would open an installed app on a redirect to
      the login page for anyone whose session had lapsed.
    */
    start_url: '/',
    scope: '/',
    display: 'standalone',

    /*
      §11's canvas and its primary surface: mist is what the app sits on, so an
      installed splash matches the first paint instead of flashing white. Navy
      is the brand surface and tints the status bar around the window.

      Deliberately not the DEV banner's amber — the theme colour is the
      product's, and the banner says which environment this is on its own.
    */
    background_color: '#EAF1F5',
    theme_color: '#152B3C',

    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      /*
        Separate art, not the same file relabelled. Android masks icons to a
        circle, a squircle or whatever the launcher prefers, and guarantees
        only the middle ~80%; this one carries extra margin so the symbol
        survives the crop. Shipping one icon as both is how a logo comes back
        with its edges shaved off.
      */
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
