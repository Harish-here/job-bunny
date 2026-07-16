// scripts/pipeline/extract/parse.js — pure config parsers for the extract pipeline: search_urls.md
// (hierarchical Channel → page → labeled URLs), page_inventory/<page>.md (key: value selectors),
// inventory validation, and the one-off f_TPR window override. Moved verbatim from extract.js —
// no behavior changes.

// ---------- search_urls.md (hierarchical Channel → page → labeled URLs) ----------
export function parseSearchUrls(text) {
  const groups = new Map(); // page → { channel, page, inventory, urls: [{label, url}] }
  let channel = null;
  let page = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^##\s+(.+)$/))) {
      channel = m[1].trim();
      page = null;
    } else if ((m = line.match(/^###\s+(.+)$/))) {
      page = m[1].trim();
      if (!groups.has(page)) {
        groups.set(page, { channel, page, inventory: `page_inventory/${page}.md`, urls: [] });
      }
    } else if ((m = line.match(/^<!--\s*inventory:\s*(.+?)\s*-->$/)) && page) {
      groups.get(page).inventory = m[1].trim();
    } else if ((m = line.match(/^[•*-]\s+(.+?)\s+-\s+(https?:\/\/\S+)$/)) && page) {
      groups.get(page).urls.push({ label: m[1].trim(), url: m[2].trim() });
    }
  }
  return [...groups.values()].filter((g) => g.urls.length > 0);
}

// ---------- page_inventory/<page>.md (key: value under sections) ----------
export function parseInventory(text) {
  const cfg = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^[-*]\s+([a-z_]+):\s*(.*)$/i);
    if (m) cfg[m[1].trim()] = m[2].trim();
  }
  return cfg;
}

// job_card_href is optional — pages that provide job IDs via job_card_id_attr + url_pattern_of_job
// don't need a link selector on the card itself.
export const REQUIRED_SELECTORS = ["job_card", "job_card_title", "job_card_company", "jd_body"];

export function validateInventory(cfg, page) {
  const missing = REQUIRED_SELECTORS.filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `inventory for "${page}" is missing/blank selector(s): ${missing.join(", ")}. ` +
        `Run /page-analyse to fill page_inventory/${page}.md.`
    );
  }
}

export function parseList(v) {
  if (!v) return [];
  return v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

// One-off widen of the f_TPR search window (e.g. a missed daily run) without touching
// search_urls.md — only rewrites relative windows (r<sec>); absolute anchors (a<epoch>) are a
// different, already-handled case in add_url.js and are left alone.
export function applyWindowOverride(url, hours = parseInt(process.env.JOBBUNNY_WINDOW_HOURS || "0", 10)) {
  if (!hours) return url;
  const u = new URL(url);
  if (!/^r\d+/.test(u.searchParams.get("f_TPR") || "")) return url;
  u.searchParams.set("f_TPR", `r${hours * 3600}`);
  return u.toString();
}
