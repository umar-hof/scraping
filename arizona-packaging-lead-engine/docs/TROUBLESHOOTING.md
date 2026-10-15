# Troubleshooting

- `DISABLED`: set `Automation Enabled` to TRUE only after pilot review.
- `NO_CANDIDATES`: import a CSV with the required headers.
- `LOCKED`: another hourly execution is active; the next trigger will retry.
- `NEEDS_REVIEW`: inspect the candidate source, Arizona evidence, and product evidence in `Review Queue`.
- HTTP failures: confirm the official site permits automated access and reduce the configured rate before retrying.

