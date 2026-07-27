# Page Inventory — linkedin / linkedin__jobs-search-results

Filled from live DOM analysis on 2026-06-30 (Chrome 149, logged-in session) against
`https://www.linkedin.com/jobs/search-results/`. This route uses hashed/obfuscated CSS
class names (unstable); card identity comes from the stable `componentkey` attribute.
`must_exist` changed from job-card selector to
`[componentkey="JobsSearchFilters"]` so 0-result pages don't false-fail the assertion.

Selectors re-verified live against LinkedIn on 2026-07-27: `job_card_company` and
`job_card_location` were `p:nth(1)`/`p:nth(2)` — `:nth()` is not valid CSS and crashed
`farm`'s `page.evaluate` with a `SyntaxError`. Replaced with `:has()`-based sibling
selectors, tested against all 50 job cards on a live search-results page with 100%
match rate against ground truth.

## 1. Behavior (manual)
- interaction_model: new-page
- job_list_trigger: job ID extracted from componentkey attr; URL built via url_pattern_of_job
- pagination_type: url-pages
- pagination_param: start
- pagination_page_size: 25
- max_pages: 4
- jd_settled_signal: selector-visible
- url_pattern_of_job: https://www.linkedin.com/jobs/view/<id>/
- jd_anchor_text: About the job
- max_raw_text_chars: 2500

## 2. Selectors (from live page analysis 2026-07-27)
### Search page
- job_card: div[componentkey^="job-card-component-ref-"]
- job_card_title: p
- job_card_company: div:has(> p) + div > p
- job_card_location: div:has(> p) + div + p
- job_card_href:
- job_card_id_attr: componentkey
- job_card_id_attr_prefix: job-card-component-ref-
- scroll_container:
- end_of_results_signal:

### JD panel / page (same /jobs/view/<id>/ surface as linkedin__jobs-search)
- jd_container: .jobs-search__job-details--container
- jd_title: .job-details-jobs-unified-top-card__job-title
- jd_company: .job-details-jobs-unified-top-card__company-name
- jd_body: [componentkey^="JobDetails_AboutTheJob"]
- jd_metadata: .job-details-jobs-unified-top-card__primary-description-container

2026-07-27: direct-nav `/jobs/view/` pages render under hashed CSS class
names — `#job-details` does not exist on that surface. The stable hook is
the `componentkey` attribute `JobDetails_AboutTheJob_<jobId>` (also mirrored
as the element's `id`); `jd_body` above was updated to match on that prefix.

## 3. Assertions
- must_exist: [[componentkey="JobsSearchFilters"]]
- min_job_cards: 0
