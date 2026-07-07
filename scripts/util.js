// scripts/util.js — shared pure helpers (no I/O, no network). Used by cache.js, dedup.js,
// filter.js, rank.js so the matching/normalization rules live in exactly one place.

// Strip common legal/suffix noise and lowercase, for avoid-list + dedup name matching.
const SUFFIXES = [
  "private limited", "pvt ltd", "pvt. ltd.", "pvt", "ltd", "limited", "inc", "inc.",
  "llc", "corp", "corporation", "technologies", "technology", "software", "labs",
  "solutions", "systems", "global", "india",
];

export function normalizeName(raw) {
  if (!raw) return "";
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  // strip trailing suffix words repeatedly (e.g. "acme technologies pvt ltd")
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      if (s.endsWith(" " + suf) || s === suf) {
        s = s.slice(0, s.length - suf.length).trim();
        changed = true;
      }
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

// G6: job_id is the LinkedIn id in the /jobs/view/<id>/ segment of the card/job href.
// Returns the id string, or null when the URL carries no view id.
export function extractJobId(url) {
  if (!url) return null;
  const m = String(url).match(/\/jobs\/view\/([^/?#]+)/);
  return m ? m[1] : null;
}

// Dedup key: job_id primary; fallback to normalized role + company when job_id is absent.
export function dedupKey(job) {
  const id = job.job_id || extractJobId(job.job_url);
  if (id) return `id:${id}`;
  return `rc:${normalizeName(job.job_title)}::${normalizeName(job.company_name)}`;
}

// Repost key: same role at same company in same city — a fresh job_id on this key is a repost.
// location_city is included deliberately: a company posting the same title in two cities is two
// distinct openings, while a LinkedIn repost keeps its location.
export function repostKey(job) {
  return `rp:${normalizeName(job.job_title)}::${normalizeName(job.company_name)}::${normalizeName(job.location_city)}`;
}
