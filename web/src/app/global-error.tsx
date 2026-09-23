'use client';

/**
 * The last resort: a failure in the root layout itself, which the segment
 * boundaries cannot catch because they sit inside it.
 *
 * This file replaces the root layout when active, so it renders its own
 * `<html>` and `<body>` and cannot rely on globals.css or next/font being
 * applied — neither the tokens nor Inter is loaded here. The styles are
 * therefore inline, with §11's navy on mist written out literally and the
 * system stack for type: naming Inter would be a font nobody has fetched,
 * which is the synthetic-weight fallback §11 §4 tells us not to ship.
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
          background: '#EAF1F5',
          color: '#152B3C',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          padding: 16,
        }}
      >
        <main style={{ maxWidth: 420 }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0 }}>FlightSquare</h1>
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
              background: '#152B3C',
              color: '#FFFFFF',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ fontSize: 12, color: '#526675', marginTop: 16 }}>
              Reference {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
