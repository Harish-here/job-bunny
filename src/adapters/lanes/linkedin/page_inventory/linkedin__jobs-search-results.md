# Page Inventory — linkedin / linkedin__jobs-search-results

Filled from live DOM analysis on 2026-06-30 (Chrome 149, logged-in session) against
`https://www.linkedin.com/jobs/search-results/`. This route uses hashed/obfuscated CSS
class names (unstable); card identity comes from the stable `componentkey` attribute.
Selectors verified still valid. `must_exist` changed from job-card selector to
`[componentkey="JobsSearchFilters"]` so 0-result pages don't false-fail the assertion.

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

## 2. Selectors (from live page analysis 2026-06-24)
### Search page
- job_card: div[componentkey^="job-card-component-ref-"]
- job_card_title: p
- job_card_company: p:nth(1)
- job_card_location: p:nth(2)
- job_card_href:
- job_card_id_attr: componentkey
- job_card_id_attr_prefix: job-card-component-ref-
- scroll_container:
- end_of_results_signal:

### JD panel / page (same /jobs/view/<id>/ surface as linkedin__jobs-search)
- jd_container: .jobs-search__job-details--container
- jd_title: .job-details-jobs-unified-top-card__job-title
- jd_company: .job-details-jobs-unified-top-card__company-name
- jd_body: #job-details
- jd_metadata: .job-details-jobs-unified-top-card__primary-description-container

## 3. Assertions
- must_exist: [[componentkey="JobsSearchFilters"]]
- min_job_cards: 0
