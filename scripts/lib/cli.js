// scripts/lib/cli.js — shared CLI plumbing.
// isMain: the run-directly guard every script uses (exact `file://${argv[1]}` semantics —
// true only when the module IS the entrypoint, false under import and node --test).
// parseFlags: the `--flag value` parser notify.js and mark_run_result.js re-implemented.

export const isMain = (metaUrl) => metaUrl === `file://${process.argv[1]}`;

export function parseFlags(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}
