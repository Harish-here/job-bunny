// scripts/pipeline/extract/cards.test.js — pure-function / stub-based unit tests for the batch
// card collector. No real browser: collectCardsInPage runs against a fake global `document`,
// collectCards/collectAllPages against a fake Playwright page whose evaluate() returns canned
// harvests. Run with:
//   node --test scripts/pipeline/extract/cards.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalUrl,
  collectCardsInPage,
  mergeCardRows,
  collectCards,
  collectAllPages,
} from "./cards.js";

// --- collectCardsInPage (fake DOM) --------------------------------------------

function fakeEl({ text = "", attrs = {}, children = {} } = {}) {
  return {
    innerText: text,
    getAttribute: (a) => attrs[a] ?? null,
    querySelectorAll: (sel) => children[sel] || [],
  };
}

function withFakeDocument(cards, jobCardSel, fn) {
  const prev = globalThis.document;
  globalThis.document = { querySelectorAll: (sel) => (sel === jobCardSel ? cards : []) };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  }
}

test("collectCardsInPage: extracts title/company/location/href/id in one pass", () => {
  const card = fakeEl({
    attrs: { "data-occludable-job-id": "4271" },
    children: {
      ".title": [fakeEl({ text: "  \n Staff Engineer \n with verification " })],
      ".subtitle": [fakeEl({ text: "Acme Corp" })],
      ".caption": [fakeEl({ text: "Chennai, India (Remote)" })],
      "a.link": [fakeEl({ attrs: { href: "/jobs/view/4271/?tracking=x" } })],
    },
  });
  const { rows, end } = withFakeDocument([card], "li[data-occludable-job-id]", () =>
    collectCardsInPage({
      job_card: "li[data-occludable-job-id]",
      job_card_title: ".title",
      job_card_company: ".subtitle",
      job_card_location: ".caption",
      job_card_href: "a.link",
      job_card_id_attr: "data-occludable-job-id",
    })
  );
  assert.equal(end, false); // no end_of_results_signal configured
  assert.deepEqual(rows, [
    {
      index: 0,
      title: "Staff Engineer",
      company: "Acme Corp",
      location: "Chennai, India (Remote)",
      href: "/jobs/view/4271/?tracking=x",
      idAttr: "4271",
    },
  ]);
});

test("collectCardsInPage: supports the :nth(N) selector suffix", () => {
  const ps = [fakeEl({ text: "Title" }), fakeEl({ text: "Company" }), fakeEl({ text: "Location" })];
  const card = fakeEl({ attrs: { componentkey: "job-card-component-ref-99" }, children: { p: ps } });
  const { rows } = withFakeDocument([card], "div[componentkey]", () =>
    collectCardsInPage({
      job_card: "div[componentkey]",
      job_card_title: "p",
      job_card_company: "p:nth(1)",
      job_card_location: "p:nth(2)",
      job_card_id_attr: "componentkey",
    })
  );
  assert.equal(rows[0].title, "Title");
  assert.equal(rows[0].company, "Company");
  assert.equal(rows[0].location, "Location");
  assert.equal(rows[0].idAttr, "job-card-component-ref-99");
  assert.equal(rows[0].href, null);
});

test("collectCardsInPage: unhydrated placeholder rows come back with empty fields, not errors", () => {
  const card = fakeEl({ attrs: {} }); // occluded row: no children, no id yet
  const { rows } = withFakeDocument([card], "li", () =>
    collectCardsInPage({ job_card: "li", job_card_title: ".t", job_card_company: ".c", job_card_location: ".l", job_card_href: "a", job_card_id_attr: "id" })
  );
  assert.deepEqual(rows, [{ index: 0, title: "", company: "", location: "", href: null, idAttr: null }]);
});

// --- mergeCardRows -------------------------------------------------------------

test("mergeCardRows: adds new rows keyed by id and reports growth", () => {
  const byKey = new Map();
  const grew = mergeCardRows(byKey, [
    { index: 0, title: "A", idAttr: "1", href: null },
    { index: 1, title: "B", idAttr: "2", href: null },
  ]);
  assert.equal(grew, 2);
  assert.equal(byKey.size, 2);
});

test("mergeCardRows: re-harvest of the same rows is not growth", () => {
  const byKey = new Map();
  const rows = [{ index: 0, title: "A", idAttr: "1", href: null }];
  mergeCardRows(byKey, rows);
  assert.equal(mergeCardRows(byKey, rows), 0);
  assert.equal(byKey.size, 1);
});

test("mergeCardRows: a row hydrating (empty → real title) replaces its placeholder and counts as growth", () => {
  const byKey = new Map();
  mergeCardRows(byKey, [{ index: 3, title: "", idAttr: null, href: null }]);
  const grew = mergeCardRows(byKey, [{ index: 3, title: "Staff Engineer", idAttr: "9", href: null }]);
  assert.equal(grew, 1);
  const values = [...byKey.values()];
  assert.equal(values.length, 1); // the idx-keyed placeholder is dropped, not kept as a ghost row
  assert.equal(values[0].title, "Staff Engineer");
  assert.equal(values[0].idAttr, "9");
});

test("mergeCardRows: id-less rows keyed by href ignore querystring churn between rounds", () => {
  const byKey = new Map();
  mergeCardRows(byKey, [{ index: 0, title: "A", idAttr: null, href: "/jobs/view/1/?trackingId=aaa" }]);
  const grew = mergeCardRows(byKey, [{ index: 0, title: "A", idAttr: null, href: "/jobs/view/1/?trackingId=bbb" }]);
  assert.equal(grew, 0); // same card, different tracking param — not growth
  assert.equal(byKey.size, 1);
});

// --- collectCards (fake page) --------------------------------------------------

const CFG = {
  job_card: "li[data-occludable-job-id]",
  job_card_title: ".title",
  job_card_company: ".subtitle",
  job_card_location: ".caption",
  job_card_href: "a.link",
  job_card_id_attr: "data-occludable-job-id",
  url_pattern_of_job: "https://www.linkedin.com/jobs/view/<id>/",
};

const row = (i, id, title = `Job ${id}`) => ({
  index: i,
  title,
  company: "Acme",
  location: "Remote",
  href: `/jobs/view/${id}/?t=x`,
  idAttr: id,
});

// harvests: array of row-arrays returned by successive collect evaluates.
// scrolls: array of {top,height,client} returned by successive scroll evaluates.
function fakePage({ harvests, scrolls = [], url = "https://www.linkedin.com/jobs/search/?q=1" }) {
  let h = 0;
  let s = 0;
  const page = {
    url: () => url,
    harvestCalls: 0,
    scrollCalls: 0,
    goto: async () => {},
    locator: () => ({ count: async () => 1 }),
    evaluate: async (fn) => {
      if (fn === collectCardsInPage) {
        page.harvestCalls++;
        return { rows: harvests[Math.min(h++, harvests.length - 1)], end: false };
      }
      page.scrollCalls++;
      return scrolls[Math.min(s++, scrolls.length - 1)] ?? { top: 0, height: 1000, client: 1000 };
    },
  };
  return page;
}

const fastOpts = { maxMs: 5000, roundDelayMs: 1, stableRounds: 1, log: { warn() {}, log() {} } };

test("collectCards: harvests until stable and maps rows to the legacy card shape", async () => {
  const page = fakePage({
    harvests: [
      [row(0, "11"), { index: 1, title: "", company: "", location: "", href: null, idAttr: null }],
      [row(0, "11"), row(1, "22")],
      [row(0, "11"), row(1, "22")],
    ],
    scrolls: [
      { top: 500, height: 2000, client: 1000 },
      { top: 1000, height: 2000, client: 1000 },
      { top: 1000, height: 2000, client: 1000 },
    ],
  });
  const cards = await collectCards(page, CFG, fastOpts);
  const c22 = cards.find((c) => c.job_id === "22");
  assert.ok(c22, "hydrated second row present");
  assert.equal(c22.job_url, "https://www.linkedin.com/jobs/view/22/");
  assert.equal(c22.title, "Job 22");
  const c11 = cards.find((c) => c.job_id === "11");
  assert.equal(c11.job_url, "https://www.linkedin.com/jobs/view/11/");
});

test("collectCards: strips the configured id-attr prefix", async () => {
  const page = fakePage({
    harvests: [[{ index: 0, title: "T", company: "C", location: "L", href: null, idAttr: "job-card-component-ref-77" }]],
    scrolls: [{ top: 0, height: 500, client: 500 }],
  });
  const cfg = { ...CFG, job_card_href: "", job_card_id_attr: "componentkey", job_card_id_attr_prefix: "job-card-component-ref-" };
  const cards = await collectCards(page, cfg, fastOpts);
  assert.equal(cards[0].job_id, "77");
  assert.equal(cards[0].job_url, "https://www.linkedin.com/jobs/view/77/");
});

test("collectCards: an expired budget warns and returns the first harvest instead of looping", async () => {
  const warns = [];
  const page = fakePage({ harvests: [[row(0, "11")], [row(1, "22")]] });
  const cards = await collectCards(page, CFG, { ...fastOpts, maxMs: 0, log: { warn: (m) => warns.push(m), log() {} } });
  assert.equal(cards.length, 1); // one harvest always happens, later rounds don't
  assert.ok(warns.some((w) => /collectCards: hit 0ms cap/.test(w)), `expected cap warn, got: ${warns}`);
});

test("collectCards: a wedged evaluate is bounded and returns what was collected", async () => {
  const warns = [];
  let calls = 0;
  const page = {
    url: () => "https://x.test/",
    evaluate: (fn) => {
      calls++;
      if (calls === 1 && fn === collectCardsInPage) return Promise.resolve({ rows: [row(0, "11")], end: false });
      return new Promise(() => {}); // scroll (and anything after) wedges
    },
  };
  const start = Date.now();
  const cards = await collectCards(page, CFG, { ...fastOpts, evalTimeoutMs: 30, log: { warn: (m) => warns.push(m), log() {} } });
  assert.ok(Date.now() - start < 5000, "must not hang on a wedged tab");
  assert.equal(cards.length, 1);
  assert.ok(warns.length >= 1, "expected a warn about the wedged call");
});

test("collectCards: stops at the bottom once growth stalls for stableRounds", async () => {
  const page = fakePage({
    harvests: [[row(0, "11")], [row(0, "11")]],
    scrolls: [{ top: 1000, height: 2000, client: 1000 }], // top+client === height → bottom
  });
  await collectCards(page, CFG, { ...fastOpts, stableRounds: 1 });
  assert.equal(page.scrollCalls, 1);
});

test("collectCards: keeps scrolling through stale mid-list rounds until the bottom is reached", async () => {
  // Non-virtualized page: every card is in the DOM from round 0, so no round ever "grows" —
  // the loop must still scroll all the way down (append-on-bottom loaders fire there), not
  // bail after stableRounds mid-list.
  const page = fakePage({
    harvests: [[row(0, "11")]],
    scrolls: [
      { top: 500, height: 5000, client: 500 },
      { top: 1000, height: 5000, client: 500 },
      { top: 4500, height: 5000, client: 500 }, // bottom on the third step
    ],
  });
  await collectCards(page, CFG, { ...fastOpts, stableRounds: 1 });
  assert.equal(page.scrollCalls, 3); // scrolled to the bottom despite zero growth after round 0
});

test("collectCards: an omitted maxMs means uncapped, not instant expiry", async () => {
  const warns = [];
  const page = fakePage({
    harvests: [[row(0, "11")], [row(0, "11"), row(1, "22")], [row(0, "11"), row(1, "22")]],
    scrolls: [{ top: 1000, height: 2000, client: 1000 }],
  });
  const cards = await collectCards(page, CFG, { roundDelayMs: 1, stableRounds: 1, log: { warn: (m) => warns.push(m), log() {} } });
  assert.equal(cards.length, 2); // later rounds ran and merged — no NaN-deadline bailout
  assert.deepEqual(warns, []);
});

test("collectCards: an end_of_results_signal in the harvest ends the loop after one stale round", async () => {
  let harvestCalls = 0;
  let scrollCalls = 0;
  const page = {
    url: () => "https://x.test/",
    evaluate: async (fn) => {
      if (fn === collectCardsInPage) {
        harvestCalls++;
        return { rows: [row(0, "11")], end: true };
      }
      scrollCalls++;
      return { top: 0, height: 5000, client: 500 }; // nowhere near the geometric bottom
    },
  };
  const cards = await collectCards(page, { ...CFG, end_of_results_signal: ".end" }, { ...fastOpts, stableRounds: 5 });
  assert.equal(cards.length, 1);
  assert.equal(harvestCalls, 2); // growth round + one stale round, not 5 stableRounds
  assert.equal(scrollCalls, 1);
});

// --- collectAllPages (url-pages) ----------------------------------------------

test("collectAllPages url-pages: paginates, dedupes by job_id, stops on a short page", async () => {
  const pageSize = 2;
  const gotos = [];
  let currentHarvest = [];
  const page = {
    url: () => "https://x.test/",
    goto: async (u) => {
      gotos.push(u);
      const start = new URL(u).searchParams.get("start");
      currentHarvest =
        start === "0"
          ? [row(0, "11"), row(1, "22")]
          : [row(0, "22"), row(1, "33")].slice(0, 1); // short raw page (1 < pageSize) ends pagination
    },
    locator: () => ({ count: async () => 2, first: () => ({ waitFor: async () => {} }) }),
    evaluate: async (fn) =>
      fn === collectCardsInPage ? { rows: currentHarvest, end: false } : { top: 0, height: 500, client: 500 },
  };
  const cfg = {
    ...CFG,
    pagination_type: "url-pages",
    pagination_param: "start",
    pagination_page_size: String(pageSize),
    max_pages: "4",
    min_job_cards: "1",
  };
  const all = await collectAllPages(page, "https://x.test/?q=1", cfg, {
    maxMs: 5000,
    roundDelayMs: 1,
    stableRounds: 1,
    jitterFn: async () => {},
    log: { warn() {}, log() {} },
  });
  assert.deepEqual(all.map((c) => c.job_id).sort(), ["11", "22"]); // page-2 "22" deduped
  assert.equal(gotos.length, 2); // page 3 never fetched — page 2's raw count was short
});
