# Arizona Packaging Lead Engine

Dependency-free Google Apps Script automation for researching Arizona physical-product brands and accumulating source-backed packaging prospects in Google Sheets.

The discovery connector is an approved user-provided CSV import. Company websites are manually reviewed; the engine does not automatically scrape sites. It does not scrape LinkedIn, Google Maps, undocumented search results, authenticated pages, or CAPTCHA-protected sites.

## Quick start

1. Create/open a Google Sheet and open Extensions → Apps Script.
2. Copy the files under `apps-script/` into the project.
3. Run `setupSystem()` and authorize the requested spreadsheet/external-request permissions.
4. Prepare a CSV with `Company Name,Website,City`; pilot CSVs should also include `Address,Industry,Source URL,Brand Evidence,Arizona Evidence URL,Product Evidence URL,Physical Products Evidence,Evidence Reviewed,Source ID,Packaging Opportunity,Notes`.
5. Run `importCandidatesCsv(csvText, 'your approved source label')` from a small wrapper or Apps Script editor. Keep the source permission documented in `Source Registry`.
6. `previewCandidatesCsv(csvText, 'MANUAL_OFFICIAL_WEB_REVIEW')` validates the CSV entirely in memory, checks existing Prospects for duplicates, and does not write to any sheet. `runPilot()` is also a no-write dry run by default, but only evaluates candidates already in Review Queue.
7. Do not call `runPilot({dryRun:false, confirmWrite:true})` until the user explicitly approves live writes. Hourly triggers remain a separate, unapproved operation.

No outreach is sent. Missing POC details stay blank. The pipeline only stores contact fields with a public source URL and labels them `SOURCE_LISTED`; syntax checks do not prove that a mailbox or number is active. It never claims `PROVIDER_VERIFIED` without a genuine verification result.

## Local tests

```text
npm test
npm run pilot:preview
```

The local preview reads only the candidate CSV and local Apps Script source; it cannot check live Prospects for duplicates. After code is deliberately pushed, `previewCandidatesCsv(csvText, 'MANUAL_OFFICIAL_WEB_REVIEW')` performs the corresponding read-only preview against the existing sheet without importing or writing candidate rows.

