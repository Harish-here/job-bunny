// scripts/notion/schema.test.js — node:test unit tests locking down the Notion schema
// literals. PROP values must stay byte-exact with DB_PROPERTIES keys (Gate 3) — a drift
// here means notion_sync/cache read/write a column that doesn't exist in the live DB.
// Run with: node --test scripts/notion/schema.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DB_TITLE,
  PARENT_PAGE_TITLE,
  DB_PROPERTIES,
  AUTOMATED_FIELDS,
  PROP,
  SENIORITY_OPTIONS,
  WORK_TYPE_OPTIONS,
  TIMEZONE_OPTIONS,
  EXCITEMENT_OPTIONS,
  STATUS_OPTIONS,
} from "./schema.js";

test("every PROP value is an existing DB_PROPERTIES key", () => {
  const keys = new Set(Object.keys(DB_PROPERTIES));
  for (const [name, value] of Object.entries(PROP)) {
    assert.ok(keys.has(value), `PROP.${name} = "${value}" is not a DB_PROPERTIES key`);
  }
});

test("every AUTOMATED_FIELDS entry is an existing DB_PROPERTIES key", () => {
  const keys = new Set(Object.keys(DB_PROPERTIES));
  for (const field of AUTOMATED_FIELDS) {
    assert.ok(keys.has(field), `AUTOMATED_FIELDS entry "${field}" is not a DB_PROPERTIES key`);
  }
});

test("PROP is frozen (byte-exact literals can't drift at runtime)", () => {
  assert.equal(Object.isFrozen(PROP), true);
});

test("select-option literals are non-empty and unchanged", () => {
  assert.deepEqual(SENIORITY_OPTIONS, ["Staff", "Lead", "Mid", "Manager", "Senior"]);
  assert.deepEqual(WORK_TYPE_OPTIONS, ["Remote", "Hybrid", "On-site"]);
  assert.deepEqual(TIMEZONE_OPTIONS, ["APAC", "EMEA"]);
  assert.deepEqual(EXCITEMENT_OPTIONS, ["Vera level", "Kandipa podu", "Try panalam"]);
  assert.deepEqual(STATUS_OPTIONS, [
    "Lead", "Applied", "Recruiter Screen", "Tech Round", "Onsite", "Offer", "Rejected", "Passed",
  ]);
});

test("DB_TITLE and PARENT_PAGE_TITLE are unchanged", () => {
  assert.equal(DB_TITLE, "Job Bunny — Jobs");
  assert.equal(PARENT_PAGE_TITLE, "Job Bunny's List");
});
