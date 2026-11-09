// Flash PCE website runner.
// Runs the SAME model code as the Google Sheet (model/Flash_PCE_Nowcast.gs) and writes docs/data.json.
// On days with no CPI, PPI or PCE release (per FRED's release calendar) it exits straight away.
//
// Env: BEA_API_KEY, BLS_API_KEY, FRED_API_KEY. FORCE=1 runs regardless of the calendar.
// Optional offline test: LOCAL_BEA_PRICE, LOCAL_BEA_NOM (BEA JSON files), LOCAL_BLS (JSON {id:{ym:v}}).
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const RELEASES = { 10: 'CPI', 46: 'PPI', 54: 'PCE' };   // FRED release ids

// ---- load the sheet's model code (pure functions only are used) ----
const ctx = { console, Math, JSON, Date, Object, String, Array, isNaN, parseFloat, Infinity, NaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'model', 'Flash_PCE_Nowcast.gs'), 'utf8'), ctx);
const M = ctx;

function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d); // YYYY-MM-DD
}

async function getJson(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return await r.json();
      console.log(`HTTP ${r.status} ${url.split('?')[0]}`);
    } catch (e) { console.log('fetch error', e.message); }
    await new Promise(res => setTimeout(res, 2000 * 2 ** i));
  }
  throw new Error('failed: ' + url.split('?')[0]);
}

async function releaseCalendar(key) {
  const today = nyDate();
  const y = +today.slice(0, 4);
  const out = {};
  for (const id of Object.keys(RELEASES)) {
    const js = await getJson(`https://api.stlouisfed.org/fred/release/dates?release_id=${id}&api_key=${key}` +
      `&file_type=json&include_release_dates_with_no_data=true&realtime_start=${y - 1}-01-01&realtime_end=${y + 1}-12-31&sort_order=asc`);
    out[RELEASES[id]] = js.release_dates.map(d => d.date);
  }
  return out;
}

async function fetchBea(table, y0, y1, key) {
  const years = []; for (let y = y0; y <= y1; y++) years.push(y);
  const js = await getJson(`https://apps.bea.gov/api/data?UserID=${key}&method=GetData&DataSetName=NIUnderlyingDetail` +
    `&TableName=${table}&Frequency=M&Year=${years.join(',')}&ResultFormat=JSON`);
  return M.parseBea_(js);
}

async function fetchBls(ids, y0, y1, key) {
  const data = {}, failed = [];
  for (let i = 0; i < ids.length; i += 50) {
    const body = { seriesid: ids.slice(i, i + 50), startyear: String(y0), endyear: String(y1), registrationkey: key };
    try {
      const js = await getJson('https://api.bls.gov/publicAPI/v2/timeseries/data/',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (js.status !== 'REQUEST_SUCCEEDED') failed.push((js.message || []).join(' '));
      M.parseBls_(js, data);
    } catch (e) { failed.push(e.message); }
  }
  return { data, failed };
}

const r = (v, d) => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 10 ** d) / 10 ** d : null;

function buildPayload(res, cal, failed) {
  const now = res.now, t = res.target;
  const yoy = (idx, mom) => {
    const p = idx[M.ymAdd_(t, -1)], b = idx[M.ymAdd_(t, -12)];
    return (p == null || b == null) ? null : r((p * (1 + mom / 100) / b - 1) * 100, 2);
  };
  const ann = mom => r(((1 + mom / 100) ** 12 - 1) * 100, 2);
  // y/y: implied by an estimated m/m (est != null) on top of last month's published level, or actual
  const yy = (idx, m, est) => {
    const p = idx[M.ymAdd_(m, -1)], c = idx[m], base = idx[M.ymAdd_(m, -12)];
    if (base == null) return null;
    if (est == null) return c == null ? null : r((c / base - 1) * 100, 2);
    return p == null ? null : r((p * (1 + est / 100) / base - 1) * 100, 2);
  };
  const st = M.btStats_(res.bt);
  const cov = {}, groups = {};
  now.est.forEach(e => {
    if (isFinite(e.share)) cov[e.how] = (cov[e.how] || 0) + e.share;
    if (isFinite(e.ch)) groups[e.lf[5]] = (groups[e.lf[5]] || 0) + e.ch;
  });
  const status = res.cpiOut && res.ppiOut ? 'final' : (res.cpiOut || res.ppiOut) ? 'provisional' : 'waiting';
  const lines = now.est.filter(e => isFinite(e.ch)).map(e => ({
    line: e.lf[0], name: e.lf[2], group: e.lf[5], core: !!e.lf[4], weight: r(e.share, 3), mom: r(e.mom, 3),
    headBp: r(e.ch, 2), coreBp: isFinite(e.cc) ? r(e.cc, 2) : null, how: e.how, method: e.method || ''
  }));
  const today = nyDate();
  const next = k => (cal[k] || []).find(d => d > today) || null;
  return {
    target: t, lastPublished: res.lastPub, status,
    cpiIn: !!res.cpiOut, ppiIn: !!res.ppiOut,
    headline: { mom: r(now.head, 3), ann: ann(now.head), yoy: yoy(res.pceIdx, now.head) },
    core: { mom: r(now.core, 3), ann: ann(now.core), yoy: yoy(res.coreIdx, now.core) },
    coverage: Object.fromEntries(Object.entries(cov).map(([k, v]) => [k, r(v, 1)])),
    groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, r(v, 1)])),
    lines,
    backtest: {
      stats: { headMae: r(st.hMae, 2), headRmse: r(st.hRmse, 2), coreMae: r(st.cMae, 2), coreRmse: r(st.cRmse, 2),
               headBias: r(st.hBias, 2), coreBias: r(st.cBias, 2) },
      months: res.bt.map(b => ({ m: b.t, head: r(b.head, 3), aHead: r(b.aHead, 3), core: r(b.core, 3), aCore: r(b.aCore, 3),
                                 yHead: yy(res.pceIdx, b.t, b.head), ayHead: yy(res.pceIdx, b.t, null),
                                 yCore: yy(res.coreIdx, b.t, b.core), ayCore: yy(res.coreIdx, b.t, null),
                                 excluded: M.SKIP.indexOf(b.t) >= 0 }))
    },
    nextReleases: { CPI: next('CPI'), PPI: next('PPI'), PCE: next('PCE') },
    warnings: [...res.warnings, ...failed]
  };
}

/** Live track record: the estimate standing just before each PCE release, then the actual. */
function updateRecord(record, payload, res) {
  const rec = record[payload.target] || (record[payload.target] = {});
  rec.head = payload.headline.mom; rec.core = payload.core.mom; rec.status = payload.status;
  rec.asOf = new Date().toISOString();
  for (const m of Object.keys(record)) {
    if (record[m].aHead == null && res.pceIdx[m] != null) {
      record[m].aHead = r((res.pceIdx[m] / res.pceIdx[M.ymAdd_(m, -1)] - 1) * 100, 3);
      record[m].aCore = r((res.coreIdx[m] / res.coreIdx[M.ymAdd_(m, -1)] - 1) * 100, 3);
    }
  }
  return record;
}

async function main() {
  const env = process.env, force = env.FORCE === '1' || env.FORCE === 'true';
  const local = env.LOCAL_BLS;
  let cal = {};
  if (!local) {
    cal = await releaseCalendar(env.FRED_API_KEY);
    const today = nyDate();
    const hits = Object.entries(cal).filter(([, ds]) => ds.includes(today)).map(([k]) => k);
    if (!hits.length && !force) { console.log(`${today}: no CPI/PPI/PCE release today, nothing to do.`); return; }
    console.log(`${today}: release day (${hits.join(', ') || 'forced'})`);
    // Email on CPI/PPI days (and manual runs), not on PCE-only days.
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `email=${hits.some(h => h !== 'PCE') || force}\n`);
  }
  const y1 = new Date().getFullYear(), y0 = y1 - M.BACK_YEARS;
  let price, nom, bls;
  if (local) {
    const cut = js => { js.BEAAPI.Results.Data = js.BEAAPI.Results.Data.filter(x => +x.TimePeriod.slice(0, 4) >= y0); return js; };
    price = M.parseBea_(cut(JSON.parse(fs.readFileSync(env.LOCAL_BEA_PRICE))));
    nom = M.parseBea_(cut(JSON.parse(fs.readFileSync(env.LOCAL_BEA_NOM))));
    bls = { data: JSON.parse(fs.readFileSync(local)), failed: [] };
  } else {
    price = await fetchBea('U20404', y0, y1, env.BEA_API_KEY);
    nom = await fetchBea('U20405', y0, y1, env.BEA_API_KEY);
    bls = await fetchBls(M.blsIds_(), y0, y1, env.BLS_API_KEY);
  }
  const res = M.runModel_(price, nom, bls.data);
  const payload = buildPayload(res, cal, bls.failed);

  const dataPath = path.join(DOCS, 'data.json'), recPath = path.join(DOCS, 'record.json');
  const old = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : null;
  const strip = o => { if (!o) return null; const c = { ...o }; delete c.updated; delete c.nextReleases; return JSON.stringify(c); };
  if (old && strip(old) === strip(payload) && !force) { console.log('No change in the estimate; leaving the page as it is.'); return; }
  payload.updated = new Date().toISOString();
  const record = fs.existsSync(recPath) ? JSON.parse(fs.readFileSync(recPath, 'utf8')) : {};
  fs.writeFileSync(recPath, JSON.stringify(updateRecord(record, payload, res), null, 1));
  fs.writeFileSync(dataPath, JSON.stringify(payload, null, 1));
  console.log(`Updated: ${payload.target} headline ${payload.headline.mom} core ${payload.core.mom} (${payload.status})`);
}

main().catch(e => { console.error(e); process.exit(1); });
