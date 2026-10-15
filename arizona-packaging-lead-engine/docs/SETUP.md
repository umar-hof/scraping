# Setup

The primary tab is `Prospects`; its first eight columns are fixed exactly as required. `setupSystem()` creates all supporting tabs and default settings. Use a bound Apps Script project so `SpreadsheetApp.getActive()` resolves to the target sheet.

CSV minimum columns: `Company Name`, `Website`, `City`. The import stores the candidate in `Review Queue`, preventing duplicate candidate IDs by normalized website/name identity.

