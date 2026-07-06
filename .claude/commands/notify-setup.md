---
description: Guided Telegram notification setup for one profile — bot token, chat_id auto-detect, live test message.
---

Run the guided Telegram setup (`$ARGUMENTS` = profile name; falls back to `JOBBUNNY_PROFILE` / `config.json` `default_profile`):

```bash
node scripts/notify_setup.js <profile>
```

Requires the profile to already exist (`profiles/<profile>/profile.json`, from `/setup <profile>`) — this command only adds notification config to it, never creates a profile.

It prompts (masked) for the shared `TELEGRAM_BOT_TOKEN` only if `.env` doesn't already have one — if you don't have a bot yet, it prints @BotFather instructions first (`/newbot` in a chat with @BotFather, copy the token it gives you). It then asks you to message your bot on Telegram and polls `getUpdates` for up to 60s to auto-detect your `chat_id`, showing the sender name it found before asking you to confirm.

Once confirmed, it merges `notify: { telegram: { enabled: true, chat_id } }` into `profiles/<profile>/profile.json` — every other existing key (`schedule`, `notion_db_id`, …) is preserved untouched, never wholesale-overwritten. Finally it sends a live test message and prints an explicit pass/fail.

Re-running is safe: it won't re-prompt for the token if one is already in `.env`, and re-detecting a chat_id just replaces the `notify` block (nothing else is touched).

After setup, `/doctor` verifies `TELEGRAM_BOT_TOKEN` + `chat_id` are present whenever `notify.telegram.enabled` is `true`.
