// scripts/lib/prompt.js — shared readline prompt helpers, previously duplicated between
// setup/init.js and setup/notify_setup.js. Both take an existing `rl` (createInterface())
// so a script asking more than one question shares a single interface for its lifetime —
// a fresh interface per question was observed to hang on piped/non-TTY stdin once a script
// asks a second question (notify_setup.js's original fix, generalized here).

// Plain prompt (Y/n confirmations, free-text answers).
export function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// Masked prompt — never echoes, never a CLI arg.
export function promptMasked(rl, question) {
  return new Promise((resolve) => {
    const onData = () => rl.output.write("\x1B[2K\x1B[200D" + question);
    process.stdout.write(question);
    rl.input.on("data", onData);
    rl.question("", (answer) => {
      rl.input.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
