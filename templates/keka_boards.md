# Keka tenant watchlist for the /keka lane (scripts/pipeline/keka.js).
# Fetches jobs from the public, keyless Keka careers API — no browser, no LinkedIn.
#
# Format: one tenant per line —
#   - <Display Name> - <tenant_subdomain>
# e.g.:
#   - Acme Corp - acme  (acme.keka.com)
#
# Blank lines and any line starting with # (including these, and the two ## section
# headings below) are ignored/structural. Anything else that doesn't match the
# "- Name - token" shape makes scripts/pipeline/keka.js's parseWatchlist() throw — a
# malformed line fails loud, it is never silently skipped.
#
# ## Curated is hand-maintained: companies you already know post openings to Keka.
# ## Auto-discovered is appended to automatically by the probe phase in scripts/pipeline/keka.js,
# which guesses tenant subdomains for companies seen in your job data and confirms each guess
# against the careers API before adding it here. Safe to hand-edit or promote entries up
# into ## Curated.

## Curated

## Auto-discovered
