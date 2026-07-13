// scripts/lib/util.js — shared pure helpers (no I/O, no network). Used by cache.js, dedup.js,
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

// G6: job_id from a job URL, or null when the URL carries none.
//  - LinkedIn: the id in the /jobs/view/<id>/ segment.
//  - Greenhouse (the /greenhouse lane): embedded boards carry ?gh_jid=<id>; hosted boards are
//    greenhouse.io/<token>/jobs/<id>. Returned as "gh-<id>" — the exact id the lane emits —
//    so a /reconcile rebuild of the cache round-trips to the same job_id.
export function extractJobId(url) {
  if (!url) return null;
  const s = String(url);
  const li = s.match(/\/jobs\/view\/([^/?#]+)/);
  if (li) return li[1];
  const gh =
    s.match(/[?&]gh_jid=(\d+)/) ||
    (s.includes("greenhouse.io/") ? s.match(/\/jobs\/(\d+)(?:[/?#]|$)/) : null);
  if (gh) return `gh-${gh[1]}`;
  return null;
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

// resume_meta.json `location` is a string (single home city) or an array of strings
// (multiple home cities). Anything else — including an array that isn't all non-empty
// strings — is a shape error: fail loud rather than let it silently coerce (an array
// naively stringified normalizes to a joined string that never matches any single city,
// which used to make filter.js/rank.js drop every on-site job with no error at all).
export function homeLocations(location) {
  const arr = Array.isArray(location) ? location : [location];
  if (!arr.length || !arr.every((l) => typeof l === "string" && l.trim())) {
    throw new Error(
      `location must be a non-empty string or a non-empty array of non-empty strings, got ${JSON.stringify(location)}`
    );
  }
  return arr;
}

// True when `city` matches ANY of the configured home locations (string or array).
export function isHomeCity(city, location) {
  const norm = normalizeName(city);
  return homeLocations(location).some((l) => normalizeName(l) === norm);
}
