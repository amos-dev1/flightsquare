'use client';

/**
 * The last resort: a failure in the root layout itself, which the segment
 * boundaries cannot catch because they sit inside it.
 *
 * This file replaces the root layout when active, so it renders its own
 * `<html>` and `<body>` and cannot rely on globals.css being applied. The
 * styles are therefore inline and deliberately plain — §11's black on white,
 * Manrope if it happens to be available, and nothing that depends on the app
 * having loaded.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FFFFFF',
          color: '#000000',
          fontFamily: 'Manrope, system-ui, sans-serif',
          padding: 16,
        }}
      >
        <main style={{ maxWidth: 420 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>FlightSquare</h1>
          <p style={{ fontSize: 16, lineHeight: 1.5, marginTop: 12 }}>
            The app failed to load. Your records are unaffected.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: 24,
              height: 44,
              padding: '0 16px',
              borderRadius: 8,
              border: 'none',
              background: '#000000',
              color: '#FFFFFF',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ fontSize: 12, color: '#6B6B6B', marginTop: 16 }}>
              Reference {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
