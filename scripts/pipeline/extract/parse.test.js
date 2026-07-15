// scripts/pipeline/extract/parse.test.js — node:test unit tests for the pure config parsers
// (parseSearchUrls, parseInventory, validateInventory, parseList, applyWindowOverride). No I/O.
// Run with: node --test scripts/pipeline/extract/parse.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchUrls,
  parseInventory,
  validateInventory,
  REQUIRED_SELECTORS,
  parseList,
  applyWindowOverride,
} from "./parse.js";

// ---------- parseSearchUrls ----------

test("parseSearchUrls builds Channel → page hierarchy and captures label+URL", () => {
  const text = [
    "## LinkedIn",
    "### jobs-search",
    "- Staff Frontend - https://example.com/jobs?a=1",
  ].join("\n");
  const groups = parseSearchUrls(text);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].channel, "LinkedIn");
  assert.equal(groups[0].page, "jobs-search");
  assert.deepEqual(groups[0].urls, [{ label: "Staff Frontend", url: "https://example.com/jobs?a=1" }]);
});

test("parseSearchUrls defaults inventory path to page_inventory/<page>.md", () => {
  const text = ["## LinkedIn", "### jobs-search", "- A - https://example.com/x"].join("\n");
  const [group] = parseSearchUrls(text);
  assert.equal(group.inventory, "page_inventory/jobs-search.md");
});

test("parseSearchUrls honors an <!-- inventory: custom.md --> override", () => {
  const text = [
    "## LinkedIn",
    "### jobs-search",
    "<!-- inventory: custom.md -->",
    "- A - https://example.com/x",
  ].join("\n");
  const [group] = parseSearchUrls(text);
  assert.equal(group.inventory, "custom.md");
});

test("parseSearchUrls accepts bullet variants •, *, -", () => {
  const text = [
    "## LinkedIn",
    "### jobs-search",
    "• Bullet1 - https://example.com/1",
    "* Bullet2 - https://example.com/2",
    "- Bullet3 - https://example.com/3",
  ].join("\n");
  const [group] = parseSearchUrls(text);
  assert.equal(group.urls.length, 3);
  assert.deepEqual(group.urls.map((u) => u.label), ["Bullet1", "Bullet2", "Bullet3"]);
});

test("parseSearchUrls drops groups with zero URLs", () => {
  const text = [
    "## LinkedIn",
    "### empty-page",
    "### jobs-search",
    "- A - https://example.com/x",
  ].join("\n");
  const groups = parseSearchUrls(text);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].page, "jobs-search");
});

// ---------- parseInventory ----------

test("parseInventory parses '- key: value' lines and ignores headings/prose", () => {
  const text = [
    "# Page inventory",
    "some prose describing the page",
    "- job_card: .card",
    "- job_card_title: .title",
  ].join("\n");
  const cfg = parseInventory(text);
  assert.deepEqual(cfg, { job_card: ".card", job_card_title: ".title" });
});

test("parseInventory also accepts '* key: value' bullets", () => {
  const text = ["* job_card: .card"].join("\n");
  const cfg = parseInventory(text);
  assert.equal(cfg.job_card, ".card");
});

test("parseInventory trims values", () => {
  const text = ["- job_card:    .card   "].join("\n");
  const cfg = parseInventory(text);
  assert.equal(cfg.job_card, ".card");
});

// ---------- validateInventory ----------

test("validateInventory throws naming ALL missing required selectors", () => {
  assert.throws(
    () => validateInventory({}, "jobs-search"),
    (err) => {
      for (const key of REQUIRED_SELECTORS) assert.match(err.message, new RegExp(key));
      return true;
    }
  );
});

test("validateInventory passes when all required selectors present (job_card_href optional)", () => {
  const cfg = {
    job_card: ".card",
    job_card_title: ".title",
    job_card_company: ".company",
    jd_body: ".jd",
  };
  assert.doesNotThrow(() => validateInventory(cfg, "jobs-search"));
});

// ---------- parseList ----------

test("parseList parses a bracketed, quoted list", () => {
  assert.deepEqual(parseList('[".a", ".b"]'), [".a", ".b"]);
});

test("parseList parses a bare comma list", () => {
  assert.deepEqual(parseList("a, b"), ["a", "b"]);
});

test("parseList returns [] for empty/falsy input", () => {
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList(undefined), []);
});

// ---------- applyWindowOverride ----------

test("applyWindowOverride rewrites a relative f_TPR window per JOBBUNNY_WINDOW_HOURS", () => {
  process.env.JOBBUNNY_WINDOW_HOURS = "72";
  try {
    const out = applyWindowOverride("https://example.com/jobs?f_TPR=r86400");
    assert.equal(new URL(out).searchParams.get("f_TPR"), "r259200");
  } finally {
    delete process.env.JOBBUNNY_WINDOW_HOURS;
  }
});

test("applyWindowOverride leaves an absolute f_TPR anchor untouched", () => {
  process.env.JOBBUNNY_WINDOW_HOURS = "72";
  try {
    const url = "https://example.com/jobs?f_TPR=a1700000000-";
    assert.equal(applyWindowOverride(url), url);
  } finally {
    delete process.env.JOBBUNNY_WINDOW_HOURS;
  }
});

test("applyWindowOverride leaves URLs without f_TPR untouched", () => {
  process.env.JOBBUNNY_WINDOW_HOURS = "72";
  try {
    const url = "https://example.com/jobs?q=engineer";
    assert.equal(applyWindowOverride(url), url);
  } finally {
    delete process.env.JOBBUNNY_WINDOW_HOURS;
  }
});

test("applyWindowOverride is a no-op when JOBBUNNY_WINDOW_HOURS is unset", () => {
  delete process.env.JOBBUNNY_WINDOW_HOURS;
  const url = "https://example.com/jobs?f_TPR=r86400";
  assert.equal(applyWindowOverride(url), url);
});
