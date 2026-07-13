// scripts/notify.js — generic notification dispatcher. Best-effort: this module must
// never throw out into a calling pipeline stage. Reads the active profile's `notify`
// block, fans out to each enabled channel in parallel, and swallows every failure
// (including a loadProfile() throw — e.g. a missing/incomplete profile.json)
// behind a console.warn.
//
// As a module: import { notify } from "./notify.js".
// Run directly (CLI): JOBBUNNY_PROFILE=<p> node scripts/notify.js --severity <s> --title <t> --body <b>

import "dotenv/config";
import { loadProfile } from "./config.js";
import { sendTelegram } from "./notifiers/telegram.js";

export async function notify({ severity = "info", title, body } = {}) {
  try {
    const profile = loadProfile();
    const channels = profile?.notify ?? {};

    const sends = [];
    if (channels.telegram?.enabled) {
      sends.push(
        sendTelegram({ chat_id: channels.telegram.chat_id, severity, title, body, profileName: profile.name })
      );
    }

    if (!sends.length) return;

    const results = await Promise.allSettled(sends);
    for (const r of results) {
      if (r.status === "rejected") console.warn(`[notify] channel send rejected: ${r.reason?.message ?? r.reason}`);
    }
  } catch (err) {
    console.warn(`[notify] skipped (${err.message})`);
  }
}

// Run directly → CLI mode, e.g. from run_scheduled.sh / run.md digest hooks.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  notify({ severity: flags.severity ?? "info", title: flags.title, body: flags.body })
    .catch((err) => console.warn(`[notify] unexpected error: ${err.message}`))
    .finally(() => process.exit(0));
}
