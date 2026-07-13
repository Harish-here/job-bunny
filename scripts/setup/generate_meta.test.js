// scripts/setup/generate_meta.test.js — node:test unit tests for the pure shape validator
// validateFields() (no I/O — fast, deterministic). main() is out of scope (real file I/O).
// Run with: node --test scripts/setup/generate_meta.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFields } from "./generate_meta.js";

const VALID = {
  current_yoe: 8,
  target_seniority: ["Staff", "Lead"],
  core_skills: ["React", "TypeScript"],
  secondary_skills: ["Vue.js"],
  preferred_work_type: ["Remote", "Hybrid"],
  location: "Bengaluru",
  domain_experience: ["Enterprise SaaS"],
  usp: ["One-line impact statement"],
};

test("validateFields accepts a fully valid resume shape (string location)", () => {
  assert.doesNotThrow(() => validateFields(VALID));
});

test("validateFields accepts an array location (multi-city)", () => {
  assert.doesNotThrow(() => validateFields({ ...VALID, location: ["Bengaluru", "Chennai"] }));
});

test("validateFields throws listing every missing field", () => {
  assert.throws(
    () => validateFields({ current_yoe: 8 }),
    /missing required field\(s\): target_seniority, core_skills, secondary_skills, preferred_work_type, location, domain_experience, usp/
  );
});

test("validateFields throws when current_yoe is not a non-negative number", () => {
  assert.throws(() => validateFields({ ...VALID, current_yoe: "8" }), /current_yoe must be a non-negative number/);
  assert.throws(() => validateFields({ ...VALID, current_yoe: -1 }), /current_yoe must be a non-negative number/);
});

test("validateFields throws when an array-of-strings field is empty", () => {
  assert.throws(() => validateFields({ ...VALID, core_skills: [] }), /core_skills must be a non-empty array/);
});

test("validateFields throws when an array-of-strings field contains a non-string", () => {
  assert.throws(
    () => validateFields({ ...VALID, target_seniority: ["Staff", 42] }),
    /target_seniority must be a non-empty array/
  );
});

test("validateFields throws when location is an array containing a non-string (the original bug's shape)", () => {
  assert.throws(() => validateFields({ ...VALID, location: ["Bengaluru", 42] }), /location:/);
});

test("validateFields throws when location is missing entirely", () => {
  const { location, ...withoutLocation } = VALID;
  assert.throws(() => validateFields(withoutLocation), /missing required field\(s\).*location/);
});

test("validateFields reports multiple problems in one error when several fields are invalid", () => {
  assert.throws(
    () => validateFields({ ...VALID, current_yoe: "eight", core_skills: [] }),
    (err) => /current_yoe/.test(err.message) && /core_skills/.test(err.message)
  );
});
