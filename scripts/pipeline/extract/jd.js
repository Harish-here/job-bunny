// scripts/pipeline/extract/jd.js — JD capture (settle-wait, text extraction, capture orchestration),
// moved verbatim from extract.js except for gotoWithRetry adoption in captureJd's new-page branch.
// See the extract-rewrite task's behavior diff report for the exhaustive list of sanctioned
// deviations.

import { sleep, gotoWithRetry, withTimeout, DEFAULT_CALL_TIMEOUT_MS } from "../../lib/page_actions.js";

// Every JD-page CDP call below carries an explicit deadline — Playwright's 30s action default
// (innerText, click) and unbounded evaluate() are exactly the ceilings that compounded into
// multi-minute URLs in the collectCards incident; a JD is cheap to skip, so bound tightly.

// ---------- JD capture ----------
export async function waitSettled(page, cfg) {
  switch ((cfg.jd_settled_signal || "selector-visible").trim()) {
    case "network-idle":
      // Cap the wait — LinkedIn's long-poll/websocket traffic means networkidle often never
      // fires, which would otherwise hang ~30s (default timeout) per JD.
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      break;
    case "url-change":
      await sleep(800);
      break;
    default:
      if (cfg.jd_body) await page.locator(cfg.jd_body).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  }
}

// Extract JD text robustly: try the configured selector first; if empty (e.g. the direct-nav
// job page uses hashed class names), fall back to the smallest container whose text starts with
// jd_anchor_text ("About the job"). Anchor text is stable across LinkedIn's CSS churn.
export async function extractJdText(target, cfg) {
  if (cfg.jd_body) {
    const t = ((await target.locator(cfg.jd_body).first().innerText({ timeout: DEFAULT_CALL_TIMEOUT_MS }).catch(() => "")) || "").trim();
    if (t) return t;
  }
  const anchor = cfg.jd_anchor_text || "About the job";
  return (
    await withTimeout(target
      .evaluate((a) => {
        const els = [...document.querySelectorAll("section,div,article,main")];
        // Tightest container that starts with the anchor AND holds real content (>=200 chars) —
        // skips the bare "About the job" heading and avoids grabbing the whole page wrapper.
        const m = els
          .filter((e) => {
            const t = (e.innerText || "").trim();
            return t.startsWith(a) && t.length >= 200;
          })
          .sort((x, y) => x.innerText.length - y.innerText.length)[0];
        return m ? m.innerText.trim() : "";
      }, anchor), DEFAULT_CALL_TIMEOUT_MS, "jd anchor evaluate")
      .catch(() => "")
  );
}

// Token efficiency: cap stored JD length (JD_MAX_CHARS env or max_raw_text_chars in inventory,
// default 2500). The first ~2500 chars reliably carry title/seniority/skills/YoE/location; the
// rest is boilerplate (benefits, EEO, "about company") that just inflates the structuring step.
export function jdCap(cfg) {
  return parseInt(process.env.JD_MAX_CHARS || cfg.max_raw_text_chars || "2500", 10);
}

// jdTab is a single REUSED tab for the new-page model — we goto() into it per job rather than
// opening/closing a fresh tab each time. Rapid newPage/close churn was destabilizing the shared
// CDP browser; one long-lived tab is far more reliable.
export async function captureJd(jdTab, page, cfg, card, cap, { log = console } = {}) {
  if ((cfg.interaction_model || "inline").trim() === "new-page") {
    // A JD page is cheap to skip — only one retry, unlike the up-to-3-attempt default.
    await gotoWithRetry(jdTab, card.job_url || card.href, { retries: 1, log });
    await waitSettled(jdTab, cfg);
    let t = await extractJdText(jdTab, cfg);
    if (!t) {
      await jdTab.waitForTimeout(1800);
      t = await extractJdText(jdTab, cfg);
    }
    return t.slice(0, cap);
  }
  // inline: clicking the card renders the JD in a side panel on the same page
  await page.locator(cfg.job_card).nth(card.index).click({ timeout: DEFAULT_CALL_TIMEOUT_MS });
  await waitSettled(page, cfg);
  return (await extractJdText(page, cfg)).slice(0, cap);
}
