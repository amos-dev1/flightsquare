/**
 * "This is not production" — across the top of every page, or nothing at all.
 *
 * It shows unless `FS_ENV` is exactly `prod`, and the direction of that
 * default is the whole design. The failure worth preventing is somebody
 * treating dev as production — entering a real member, a real squawk, a real
 * flight, or testing a password reset against what they think is a scratch
 * environment. If the variable is missing, showing the banner on production is
 * embarrassing for an afternoon; hiding it on a dev deployment is the mistake
 * itself. So production has to say so, and silence means caution.
 *
 * It also means `npm run dev -w web` is banded without configuring anything,
 * which is where most of the confusion actually happens.
 *
 * NOT `NODE_ENV`. The deployed dev service runs with `NODE_ENV=production`,
 * because it is a production *build* — Next needs that for a real build, and
 * the API container sets it too. Keying off it would hide the banner in
 * exactly the environment it exists for. `FS_ENV` carries the stack's
 * `envName` and nothing else.
 *
 * A server component, so the decision is made once on the server and the
 * markup either exists or does not. Nothing ships to the client, and there is
 * no flash of an unbannered page while JavaScript loads.
 */
export function EnvBanner() {
  const env = process.env.FS_ENV;
  if (env === 'prod') return null;

  // 'dev' becomes DEV; anything unexpected is named rather than hidden, so a
  // mislabelled environment reads as itself instead of silently as dev.
  const label = (env ?? 'dev').toUpperCase();

  return (
    <div
      // Sticky rather than in flow: it has to stay true after somebody has
      // scrolled into the middle of a long list of flights. Nothing else in
      // the app is sticky to the top, so there is nothing to collide with.
      className="sticky top-0 z-50 bg-caution text-on-caution"
      // A landmark rather than a live region: it never changes, so announcing
      // it as an update would be noise. Screen readers reach it first because
      // it is first in the document.
      role="note"
      aria-label={`${label} environment. This is not production.`}
    >
      <p className="flex items-center justify-center gap-2 px-4 py-1.5 text-center text-sm font-medium">
        {/* Letter-spaced and heavy, which is what makes it read as a band
            across the page rather than as a sentence someone might skim. §11
            allows uppercase for short metadata; this is three letters. */}
        <span className="font-semibold tracking-[0.2em]">{label}</span>
        {/* The words matter as much as the colour. §11 and §13 both forbid
            communicating meaning by colour alone, and this is the only thing
            on the screen whose entire job is to communicate one thing. */}
        <span aria-hidden="true">·</span>
        <span>not production — data here is disposable</span>
      </p>
    </div>
  );
}
