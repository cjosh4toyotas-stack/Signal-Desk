// ── classify13D:begin ─────────────────────────────────────────
// SHARED between index.html and alpaca-proxy-worker.js — the unit test
// asserts the two copies are byte-identical. Edit both or neither.
//
// "A 13D was filed" is not a signal. What matters is HOW the filer came
// to own the shares and WHAT they say they'll do. Kinds, in the priority
// order they're assigned:
//   financing     — SPA / convertible / warrant / PIPE, 9.99% blocker: the
//                   company sold paper to the filer. Dilution, never a buy.
//   issuance      — shares the issuer printed to settle an obligation:
//                   accrued preferred dividends paid in stock, PIK, debt
//                   or fees settled in shares (Rainmaker Worldwide, Sep
//                   2026: 9.2M shares "in satisfaction of accrued
//                   dividends" on the insider's own preferred). Nobody
//                   bought anything.
//   consideration — shares were payment for a business/asset the filer
//                   sold to the issuer (earn-outs, tranches).
//   deal          — voting/support/merger agreement: an acquirer's 13D.
//   activist      — stated intent (nominations, proxy, strategic review,
//                   sale of the company) in sentences that aren't denials.
//   accumulation  — real open-market buying, by a non-insider, in a size
//                   that isn't token ($250K+ where the text lets us add
//                   it up). "20,000 shares at $0.01" is not accumulation.
//   affiliate     — director/officer/founder, or a filer whose business
//                   address on the SEC header IS the issuer's address.
//   plain         — nothing distinctive.
const NEGATED_SENTENCE = /\b(?:no (?:present |current )?(?:plans?|proposals?|intention|right)|does not (?:have|intend|currently)|do not (?:have|intend)|has no (?:right|plan|intention)|have no (?:right|plan|intention)|not (?:currently )?(?:have|intend|entitled)|except as (?:set forth|described))\b/i;
function stripNegated(t) {
  return t.split(/(?<=[.;:])\s+|\n+/).filter(sen => !NEGATED_SENTENCE.test(sen)).join(' ');
}
const OPEN_MARKET_TOKEN_USD = 250000; // below this, "open market purchases" is a footnote, not a signal

// Two ways a filer turns out to live at the issuer's address:
//   1. the SEC header of the full submission carries a BUSINESS ADDRESS
//      block for the SUBJECT COMPANY and for each FILED BY entity — same
//      street + zip on both sides;
//   2. the body: Item 1 states the issuer's principal executive office,
//      and the same street shows up again under Item 2 as a reporting
//      person's address (Rainmaker: "2510 East Sunset Road" for the
//      issuer AND for both of the insider's holding companies).
function sched13SameAddress(text) {
  const t = String(text || '');
  const head = t.slice(0, 20000);
  const blocks = head.split(/\n(?=\s*(?:SUBJECT COMPANY|FILED BY):)/);
  const addr = b => {
    const m = b.match(/(?:BUSINESS|MAIL) ADDRESS:[\s\S]{0,400}?STREET 1:\s*([^\n]+)[\s\S]{0,300}?ZIP:\s*([0-9A-Za-z -]+)/);
    return m ? (m[1] + ' ' + m[2]).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  };
  let subject = null; const filers = [];
  for (const b of blocks) {
    if (/^\s*SUBJECT COMPANY:/.test(b)) subject = addr(b);
    else if (/^\s*FILED BY:/.test(b)) { const a = addr(b); if (a) filers.push(a); }
  }
  if (subject && filers.some(f => f === subject)) return true;
  const body = t.replace(/<SEC-HEADER>[\s\S]*?<\/SEC-HEADER>/, '');
  const office = body.match(/principal (?:executive )?offices?[^.]{0,80}?\b(\d{2,6}\s+(?:[A-Z][A-Za-z.]*\s+){1,4}(?:Road|Rd|Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Way|Lane|Ln|Parkway|Pkwy|Plaza|Place|Court|Highway|Hwy)\b)/);
  if (!office) return false;
  const street = office[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hits = body.toUpperCase().replace(/[^A-Z0-9]/g, '').split(street).length - 1;
  return hits >= 2; // once in Item 1 (the issuer), again under Item 2 (the filer)
}

// Add up the dollars behind purchase sentences ("1,250,000 shares ... at
// $14.20"). Conversion/exercise/warrant sentences are skipped so a
// financing's terms never read as a buy. Null when nothing is countable.
function sched13PurchaseDollars(text) {
  const sentences = String(text || '').split(/(?<=[.;])\s+|\n+/);
  let total = 0, n = 0;
  for (const sen of sentences) {
    if (!/purchas|acquired|bought|open[- ]market/i.test(sen)) continue;
    if (/conver|exercis|warrant|dividend|in satisfaction|consideration for/i.test(sen)) continue;
    for (const m of sen.matchAll(/([\d,]{2,})\s+(?:shares|Shares|common shares)[^$]{0,160}?\$\s?([\d,]*\.?\d+)/g)) {
      const sh = parseFloat(m[1].replace(/,/g, '')), px = parseFloat(m[2].replace(/,/g, ''));
      if (sh > 0 && px > 0 && px < 100000) { total += sh * px; n++; }
    }
  }
  return n ? total : null;
}

function classify13D(text) {
  const t = String(text || '');
  const count = re => (t.match(re) || []).length;
  const flags = [];
  const financingHits =
    count(/securities purchase agreement/gi) + count(/subscription agreement/gi) + count(/private placement/gi) +
    count(/\bPIPE\b/g) + count(/convertible (?:note|notes|debenture|debentures|preferred)/gi) + count(/\bdebentures?\b/gi) +
    count(/purchase warrants?\b/gi) + count(/registration rights agreement/gi) + count(/additional investment right/gi) +
    count(/conversion price/gi) + count(/stated value/gi) + count(/exercise price/gi);
  const blocker = /beneficial ownership (?:limitation|restriction|cap|blocker)/i.test(t) || /\b[49]\.99\s*%/.test(t) || /ownership (?:limitation|restriction) of [49]\.99/i.test(t);
  if (blocker) flags.push('9.99%-style ownership blocker');
  if (/securities purchase agreement|subscription agreement|private placement/i.test(t)) flags.push('shares issued by the company (SPA / private placement)');
  if (/convertible|debenture/i.test(t)) flags.push('convertible security');
  if (/\bwarrants?\b/i.test(t) && financingHits >= 2) flags.push('warrants');
  if (/additional investment right/i.test(t)) flags.push('further-investment right');
  // Issuance: the issuer printed shares to settle something it owed.
  const issuanceHits =
    count(/in (?:full |partial )?satisfaction of (?:the )?(?:accrued|accumulated|unpaid|outstanding)? ?(?:dividends?|interest|indebtedness|debt|amounts? (?:owed|due)|obligations?|fees)/gi) +
    count(/(?:accrued|accumulated|unpaid) (?:and unpaid )?dividends? (?:payable|paid|settled|satisfied)/gi) +
    count(/dividends? (?:paid|payable|settled) in (?:shares|common stock|kind)/gi) +
    count(/in lieu of (?:a )?cash/gi) + count(/paid[- ]in[- ]kind|\bPIK\b/g) +
    count(/(?:for|in exchange for) services (?:rendered|provided|performed)/gi) +
    count(/(?:settlement|conversion|cancellation) of (?:accrued |outstanding )?(?:interest|indebtedness|debt|notes? payable|amounts? owed)/gi);
  if (issuanceHits) flags.push('shares issued to settle an obligation (dividend / PIK / debt / fees)');
  const dealHits = count(/voting agreement/gi) + count(/support agreement/gi) + count(/agreement and plan of merger/gi) + count(/merger agreement/gi) + count(/tender offer/gi);
  // Consideration shares: the filer SOLD something and got paid in stock.
  const considerationHits =
    count(/no funds were used/gi) + count(/as (?:non-cash )?consideration for/gi) + count(/consideration shares/gi) +
    count(/(?:stock|asset|share) purchase agreement/gi) + count(/in exchange for (?:all|the) (?:issued and )?outstanding/gi) +
    count(/merger consideration/gi) + count(/earn-?out/gi) + count(/deferred purchase consideration/gi) + count(/tranches?/gi);
  const soldToIssuer = /(?:issuer|company) (?:purchased|acquired) from (?:the reporting person|[A-Z]{2,5}|the filer)/i.test(t) ||
    /(?:sale|transfer) of [\s\S]{0,80}? to the issuer/i.test(t) || /no funds were used/i.test(t);
  if (soldToIssuer || considerationHits >= 3) flags.push('shares were consideration for an asset/company sold to the issuer');
  // Intent is counted only in sentences that are NOT denying it.
  const pos = stripNegated(t);
  const pcount = re => (pos.match(re) || []).length;
  const intentHits = pcount(/nominat(?:e|ion|ing|ed)/gi) + pcount(/proxy (?:contest|solicitation|fight|statement)/gi) +
    pcount(/strategic (?:alternatives|review)/gi) + pcount(/sale of the (?:issuer|company)/gi) + pcount(/board (?:composition|representation|refresh|seats?)/gi) +
    pcount(/letter to the (?:board|issuer|company)/gi) + pcount(/maximiz(?:e|ing) (?:shareholder|stockholder) value/gi) + pcount(/undervalued/gi) +
    pcount(/unsolicited/gi) + pcount(/proposal to acquire/gi) + pcount(/going.private/gi) + pcount(/special meeting/gi) +
    pcount(/intends? to (?:engage|seek|pursue|nominate|solicit)/gi);
  const openMarketHits = count(/open[- ]market/gi);
  // Affiliate: a director/officer of the issuer is the filer OR owns a
  // piece of the filer OR the filer's SEC-header address is the issuer's.
  const sameAddress = sched13SameAddress(t);
  if (sameAddress) flags.push("filer's business address is the issuer's address");
  const affiliate = sameAddress ||
    /(?:director|officer|chairman|chief executive officer|founder|president) of the (?:issuer|company)/i.test(t) ||
    /serves? as (?:a |the )?(?:director|chairman|chief [a-z]+ officer|chief executive)/i.test(t) || /employment agreement/i.test(t) ||
    /member of the (?:issuer|company)'s board/i.test(t) || /(?:issuer|company)'s (?:chief [a-z]+ officer|board of directors)/i.test(t) ||
    /(?:ownership|membership|equity) interest in (?:the reporting person|the filer|[A-Z]{2,5}\b)/i.test(t);
  if (affiliate && !sameAddress) flags.push('filer is, or is part-owned by, a director/officer of the issuer');
  // Distress tells in the filing text itself.
  const reverseSplit = /reverse (?:stock )?split/i.test(t);
  if (reverseSplit) flags.push('recent reverse split — cover-page share count may be pre-split');
  if (/delist(?:ing|ed)?/i.test(t)) flags.push('delisting language');
  const subDollar = /\$\s?0?\.\d{2,}\s*(?:per share|a share|\/share)/i.test(t);
  if (subDollar) flags.push('sub-dollar share price quoted in the filing');
  // Open-market buying only counts when it's real money.
  const purchaseUsd = sched13PurchaseDollars(t);
  const tokenBuying = openMarketHits > 0 && purchaseUsd != null && purchaseUsd < OPEN_MARKET_TOKEN_USD;
  if (dealHits) flags.push('voting/merger agreement');
  if (intentHits >= 2) flags.push('stated activist intent');
  if (openMarketHits && !tokenBuying) flags.push('open-market purchases');
  if (tokenBuying) flags.push(`open-market buying is token (~$${Math.round(purchaseUsd).toLocaleString('en-US')})`);
  const strongFinancing = /securities purchase agreement|subscription agreement|private placement/i.test(t) && /convertible|debenture|warrant|preferred/i.test(t);
  let kind = 'plain';
  if (strongFinancing || financingHits >= 4 || (blocker && financingHits >= 1)) kind = 'financing';
  else if (issuanceHits >= 1 && intentHits < 2) kind = 'issuance';
  else if (soldToIssuer || considerationHits >= 3) kind = 'consideration';
  else if (dealHits >= 2) kind = 'deal';
  else if (intentHits >= 2) kind = 'activist';
  else if (openMarketHits >= 1 && !affiliate && !tokenBuying) kind = 'accumulation';
  else if (affiliate || blocker) kind = 'affiliate';
  return { kind, flags, blocker, affiliate, sameAddress, reverseSplit, subDollar, purchaseUsd, openMarket: openMarketHits > 0 && !tokenBuying, intent: intentHits >= 2 };
}
// A kind that can never be a buy signal, whatever the name on the filing.
const SCHED13_DEAD_KINDS = new Set(['financing', 'issuance', 'consideration', 'affiliate']);
// ── classify13D:end ───────────────────────────────────────────
