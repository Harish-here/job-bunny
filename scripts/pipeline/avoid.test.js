// scripts/pipeline/avoid.test.js — node:test unit tests for the pure avoid-list helpers
// (parseAvoid, isAvoided). No I/O, no fetch — fast, deterministic. loadAvoid is out of
// scope (does real file I/O against the active profile). Run with:
//   node --test scripts/avoid.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAvoid, isAvoided } from "./avoid.js";

test("parseAvoid puts bullets before '## Alias map' into companies, normalized", () => {
  const text = [
    "# Avoid list",
    "- Acme Technologies Pvt Ltd",
    "- Widget Corp",
  ].join("\n");
  const { companies, aliases } = parseAvoid(text);
  assert.equal(companies.size, 2);
  assert.ok(companies.has("acme"));
  assert.ok(companies.has("widget"));
  assert.equal(aliases.size, 0);
});

test("parseAvoid recognizes '## Alias map' heading case-insensitively (e.g. '## ALIAS MAP')", () => {
  const text = [
    "- Acme Technologies Pvt Ltd",
    "## ALIAS MAP",
    "- Acme Legacy Co → Acme Technologies Pvt Ltd",
  ].join("\n");
  const { companies, aliases } = parseAvoid(text);
  assert.ok(companies.has("acme"));
  assert.equal(aliases.size, 1);
  assert.equal(aliases.get("acme legacy co"), "acme");
});

test("parseAvoid splits alias lines on all three separators: →, ->, =>", () => {
  const text = [
    "## Alias map",
    "- Foo Co → Foo Corp",
    "- Bar Co -> Bar Corp",
    "- Baz Co => Baz Corp",
  ].join("\n");
  const { aliases } = parseAvoid(text);
  assert.equal(aliases.size, 3);
  assert.equal(aliases.get("foo co"), "foo");
  assert.equal(aliases.get("bar co"), "bar");
  assert.equal(aliases.get("baz co"), "baz");
});

test("parseAvoid skips bullets with empty bodies", () => {
  const text = [
    "- Acme Technologies",
    "-",
    "-   ",
    "- Widget Corp",
  ].join("\n");
  const { companies } = parseAvoid(text);
  assert.equal(companies.size, 2);
  assert.ok(companies.has("acme"));
  assert.ok(companies.has("widget"));
});

test("parseAvoid skips malformed alias lines (not exactly 2 parts) without throwing", () => {
  const text = [
    "## Alias map",
    "- just one side, no separator",
    "- A → B → C",
    "- Good Co → Good Corp",
  ].join("\n");
  let aliases;
  assert.doesNotThrow(() => {
    ({ aliases } = parseAvoid(text));
  });
  assert.equal(aliases.size, 1);
  assert.equal(aliases.get("good co"), "good");
});

test("parseAvoid treats '*' bullets the same as '-' bullets", () => {
  const text = [
    "* Acme Technologies",
    "## Alias map",
    "* Acme Legacy Co → Acme Technologies",
  ].join("\n");
  const { companies, aliases } = parseAvoid(text);
  assert.ok(companies.has("acme"));
  assert.equal(aliases.get("acme legacy co"), "acme");
});

test("parseAvoid with no alias section at all treats every bullet as a company", () => {
  const text = [
    "# Companies to avoid",
    "- Acme Technologies",
    "- Widget Corp",
    "- Gizmo Inc",
  ].join("\n");
  const { companies, aliases } = parseAvoid(text);
  assert.equal(companies.size, 3);
  assert.equal(aliases.size, 0);
});

test("isAvoided resolves an alias to a blocked company name and returns true", () => {
  const companies = new Set(["acme"]);
  const aliases = new Map([["acme legacy co", "acme"]]);
  assert.equal(isAvoided("Acme Legacy Co", { companies, aliases }), true);
});

test("isAvoided returns true for a company name directly in companies, no alias involved", () => {
  const companies = new Set(["widget"]);
  const aliases = new Map();
  assert.equal(isAvoided("Widget Corp", { companies, aliases }), true);
});

test("isAvoided returns false for a company in neither companies nor aliases", () => {
  const companies = new Set(["acme"]);
  const aliases = new Map();
  assert.equal(isAvoided("Totally Unrelated Co", { companies, aliases }), false);
});

test("isAvoided matches case/suffix variations of a blocked name via normalization", () => {
  const companies = new Set(["acme"]);
  const aliases = new Map();
  assert.equal(isAvoided("ACME Technologies Inc.", { companies, aliases }), true);
});
