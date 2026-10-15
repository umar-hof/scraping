# Deployment

Copy `apps-script/` into a Google Apps Script project or use clasp if your team already manages Apps Script that way. Configure the bound spreadsheet, run `setupSystem()`, import a small approved CSV, run `runPilot()`, inspect the queue and Prospects output, then explicitly enable automation and install the hourly trigger.

Do not claim deployment until a scheduled execution has written a Run Logs row and the sheet has been inspected.

