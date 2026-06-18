# Page Inventory — linkedin / linkedin__jobs-search

Filled from live DOM analysis on 2026-06-18 (Chrome 149, logged-in session) against
`https://www.linkedin.com/jobs/search/`. extract.js reads this at runtime (config-driven).

## 1. Behavior (manual)
- interaction_model: inline
- job_list_trigger: clicking a card loads the JD into the right-hand #job-details panel (same page)
- pagination_type: infinite-scroll
- jd_settled_signal: network-idle
- url_pattern_of_job: https://www.linkedin.com/jobs/view/<id>/

## 2. Selectors (from live page analysis)
### Search page
- job_list_container: .scaffold-layout__list
- job_card: li[data-occludable-job-id]
- job_card_title: .artdeco-entity-lockup__title
- job_card_company: .artdeco-entity-lockup__subtitle
- job_card_location: .artdeco-entity-lockup__caption
- job_card_href: a.job-card-container__link
- job_card_id_attr: data-occludable-job-id
- scroll_container: .scaffold-layout__list
- end_of_results_signal:

### JD panel / page
- jd_container: .jobs-search__job-details--container
- jd_title: .job-details-jobs-unified-top-card__job-title
- jd_company: .job-details-jobs-unified-top-card__company-name
- jd_body: #job-details
- jd_metadata: .job-details-jobs-unified-top-card__primary-description-container

## 3. Assertions (derived from selectors above)
- must_exist: [".scaffold-layout__list"]
- min_job_cards: 1
