// Headless smoke test for the rebuilt Signal Desk index.html.
// Serves the repo, stubs every network dependency with fixtures, and
// asserts the new machinery actually fires: insider cluster detection,
// 13G→13D escalation from memory, stake deltas, campaign timelines, and
// the always-visible confluence board.
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { extname } from 'path';

const PORT = 8787;
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  try {
    const path = '.' + (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]);
    res.setHeader('Content-Type', MIME[extname(path)] || 'text/plain');
    res.end(readFileSync(path));
  } catch { res.statusCode = 404; res.end('nope'); }
});
server.listen(PORT);

const now = new Date();
const iso = d => d.toISOString();
const entry = (form, subject, filer, acc, cik = '1234567') => `
  <entry><title>${form} - ${subject} (0001234567) (Subject)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/x.html"/>
    <updated>${iso(now)}</updated></entry>
  <entry><title>${form} - ${filer} (0007654321) (Filed by)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/x.html"/>
    <updated>${iso(now)}</updated></entry>`;
const atom = inner => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${inner}</feed>`;

const ACC_13D = '000123456726000001';
const ACC_PREC = '000123456726000002';
const ACC_F4A = '000123456726000011';
const ACC_F4B = '000123456726000012';

const form4Xml = (owner, title, shares, price) => `<ownershipDocument>
  <issuer><issuerName>Acme Corp</issuerName><issuerTradingSymbol>ACME</issuerTradingSymbol></issuer>
  <reportingOwner><reportingOwnerId><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>${title}</officerTitle></reportingOwnerRelationship></reportingOwner>
  <nonDerivativeTable><nonDerivativeTransaction>
    <transactionDate><value>${iso(now).slice(0, 10)}</value></transactionDate>
    <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
    <transactionAmounts><transactionShares><value>${shares}</value></transactionShares>
      <transactionPricePerShare><value>${price}</value></transactionPricePerShare></transactionAmounts>
    <postTransactionAmounts><sharesOwnedFollowingTransaction><value>99999</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
  </nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;

const insiderAtom = atom(`
  <entry><title>4 - Acme Corp (0001234567) (Issuer)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/1234567/${ACC_F4A}/x.html"/><updated>${iso(now)}</updated></entry>
  <entry><title>4 - Acme Corp (0001234567) (Issuer)</title>
    <link href="https://www.sec.gov/Archives/edgar/data/1234567/${ACC_F4B}/x.html"/><updated>${iso(new Date(now - 3600e3))}</updated></entry>`);

const bars = (n, from, to) => Array.from({ length: n }, (_, i) => {
  const c = from + (to - from) * (i / (n - 1));
  return { t: iso(new Date(now - (n - i) * 86400e3)), o: c, h: c * 1.02, l: c * 0.98, c, v: 1e6 };
});

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const failures = [];
page.on('pageerror', e => failures.push('PAGE ERROR: ' + e.message));

// Pre-seed local memory: this filer previously held ACME passively (13G,
// 4.9%) — today's 13D must therefore flag 13G→13D escalation and a delta.
await page.addInitScript(() => {
  localStorage.setItem('sd_sched13_hist_v1', JSON.stringify({
    'acme||starboard value': { family: 'G', pct: 4.9, seen: new Date(Date.now() - 5 * 86400e3).toISOString() }
  }));
  localStorage.setItem('signalDeskWatchlist', JSON.stringify(['ACME']));
});

await page.route('**/*', route => {
  const url = route.request().url();
  const q = decodeURIComponent(url);
  if (url.startsWith(`http://localhost:${PORT}`)) return route.continue();
  // Worker routes
  if (url.includes('/insider-feed')) {
    return q.includes('start=0')
      ? route.fulfill({ contentType: 'application/atom+xml', body: insiderAtom })
      : route.fulfill({ contentType: 'application/atom+xml', body: atom('') });
  }
  if (url.includes('/form4-batch')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [
      { id: `1234567-${ACC_F4A}`, xml: form4Xml('DOE JANE', 'Chief Financial Officer', 20000, 20) },
      { id: `1234567-${ACC_F4B}`, xml: form4Xml('SMITH JOHN', 'Chief Executive Officer', 15000, 20) },
    ] }) });
  }
  if (url.includes('/bars')) {
    const sym = new URL(url).searchParams.get('symbol');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ symbol: sym, bars: sym === 'SPY' ? bars(250, 500, 550) : bars(250, 40, 20) }) });
  }
  if (url.includes('/fundamentals')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ peTTM: 10.2, grossMarginTTM: 46, netProfitMarginTTM: 4.1, marketCapM: 2100, week52High: 41, week52Low: 19 }) });
  }
  // SEC feeds (direct or via sec-proxy)
  if (q.includes('type=SCHEDULE 13D') && q.includes('getcurrent')) {
    return route.fulfill({ contentType: 'application/atom+xml', body: atom(entry('SCHEDULE 13D', 'ACME CORP', 'Starboard Value LP', ACC_13D)) });
  }
  if (q.includes('type=SCHEDULE 13G') && q.includes('getcurrent')) {
    return route.fulfill({ contentType: 'application/atom+xml', body: atom('') });
  }
  if (q.includes('type=PREC14A') && q.includes('getcurrent')) {
    return route.fulfill({ contentType: 'application/atom+xml', body: atom(entry('PREC14A', 'ACME CORP', 'Starboard Value LP', ACC_PREC)) });
  }
  if (q.includes('getcurrent')) return route.fulfill({ contentType: 'application/atom+xml', body: atom('') });
  if (url.includes(`/Archives/edgar/data/1234567/${ACC_13D}/`)) {
    return route.fulfill({ contentType: 'text/plain', body: '<percentOfClass>8.2</percentOfClass>' });
  }
  if (url.includes('data.sec.gov/submissions')) return route.abort(); // skip 13F cards — separately exercised path
  if (url.includes('api.openfigi.com')) return route.fulfill({ contentType: 'application/json', body: '[]' });
  return route.abort();
});

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForTimeout(4500);

const check = async (name, fn) => {
  try {
    const ok = await fn();
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
    if (!ok) failures.push(name);
  } catch (e) { console.log('FAIL  ' + name + ' — ' + e.message); failures.push(name); }
};
const bodyText = await page.textContent('body');

await check('insider cluster detected (2 insiders → CLUSTER BUY)', async () => bodyText.includes('CLUSTER BUY'));
await check('cluster names both insiders in Top Signals', async () => /2 insiders — ACME/.test(bodyText));
await check('13G→13D escalation badge renders', async () => bodyText.includes('13G→13D'));
await check('activist roster match (Starboard) renders', async () => bodyText.includes('STARBOARD'));
await check('stake % parsed with delta vs prior filing', async () => bodyText.includes('8.2%') && bodyText.includes('+3.3pt'));
await check('campaign card built for ACME with proxy-fight stage', async () => {
  await page.click('[data-tab="campaigns"]');
  const t = await page.textContent('#campaigns-body');
  return t.includes('ACME CORP') && /PROXY FIGHT/i.test(t);
});
await check('activist track record shown on campaign card', async () => (await page.textContent('#campaigns-body')).includes('TRACK RECORD'));
await check('confluence board has cards (not placeholder)', async () => {
  const t = await page.textContent('#cc-grid');
  return !t.includes('Scanning all disclosure streams') && t.trim().length > 0;
});
await check('confluence board shows ACME with stacked streams', async () => {
  const t = await page.textContent('#cc-grid');
  return t.includes('ACME') && (t.includes('STREAMS') || t.includes('CLUSTER'));
});
await check('price context (bought off highs) attached', async () => (await page.textContent('body')).includes('off the 52-wk high'));
await check('target screener scores watchlist names', async () => {
  await page.click('[data-tab="screener"]');
  await page.waitForTimeout(2500);
  const t = await page.textContent('#screener-body');
  return t.includes('ACME') && t.includes('Activist-target profile');
});
await check('no Congress tab remains', async () => !(await page.textContent('.tabs')).includes('Congress'));
await check('no page JS errors', async () => !failures.some(f => f.startsWith('PAGE ERROR')));

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failure(s):\n- ` + failures.join('\n- ') : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
