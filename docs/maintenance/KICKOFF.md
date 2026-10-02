# Kickoff prompt for Claude Code — Maintenance module, Phase 1

Paste the text below into Claude Code from the root of the `flightsquare` repo, after committing the `docs/maintenance/` folder.

---

Build Phase 1 (Core tracking) of the Maintenance module.

Read these first, in order:
1. `CLAUDE.md` — architecture rules (RLS tenancy, flags tenant → plan → global, resource + level permissions, 404 feature gate / 403 permission gate). They apply to everything here.
2. `docs/maintenance/SPEC.md` — the source of truth. Phase 1 = sections 1–9 and 13. Sections 10–12 are later phases: design the Phase 1 schema so they slot in without migrations that rewrite data, but do not build them.
3. `docs/maintenance/mockups/*.html` — open them; they are the visual target for the Expo app (screens 01–05 for Phase 1). Match layout, copy, typography (IBM Plex Sans / Mono) and the color tokens in SPEC §6. The Next.js web version gets the same screens laid out responsively.

How to work:
- Start in plan mode. Before writing code, inspect what already exists (aircraft, users/roles, bookings, post-flight tach/Hobbs entries, flags, notifications) and tell me what you'll reuse vs add. List anything in the spec that conflicts with the existing code and ask before deviating.
- Order: migrations + RLS policies → domain logic (interval math, status, projection, grounding) with unit tests → API endpoints with permission/flag gates and tests → recompute hooks + hourly job + notifications → Expo screens → web screens.
- All due/remaining/status math lives server-side; clients render API results and use the preview endpoint for forms.
- No seeded maintenance items, ever — including in dev fixtures shown to users. Test fixtures are fine.
- Every acceptance criterion in SPEC §13 must have an automated test.
- Commit in small, reviewable steps; open a PR when Phase 1 is complete with a checklist mapped to §13.
