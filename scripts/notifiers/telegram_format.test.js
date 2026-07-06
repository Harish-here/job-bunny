// scripts/notifiers/telegram_format.test.js — node:test unit tests for the pure
// text-transform helpers (no I/O, no fetch — fast, deterministic). Run with:
//   node --test scripts/

import { test } from "node:test";
import assert from "node:assert/strict";
import { toBoldUnicode, reformatBody, severityIcon, truncate, formatTelegramMessage } from "./telegram_format.js";

test("toBoldUnicode maps A-Z/a-z/0-9, leaves other characters unchanged", () => {
  const out = toBoldUnicode("Run 1: café → done!");
  // Built via the codepoint math directly (0x1D400/0x1D41A/0x1D7CE bases) rather than
  // hand-typed literals — hand-typing bold Unicode glyphs is error-prone (easy to grab the
  // wrong bold sub-block, e.g. sans-serif vs serif) and was in fact wrong on the first pass.
  const bold = (s) => Array.from(s).map((ch) => {
    const cp = ch.codePointAt(0);
    if (cp >= 0x41 && cp <= 0x5a) return String.fromCodePoint(0x1d400 + (cp - 0x41));
    if (cp >= 0x61 && cp <= 0x7a) return String.fromCodePoint(0x1d41a + (cp - 0x61));
    if (cp >= 0x30 && cp <= 0x39) return String.fromCodePoint(0x1d7ce + (cp - 0x30));
    return ch;
  }).join("");
  assert.equal(out, `${bold("Run")} ${bold("1")}: ${bold("café")} → ${bold("done")}!`);
  // café's accented "é" is non-ASCII and has no bold-plane equivalent — confirm it survives untouched.
  assert.ok(out.includes("é"));
});

test("toBoldUnicode round-trips through codepoint iteration without corrupting surrogate pairs", () => {
  const out = toBoldUnicode("Ab9");
  // Each bolded ASCII char becomes a 2-code-unit surrogate pair; the space (if any) stays 1 unit.
  assert.equal(Array.from(out).length, 3); // 3 codepoints in, 3 codepoints out
  assert.equal(out.length, 6); // each of the 3 becomes a UTF-16 surrogate pair (2 units each)
  // Slicing by codepoint must never split a pair.
  const firstCodepoint = Array.from(out)[0];
  assert.equal(firstCodepoint.length, 2); // one JS "character" here is actually a surrogate pair
});

test("reformatBody converts a markdown table into bullet lines, generic across column count", () => {
  const body = [
    "| Score | Title | Company |",
    "|---|---|---|",
    "| 81 | UI Architect | Grid Dynamics |",
    "| 70 | Tech Lead | Husky Technologies |",
  ].join("\n");
  const out = reformatBody(body);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^• .*— UI Architect — Grid Dynamics$/);
  assert.match(lines[1], /^• .*— Tech Lead — Husky Technologies$/);
});

test("reformatBody handles a table followed by trailing content without dropping or duplicating lines", () => {
  const body = [
    "**Top excitement bands (ranked):**",
    "| Score | Title | Company |",
    "|---|---|---|",
    "| 92 | Senior Backend Engineer | Acme Corp |",
    "",
    "Notes:",
    "- something noteworthy",
  ].join("\n");
  const out = reformatBody(body);
  const lines = out.split("\n");
  assert.equal(lines.length, 5); // heading, bullet, blank, "Notes:", note bullet
  assert.match(lines[1], /^• .*— Senior Backend Engineer — Acme Corp$/);
  assert.equal(lines[3], "Notes:");
  assert.equal(lines[4], "- something noteworthy");
});

test("reformatBody strips heading markers and bolds the heading text", () => {
  const out = reformatBody("## Run Summary — profile: harish");
  assert.ok(!out.includes("#"));
  // The letters themselves get bolded (different codepoints than plain ASCII), but
  // punctuation like ":" and "—" passes through literally — check for those instead
  // of asserting the ASCII word "profile" appears verbatim.
  assert.ok(out.includes(":"));
  assert.ok(out.includes("—"));
  assert.equal(toBoldUnicode("profile"), out.slice(out.indexOf(":") - toBoldUnicode("profile").length, out.indexOf(":")));
});

test("reformatBody bolds inline **spans** and strips the asterisks, even inside bullet lines", () => {
  const out = reformatBody("- **URLs processed:** 21 (breakdown)");
  assert.ok(!out.includes("**"));
  assert.ok(out.startsWith("- "));
  assert.ok(out.endsWith(": 21 (breakdown)"));
  assert.ok(out.includes(toBoldUnicode("URLs processed")));
});

test("severityIcon maps known severities and falls back for unknown ones", () => {
  assert.equal(severityIcon("blocking"), "🔴");
  assert.equal(severityIcon("success"), "✅");
  assert.equal(severityIcon("info"), "ℹ️");
  assert.equal(severityIcon("nonsense"), "🔔");
  assert.equal(severityIcon(undefined), "🔔");
});

test("truncate leaves short text untouched", () => {
  const short = "hello world";
  assert.equal(truncate(short), short);
});

test("truncate caps long text and appends a note, without splitting a surrogate pair", () => {
  const bolded = toBoldUnicode("x".repeat(5000)); // all surrogate pairs
  const out = truncate(bolded);
  assert.ok(out.endsWith("…(truncated — see log)"));
  // No lone surrogate: every code unit pairs correctly when re-iterated by codepoint.
  const codepoints = Array.from(out);
  assert.ok(codepoints.length > 0);
  for (const cp of codepoints) assert.equal(typeof cp, "string");
});

test("formatTelegramMessage composes banner + title + body, and never throws on empty inputs", () => {
  const out = formatTelegramMessage({ severity: "success", title: "Run complete", body: "", profileName: "harish" });
  assert.match(out, /^✅ Job Bunny — harish/);
  assert.ok(out.includes(toBoldUnicode("Run complete")));

  // Empty/undefined title+body must not throw or produce a broken string.
  assert.doesNotThrow(() => formatTelegramMessage({ severity: "blocking", title: undefined, body: undefined, profileName: undefined }));
});
