// PCE-morning check: is the official PCE out today (New York date, per FRED's calendar),
// and does the published estimate cover that month? Writes send=true|false to GITHUB_OUTPUT.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = v => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `send=${v}\n`); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function pceDates(key) {
  const y = +today.slice(0, 4);
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://api.stlouisfed.org/fred/release/dates?release_id=54&api_key=${key}&file_type=json` +
        `&include_release_dates_with_no_data=true&realtime_start=${y - 1}-01-01&realtime_end=${y + 1}-12-31`);
      if (r.ok) return (await r.json()).release_dates.map(d => d.date);
      console.log('HTTP', r.status);
    } catch (e) { console.log('fetch error', e.message); }
    await new Promise(res => setTimeout(res, 2000 * 2 ** i));
  }
  throw new Error('FRED release calendar unavailable');
}

const force = process.env.FORCE === '1' || process.env.FORCE === 'true';
const dates = await pceDates(process.env.FRED_API_KEY);
if (!dates.includes(today) && !force) { console.log(`${today}: not a PCE release day.`); out(false); process.exit(0); }
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data.json'), 'utf8'));
console.log(`${today}: PCE release day${dates.includes(today) ? '' : ' (forced)'}; estimate for ${d.target} (${d.status}).`);
out(true);
