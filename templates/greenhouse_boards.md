# Greenhouse board watchlist for the /greenhouse lane (scripts/greenhouse.js).
# Fetches jobs from the public, keyless Greenhouse Boards API — no browser, no LinkedIn.
#
# Format: one board per line —
#   - <Display Name> - <board_token>
# e.g.:
#   - Acme Corp - acme
#
# Blank lines and any line starting with # (including these, and the two ## section
# headings below) are ignored/structural. Anything else that doesn't match the
# "- Name - token" shape makes scripts/greenhouse.js's parseWatchlist() throw — a
# malformed line fails loud, it is never silently skipped.
#
# ## Curated is hand-maintained: companies you already know post openings to Greenhouse.
# ## Auto-discovered is appended to automatically by the probe phase in scripts/greenhouse.js,
# which guesses board tokens for companies seen in your job data and confirms each guess
# against the Boards API before adding it here. Safe to hand-edit or promote entries up
# into ## Curated.

## Curated

## Auto-discovered
