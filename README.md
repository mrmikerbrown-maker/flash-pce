# Flash PCE Nowcast

A mid-month nowcast of US PCE and core PCE inflation, following the Chicago Fed's
"Flash PCE" method (Chicago Fed Letter 529, September 2026). Live page: GitHub Pages from `docs/`.

- `model/Flash_PCE_Nowcast.gs` is the model. It is the same file as the Google Sheets version, so the
  sheet and the website always agree. Update it here and in the sheet together.
- `scripts/run.mjs` runs it in Node: checks FRED's release calendar (CPI, PPI, Personal Income and
  Outlays), and on release days pulls BEA and BLS data, runs the model and writes `docs/data.json`
  and `docs/record.json` (the live track record).
- `.github/workflows/update.yml` runs it three times on weekday afternoons (UK) and commits only
  if the estimate changed. Run it by hand from the Actions tab ("Run workflow") at any time.

Secrets (Settings > Secrets and variables > Actions): `BEA_API_KEY`, `BLS_API_KEY`, `FRED_API_KEY`.

Email after each update (optional): secrets `SENDER` (Gmail address), `RECIPIENT`, `APP_PASSWORD`
(Gmail app password), the same setup as the market alert emails.
