# Sources and permissions

## Pilot provenance

The `pilot-data/arizona-physical-product-candidates.csv` seed contains only businesses whose official pages were manually checked for Arizona evidence and physical products. It is labeled `MANUAL_OFFICIAL_WEB_REVIEW`; it must not be represented as an Overpass-derived export.

The planned one-time Overpass request was a bounded Arizona query for named cosmetics, coffee, tea, chocolate, health-food, candle, and selected artisan-product features, capped at 40 results. The current Overpass guidance permits occasional manual queries but warns against public Overpass instances as an application backend. The API response could not be retrieved in this environment, so no OSM rows were used. If this query is performed later, retain OSM attribution and comply with ODbL; do not turn it into recurring discovery.

## Connectors

- `CSV_USER_IMPORT`: a user-provided file whose provenance and use permission are recorded by the user.
- `MANUAL_OFFICIAL_WEB_REVIEW`: candidate-by-candidate review of public official company pages. This is not permission to bulk scrape or to fetch pages automatically. Check applicable terms and site rules before any automation.
- `OSM_OVERPASS_PILOT`: reserved for a one-time query only; disabled because the query was not completed in this environment.

`previewCandidatesCsv(csvText, sourceLabel)` is an in-memory qualification and read-only duplicate check. `importCandidatesCsv()` is the separate operation that writes candidate rows into Review Queue.

Do not scrape Google Maps or LinkedIn, use paid APIs/proxies, bypass CAPTCHAs, or access authenticated pages. The pipeline intentionally requires official Arizona-location and physical-product evidence URLs before a candidate qualifies. Contact data is left blank unless publicly listed with a source URL; format checks do not establish active mailboxes or working telephone numbers, and no contact is labeled provider-verified without a genuine provider result.
