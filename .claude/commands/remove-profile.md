---
description: Remove a profile entirely — local files, .env token, permission entry — and reconcile schedule. Archives stale Notion jobs first via /cleanup; the DB/page itself is left untouched (persists remotely).
---

`$ARGUMENTS` = profile name. This is a destructive local operation on real files — confirm the profile name with the user before running if there's any ambiguity.

**1. Archive stale Notion jobs first.**

```bash
JOBBUNNY_PROFILE=<profile> node scripts/notion/cleanup.js --apply
```

Once the profile is removed, nothing will maintain that Notion DB anymore, so archive what's already stale now (Passed >7d, untouched leads >30d — see `/cleanup`). This is a live Notion mutation (archived pages are recoverable via Notion's own trash for 30 days) — confirm with the user before running `--apply` if there's any doubt.

**2. Dry-run, then apply.**

```bash
node scripts/setup/remove_profile.js <profile>            # dry-run — prints the full summary, touches nothing
node scripts/setup/remove_profile.js <profile> --apply    # actually removes
```

Run without `--apply` first and show the summary to the user (profile directory, Notion IDs, schedule, Telegram chat_id, the `.env` key and permission entries that would be stripped). Get confirmation, then re-run with `--apply`. Stop and report if it refuses — missing profile, is `rajni` (the committed fixture profile, never removable), or is the current `default_profile` in `config.json` (change that first, then re-run).

If the summary showed `schedule.enabled: true`, `--apply` automatically re-runs `scripts/ops/schedule.js` to reconcile launchd (drops the profile from any shared time-slot plist, deletes now-empty ones) — report what it printed, no separate step needed.

**3. Notion is untouched — say so.** Report the Notion DB id from the summary and remind the user the DB/page itself is left alone. Offer to help archive the whole page in Notion only if they explicitly ask — never automatically (matches this repo's hard rule against automated whole-page delete/overwrite).
