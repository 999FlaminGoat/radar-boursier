(() => {
const $ = s => document.querySelector(s);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const ANIM = REDUCED ? false : { duration: 650, easing: 'easeOutQuart' };
if (!REDUCED) { document.documentElement.classList.add('anim'); setTimeout(() => document.documentElement.classList.remove('anim'), 3500); }
const state = { alerts: {}, splits: [], finRange: 'y', range: '1y', reg: '', raw: {}, stocks: {}, positions: null, posVersion: 0, investors: [], txs: [], divs: [], canWrite: null, form: false, meta: null, status: null, filter: 'all', sect: '', q: '', sortAll: { k: 'score', d: -1 }, sortHold: { k: 'value', d: -1 }, open: null };
let charts = {};
let dbFresh = false;

/* ---------- formatting ---------- */
const nf = (v, d = 2) => v == null || isNaN(v) ? '–' : v.toLocaleString('fr-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v, d = 0) => v == null ? '–' : nf(v, d) + ' $';
const pct = (v, d = 1, sign = true) => v == null || isNaN(v) ? '–' : (sign && v > 0 ? '+' : '') + nf(v * 100, d) + ' %';
const big = v => v == null ? '–' : v >= 1e12 ? nf(v / 1e12, 2) + ' T$' : v >= 1e9 ? nf(v / 1e9, 1) + ' G$' : nf(v / 1e6, 0) + ' M$';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmtDate = iso => { if (!iso) return '–'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

/* ---------- portfolio math ---------- */
function holdingsMap() {
  const out = {};
  for (const p of state.positions || []) {
    if (!(p.qty > 1e-9)) continue;
    const h = out[p.t] || (out[p.t] = { qty: 0, cost: 0, cur: p.cur, accounts: [] });
    h.qty += p.qty; h.cost += p.qty * p.avg;
    if (!h.accounts.includes(p.account)) h.accounts.push(p.account);
  }
  for (const h of Object.values(out)) { h.avg = h.cost / h.qty; }
  return out;
}
// derive what can be derived when a field is still missing, so fewer cells read "n.d."
function fillGaps(s) {
  const h = (s.hist || []).filter(p => p && p.p != null && p.d).sort((a, b) => a.d.localeCompare(b.d));
  if (h.length) {
    const last = h[h.length - 1];
    if (s.price == null) { s.price = last.p; s.est = { ...(s.est || {}), price: true }; }
    const yearAgo = new Date(Date.parse(last.d) - 365 * 864e5).toISOString().slice(0, 10);
    const yr = h.filter(p => p.d >= yearAgo).map(p => p.p);
    if (yr.length > 1) {
      if (s.hi52 == null) { s.hi52 = Math.max(...yr, s.price ?? -Infinity); s.est = { ...(s.est || {}), hi52: true }; }
      if (s.lo52 == null) { s.lo52 = Math.min(...yr, s.price ?? Infinity); s.est = { ...(s.est || {}), lo52: true }; }
    }
    if (s.chg == null && h.length > 1) { const prev = h[h.length - 2]; if (Date.parse(last.d) - Date.parse(prev.d) <= 4 * 864e5) { s.chg = last.p / prev.p - 1; s.chgDate = s.chgDate || last.d; } }
  }
  if (s.fin && s.mcap == null && s.pe && s.fin.ni > 0) s.mcap = s.pe * s.fin.ni;
  if (s.fin && s.pe == null && s.mcap && s.fin.ni > 0) { s.pe = s.mcap / s.fin.ni; s.est = { ...(s.est || {}), pe: true }; }
  return s;
}
/* stock splits: recorded ones (collection "splits") + a check on the price series */
const SPLIT_K = [2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50];
function splitHint(s) {
  const h = (s.hist || []).filter(p => p && p.p > 0 && p.d).sort((a, b) => a.d.localeCompare(b.d));
  if (h.length < 2) return null;
  const a = h[h.length - 2], b = h[h.length - 1];
  if (Date.parse(b.d) - Date.parse(a.d) > 6 * 864e5) return null;
  const r = a.p / b.p;
  const near = x => SPLIT_K.find(k => Math.abs(x - k) / k < 0.07);
  if (r > 1.8) { const k = near(r); if (k) return { t: s.ticker, ratio: k, date: b.d, reverse: false }; }
  if (r < 0.56) { const k = near(1 / r); if (k) return { t: s.ticker, ratio: k, date: b.d, reverse: true }; }
  return null;
}
function splitList() {
  const now = Date.now(), out = [];
  for (const sp of state.splits) if (now - Date.parse(sp.date + 'T12:00') < 45 * 864e5) out.push({ ...sp, recorded: true });
  for (const s of Object.values(state.stocks)) {
    const h = splitHint(s); if (!h) continue;
    if (out.some(x => x.t === h.t && Math.abs(Date.parse(x.date) - Date.parse(h.date)) < 10 * 864e5)) continue;
    out.push({ ...h, recorded: false });
  }
  return out.map(x => ({ ...x, owned: !!state.stocks[x.t]?.owned })).sort((a, b) => b.date.localeCompare(a.date));
}
const splitTxt = x => x.reverse ? `regroupement de ${x.ratio} actions en 1` : `fractionnement de 1 action en ${x.ratio}`;
function renderSplits() {
  const list = splitList().filter(x => !state.priv || !x.owned || true);
  const el = $('#splits');
  if (!list.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-split"/></svg> Fractionnements d'actions</span>` + list.map(x => {
    const s = state.stocks[x.t];
    const mine = x.owned && !state.priv;
    let what;
    if (x.recorded && mine && x.before && x.after) what = `Ta position a été ajustée automatiquement : ${nf(x.before.qty, 4)} → <b>${nf(x.after.qty, 4)} actions</b>, prix moyen ${nf(x.before.avg)} → <b>${nf(x.after.avg)}</b>. Ta valeur ne change pas.`;
    else if (x.recorded) what = 'L\'historique de prix a été ajusté. Le nombre d\'actions change, mais la valeur totale reste la même.';
    else if (mine) what = `Le prix a changé d'un facteur ${x.ratio} en un jour. Ta position sera ajustée à la prochaine mise à jour automatique; vérifie le nombre d'actions dans Wealthsimple.`;
    else what = `Le prix a changé d'un facteur ${x.ratio} en un jour : probablement un ${x.reverse ? 'regroupement' : 'fractionnement'}. La mise à jour automatique va le confirmer.`;
    return `<div class="row" data-t="${esc(x.t)}"><b>${esc(x.t)}</b><span>${esc(nice(s?.name || ''))} · ${esc(splitTxt(x))} · ${esc(x.date)}${x.recorded ? '' : ' · <i>à confirmer</i>'}</span></div><div class="note" style="margin:-2px 0 4px">${what}</div>`;
  }).join('');
}
function renderVerdicts() {
  const el = $('#verdicts'); const ch = [];
  for (const s of Object.values(state.stocks)) {
    const h = s.scoreHist || []; if (h.length < 2) continue;
    const a = h[h.length - 2][1], b = h[h.length - 1][1];
    const va = verdictOf(a), vb = verdictOf(b);
    if (va.t !== vb.t) ch.push({ s, a, b, va, vb, up: b > a });
  }
  if (!ch.length) { el.hidden = true; return; }
  ch.sort((x, y) => (y.up - x.up) || (y.b - x.b));
  el.hidden = false;
  el.innerHTML = `<span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-repeat"/></svg> Changements de verdict depuis la dernière mise à jour</span>` + ch.slice(0, 8).map(x => `<div class="row" data-t="${esc(x.s.ticker)}"><b>${esc(x.s.ticker)}</b><span>${x.up ? '<svg class="i up" aria-hidden="true"><use href="#i-arrow-up"/></svg>' : '<svg class="i down" aria-hidden="true"><use href="#i-arrow-down"/></svg>'} ${esc(x.va.t)} → <b>${esc(x.vb.t)}</b> <span class="muted">(score ${x.a} → ${x.b})</span></span></div>`).join('');
}
function renderDiscover() {
  const d = Store.discover?.items || [];
  const el = $('#discList'); if (!el) return;
  if (!d.length) return;
  const L = state.lang || 'fr';
  el.innerHTML = d.map((x, i) => { const v = verdictOf(x.score || 0); const added = !!Store.uni[x.t];
    return `<div class="card" style="--i:${i};cursor:default">
      <div class="row"><div class="idn">${logo(x.t, x.name)}<div><div class="tk">${esc(x.t)} · ${esc(x.index || '')}</div><div class="nm">${esc(x.name || x.t)}</div><div class="note">${esc(x.sector || '')}${x.region ? ' · ' + esc(x.region) : ''}</div></div></div>${ring(x.score || 0, v.col)}</div>
      <div class="row" style="align-items:center"><span class="pill ${v.c}">${v.h}</span><span class="num">${nf(x.price)} ${cp(x.chg)}</span></div>
      <ul class="reasons">${((x.pros || {})[L] || []).slice(0, 2).map(r => `<li>${esc(r)}</li>`).join('')}${((x.cons || {})[L] || []).slice(0, 1).map(r => `<li class="c">${esc(r)}</li>`).join('')}</ul>
      ${added ? '<span class="note"><svg class="i up" aria-hidden="true"><use href="#i-check"/></svg> ' + T('Déjà suivi', 'Already tracked') + '</span>' : `<button class="btn owner" data-add="${esc(x.t)}" data-name="${esc(x.name || '')}" data-sector="${esc(x.sector || '')}" data-region="${esc(x.region || '')}" data-cur="${esc(x.cur || '')}"><svg class="i" aria-hidden="true"><use href="#i-plus"/></svg> Ajouter à ma liste</button>`}
    </div>`; }).join('');
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-add]'); if (!b) return;
  b.disabled = true; b.textContent = 'Ajout…';
  try { await DB.doc('stocks/' + docId(b.dataset.add)).set({ ticker: b.dataset.add, name: b.dataset.name, sector: b.dataset.sector || 'Autre', region: b.dataset.region || null, cur: b.dataset.cur || 'USD', etf: false, addedBy: 'Découverte du Radar' }); b.outerHTML = '<span class="note"><svg class="i up" aria-hidden="true"><use href="#i-check"/></svg> Ajouté. Ses données arrivent dans environ 15 minutes.</span>'; }
  catch (err) { b.disabled = false; b.textContent = err?.code === 'no_token' ? 'Ajoute ton jeton GitHub (Réglages)' : 'Réessayer'; }
});
function renderPriceAlerts() {
  const el = $('#pricealerts');
  const list = Object.values(state.stocks).map(s => ({ s, al: alertState(s) })).filter(x => x.al);
  if (!list.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-bell"/></svg> Tes alertes de prix</span>` + list.map(({ s, al }) => `<div class="row" data-t="${esc(s.ticker)}"><b>${esc(s.ticker)}</b><span>${al.hit ? '<svg class="i" aria-hidden="true"><use href="#i-target"/></svg>' : '<svg class="i" aria-hidden="true"><use href="#i-hourglass"/></svg>'} ${esc(al.msg)}</span></div>`).join('');
}
function rebuild() {
  const held = holdingsMap(), o = {};
  for (const [k, v] of Object.entries(state.raw)) o[k] = fillGaps({ ...v, owned: !!held[k] });
  for (const t of Object.keys(held)) if (!o[t]) o[t] = { ticker: t, name: t, sector: 'Autre', owned: true, scores: {}, green: [], red: [] };
  state.stocks = o;
}
const fxRate = () => state.meta?.fx?.USDCAD || 1.39;
const whtax = cur => cur === 'USD' ? 0.15 : 0;
function portfolio() {
  const m = state.meta; if (!m || !state.positions) return null;
  const fx = fxRate();
  const rows = []; let total = 0, cost = 0;
  for (const [t, h] of Object.entries(holdingsMap())) {
    const s = state.stocks[t]; const p = s?.price;
    const r = h.cur === 'USD' ? fx : 1;
    const value = (p != null ? h.qty * p : h.qty * h.avg) * r;
    const c = h.qty * h.avg * r;
    total += value; cost += c;
    rows.push({ t, s, h, value, cost: c, gain: h.avg ? (p ?? h.avg) / h.avg - 1 : null });
  }
  rows.forEach(r => r.w = r.value / total);
  const sect = {};
  rows.forEach(r => { const k = r.s?.etf ? 'ETF' : (r.s?.sector || 'Autre'); sect[k] = (sect[k] || 0) + r.value; });
  Object.keys(sect).forEach(k => sect[k] /= total);
  return { rows, total, cost, sect, fx };
}

/* ---------- analysis engine ---------- */
const T = (fr, en) => (state.lang || 'fr') === 'en' ? en : fr;
function analyze(s, pf) {
  const pros = [], cons = [];
  let pts = 50, cl = 0; // cl : ajustements calculés seulement dans la page (ton portefeuille, grands investisseurs)
  if (pf && !(pf.rows || []).length) pf = null; // visiteur ou coffre verrouillé : aucun ajustement « portefeuille »
  const price = s.price, hi = s.hi52, lo = s.lo52;
  const disc = price && hi ? 1 - price / hi : null;
  const pos = price && hi && lo && hi > lo ? (price - lo) / (hi - lo) : null;
  const up = s.target && price ? s.target / price - 1 : null;
  const pe = s.fpe || s.pe;
  if (s.etf) {
    pts += 10; pros.push(T('Fonds indiciel : diversification instantanée sur des dizaines ou centaines de titres', 'Index fund: instant diversification across dozens or hundreds of stocks'));
    const etfW = pf?.sect?.ETF ?? null, tgt = state.meta?.sectorTargets?.ETF;
    if (etfW != null && tgt && etfW < tgt - 0.05) { pts += 10; cl += 10; pros.push(T(`Tes FNB pèsent ${pct(etfW, 0, false)} du portefeuille pour une cible de ${pct(tgt, 0, false)}`, `Your ETFs are ${pct(etfW, 0, false)} of the portfolio vs a ${pct(tgt, 0, false)} target`)); }
  } else {
    if (pe == null || pe <= 0) { pts -= 12; cons.push(T('Pas de bénéfice positif (P/E nul ou négatif) : le prix repose sur des promesses', 'No positive earnings (P/E negative or zero): the price rests on promises')); }
    else if (pe < 12) { pts += 14; pros.push(T(`Valorisation basse : P/E de ${nf(pe, 1)}, on paie peu pour chaque dollar de profit`, `Cheap valuation: P/E of ${nf(pe, 1)}, you pay little for each dollar of profit`)); }
    else if (pe < 18) { pts += 8; pros.push(T(`Valorisation raisonnable (P/E ${nf(pe, 1)})`, `Reasonable valuation (P/E ${nf(pe, 1)})`)); }
    else if (pe < 28) { }
    else if (pe < 45) { pts -= 8; cons.push(T(`Valorisation élevée (P/E ${nf(pe, 1)}) : beaucoup de croissance déjà dans le prix`, `High valuation (P/E ${nf(pe, 1)}): a lot of growth already priced in`)); }
    else { pts -= 16; cons.push(T(`Valorisation très élevée (P/E ${nf(pe, 0)}) : peu de marge d'erreur`, `Very high valuation (P/E ${nf(pe, 0)}): little room for error`)); }
    if (s.mcap > 2e11) { pts += 4; pros.push(T(`Géant établi (${big(s.mcap)} de capitalisation)`, `Established giant (${big(s.mcap)} market cap)`)); }
    else if (s.mcap && s.mcap < 3e9) { pts -= 6; cons.push(T(`Petite capitalisation (${big(s.mcap)}) : plus fragile et plus volatile`, `Small cap (${big(s.mcap)}): more fragile and volatile`)); }
  }
  if (disc != null) {
    if (disc >= 0.15 && disc <= 0.45) { pts += 8; pros.push(T(`Se négocie ${pct(disc, 0, false)} sous son sommet de l'année : point d'entrée plus bas`, `Trades ${pct(disc, 0, false)} below its 52-week high: a lower entry point`)); }
    else if (disc > 0.45) { pts -= 4; cons.push(T(`A chuté de ${pct(disc, 0, false)} depuis son sommet : comprendre pourquoi avant d'acheter`, `Down ${pct(disc, 0, false)} from its high: understand why before buying`)); }
    else if (disc < 0.04) { pts -= 3; cons.push(T('Proche de son sommet de l\'année : peu de rabais', 'Near its 52-week high: little discount')); }
  }
  if (s.beta != null) {
    if (s.beta > 1.6) { pts -= 8; cons.push(T(`Très volatile (bêta ${nf(s.beta, 2)}) : bouge environ ${nf(s.beta, 1)}× plus que le marché`, `Very volatile (beta ${nf(s.beta, 2)}): moves about ${nf(s.beta, 1)}× the market`)); }
    else if (s.beta < 0.8 && s.beta > 0) { pts += 4; pros.push(T(`Peu volatile (bêta ${nf(s.beta, 2)}) : stabilise le portefeuille`, `Low volatility (beta ${nf(s.beta, 2)}): steadies the portfolio`)); }
  }
  if (up != null) {
    if (up > 0.2) { pts += 10; pros.push(T(`Les analystes visent ${money(s.target, 2)}, soit ${pct(up, 0)} de potentiel`, `Analysts target ${money(s.target, 2)}, ${pct(up, 0)} upside`)); }
    else if (up > 0.08) { pts += 5; pros.push(T(`Cible moyenne des analystes : ${money(s.target, 2)} (${pct(up, 0)})`, `Average analyst target: ${money(s.target, 2)} (${pct(up, 0)})`)); }
    else if (up < 0) { pts -= 8; cons.push(T(`Le prix dépasse déjà la cible des analystes (${money(s.target, 2)})`, `Price is already above the analyst target (${money(s.target, 2)})`)); }
  }
  // fit with Evan's portfolio
  if (pf && !s.etf) {
    const sec = s.sector, w = pf.sect[sec] ?? 0, tgt = state.meta?.sectorTargets?.[sec];
    if (tgt != null) {
      if (w > tgt + 0.05) { pts -= 6; cl -= 6; cons.push(T(`Ton portefeuille a déjà ${pct(w, 0, false)} en ${sec} (cible ${pct(tgt, 0, false)})`, `Your portfolio already has ${pct(w, 0, false)} in ${sec} (target ${pct(tgt, 0, false)})`)); }
      else if (w < tgt - 0.03) { pts += 5; cl += 5; pros.push(T(`Rééquilibre ton portefeuille : ${sec} à ${pct(w, 0, false)} pour une cible de ${pct(tgt, 0, false)}`, `Rebalances your portfolio: ${sec} at ${pct(w, 0, false)} vs a ${pct(tgt, 0, false)} target`)); }
    } else if (!w) { pts += 4; cl += 4; pros.push(T(`Ajoute un secteur absent de ton portefeuille (${sec})`, `Adds a sector missing from your portfolio (${sec})`)); }
  }
  if (pf && !s.owned) {
    const g = regionOf(s);
    const us = pf.rows.reduce((acc, r) => acc + (regionOf(r.s) === 'États-Unis' ? r.w : 0), 0);
    if (g !== 'États-Unis' && us > 0.8) { pts += 4; cl += 4; pros.push(T(`Diversifie hors des États-Unis (${s.region && g === 'International' ? s.region : g}) : ${pct(us, 0, false)} de ton portefeuille y est`, `Diversifies outside the US (${s.region && g === 'International' ? s.region : g}): ${pct(us, 0, false)} of your portfolio is there`)); }
  }
  if (pf && s.owned) {
    const r = pf.rows.find(r => r.t === s.ticker);
    if (r && r.w > 0.06) { pts -= 4; cl -= 4; cons.push(T(`Déjà ${pct(r.w, 1, false)} de ton portefeuille : attention à la concentration`, `Already ${pct(r.w, 1, false)} of your portfolio: watch concentration`)); }
  }
  // what the great investors do with it
  const byInv = investorMap()[s.ticker] || [];
  const longs = byInv.filter(x => !x.short), shorts = byInv.filter(x => x.short);
  if (longs.length) {
    pts += Math.min(8, 3 * longs.length); cl += Math.min(6, 2 * longs.length);
    pros.push(T('Détenu par ', 'Held by ') + longs.map(x => x.name + (x.w ? ` (${nf(x.w, 1)} %)` : '') + (x.chg ? ` · ${x.chg.toLowerCase()}` : '')).join(', '));
  }
  shorts.forEach(x => { pts -= 4; cl -= 4; cons.push(T(`${x.name} a parié contre ce titre (options de vente)`, `${x.name} bet against this stock (put options)`)); });
  // flags from the workbook that the rules don't already cover
  const skip = /P\/E|β|Décote|creux|capitalisation|Méga/i;
  if ((state.lang || 'fr') === 'fr') { (s.green || []).filter(x => !skip.test(x)).forEach(x => pros.push(x)); (s.red || []).filter(x => !skip.test(x)).forEach(x => cons.push(x)); }
  const rule = Math.max(0, Math.min(100, pts));
  const base = s.radarScore != null ? s.radarScore : Math.round(s.consensus != null ? 0.5 * s.consensus + 0.5 * rule : rule);
  const score = Math.round(Math.max(0, Math.min(100, base + cl)));
  return { score, base, cl, rule, disc, pos, up, pros: [...(s.pros || []), ...pros], cons: [...(s.cons || []), ...cons], verdict: verdictOf(score) };
}
let invCache = null, invKey = null;
function investorMap() {
  if (invKey === state.investors) return invCache;
  const m = {};
  for (const inv of state.investors) {
    for (const h of inv.holdings || []) (m[h.t] = m[h.t] || []).push({ name: inv.name, w: h.w, chg: h.chg });
    for (const o of inv.options || []) if (o.type === 'put') (m[o.t] = m[o.t] || []).push({ name: inv.name, short: true });
  }
  invKey = state.investors; invCache = m; return m;
}
function verdictOf(sc) {
  if (sc >= 66) return { t: 'Achat intéressant', h: '<svg class="i" aria-hidden="true"><use href="#i-buy"/></svg> Achat intéressant', c: 'v-buy', col: '--good' };
  if (sc >= 57) return { t: 'À considérer', h: '<svg class="i" aria-hidden="true"><use href="#i-thumb"/></svg> À considérer', c: 'v-con', col: '--mid' };
  if (sc >= 46) return { t: 'À surveiller', h: '<svg class="i" aria-hidden="true"><use href="#i-eye"/></svg> À surveiller', c: 'v-watch', col: '--muted' };
  if (sc >= 36) return { t: 'Prudence', h: '<svg class="i" aria-hidden="true"><use href="#i-alert"/></svg> Prudence', c: 'v-care', col: '--warn' };
  return { t: 'Éviter', h: '<svg class="i" aria-hidden="true"><use href="#i-ban"/></svg> Éviter', c: 'v-avoid', col: '--bad' };
}
const INTL = ['TSM', 'ASML', 'ARM', 'BYDDY', 'SPOT', 'STM', 'NVO', 'SAP', 'MELI', 'SONY', 'TM', 'BABA', 'RACE', 'SE', 'AZN', 'HDB', 'SHEL', 'BIDU', 'YPF'];
function regionOf(s) {
  if (!s) return 'États-Unis';
  if (s.etf) return s.ticker === 'VCN.TO' || s.ticker === 'ZEB.TO' || s.ticker === 'CBIL.TO' ? 'Canada' : 'États-Unis';
  if (/\.(TO|V|NE|CN)$/.test(s.ticker) || ['SHOP', 'BN', 'QSR'].includes(s.ticker)) return 'Canada';
  if (s.region && s.region !== 'États-Unis' && s.region !== 'Canada') return 'International';
  return INTL.includes(s.ticker) ? 'International' : (s.region || 'États-Unis');
}
function sellSignal(s, a, pf) {
  if (!s.owned || !pf) return null;
  const r = pf.rows.find(r => r.t === s.ticker); if (!r) return null;
  const out = [];
  let level = null;
  if (a.score < 33) { level = 'Vendre'; out.push(`Score très faible (${a.score}/100) : les signaux négatifs dominent`); }
  else if (a.score < 40) { level = 'Réévaluer'; out.push(`Score faible (${a.score}/100) : relis les raisons de t'abstenir et demande-toi si tu rachèterais ce titre aujourd'hui`); }
  if (r.w > 0.08) { level = level || 'Alléger'; out.push(`Position très lourde : ${pct(r.w, 1, false)} de ton portefeuille`); }
  if (s.target && s.price > s.target * 1.05) { level = level || 'Prendre des profits'; out.push(`Le cours dépasse de ${pct(s.price / s.target - 1, 0, false)} la cible moyenne des analystes`); }
  const sec = s.etf ? 'ETF' : s.sector, tg = state.meta?.sectorTargets?.[sec];
  if (!s.etf && tg != null && (pf.sect[sec] || 0) > tg + 0.1 && a.score < 52) { level = level || 'Alléger'; out.push(`Secteur ${sec} surpondéré (${pct(pf.sect[sec], 0, false)} pour une cible de ${pct(tg, 0, false)}) et score moyen`); }
  return level ? { level, reasons: out, row: r } : null;
}
const EMO = { 'Vendre': '<svg class="i" aria-hidden="true"><use href="#i-sell"/></svg>', 'Alléger': '<svg class="i" aria-hidden="true"><use href="#i-scale"/></svg>', 'Réévaluer': '<svg class="i" aria-hidden="true"><use href="#i-search"/></svg>', 'Prendre des profits': '<svg class="i" aria-hidden="true"><use href="#i-coins"/></svg>', 'Renforcer': '<svg class="i" aria-hidden="true"><use href="#i-plus"/></svg>', 'Conserver': '<svg class="i" aria-hidden="true"><use href="#i-shield-check"/></svg>' };
const emo = l => (EMO[l] ? EMO[l] + ' ' : '') + l;
function actionOf(a, sig) {
  if (sig) return { t: emo(sig.level), c: sig.level === 'Vendre' ? 'v-avoid' : 'v-care' };
  if (a.score >= 60) return { t: emo('Renforcer'), c: 'v-buy' };
  return { t: emo('Conserver'), c: 'v-watch' };
}
// per-account P/L if sold today, in position currency and CAD
function sellPreview(t) {
  const s = state.stocks[t]; const fx = fxRate();
  return (state.positions || []).filter(p => p.t === t && p.qty > 1e-9).map(p => {
    const price = s?.price ?? p.avg; const r = p.cur === 'USD' ? fx : 1;
    const pl = (price - p.avg) * p.qty;
    return { ...p, price, pl, plCAD: pl * r, plPct: price / p.avg - 1, valueCAD: price * p.qty * r };
  });
}
function taxNote(acc, pl) {
  if (acc === 'Non-enregistré') return pl >= 0 ? 'Gain en capital imposable : la moitié du gain s\'ajoute à ton revenu de l\'année.' : 'Perte en capital : elle peut réduire l\'impôt sur tes gains (cette année, 3 ans passés ou plus tard). Ne rachète pas le titre dans les 30 jours avant ou après, sinon la perte est refusée (perte apparente).';
  if (acc === 'CELI') return pl >= 0 ? 'Aucun impôt sur le gain dans le CELI. Le montant retiré redevient de l\'espace de cotisation l\'an prochain seulement.' : 'Une perte dans le CELI n\'est pas déductible et l\'espace perdu ne revient pas.';
  if (acc === 'CELIAPP') return pl >= 0 ? 'Aucun impôt tant que l\'argent sert à l\'achat d\'une première maison.' : 'Une perte dans le CELIAPP n\'est pas déductible.';
  return '';
}

/* ---------- render ---------- */
function list() {
  const pf = portfolio();
  return { pf, items: Object.values(state.stocks).map(s => ({ s, a: analyze(s, pf) })) };
}
function render() {
  const { pf, items } = list();
  renderStatus(); renderHero(pf, items); maybeEgg(); renderKpis(pf, items); renderOpps(items); renderAvoid(items);
  renderHold(pf, items); renderAll(items); renderCharts(pf, items);
  renderInvestors(); renderDivs(pf); renderTx(); renderDay(pf); renderSplits(); renderPriceAlerts(); renderPlan(); renderVerdicts(); renderDiscover();
  $('#txOpen').hidden = state.canWrite === false;
  $('#impOpen').hidden = state.canWrite === false;
  $('#ajout').hidden = state.canWrite === false;
  if (state.open && !state.form) renderDrawer(state.open, false);
}
function renderInvestors() {
  const invs = state.investors.slice().sort((a, b) => (a.order || 99) - (b.order || 99));
  if (!invs.length) { $('#investors').innerHTML = '<div class="empty">Les portefeuilles des grands investisseurs s\'afficheront ici.</div>'; $('#consensus').innerHTML = ''; return; }
  const held = holdingsMap();
  const cnt = {};
  invs.forEach(i => (i.holdings || []).forEach(h => { (cnt[h.t] = cnt[h.t] || { n: h.n, who: [] }).who.push(i.name.split(' ').pop()); }));
  const multi = Object.entries(cnt).filter(([, v]) => v.who.length > 1).sort((a, b) => b[1].who.length - a[1].who.length);
  $('#consensus').innerHTML = multi.map(([t, v]) => `<button class="chip" ${state.stocks[t] ? `data-t="${esc(t)}"` : 'disabled'} title="${esc(v.who.join(', '))}"><b>${esc(t)}</b>${esc(v.n)} · ${v.who.length} investisseurs${held[t] ? ' <span class="tag me priv">tu l\'as</span>' : ''}</button>`).join('') || '<span class="note">Aucun titre commun pour l\'instant.</span>';
  $('#investors').innerHTML = invs.map(i => {
    const hs = (i.holdings || []).slice(0, 9);
    const max = Math.max(...hs.map(h => h.w ?? (h.v || 0)));
    const tag = c => !c ? '' : c === 'Nouveau' ? '<span class="tag new">nouveau</span>' : c === 'Augmenté' ? '<span class="tag up">▲</span>' : c === 'Réduit' ? '<span class="tag dn">▼</span>' : '';
    const opts = (i.options || []).map(o => `<li class="${o.type === 'put' ? 'c' : ''}">${o.type === 'put' ? 'Pari à la baisse' : 'Pari à la hausse'} sur <b>${esc(o.t)}</b> (${big(o.v)} notionnel)</li>`).join('');
    return `<article class="ic">
      <div class="who"><div><h3>${esc(i.name)}</h3><div class="note">${esc(i.firm)} · ${esc(i.period)}</div></div><span class="pill v-con">${esc(i.style)}</span></div>
      <div class="note">${i.aum ? `Portefeuille déclaré ${big(i.aum)}` : ''}${i.positions ? ` · ${i.positions} positions` : ''}${i.filed ? ` · déposé le ${esc(new Date(i.filed + 'T12:00').toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' }))}` : ''}</div>
      <div class="hl">${hs.map(h => { const v = h.w ?? h.v ?? 0; const mine = !!held[h.t]; const can = !!state.stocks[h.t];
        return `<div class="hr ${mine ? 'mine' : ''} ${can ? 'click' : ''}" ${can ? `data-t="${esc(h.t)}" tabindex="0"` : ''}><span class="nm2"><span class="tk">${esc(h.t)}</span> ${esc(h.n)}${tag(h.chg)}${mine ? '<span class="tag me priv">tu l\'as</span>' : ''}</span><span class="t"><i style="width:${max ? v / max * 100 : 0}%"></i></span><span class="val">${h.w != null ? nf(h.w, 1) + ' %' : big(h.v)}</span></div>`; }).join('')}</div>
      ${opts ? `<ul class="reasons">${opts}</ul>` : ''}
      <div><span class="lbl">Mouvements récents</span><ul class="reasons" style="margin-top:6px">${(i.moves || []).map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>
      ${i.note ? `<p class="note" style="margin:0">${esc(i.note)}</p>` : ''}
      <p class="note" style="margin:0">Source : ${esc(i.source || '13F')}</p>
    </article>`;
  }).join('');
}
function divEstimate(pf) {
  if (!pf) return { total: 0, rows: [] };
  const fx = fxRate(); const rows = [];
  for (const p of state.positions || []) {
    const s = state.stocks[p.t]; const d = s?.divAnnual;
    if (!d || !(p.qty > 0)) continue;
    const cad = p.qty * d * (p.cur === 'USD' ? fx : 1) * (1 - whtax(p.cur));
    rows.push({ t: p.t, account: p.account, cad });
  }
  return { total: rows.reduce((a, r) => a + r.cad, 0), rows };
}
function renderDivs(pf) {
  const est = divEstimate(pf);
  const yr = new Date().getFullYear();
  const got = state.divs.filter(d => (d.payDate || '').startsWith(String(yr)));
  const gotCad = got.reduce((a, d) => a + (d.netCAD || 0), 0);
  const known = Object.values(state.stocks).filter(s => s.owned && s.divAnnual).length;
  $('#divKpis').innerHTML = `
    <div class="kpi"><span class="lbl">Revenu annuel estimé</span><span class="v">${money(est.total)}</span><span class="s">${known ? `${known} titres versent un dividende` : 'en cours de collecte'}</span></div>
    <div class="kpi"><span class="lbl">Par mois</span><span class="v">${money(est.total / 12)}</span><span class="s">après retenue US</span></div>
    <div class="kpi"><span class="lbl">Réinvesti en ${yr}</span><span class="v">${money(gotCad, 2)}</span><span class="s">${got.length} versements</span></div>`;
  $('#divList').innerHTML = state.divs.length ? state.divs.slice(0, 8).map(d => `<div class="jr"><span class="d">${esc(d.payDate)}</span><span><b>${esc(d.t)}</b> · ${esc(d.account)} · ${nf(d.amountPerShare, 4)} $/action</span><span class="num up">+${nf(d.shares, 4)} act.</span></div>`).join('')
    : '<p class="note" style="margin:0">Aucun dividende réinvesti enregistré depuis le 3 nov. 2026. Les prochains apparaîtront ici automatiquement.</p>';
}
let undoArm = false;
function renderTx() {
  const tx = state.txs;
  $('#txList').innerHTML = tx.length ? tx.slice(0, 10).map((t, i) => `<div class="jr"><span class="d">${esc(t.date)}</span><span><span class="pill ${t.type === 'sell' ? 'v-care' : 'v-buy'}" style="padding:1px 7px">${t.type === 'sell' ? 'Vente' : t.type === 'drip' ? 'DRIP' : 'Achat'}</span> <b>${esc(t.t)}</b> · ${nf(t.qty, 4)} à ${nf(t.price)} ${esc(t.cur)} · ${esc(t.account)}${t.type === 'sell' && t.realized != null ? ` · <span class="${t.realized >= 0 ? 'up' : 'down'}">${t.realized >= 0 ? '+' : ''}${nf(t.realized)} ${esc(t.cur)}</span>` : ''}</span>${i === 0 && state.canWrite !== false ? `<button class="btn" id="txUndo">${undoArm ? 'Confirmer l\'annulation' : 'Annuler'}</button>` : '<span></span>'}</div>`).join('')
    : '<p class="note" style="margin:0">Aucun mouvement pour l\'instant. Clique « Ajouter un achat ou une vente » après chaque transaction sur Wealthsimple.</p>';
  const u = $('#txUndo'); if (u) u.onclick = undoLast;
}
function renderStatus() {
  const st = state.status, el = $('#status');
  const last = st?.lastRun || Object.values(state.stocks).reduce((m, s) => s.updatedAt > m ? s.updatedAt : m, '');
  const ageH = last ? (Date.now() - new Date(last)) / 36e5 : 999;
  const cls = !dbFresh ? '' : ageH < 30 ? 'live' : 'stale';
  el.innerHTML = `<span class="dot ${cls}"></span><span>Données au ${esc(fmtDate(last))}</span><span>·</span><span>Mise à jour auto : ${esc(st?.schedule || 'jours ouvrables')}</span>${state.unlocked ? '' : '<span>·</span><span><svg class="i" aria-hidden="true"><use href="#i-lock"/></svg> portefeuille verrouillé</span>'}`;
  if (!isOwner()) el.innerHTML = `<span class="dot ${cls}"></span><span>${T('Données au', 'Data as of')} ${esc(fmtDate(last))}</span>`;
}
function renderKpis(pf, items) {
  if (!pf) { $('#resume').innerHTML = ''; return; }
  const gain = pf.total - pf.cost;
  const tech = pf.sect['Technologie'] || 0;
  const best = items.filter(x => !x.s.owned && !x.s.etf).sort((a, b) => b.a.score - a.a.score)[0];
  const n = items.filter(x => !x.s.owned).length;
  $('#resume').innerHTML = `
   <div class="kpi"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-chart"/></svg> Gain latent</span><span class="v ${gain >= 0 ? 'up' : 'down'}">${gain >= 0 ? '+' : ''}${money(gain)}</span><span class="s">${pct(gain / pf.cost)} sur le coût</span></div>
   <div class="kpi"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-cpu"/></svg> Poids techno</span><span class="v ${tech > 0.35 ? 'down' : ''}">${pct(tech, 0, false)}</span><span class="s">cible ${pct(state.meta.sectorTargets?.Technologie ?? .3, 0, false)} · ${tech > 0.35 ? 'surpondéré' : 'équilibré'}</span></div>
   <div class="kpi"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-star"/></svg> Meilleure occasion</span><span class="v">${best ? esc(best.s.ticker.replace('_', '.')) : '–'}</span><span class="s">${best ? `score ${best.a.score} parmi ${n} titres surveillés` : ''}</span></div>`;
  countUp($('#resume'));
  const b = state.status?.marketBrief;
  $('#brief').hidden = !b;
  if (b) $('#brief').innerHTML = `<span class="lbl" style="flex:none;padding-top:2px">Le point marché</span><p>${esc(b)}</p>`;
}
let counted = false;
function countUp(root) {
  if (counted || REDUCED) return; counted = true;
  root.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.dataset.count, suf = el.dataset.suffix || '', t0 = performance.now(), d = 900;
    const step = now => { const k = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - k, 3); el.textContent = nf(to * e, 0) + suf; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
// smart badges: earnings soon, ex-dividend soon, price alert reached
function daysTo(d) { if (!d) return null; const x = (Date.parse(d + 'T12:00') - Date.now()) / 864e5; return Math.ceil(x); }
function trend(s) {
  const h = s.scoreHist || []; if (h.length < 2) return null;
  const last = h[h.length - 1], lim = Date.parse(last[0]) - 7 * 864e5;
  let ref = h[0]; for (const x of h) { if (Date.parse(x[0]) <= lim) ref = x; }
  if (ref === last) ref = h[h.length - 2];
  return { d: last[1] - ref[1], days: Math.round((Date.parse(last[0]) - Date.parse(ref[0])) / 864e5) };
}
function trendTag(s) { const tr = trend(s); if (!tr || Math.abs(tr.d) < 3) return ''; return `<span class="trend ${tr.d > 0 ? 'up' : 'down'}" title="Variation du score radar sur ${tr.days} jours">${tr.d > 0 ? '▲' : '▼'}${Math.abs(tr.d)}</span>`; }
function badges(s) {
  const out = [];
  const tt = trendTag(s); if (tt) out.push(tt);
  const e = daysTo(s.nextEarnings); if (e != null && e >= 0 && e <= 7) out.push(`<span class="badge hot" title="Prochains résultats le ${esc(s.nextEarnings)}"><svg class="i" aria-hidden="true"><use href="#i-megaphone"/></svg> Résultats ${e === 0 ? 'aujourd\'hui' : 'dans ' + e + ' j'}</span>`);
  const x = daysTo(s.lastDiv?.exDate); if (s.owned && !state.priv && x != null && x >= 0 && x <= 10) out.push(`<span class="badge ok" title="Pour recevoir le dividende, il faut détenir le titre avant cette date"><svg class="i" aria-hidden="true"><use href="#i-banknote"/></svg> Ex-div. ${x === 0 ? 'aujourd\'hui' : 'dans ' + x + ' j'}</span>`);
  const al = alertState(s); if (al && !state.priv) out.push(`<span class="badge hot bell" title="${esc(al.msg)}"><svg class="i" aria-hidden="true"><use href="#i-bell"/></svg> ${al.short}</span>`);
  return out.join('');
}
function alertState(s) {
  const a = state.alerts[s.ticker]; if (!a || s.price == null) return null;
  if (a.below != null && s.price <= a.below) return { short: 'Prix visé atteint', msg: `${s.ticker} est à ${nf(s.price)}, sous ton prix visé de ${nf(a.below)}`, hit: true };
  if (a.above != null && s.price >= a.above) return { short: 'Seuil haut atteint', msg: `${s.ticker} est à ${nf(s.price)}, au-dessus de ton seuil de ${nf(a.above)}`, hit: true };
  if (a.below != null && s.price <= a.below * 1.03) return { short: 'Presque au prix visé', msg: `${s.ticker} est à ${nf(s.price)}, à moins de 3 % de ton prix visé de ${nf(a.below)}`, hit: false };
  return null;
}
function logo(t, name, size = '') {
  const rec = (Store.logos || {})[t];
  if (rec && rec.ok) return `<span class="logo ${size}${rec.dark ? ' dk' : ''}"><img src="logos/${esc(String(t).replace(/\./g, '_'))}.png" alt="" loading="lazy" decoding="async"></span>`;
  const ini = (nice(name || t).replace(/[^A-Za-zÀ-ÿ0-9 &]/g, ' ').split(/\s+/).filter(w => w && !/^(inc|corp|ltd|the|de|du|la|le|plc|co|sa|nv|ag|&)$/i.test(w)).slice(0, 2).map(w => w[0]).join('') || String(t)[0]).toUpperCase();
  return `<span class="logo mono ${size}" aria-hidden="true">${esc(ini)}</span>`;
}
function sparkPath(v, W, H) {
  const mn = Math.min(...v), mx = Math.max(...v);
  return v.map((y, i) => `${i ? 'L' : 'M'}${(i / (v.length - 1) * W).toFixed(1)},${(H - 2 - (mx === mn ? .5 : (y - mn) / (mx - mn)) * (H - 4)).toFixed(1)}`).join('');
}
function spark(s, days = 30) {
  const h = (s.hist || []).filter(p => p && p.p > 0); if (h.length < 5) return '';
  const cut = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  let pts = h.filter(p => p.d >= cut); if (pts.length < 5) pts = h.slice(-22);
  const v = pts.map(p => p.p); const W = 120, H = 32, path = sparkPath(v, W, H);
  const ch = v[v.length - 1] / v[0] - 1;
  return `<div class="spark ${ch >= 0 ? 'up' : 'down'}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="${path}L${W},${H}L0,${H}Z"/><path d="${path}"/></svg><span class="num">${T('1 mois', '1 mo')} <b>${pct(ch, 1)}</b></span></div>`;
}
const cp = v => v == null ? '' : `<span class="cp ${v >= 0 ? 'up' : 'down'}">${pct(v)}</span>`;
function ring(sc, col) { return `<div class="ring" style="--p:${sc};--c:var(${col})"><span>${sc}</span></div>`; }
function rangeBar(s) {
  if (!s.hi52 || !s.lo52 || !s.price) return '';
  const p = Math.max(0, Math.min(1, (s.price - s.lo52) / (s.hi52 - s.lo52)));
  return `<div><div class="range"><i style="left:${p * 100}%"></i></div><div class="rl"><span>${nf(s.lo52)}</span><span>52 sem.</span><span>${nf(s.hi52)}</span></div></div>`;
}
const OPPF = () => [['all', T('Tous', 'All')], ['s70', T('Score 70+', 'Score 70+')], ['Technologie', T('Technologie', 'Tech')], ['Finance & Assurance', 'Finance'], ['Santé', T('Santé', 'Health')], ['Consommation', T('Consommation', 'Consumer')], ['Industrie', T('Industrie', 'Industrials')], ['Énergie', T('Énergie', 'Energy')], ['Matériaux', T('Matériaux', 'Materials')], ['ca', 'Canada'], ['div', T('Dividende 2 %+', 'Dividend 2 %+')], ['etf', 'FNB']];
function oppMatch(f, s, a) {
  if (f === 'all') return true; if (f === 's70') return a.score >= 70; if (f === 'ca') return /\.(TO|V|NE|CN)$/i.test(s.ticker) || /canada/i.test(s.region || '');
  if (f === 'div') return s.divAnnual && s.price && s.divAnnual / s.price >= .02; if (f === 'etf') return !!s.etf; return s.sector === f;
}
function renderOpps(items) {
  const base = items.filter(x => state.priv || !x.s.owned);
  const f = state.oppF || 'all';
  const chips = OPPF().filter(([k]) => k === 'all' || base.some(x => oppMatch(k, x.s, x.a)));
  const ch = $('#oppChips'); if (ch) ch.innerHTML = chips.map(([k, l]) => `<button type="button" data-of="${esc(k)}" aria-pressed="${k === f}">${esc(l)} <span class="muted">${k === 'all' ? base.length : base.filter(x => oppMatch(k, x.s, x.a)).length}</span></button>`).join('');
  const top = base.filter(x => oppMatch(f, x.s, x.a)).sort((a, b) => b.a.score - a.a.score).slice(0, 6);
  if (!top.length) { $('#opps').innerHTML = `<div class="empty">${f === 'all' ? T('Aucun titre suivi pour l\'instant.', 'No tracked stock yet.') : T('Aucun titre dans ce filtre pour l\'instant.', 'No stock in this filter yet.')}</div>`; return; }
  $('#opps').innerHTML = top.map(({ s, a }, i) => `
    <button class="card" style="--i:${i}" data-t="${esc(s.ticker)}">
      <div class="row"><div class="idn">${logo(s.ticker, s.name)}<div><div class="tk">${esc(s.ticker)} · ${esc(s.sector || '')}</div><div class="nm">${esc(nice(s.name))}</div><div>${badges(s)}</div></div></div>${ring(a.score, a.verdict.col)}</div>
      <div class="row" style="align-items:center"><span class="pill ${a.verdict.c}">${a.verdict.h}</span><span class="num">${nf(s.price)} ${cp(s.chg)}</span></div>
      <ul class="reasons">${a.pros.length ? `<li>${esc(a.pros[0])}</li>` : a.cons.slice(0, 1).map(r => `<li class="c">${esc(r)}</li>`).join('')}</ul>
      ${spark(s) || rangeBar(s)}
    </button>`).join('');
}
function renderAvoid(items) {
  const low = items.filter(x => !x.s.etf && !x.s.owned).sort((a, b) => a.a.score - b.a.score).slice(0, 6);
  $('#avoid').innerHTML = low.map(({ s, a }) => `<li class="c" style="cursor:pointer" data-t="${esc(s.ticker)}" tabindex="0"><span><b>${esc(nice(s.name))}</b> <span class="tk">${esc(s.ticker)}</span> · score ${a.score}${s.owned ? ' · <span class="pill v-care">détenu</span>' : ''}<br><span class="muted">${esc(a.cons[0] || '')}</span></span></li>`).join('');
}
function sortRows(rows, srt, get) {
  return rows.sort((x, y) => { const a = get(x, srt.k), b = get(y, srt.k); if (a == null) return 1; if (b == null) return -1; return (typeof a === 'string' ? a.localeCompare(b, 'fr') : a - b) * srt.d; });
}
function renderHold(pf, items) {
  if (!pf) return;
  const map = Object.fromEntries(items.map(x => [x.s.ticker, x]));
  const rows = pf.rows.map(r => { const it = map[r.t]; const a = it?.a || { score: null }; const sig = it ? sellSignal(it.s, a, pf) : null; return { ...r, a, sig, pl: r.value - r.cost }; });
  sortRows(rows, state.sortHold, (r, k) => k === 'name' ? nice(r.s?.name || r.t) : k === 'score' ? r.a.score : k === 'action' ? (r.sig ? 0 : r.a.score) : r[k]);
  const maxW = Math.max(...rows.map(r => r.w));
  $('#tHold tbody').innerHTML = rows.map(r => {
    const act = r.a.score != null ? actionOf(r.a, r.sig) : { t: '–', c: 'v-watch' };
    return `<tr data-t="${esc(r.t)}"><td><b>${esc(nice(r.s?.name || r.t))}</b> <span class="tk">${esc(r.t)}</span>${r.s ? badges(r.s) : ''}<div class="note">${esc(r.h.accounts.join(' · '))}</div></td>
     <td class="r num">${money(r.value)}</td><td class="r num"><span class="bar" style="width:${Math.round(r.w / maxW * 50)}px"></span>${pct(r.w, 1, false)}</td>
     <td class="r num ${r.gain >= 0 ? 'up' : 'down'}">${pct(r.gain, 0)}</td>
     <td class="r num ${r.pl >= 0 ? 'up' : 'down'}">${r.pl >= 0 ? '+' : '−'}${money(Math.abs(r.pl))}<div class="note">${r.pl >= 0 ? 'gain' : 'perte'}</div></td>
     <td class="r num">${r.a.score ?? '–'}</td><td><span class="pill ${act.c}">${act.t}</span></td></tr>`;
  }).join('');
  // sell suggestions
  const sells = rows.filter(r => r.sig).sort((a, b) => (a.sig.level === 'Vendre' ? 0 : 1) - (b.sig.level === 'Vendre' ? 0 : 1) || a.a.score - b.a.score);
  $('#sells').innerHTML = sells.length ? sells.slice(0, 8).map(r => `<div class="jr" style="grid-template-columns:minmax(0,1fr) auto;cursor:pointer" data-t="${esc(r.t)}">
      <span><span class="pill ${r.sig.level === 'Vendre' ? 'v-avoid' : 'v-care'}" style="padding:1px 8px">${emo(r.sig.level)}</span> <b>${esc(nice(r.s?.name || r.t))}</b> <span class="tk">${esc(r.t)}</span><br><span class="muted">${esc(r.sig.reasons[0])}</span></span>
      <span class="num ${r.pl >= 0 ? 'up' : 'down'}" style="text-align:right">${r.pl >= 0 ? 'Gain' : 'Perte'}<br>${r.pl >= 0 ? '+' : '−'}${money(Math.abs(r.pl))}</span></div>`).join('')
    : '<p class="note" style="margin:0">Aucune position ne déclenche de signal de vente pour l\'instant.</p>';
  // geography & currency
  const reg = {}, cur = { USD: 0, CAD: 0 };
  rows.forEach(r => { const g = regionOf(r.s); reg[g] = (reg[g] || 0) + r.w; cur[r.h.cur === 'USD' ? 'USD' : 'CAD'] += r.w; });
  const bars = [['États-Unis', reg['États-Unis'] || 0], ['Canada', reg['Canada'] || 0], ['International', reg['International'] || 0], ['En USD', cur.USD], ['En CAD', cur.CAD]];
  $('#geo').innerHTML = bars.map(([n, v]) => `<div style="grid-template-columns:96px 1fr 48px"><span>${n}</span><span class="t"><i style="width:${v * 100}%"></i></span><span class="num">${nf(v * 100, 0)} %</span></div>`).join('');
  $('#geoNote').textContent = (reg['États-Unis'] || 0) > 0.8 ? `${nf((reg['États-Unis'] || 0) * 100, 0)} % de ton portefeuille dépend des États-Unis et ${nf(cur.USD * 100, 0)} % est en dollars US : une baisse du dollar américain réduit ta valeur en CAD. Les titres canadiens et internationaux du radar t'aident à diversifier.` : 'Répartition par région et par devise.';
  // upcoming events
  const now = Date.now(), lim = now + 45 * 864e5, ev = [];
  rows.forEach(r => { const s = r.s; if (!s) return;
    const e = s.nextEarnings && Date.parse(s.nextEarnings + 'T12:00'); if (e && e >= now - 864e5 && e <= lim) ev.push({ d: s.nextEarnings, t: r.t, w: 'Résultats trimestriels' });
    const x = s.lastDiv?.exDate && Date.parse(s.lastDiv.exDate + 'T12:00'); if (x && x >= now - 864e5 && x <= lim) ev.push({ d: s.lastDiv.exDate, t: r.t, w: `Ex-dividende (${nf(s.lastDiv.amount, 4)} $)` });
  });
  ev.sort((a, b) => a.d.localeCompare(b.d));
  $('#events').innerHTML = ev.length ? ev.slice(0, 10).map(e => `<div class="jr" style="grid-template-columns:86px minmax(0,1fr)" data-t="${esc(e.t)}"><span class="d">${esc(e.d)}</span><span><b>${esc(e.t)}</b> · ${esc(e.w)}</span></div>`).join('') : '<p class="note" style="margin:0">Les dates de résultats et d\'ex-dividende s\'ajoutent avec les mises à jour automatiques.</p>';
}
function renderAll(items) {
  const sects = [...new Set(items.map(x => x.s.etf ? 'ETF' : x.s.sector))].sort((a, b) => a.localeCompare(b, 'fr'));
  const sel = $('#fSect');
  if (sel.options.length !== sects.length + 1) sel.innerHTML = '<option value="">Tous les secteurs</option>' + sects.map(s => `<option>${esc(s)}</option>`).join('');
  sel.value = state.sect;
  const q = state.q.toLowerCase();
  const flt = state.priv ? 'all' : state.filter;
  let rows = items.filter(({ s }) => (flt === 'all' || (flt === 'own') === !!s.owned) && (!state.sect || (s.etf ? 'ETF' : s.sector) === state.sect) && (!state.reg || regionOf(s) === state.reg) && (!q || s.name.toLowerCase().includes(q) || s.ticker.toLowerCase().includes(q)));
  sortRows(rows, state.sortAll, (x, k) => ({ name: nice(x.s.name), price: x.s.price, chg: x.s.chg, score: x.a.score, verdict: x.a.score, pe: x.s.fpe || x.s.pe, disc: x.a.disc, up: x.a.up }[k]));
  $('#tAll tbody').innerHTML = rows.map(({ s, a }) => `<tr data-t="${esc(s.ticker)}">
    <td><div class="idn" style="align-items:center">${logo(s.ticker, s.name, 'sm')}<div><b>${esc(nice(s.name))}</b> <span class="tk">${esc(s.ticker)}</span>${badges(s)}${s.owned ? ' <span class="pill v-con priv" style="padding:1px 7px">détenu</span>' : ''}</div></div></td>
    <td class="r num">${nf(s.price)}</td><td class="r num">${cp(s.chg)}</td>
    <td class="r num"><b>${a.score}</b></td><td><span class="pill ${a.verdict.c}">${a.verdict.h}</span></td>
    <td class="r num">${s.etf ? '–' : nf(s.fpe || s.pe, 1)}</td><td class="r num">${pct(a.disc, 0, false)}</td><td class="r num ${a.up > 0 ? 'up' : a.up < 0 ? 'down' : ''}">${a.up == null ? '–' : pct(a.up, 0)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucun titre ne correspond.</td></tr>';
}
function nice(n) { // "ALPHABET INC." -> "Alphabet Inc."
  if (!n) return ''; if (n !== n.toUpperCase()) return n;
  return n.toLowerCase().replace(/(^|[\s\-&(.])([a-zà-ü])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bInc\b/g, 'Inc').replace(/\bAnd\b/g, 'and');
}

/* ---------- charts ---------- */
function themeOpts() {
  return { ink: css('--ink'), muted: css('--muted'), line: css('--line'), accent: css('--accent'), warn: css('--warn'), good: css('--good'), mid: css('--mid'), surface: css('--surface'), font: css('--f-body') };
}
function renderCharts(pf, items) {
  if (!window.Chart) return;
  const th = themeOpts();
  Chart.defaults.color = th.muted; Chart.defaults.font.family = th.font; Chart.defaults.borderColor = th.line;
  const tip = { backgroundColor: th.surface, titleColor: th.ink, bodyColor: th.ink, borderColor: th.line, borderWidth: 1, padding: 10 };
  // scatter
  const pts = items.filter(x => x.a.disc != null).map(x => ({ x: Math.round(x.a.disc * 100), y: x.a.score, t: x.s.ticker, own: x.s.owned, n: nice(x.s.name) }));
  const ds = state.priv ? [{ label: 'Titres', data: pts, backgroundColor: th.warn }] : [{ label: 'Je détiens', data: pts.filter(p => p.own), backgroundColor: th.accent }, { label: 'Surveillé', data: pts.filter(p => !p.own), backgroundColor: th.warn }];
  upsert('cMap', { type: 'scatter', data: { datasets: ds.map(d => ({ ...d, pointRadius: 5, pointHoverRadius: 8 })) },
    options: { maintainAspectRatio: false, animation: ANIM, plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { label: c => `${c.raw.n} (${c.raw.t}) · score ${c.raw.y} · ${c.raw.x} % sous sommet` } } },
      scales: { x: { title: { display: true, text: '% sous le sommet de 52 semaines' }, grid: { color: th.line }, min: 0 }, y: { title: { display: true, text: 'Score radar' }, grid: { color: th.line }, min: 0, max: 100 } },
      onClick: (e, els, ch) => { const el = els[0]; if (el) openDrawer(ch.data.datasets[el.datasetIndex].data[el.index].t); } } });
  // sectors
  if (pf) {
    const tg = state.meta.sectorTargets || {};
    const keys = [...new Set([...Object.keys(tg), ...Object.keys(pf.sect)])];
    upsert('cSect', { type: 'bar', data: { labels: keys, datasets: [
      { label: 'Actuel', data: keys.map(k => +((pf.sect[k] || 0) * 100).toFixed(1)), backgroundColor: th.accent, borderRadius: 4 },
      { label: 'Cible', data: keys.map(k => tg[k] != null ? tg[k] * 100 : null), backgroundColor: th.line, borderRadius: 4 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, animation: ANIM, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { ...tip, callbacks: { label: c => `${c.dataset.label} : ${nf(c.raw, 1)} %` } } },
        scales: { x: { grid: { color: th.line }, ticks: { callback: v => v + ' %' } }, y: { grid: { display: false } } } } });
    const over = keys.filter(k => tg[k] != null && (pf.sect[k] || 0) > tg[k] + 0.05), under = keys.filter(k => tg[k] != null && (pf.sect[k] || 0) < tg[k] - 0.05);
    $('#sectNote').textContent = (over.length ? `Surpondéré : ${over.join(', ')}. ` : '') + (under.length ? `Sous la cible : ${under.join(', ')}.` : 'Proche des cibles de ta feuille Analyse.');
    const h = (state.meta.history || []).filter(p => p.d < '2026-11-03');
    const today = new Date().toISOString().slice(0, 10);
    h.push({ d: today, wallet: Math.round(pf.total), live: true });
    upsert('cHist', { type: 'line', data: { labels: h.map(p => new Date(p.d + 'T12:00').toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })), datasets: [
      { label: 'Valeur', data: h.map(p => p.wallet), borderColor: th.accent, backgroundColor: th.accent + '22', fill: true, tension: .3, pointRadius: 3 },
      ] },
      options: { maintainAspectRatio: false, animation: ANIM, plugins: { legend: { display: false }, tooltip: { enabled: false },
          crosshair: { enabled: true, mode: 'index', onMove: i => { const p = h[i ?? h.length - 1]; const f = h[0]; $('#hRead').innerHTML = `${new Date(p.d + 'T12:00').toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' })}${p.live ? ' (en direct)' : ''} · <b>${money(p.wallet)}</b> · <span class="${p.wallet >= f.wallet ? 'up' : 'down'}">${pct(p.wallet / f.wallet - 1, 1)}</span> depuis le ${new Date(f.d + 'T12:00').toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })}`; } } },
        scales: { y: { grid: { color: th.line }, ticks: { callback: v => nf(v / 1000, 0) + ' k$' } }, x: { grid: { display: false } } } } });
    if (!charts.cHist?.$cx) charts.cHist.options.plugins.crosshair.onMove(null);
  }
}
/* crosshair: vertical guide + live readout while the pointer (or finger) moves on a chart */
const crosshair = {
  id: 'crosshair',
  afterEvent(chart, args) {
    const o = chart.options.plugins.crosshair; if (!o || !o.enabled) return;
    const e = args.event;
    if (e.type === 'mouseout') { chart.$cx = null; o.onMove && o.onMove(null); args.changed = true; return; }
    if (!['mousemove', 'touchmove', 'touchstart', 'click'].includes(e.type)) return;
    const els = chart.getElementsAtEventForMode(e, o.mode || 'nearest', { intersect: false, axis: 'x' }, false).filter(x => x.datasetIndex === (o.dataset || 0));
    if (!els.length) return;
    const el = els[0];
    if (chart.$cx && chart.$cx.index === el.index) return;
    chart.$cx = { index: el.index, x: el.element.x, y: el.element.y };
    o.onMove && o.onMove(el.index);
    args.changed = true;
  },
  afterDatasetsDraw(chart) {
    const o = chart.options.plugins.crosshair; const c = chart.$cx;
    if (!o || !o.enabled || !c) return;
    const { ctx, chartArea: a } = chart;
    ctx.save(); ctx.strokeStyle = css('--muted'); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(c.x, a.top); ctx.lineTo(c.x, a.bottom); ctx.stroke();
    if (o.dot !== false) { ctx.setLineDash([]); ctx.fillStyle = css('--surface'); ctx.strokeStyle = o.color || css('--accent'); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c.x, c.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    ctx.restore();
  }
};
if (window.Chart) Chart.register(crosshair);

function freshDate(s) { return s.chgDate || (s.hist && s.hist.length ? s.hist[s.hist.length - 1].d : null); }
function renderHero(pf, items) {
  const el = $('#hero'); if (!el) return;
  const all = Object.values(state.stocks);
  const fresh = all.filter(s => s.chg != null);
  const up = fresh.filter(s => s.chg > 0).length, down = fresh.filter(s => s.chg < 0).length;
  const avg = Math.round(avgOf(items.map(x => x.a.score)) || 0);
  const pick = items.filter(x => !x.s.etf && (state.priv || !x.s.owned)).sort((a, b) => b.a.score - a.a.score)[0];
  const d0 = state.status?.day;
  let left;
  if (pf && !state.priv) {
    let dv = 0, base = 0; pf.rows.forEach(r => { const s = r.s; if (!s || s.chg == null) return; const prev = r.value / (1 + s.chg); dv += r.value - prev; base += prev; });
    const gain = pf.total - pf.cost;
    const hist = (state.meta.history || []).filter(p => p && p.d < '2026-11-03' && p.wallet > 0).slice(-120).map(p => p.wallet);
    hist.push(pf.total);
    const W = 300, H = 60, path = hist.length > 4 ? sparkPath(hist, W, H) : '';
    left = `<span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-wallet"/></svg> Valeur du portefeuille</span>
      <div class="big" data-count="${Math.round(pf.total)}" data-suffix=" $">${money(pf.total)}</div>
      <div class="sub">${base ? `<span class="cp ${dv >= 0 ? 'up' : 'down'}">${dv >= 0 ? '+' : '−'}${money(Math.abs(dv))} · ${pct(dv / base, 2)}</span> aujourd'hui` : ''}<span>·</span><span>Gain total <b class="${gain >= 0 ? 'up' : 'down'}">${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))} (${pct(gain / pf.cost, 1)})</b></span></div>
      ${path ? `<div class="hspark spark ${hist[hist.length - 1] >= hist[0] ? 'up' : 'down'}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="${path}L${W},${H}L0,${H}Z"/><path d="${path}"/></svg></div>` : ''}`;
  } else {
    const mood = d0?.verdict && !/portefeuille/i.test(d0.verdict) ? d0.verdict : (up > down * 1.3 ? T('Bonne journée', 'Good day') : down > up * 1.3 ? T('Journée difficile', 'Tough day') : T('Journée tranquille', 'Quiet day'));
    left = `<span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-radar"/></svg> ${T('Le marché en bref', 'Market at a glance')}</span>
      <div class="big">${esc(state.lang === 'en' ? mood.replace('Bonne journée', 'Good day').replace('Journée difficile', 'Tough day').replace('Journée tranquille', 'Quiet day') : mood)}</div>
      <div class="sub">${(d0?.indices || []).map(i => `<span>${esc(i.n)} ${cp(i.chg)}</span>`).join('')}</div>`;
  }
  left += `<div class="stats"><div><b data-count="${all.length}">${all.length}</b><span>${T('titres suivis', 'stocks tracked')}</span></div><div><b class="up">${up}</b><span>${T('en hausse', 'up')}</span></div><div><b class="down">${down}</b><span>${T('en baisse', 'down')}</span></div><div><b>${avg}</b><span>${T('score moyen', 'avg score')}</span></div></div>`;
  const right = pick ? `<span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-star"/></svg> ${T('Le titre le mieux noté', 'Top-rated stock')}</span>
    <button class="hero-pick" data-t="${esc(pick.s.ticker)}">
      <div class="row"><div class="idn">${logo(pick.s.ticker, pick.s.name, 'lg')}<div><div class="tk">${esc(pick.s.ticker)} · ${esc(pick.s.sector || '')}</div><div class="nm">${esc(nice(pick.s.name))}</div></div></div>${ring(pick.a.score, pick.a.verdict.col)}</div>
      <div class="row" style="align-items:center"><span class="pill ${pick.a.verdict.c}">${pick.a.verdict.h}</span><span class="num">${nf(pick.s.price)} ${cp(pick.s.chg)}</span></div>
      ${spark(pick.s)}
      ${pick.a.pros[0] ? `<p class="note" style="margin:0">${esc(pick.a.pros[0])}</p>` : ''}
    </button>` : '';
  el.innerHTML = `<div class="hero-l">${left}</div><div class="hero-r">${right}</div>`;
  if (!REDUCED) el.querySelectorAll('[data-count]').forEach(n => { const to = +n.dataset.count, suf = n.dataset.suffix || '', t0 = performance.now(); const st = now => { const k = Math.min(1, (now - t0) / 900), e = 1 - Math.pow(1 - k, 3); n.textContent = nf(to * e, 0) + suf; if (k < 1) requestAnimationFrame(st); }; if (!el.dataset.done) requestAnimationFrame(st); });
  el.dataset.done = '1';
}
function openWithTransition(t) {
  const src = t.closest('.card, .hero-pick');
  if (!document.startViewTransition || REDUCED || !src || innerWidth < 761) { openDrawer(t.dataset.t); return; }
  src.style.viewTransitionName = 'pick';
  const vt = document.startViewTransition(() => { src.style.viewTransitionName = ''; $('#drawer').style.viewTransitionName = 'pick'; openDrawer(t.dataset.t); });
  vt.finished.finally(() => { $('#drawer').style.viewTransitionName = ''; });
}
/* recherche globale : / ou Ctrl+K */
function openSearch() {
  if ($('#cmdk')) return;
  const ov = document.createElement('div'); ov.className = 'cmdk'; ov.id = 'cmdk';
  ov.innerHTML = `<div class="box2" role="dialog" aria-modal="true" aria-label="${T('Rechercher un titre', 'Search a stock')}"><div class="in"><svg class="i" aria-hidden="true"><use href="#i-search"/></svg><input id="qIn" type="search" autocomplete="off" spellcheck="false" placeholder="${T('Nom ou symbole : Apple, RY.TO, Nvidia…', 'Name or symbol: Apple, RY.TO, Nvidia…')}" aria-controls="qList"><kbd>Esc</kbd></div><ul id="qList" role="listbox"></ul><div class="hint"><span><kbd>↑</kbd> <kbd>↓</kbd> ${T('choisir', 'move')}</span><span><kbd>Entrée</kbd> ${T('ouvrir', 'open')}</span></div></div>`;
  document.body.appendChild(ov);
  const inp = $('#qIn'), list = $('#qList'); let sel = 0, res = [];
  const norm = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const scoreOf = s => { try { return analyze(s).score; } catch (e) { return 0; } };
  const all = Object.values(state.stocks).map(s => ({ s, sc: scoreOf(s) }));
  const draw = () => {
    const q = norm(inp.value.trim());
    res = (q ? all.map(x => { const t = norm(x.s.ticker), n = norm(nice(x.s.name)); const r = t === q ? 0 : t.startsWith(q) ? 1 : n.startsWith(q) ? 2 : n.includes(' ' + q) ? 3 : (t.includes(q) || n.includes(q)) ? 4 : 9; return { ...x, r }; }).filter(x => x.r < 9).sort((a, b) => a.r - b.r || b.sc - a.sc)
      : all.slice().sort((a, b) => b.sc - a.sc)).slice(0, 8);
    sel = Math.min(sel, Math.max(0, res.length - 1));
    list.innerHTML = (q ? '' : `<span class="lbl">${T('Les mieux notés', 'Top rated')}</span>`) + (res.map((x, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}">${logo(x.s.ticker, x.s.name, 'sm')}<span style="min-width:0"><span class="nm2">${esc(nice(x.s.name))}</span><span class="tk">${esc(x.s.ticker)} · ${esc(x.s.sector || '')}</span></span><span class="num">${nf(x.s.price)} ${cp(x.s.chg)}</span><span class="sc">${x.sc}</span></li>`).join('') || `<li class="note" style="display:block">${T('Aucun titre ne correspond.', 'No match.')}</li>`);
  };
  const close = () => { ov.remove(); document.removeEventListener('keydown', key, true); };
  const go = i => { const x = res[i]; if (!x) return; close(); openDrawer(x.s.ticker); };
  const key = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(res.length - 1, sel + 1); draw(); list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
  };
  document.addEventListener('keydown', key, true);
  inp.oninput = () => { sel = 0; draw(); };
  list.onclick = e => { const li = e.target.closest('li[data-i]'); if (li) go(+li.dataset.i); };
  list.onmousemove = e => { const li = e.target.closest('li[data-i]'); if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; list.querySelectorAll('li[data-i]').forEach(l => l.setAttribute('aria-selected', String(+l.dataset.i === sel))); } };
  ov.onclick = e => { if (e.target === ov) close(); };
  draw(); setTimeout(() => inp.focus(), 30);
}
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); openSearch(); }
});
document.addEventListener('click', e => { if (e.target.closest('#searchBtn')) openSearch(); });
function renderDay(pf) {
  const all = Object.values(state.stocks).filter(s => s.chg != null && freshDate(s));
  if (!all.length) { $('#journee').hidden = true; return; }
  $('#journee').hidden = false;
  const last = all.reduce((m, s) => freshDate(s) > m ? freshDate(s) : m, '');
  const fresh = all.filter(s => freshDate(s) === last);
  const mine = fresh.filter(s => s.owned), watch = state.priv ? fresh : fresh.filter(s => !s.owned);
  let dv = 0, base = 0, nMine = 0;
  if (pf) pf.rows.forEach(r => { const s = r.s; if (!s || s.chg == null || freshDate(s) !== last) return; const prev = r.value / (1 + s.chg); dv += r.value - prev; base += prev; nMine++; });
  const dp = base ? dv / base : null;
  const d0 = state.status?.day?.date === last ? state.status.day : null;
  const mood = state.priv ? (d0?.indices?.length ? (avgOf(d0.indices.map(i => i.chg)) > 0.003 ? 'Bonne journée pour le marché' : avgOf(d0.indices.map(i => i.chg)) < -0.003 ? 'Journée difficile pour le marché' : 'Marché tranquille') : 'Le marché aujourd\'hui') : d0?.verdict || (dp == null ? 'Journée tranquille' : dp > 0.005 ? 'Bonne journée' : dp < -0.005 ? 'Journée difficile' : 'Journée tranquille');
  const moodCls = /bonne/i.test(mood) ? 'up' : /difficile|mauvaise/i.test(mood) ? 'down' : '';
  const up = mine.filter(s => s.chg > 0).length, down = mine.filter(s => s.chg < 0).length;
  const dateTxt = new Date(last + 'T12:00').toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' });
  const list = (arr, dir) => arr.slice().sort((a, b) => dir * (b.chg - a.chg)).filter(s => dir > 0 ? s.chg > 0 : s.chg < 0).slice(0, 3)
    .map(s => `<div class="r" data-t="${esc(s.ticker)}"><span><b>${esc(s.ticker)}</b> <span class="muted">${esc(nice(s.name))}</span></span><span class="num">${cp(s.chg)}</span></div>`).join('') || '<span class="note">Aucun</span>';
  $('#journee').innerHTML = `
    <div><span class="lbl">${state.unlocked ? 'Ta journée' : T('La journée', 'The day')} · ${esc(dateTxt)}</span>
      <h2 class="${moodCls}" style="margin-top:4px">${moodCls === 'up' ? '<svg class="i" aria-hidden="true"><use href="#i-sun"/></svg>' : moodCls === 'down' ? '<svg class="i" aria-hidden="true"><use href="#i-rain"/></svg>' : '<svg class="i" aria-hidden="true"><use href="#i-partly"/></svg>'} ${esc(mood)}</h2>
      ${dp != null ? `<div class="priv"><div class="num" style="font-size:18px;margin-top:4px"><span class="${dv >= 0 ? 'up' : 'down'}">${dv >= 0 ? '+' : '−'}${money(Math.abs(dv))} (${pct(dp, 2)})</span></div><div class="note">${up} de tes titres en hausse, ${down} en baisse (${nMine} titres avec un prix du jour)</div></div>` : ''}
      ${d0?.indices?.length ? `<div class="idx">${d0.indices.map(i => `<span>${esc(i.n)} <b class="${i.chg >= 0 ? 'up' : 'down'}">${pct(i.chg, 2)}</b></span>`).join('')}</div>` : ''}
      ${d0?.text ? `<p class="note" style="margin:8px 0 0">${esc(d0.text)}</p>` : ''}
    </div>
    <div class="priv"><span class="lbl">Mes titres</span>
      <div class="note" style="margin-top:6px"><svg class="i up" aria-hidden="true"><use href="#i-trend-up"/></svg> Plus fortes hausses</div><div class="mv">${list(mine, 1)}</div>
      <div class="note" style="margin-top:6px"><svg class="i down" aria-hidden="true"><use href="#i-trend-down"/></svg> Plus fortes baisses</div><div class="mv">${list(mine, -1)}</div></div>
    <div><span class="lbl"><span class="priv">Ma liste de surveillance</span><span class="pubonly">Titres suivis</span></span>
      <div class="note" style="margin-top:6px"><svg class="i up" aria-hidden="true"><use href="#i-trend-up"/></svg> Plus fortes hausses</div><div class="mv">${list(watch, 1)}</div>
      <div class="note" style="margin-top:6px"><svg class="i down" aria-hidden="true"><use href="#i-trend-down"/></svg> Plus fortes baisses</div><div class="mv">${list(watch, -1)}</div></div>`;
}

function upsert(id, cfg) {
  const c = charts[id];
  if (c) { c.data = cfg.data; c.options = cfg.options; c.update('none'); return c; }
  return charts[id] = new Chart(document.getElementById(id), cfg);
}

/* ---------- detail drawer ---------- */
(() => {
  let y0 = null, x0 = null;
  document.addEventListener('touchstart', e => { const d = e.target.closest('#drawer'); if (!d || d.scrollTop > 0 || innerWidth > 760) { y0 = null; return; } y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', e => { if (y0 == null) return; const t = e.changedTouches[0]; if (t.clientY - y0 > 110 && Math.abs(t.clientX - x0) < 60) closeDrawer(); y0 = null; }, { passive: true });
})();
function openDrawer(t) { state.open = t; renderDrawer(t, true); }
function closeDrawer() { state.open = null; state.form = false; render(); $('#drawer').hidden = true; $('#scrim').hidden = true; ['cPrice', 'cSnow', 'cWater', 'cFin'].forEach(k => { if (charts[k]) { charts[k].destroy(); delete charts[k]; } }); }
let aiCtl = null;
function renderDrawer(t, focus) {
  const s = state.stocks[t]; if (!s) return;
  const pf = portfolio(); const a = analyze(s, pf);
  const hold = state.priv ? null : pf?.rows.find(r => r.t === t);
  if (state.priv) { const personal = /portefeuille|ta position|tu détiens/i; a.pros = a.pros.filter(r => !personal.test(r)); a.cons = a.cons.filter(r => !personal.test(r)); }
  const sc = s.scores || {};
  const inv = [['Buffett', sc.buffett, 'valeur'], ['Burry', sc.burry, 'contrarien'], ['Duckett', sc.duckett, 'dividendes'], ['Fink', sc.fink, 'long terme'], ['Jensen', sc.jensen, 'croissance']].filter(x => x[1] != null);
  const d = $('#drawer');
  const prevAi = d.querySelector('#aiOut')?.innerHTML;
  const keepAi = d.dataset.t === t && prevAi;
  d.dataset.t = t;
  d.innerHTML = `
    <div class="dh"><div><div class="tk">${esc(s.ticker)} · ${esc(s.sector || '')} · ${esc(s.region && regionOf(s) === 'International' ? s.region : regionOf(s))}<span class="priv">${s.owned ? ' · détenu' : ' · surveillé'}</span></div><h2 id="dName">${esc(nice(s.name))}</h2>
      <div class="num" style="font-size:20px;margin-top:4px">${nf(s.price)} <span style="font-size:14px" class="${s.chg >= 0 ? 'up' : 'down'}">${s.chg >= 0 ? '▲' : '▼'} ${pct(s.chg, 2)} aujourd'hui</span></div><div style="margin-top:4px">${badges(s)}</div></div>
      <button class="close" id="xClose" aria-label="Fermer">×</button></div>
    ${(() => { const x = splitList().find(z => z.t === s.ticker); return x ? `<div class="alert"><b>${esc(splitTxt(x))} · ${esc(x.date)}${x.recorded ? '' : ' (à confirmer)'}</b><span class="note">Après un fractionnement, tu as plus d'actions à un prix plus bas : la valeur de ta position ne change pas.${x.recorded ? ' Les prix passés du graphique sont ajustés.' : ''}</span></div>` : ''; })()}
    <div class="box" style="flex-direction:row;align-items:center;gap:14px">${ring(a.score, a.verdict.col)}<div><span class="pill ${a.verdict.c}">${a.verdict.h}</span><div class="note" style="margin-top:4px">${s.radarScore != null ? `${s.snow ? T('Profil 30 critères', '30-check profile') + ' (75 %) + ' : ''}${T('modèles investisseurs', 'investor models')} (${s.snow ? '25 %' : '50 %'}) : ${s.radarScore}${a.cl ? ` · ${T('ajustement', 'adjustment')} ${a.cl > 0 ? '+' : ''}${a.cl} (${state.unlocked ? T('ton portefeuille et grands investisseurs', 'your portfolio and great investors') : T('grands investisseurs', 'great investors')})` : ''}` : `${T('règles marché', 'market rules')} ${a.rule}/100`}${(() => { const tr = trend(s); return tr ? ` · tendance ${tr.d >= 0 ? '+' : ''}${tr.d} sur ${tr.days} j` : ''; })()}</div></div></div>
    <div class="box"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-chart"/></svg> Évolution de l'action</span>
      <div class="seg" role="group" aria-label="Période" id="pRange">${[['3m', '3 mois'], ['6m', '6 mois'], ['1y', '1 an'], ['all', 'Tout']].map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${state.range === k}">${l}</button>`).join('')}</div></div>
      <div id="pStats" class="note"></div>
      <div class="read" id="pRead"></div>
      ${(s.hist || []).length > 1 ? '<div class="chartbox sm"><canvas id="cPrice" aria-label="Évolution du prix de l\'action"></canvas></div>' : '<span class="note">L\'historique sur un an est en train d\'être chargé par la mise à jour automatique. Il apparaîtra ici d\'ici quelques jours.</span>'}
    </div>
    ${fundBox(s)}
    ${s.summary ? `<div class="box"><span class="lbl">En bref</span><p style="margin:0">${esc(s.summary)}</p></div>` : ''}
    <div class="cols2">
      <div class="box g"><h3><svg class="i up" aria-hidden="true"><use href="#i-check"/></svg> Pourquoi investir</h3><ul class="reasons">${a.pros.map(r => `<li>${esc(r)}</li>`).join('') || '<li class="muted">Rien de marquant</li>'}</ul></div>
      <div class="box b"><h3><svg class="i down" aria-hidden="true"><use href="#i-x"/></svg> Pourquoi s'abstenir</h3><ul class="reasons">${a.cons.map(r => `<li class="c">${esc(r)}</li>`).join('') || '<li class="muted">Aucun signal négatif marquant</li>'}</ul></div>
    </div>
    <div class="facts">
      <div><span class="lbl">P/E</span><div class="v">${s.etf ? '–' : nf(s.pe, 1)}</div></div>
      <div><span class="lbl">P/E prévu</span><div class="v">${nf(s.fpe, 1)}</div></div>
      <div><span class="lbl">Bêta</span><div class="v">${nf(s.beta, 2)}</div></div>
      <div><span class="lbl">Capitalisation</span><div class="v">${big(s.mcap)}</div></div>
      <div><span class="lbl">Cible analystes</span><div class="v">${s.target ? nf(s.target) : '–'}</div></div>
      <div><span class="lbl">Consensus</span><div class="v" style="font-size:13px">${esc(s.rating || '–')}</div></div>
      <div><span class="lbl">Dividende / an</span><div class="v">${s.divAnnual ? nf(s.divAnnual, 2) + (s.price ? ` <span class="note">(${pct(s.divAnnual / s.price, 1, false)})</span>` : '') : s.divAnnual === 0 ? 'Aucun' : '–'}</div></div>
      <div><span class="lbl">Prochains résultats</span><div class="v" style="font-size:13px">${esc(s.nextEarnings || '–')}</div></div>
      <div><span class="lbl">Devise</span><div class="v" style="font-size:13px">${esc(s.cur || (/\.(TO|V)$/.test(s.ticker) ? 'CAD' : 'USD'))}</div></div>
    </div>
    <div class="box"><span class="lbl">Fourchette de 52 semaines</span>${rangeBar(s) || '<span class="muted">Non disponible</span>'}</div>
    ${hold ? `<div class="box"><span class="lbl">Ta position</span><div class="num">${nf(hold.h.qty, 4)} actions · prix moyen ${nf(hold.h.avg)} ${hold.h.cur} · ${money(hold.value)} · <span class="${hold.gain >= 0 ? 'up' : 'down'}">${pct(hold.gain, 1)}</span></div><div class="note">${esc(hold.h.accounts.join(' · '))} · ${pct(hold.w, 1, false)} du portefeuille</div></div>` : ''}
    ${state.priv ? '' : sellBox(s, a, pf)}
    ${inv.length ? `<div class="box"><span class="lbl">Scores par style d'investisseur</span><div class="inv">${inv.map(([n, v, k]) => `<div title="${k}"><span>${n}</span><span class="t"><i style="width:${v}%"></i></span><span class="num">${Math.round(v)}</span></div>`).join('')}</div></div>` : ''}
    <div class="box"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-news"/></svg> À savoir</span>${(s.news || []).length ? `<ul class="news">${s.news.map(n => `<li><span class="d">${esc(n.d || '')}</span><span>${esc(n.t)}</span></li>`).join('')}</ul>` : '<span class="note">Les nouvelles s\'ajoutent à la prochaine mise à jour automatique.</span>'}</div>
    <div class="box" id="aiBox"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-spark"/></svg> Avis de Claude</span><span><button class="btn" id="aiStop" hidden>Arrêter</button> <button class="btn primary" id="aiGo">Analyser ce titre</button></span></div>
      <div class="ai" id="aiOut">${keepAi ? prevAi : '<span class="note">Claude lit les chiffres ci-dessus et ton portefeuille, puis te donne un avis équilibré.</span>'}</div></div>
    ${state.canWrite !== false ? `<div class="box priv"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-bell"/></svg> Alerte de prix</span>
      <div class="form" style="grid-template-columns:1fr 1fr auto auto;align-items:end">
        <label>M'avertir sous<input type="number" step="any" min="0" id="alB" value="${state.alerts[s.ticker]?.below ?? ''}" placeholder="ex. ${s.price ? nf(s.price * 0.9, 2).replace(/\s/g, '') : ''}"></label>
        <label>M'avertir au-dessus de<input type="number" step="any" min="0" id="alA" value="${state.alerts[s.ticker]?.above ?? ''}"></label>
        <button class="btn primary" id="alSave" type="button">Enregistrer</button>${state.alerts[s.ticker] ? '<button class="btn" id="alDel" type="button">Retirer</button>' : '<span></span>'}
      </div><span class="note" id="alMsg">L'alerte s'affiche dans « Aujourd'hui » et sur le titre dès que le prix mis à jour franchit ton seuil.</span></div>` : ''}
    ${state.canWrite !== false ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn priv" id="dTx">${s.owned ? 'Enregistrer un achat ou une vente' : 'J\'ai acheté ce titre'}</button>${s.owned ? '' : '<button class="btn" id="dDel">Retirer de ma liste</button>'}</div>` : ''}
    <p class="note"><svg class="i" aria-hidden="true"><use href="#i-clock"/></svg> Source : ${esc(s.source || '–')} · mis à jour ${esc(fmtDate(s.updatedAt))}${s.updatedAt && Date.now() - Date.parse(s.updatedAt) > 8 * 864e5 ? ' · <span class="down"><svg class="i" aria-hidden="true"><use href="#i-alert"/></svg> analyse de plus de 8 jours, elle sera rafraîchie à une prochaine mise à jour</span>' : ''}</p>`;
  d.hidden = false; $('#scrim').hidden = false;
  $('#xClose').onclick = closeDrawer;
  const dTx = $('#dTx'); if (dTx) dTx.onclick = () => openTxForm(s.ticker);
  const dDel = $('#dDel'); if (dDel) dDel.onclick = () => removeWatch(s.ticker, dDel);
  const alSave = $('#alSave'); if (alSave) alSave.onclick = async () => {
    const b = parseFloat($('#alB').value), ab = parseFloat($('#alA').value);
    if (!(b > 0) && !(ab > 0)) { $('#alMsg').textContent = 'Entre au moins un prix plus grand que 0.'; return; }
    try { await DB.doc('alerts/' + docId(s.ticker)).set({ t: s.ticker, below: b > 0 ? b : null, above: ab > 0 ? ab : null, createdAt: new Date().toISOString() }); $('#alMsg').textContent = 'Alerte enregistrée.'; }
    catch (e) { $('#alMsg').textContent = 'L\'alerte n\'a pas pu être enregistrée.'; }
  };
  const alDel = $('#alDel'); if (alDel) alDel.onclick = async () => { try { await DB.doc('alerts/' + docId(s.ticker)).delete(); } catch (e) {} };
  if (focus) { d.scrollTop = 0; $('#xClose').focus(); }
  wireAi(s, a, hold);
  document.querySelectorAll('#pRange button').forEach(b => b.onclick = () => { state.range = b.dataset.r; document.querySelectorAll('#pRange button').forEach(x => x.setAttribute('aria-pressed', x === b)); drawPrice(s, hold); });
  drawPrice(s, hold);
  drawFund(s);
}
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const avgOf = arr => { const v = arr.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
// ----- profil en 5 axes : 30 critères calculés chaque jour par la mise à jour automatique
const AXK = ['value', 'future', 'past', 'health', 'dividend'];
const AXN = { value: ['Valeur', 'Value'], future: ['Futur', 'Future'], past: ['Passé', 'Past'], health: ['Santé', 'Health'], dividend: ['Dividende', 'Dividend'] };
const AXQ = { value: ['Le prix est-il bas par rapport à sa valeur, au marché et aux analystes ?', 'Is the price low versus its value, the market and analysts?'],
  future: ['Les profits et les revenus devraient-ils croître rapidement ?', 'Are earnings and revenue expected to grow fast?'],
  past: ['L\'entreprise a-t-elle bien performé ces dernières années ?', 'Has the company performed well in recent years?'],
  health: ['Le bilan est-il solide (liquidités, dette, intérêts) ?', 'Is the balance sheet solid (cash, debt, interest)?'],
  dividend: ['Le dividende est-il intéressant, stable et bien couvert ?', 'Is the dividend attractive, stable and well covered?'] };
const pc0 = v => pct(v, 1, false);
const SRC = b => b === 'f' ? T(' (prévision des analystes)', ' (analyst forecast)') : b === 'r' ? T(' (dernier trimestre sur un an)', ' (latest quarter, year over year)') : '';
const NOD = () => T('Donnée pas encore disponible', 'Data not available yet');
const CK = {
  v1: [['Sous la valeur estimée (DCF)', 'Below fair value (DCF)'], (a, b) => b ? T(`Prix ${nf(a)} pour une valeur estimée de ${nf(b)}`, `Price ${nf(a)} vs fair value ${nf(b)}`) : T('Aucune valeur estimée', 'No fair value')],
  v2: [['Nettement sous la valeur (20 % ou plus)', 'Well below fair value (20 %+)'], a => a == null ? T('Aucune valeur estimée', 'No fair value') : a >= 0 ? T(`${pc0(a)} sous la valeur estimée`, `${pc0(a)} below fair value`) : T(`${pc0(-a)} au-dessus de la valeur estimée`, `${pc0(-a)} above fair value`)],
  v3: [['P/E plus bas que le secteur', 'P/E below sector'], (a, b) => a ? T(`P/E de ${nf(a, 1)} contre ${nf(b, 1)} pour son secteur`, `P/E ${nf(a, 1)} vs ${nf(b, 1)} for its sector`) : T('Pas de bénéfice : P/E non calculable', 'No earnings: no P/E')],
  v4: [['P/E plus bas que le marché', 'P/E below market'], (a, b) => a ? T(`P/E de ${nf(a, 1)} contre ${nf(b, 1)} pour le marché`, `P/E ${nf(a, 1)} vs ${nf(b, 1)} for the market`) : T('Pas de bénéfice : P/E non calculable', 'No earnings: no P/E')],
  v5: [['P/E justifié par la croissance (PEG)', 'P/E justified by growth (PEG)'], (a, b) => a ? T(`PEG de ${nf(a, 2)} (intéressant sous 1,5)`, `PEG ${nf(a, 2)} (attractive below 1.5)`) : b != null && b <= 0 ? T('Profits prévus en baisse', 'Earnings expected to fall') : T('P/E ou croissance prévue manquant', 'P/E or forecast missing')],
  v6: [['Potentiel de 20 % selon les analystes', '20 % upside per analysts'], (a, b) => a != null ? T(`Cible moyenne de ${nf(b)} : ${pct(a, 1)}`, `Mean target ${nf(b)}: ${pct(a, 1)}`) : T('Aucune cible d\'analystes', 'No analyst target')],
  f1: [['Profits qui battent l\'épargne (3 %)', 'Earnings beat savings rate (3 %)'], (a, b) => `${pct(a, 1)}${T(' par an', ' a year')}${SRC(b)}`],
  f2: [['Profits qui croissent plus que le marché', 'Earnings grow faster than market'], (a, b) => T(`${pct(a, 1)} contre ${pct(b, 1)} pour le marché`, `${pct(a, 1)} vs ${pct(b, 1)} for the market`)],
  f3: [['Forte croissance des profits (plus de 20 %)', 'High earnings growth (20 %+)'], (a, b) => `${pct(a, 1)}${SRC(b)}`],
  f4: [['Revenus qui croissent plus que le marché', 'Revenue grows faster than market'], (a, b) => T(`${pct(a, 1)} contre ${pct(b, 1)} pour le marché`, `${pct(a, 1)} vs ${pct(b, 1)} for the market`)],
  f5: [['Forte croissance des revenus (plus de 20 %)', 'High revenue growth (20 %+)'], (a, b) => `${pct(a, 1)}${SRC(b)}`],
  f6: [['Bénéfice par action prévu en hausse de 10 %', 'EPS expected up 10 %'], (a, b) => T(`BPA de ${nf(b)} aujourd'hui, ${nf(a)} prévu`, `EPS ${nf(b)} now, ${nf(a)} expected`)],
  p1: [['Profits appuyés par de vrais flux de trésorerie', 'Earnings backed by real cash flow'], a => a != null ? T(`Le flux libre vaut ${nf(a * 100, 0)} % du profit net`, `Free cash flow is ${nf(a * 100, 0)} % of net income`) : T('Profit net négatif', 'Negative net income')],
  p2: [['Marge de profit en hausse', 'Profit margin rising'], (a, b) => T(`Marge nette de ${pc0(a)} contre ${pc0(b)} un an plus tôt`, `Net margin ${pc0(a)} vs ${pc0(b)} a year earlier`)],
  p3: [['Profits en croissance sur plusieurs années', 'Earnings growing over several years'], (a, b) => b === 'turn' ? T('Passée d\'une perte à un profit', 'Turned from a loss to a profit') : a != null ? T(`${pct(a, 1)} par an sur ${b} ans`, `${pct(a, 1)} a year over ${b} years`) : T('Perte au dernier exercice', 'Loss in last fiscal year')],
  p4: [['Croissance qui accélère', 'Growth accelerating'], (a, b) => b == null ? T('Pas de moyenne : perte au début de la période', 'No average: loss at start of period') : T(`Dernière année ${pct(a, 1)} contre ${pct(b, 1)} en moyenne`, `Last year ${pct(a, 1)} vs ${pct(b, 1)} on average`)],
  p5: [['Profits qui battent le secteur', 'Earnings beat sector'], (a, b) => T(`${pct(a, 1)} contre ${pct(b, 1)} pour son secteur`, `${pct(a, 1)} vs ${pct(b, 1)} for its sector`)],
  p6: [['Rendement des capitaux propres (ROE) de 20 %', 'Return on equity (ROE) of 20 %'], a => `ROE ${pc0(a)}`],
  h1: [['Actifs à court terme plus grands que les dettes à court terme', 'Short-term assets cover short-term liabilities'], (a, b) => a != null ? `${big(a)} ${T('contre', 'vs')} ${big(b)}` : NOD()],
  h2: [['Actifs à court terme plus grands que les dettes à long terme', 'Short-term assets cover long-term liabilities'], (a, b) => `${big(a)} ${T('contre', 'vs')} ${big(b)}`],
  h3: [['Dette nette raisonnable (moins de 40 % des capitaux)', 'Reasonable net debt (under 40 % of equity)'], a => a == null ? T('Capitaux propres négatifs', 'Negative equity') : a < 0 ? T('Plus de liquidités que de dette', 'More cash than debt') : T(`Dette nette de ${pc0(a)} des capitaux propres`, `Net debt is ${pc0(a)} of equity`)],
  h4: [['Dette en baisse depuis environ 5 ans', 'Debt down over about 5 years'], (a, b) => T(`Dette sur capitaux de ${pc0(a)} contre ${pc0(b)} avant`, `Debt to equity ${pc0(a)} vs ${pc0(b)} before`)],
  h5: [['Dette couverte par les flux d\'exploitation', 'Debt covered by operating cash flow'], a => a != null ? T(`Les flux d'exploitation valent ${pc0(a)} de la dette (bon au-dessus de 20 %)`, `Operating cash flow is ${pc0(a)} of debt (good above 20 %)`) : T('Aucune dette', 'No debt')],
  h6: [['Intérêts bien couverts par les profits', 'Interest well covered by earnings'], a => a != null ? T(`Le profit d'exploitation couvre ${nf(a, 1)} fois les intérêts (bon au-dessus de 3)`, `Operating profit covers interest ${nf(a, 1)}x (good above 3)`) : T('Aucun intérêt à payer', 'No interest to pay')],
  d1: [['Dividende notable', 'Notable dividend'], (a, b) => T(`Rendement de ${pc0(a)} contre ${pc0(b)} pour le quart le plus bas`, `Yield ${pc0(a)} vs ${pc0(b)} for the bottom quarter`)],
  d2: [['Dividende élevé', 'High dividend'], (a, b) => T(`Rendement de ${pc0(a)} contre ${pc0(b)} pour le quart le plus haut`, `Yield ${pc0(a)} vs ${pc0(b)} for the top quarter`)],
  d3: [['Dividende stable', 'Stable dividend'], (a, b) => T(`${a} baisse${a > 1 ? 's' : ''} en ${b} ans`, `${a} cut${a > 1 ? 's' : ''} in ${b} years`)],
  d4: [['Dividende en croissance', 'Growing dividend'], (a, b) => T(`${pct(a, 1)} en ${b} ans`, `${pct(a, 1)} over ${b} years`)],
  d5: [['Dividende couvert par les profits', 'Dividend covered by earnings'], a => T(`Verse ${pc0(a)} de ses profits (bon sous 90 %)`, `Pays out ${pc0(a)} of earnings (good under 90 %)`)],
  d6: [['Dividende couvert par les flux de trésorerie', 'Dividend covered by cash flow'], a => a != null ? T(`Verse ${pc0(a)} de son flux libre (bon sous 90 %)`, `Pays out ${pc0(a)} of free cash flow (good under 90 %)`) : T('Flux de trésorerie libre négatif', 'Negative free cash flow')]
};
function ckText(c) {
  const [id, ok, a, b] = c; const def = CK[id]; if (!def) return ['', ''];
  const name = T(def[0][0], def[0][1]);
  if (b === 'fin') return [name, T('Non pertinent pour une banque ou un assureur', 'Not relevant for a bank or insurer')];
  if (b === 'none') return [name, T('Ne verse pas de dividende', 'Pays no dividend')];
  if (ok == null && a == null) return [name, NOD()];
  try { return [name, def[1](a, b)]; } catch (e) { return [name, NOD()]; }
}
function axisSummary(k, ax) {
  if (!ax || ax.s == null) return T('Pas assez de données pour cet axe pour l\'instant.', 'Not enough data for this axis yet.');
  const lc = x => x.charAt(0).toLowerCase() + x.slice(1);
  const ok = ax.c.filter(c => c[1] === 1).map(c => lc(T(CK[c[0]][0][0], CK[c[0]][0][1])));
  const no = ax.c.filter(c => c[1] === 0).map(c => lc(T(CK[c[0]][0][0], CK[c[0]][0][1])));
  if (k === 'dividend' && ax.c[0][3] === 'none') return T('Pas de dividende : cet axe reste vide, ce qui est normal pour une entreprise de croissance.', 'No dividend: this axis stays empty, which is normal for a growth company.');
  if (k === 'health' && ax.c[0][3] === 'fin') return T('Banque ou assureur : les règles d\'endettement habituelles ne s\'appliquent pas.', 'Bank or insurer: usual debt rules do not apply.');
  const lvl = ax.s >= 5 ? T('Point fort', 'Strength') : ax.s >= 3 ? T('Correct', 'Fair') : T('Point faible', 'Weakness');
  return `<b>${lvl}</b> · ${ok.length ? T('réussit : ', 'passes: ') + ok.slice(0, 2).join(', ') : ''}${ok.length && no.length ? ' ; ' : ''}${no.length ? T('échoue : ', 'fails: ') + no.slice(0, 2).join(', ') : ''}.`;
}
function shapeSummary(s) {
  const sn = s.snow; if (!sn) return '';
  const sc = AXK.map(k => [T(AXN[k][0], AXN[k][1]), sn[k]?.s]).filter(x => x[1] != null);
  const hi = sc.filter(x => x[1] >= 5).map(x => x[0]), lo = sc.filter(x => x[1] <= 2).map(x => x[0]);
  return (hi.length ? T('Fort en ', 'Strong in ') + hi.join(', ') : T('Aucun axe très fort', 'No very strong axis')) + (lo.length ? T(' · faible en ', ' · weak in ') + lo.join(', ') : '') + '.';
}
// five-axis profile (0-100), in the spirit of a "snowflake"
function snow(s) {
  if (s.snow) {
    const old = snowOld(s);
    return AXK.map((k, i) => { const a = s.snow[k]; return a && a.s != null ? [T(AXN[k][0], AXN[k][1]), a.s / 6 * 100, '', false] : [T(AXN[k][0], AXN[k][1]), old[i][1], old[i][2], old[i][1] != null]; });
  }
  return snowOld(s);
}
function snowOld(s) {
  const f = s.fin || {}; const price = s.price;
  const pe = s.pe, fv = s.fairValue || s.target;
  const value = s.etf ? null : avgOf([pe == null ? 15 : pe < 12 ? 90 : pe < 18 ? 75 : pe < 25 ? 55 : pe < 35 ? 35 : 15, fv && price ? clamp(50 + (fv / price - 1) * 150) : null]);
  const g = s.pe && s.fpe > 0 ? s.pe / s.fpe - 1 : null;
  const future = s.etf ? null : avgOf([g != null ? clamp(50 + g * 150) : null, s.target && price ? clamp(50 + (s.target / price - 1) * 150) : null, f.revGrowth != null ? clamp(40 + f.revGrowth * 200) : null]);
  const margin = f.rev ? f.ni / f.rev : null;
  const hist = (s.finHist || []).filter(x => x.rev);
  const cagr = hist.length > 2 ? Math.pow(hist[hist.length - 1].rev / hist[0].rev, 1 / (hist.length - 1)) - 1 : null;
  const past = s.etf ? null : avgOf([margin != null ? clamp(margin * 250) : null, cagr != null ? clamp(40 + cagr * 200) : null, margin == null && cagr == null ? (s.scores?.buffett ?? null) : null]);
  const health = s.etf ? null : avgOf([f.fcf != null ? (f.fcf > 0 ? 75 : 20) : null, f.debt != null && s.mcap ? (f.debt / s.mcap < 0.1 ? 90 : f.debt / s.mcap < 0.3 ? 70 : f.debt / s.mcap < 0.6 ? 45 : 20) : null, s.beta != null ? clamp(100 - s.beta * 40) : null]);
  const y = s.divAnnual != null && price ? s.divAnnual / price : null;
  const dividend = y == null ? null : y === 0 ? 0 : y < 0.01 ? 25 : y < 0.02 ? 45 : y < 0.04 ? 70 : 85;
  const sc = s.scores || {};
  const fb = (v, alt) => v != null ? [v, false] : alt != null ? [alt, true] : [null, false];
  const ax = [['Valeur', fb(value, sc.buffett), 'Prix comparé aux profits et à une valeur estimée'], ['Futur', fb(future, sc.jensen), 'Croissance attendue des profits et potentiel selon les analystes'], ['Passé', fb(past, sc.fink), 'Marge de profit et croissance des revenus des dernières années'], ['Santé', fb(health, s.mcap ? (s.mcap > 2e11 ? 70 : s.mcap > 2e10 ? 55 : 40) : null), 'Flux de trésorerie, dette et stabilité'], ['Dividende', fb(dividend, sc.duckett), 'Rendement du dividende']];
  return ax.map(([n, [v, est], t]) => [n, v, t, est]);
}
function fundBox(s) {
  if (s.etf) return '';
  const f = s.fin; const ax = snow(s); const tot = avgOf(ax.map(a => a[1]));
  const colTok = tot == null ? '--muted' : tot >= 60 ? '--good' : tot >= 42 ? '--warn' : '--bad';
  const fv = s.fairValue, price = s.price, F = s.fair;
  let fvHtml = '';
  const ref = fv || s.target;
  if (ref && price) {
    const diff = 1 - price / ref; // >0 : price below value
    const pos = v => clamp(50 + (v / ref - 1) * 125, 2, 98); // ref at 50 %, ±40 % of ref spans the bar
    const band = F && F.low && F.high ? `<span class="band" style="left:${pos(F.low)}%;width:${Math.max(1, pos(F.high) - pos(F.low))}%" title="${T('Fourchette', 'Range')} ${nf(F.low)} – ${nf(F.high)}"></span>` : '';
    const how = F ? (F.method === 'bank'
      ? T(`Banque ou assureur : valeur comptable × (rendement des capitaux propres ${pct(F.roe, 1, false)} − croissance ${pct(F.terminal, 1, false)}) ÷ (taux ${pct(F.rate, 1, false)} − croissance).`,
          `Bank or insurer: book value × (ROE ${pct(F.roe, 1, false)} − growth ${pct(F.terminal, 1, false)}) ÷ (rate ${pct(F.rate, 1, false)} − growth).`)
      : T(`Modèle du Radar : ${F.method === 'fcf+earn' ? 'moyenne de deux méthodes, les flux de trésorerie disponibles et les bénéfices du propriétaire' : F.method === 'fcf' ? 'flux de trésorerie disponibles' : 'bénéfices du propriétaire'}, normalisés sur plusieurs années pour ne pas extrapoler un sommet ou un creux. Croissance de départ ${pct(F.growth, 1, false)} (${F.gsrc}) qui ralentit jusqu'à ${pct(F.terminal, 1, false)} en 10 ans. Actualisés à ${pct(F.rate, 1, false)} : taux sans risque ${pct(F.rf, 1, false)} (moyenne 5 ans de l'obligation 10 ans) + bêta ajusté ${nf(F.beta, 2)} × prime de risque 4,5 %.`,
          `Radar model: ${F.method === 'fcf+earn' ? 'average of two methods, free cash flow and owner earnings' : F.method === 'fcf' ? 'free cash flow' : 'owner earnings'}, normalised over several years so a peak or trough is not extrapolated. Starting growth ${pct(F.growth, 1, false)} fading to ${pct(F.terminal, 1, false)} over 10 years. Discounted at ${pct(F.rate, 1, false)}: risk-free ${pct(F.rf, 1, false)} (5-year average of the 10-year bond) + adjusted beta ${nf(F.beta, 2)} × 4.5 % risk premium.`))
      + (F.peak ? T(' Profits au sommet d\'un cycle : ramenés vers leur moyenne.', ' Earnings at a cyclical peak: pulled back toward their average.') : '')
      : fv ? T('Valeur selon un modèle de flux de trésorerie actualisés. Source : ', 'Value from a discounted cash flow model. Source: ') + esc(s.fairValueSource || '–') + '.' : T('Aucune valeur estimée fiable pour ce profil : comparaison avec la cible moyenne des analystes.', 'No reliable estimate for this profile: compared with the average analyst target.');
    fvHtml = `<div><span class="lbl">${T('Prix vs', 'Price vs')} ${fv ? T('valeur estimée', 'estimated value') : T('cible des analystes', 'analyst target')}</span>
      <div style="margin:6px 0;font-weight:600" class="${diff >= 0 ? 'up' : 'down'}">${diff >= 0.2 ? T('Sous-évalué', 'Undervalued') : diff >= -0.2 ? T('Prix à peu près juste', 'About fairly priced') : T('Surévalué', 'Overvalued')} · ${nf(Math.abs(diff) * 100, 1)} % ${diff >= 0 ? T('sous', 'below') : T('au-dessus de', 'above')} ${T('cette valeur', 'this value')}</div>
      <div class="fv"><span class="z1"></span><span class="z2"></span><span class="z3"></span>${band}
        <span class="mk${pos(price) > 70 ? ' flip' : ''}" style="left:${pos(price)}%"><b>${T('Prix', 'Price')} ${nf(price)}</b></span><span class="mk fair" style="left:50%"><b>${fv ? T('Valeur', 'Value') : T('Cible', 'Target')} ${nf(ref)}</b></span></div>
      <div class="fvl"><span>${T('20 % sous-évalué', '20 % undervalued')}</span><span>${T('Juste', 'Fair')}</span><span>${T('20 % surévalué', '20 % overvalued')}</span></div>
      ${F && F.low ? `<p class="note" style="margin:6px 0 0"><b>${T('Fourchette', 'Range')} : ${nf(F.low)} – ${nf(F.high)}</b> ${T('(taux d\'actualisation ± 1 point)', '(discount rate ± 1 point)')}${s.target ? ` · ${T('cible des analystes', 'analyst target')} ${nf(s.target)}` : ''}${s.fairExt ? ` · ${T('autre estimation', 'other estimate')} ${nf(s.fairExt.v)} (${esc(String(s.fairExt.src || '').split(' (')[0])})` : ''}</p>` : ''}
      <p class="note" style="margin:4px 0 0">${how}</p></div>`;
  }
  const ratios = [];
  if (s.pe) ratios.push(['P/E', nf(s.pe, 1) + 'x']);
  if (f?.rev && s.mcap) ratios.push(['P/S', nf(s.mcap / f.rev, 1) + 'x']);
  if (f?.rev) ratios.push(['Marge nette', pct(f.ni / f.rev, 1, false)]);
  if (f?.revGrowth != null) ratios.push(['Croissance revenus', pct(f.revGrowth, 1)]);
  if (f?.fcf != null) ratios.push(['Flux libre', (f.fcf < 0 ? '−' : '') + big(Math.abs(f.fcf))]);
  return `<div class="box"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-profile"/></svg> Profil de l'entreprise</span>
    <div class="fund"><div><div class="snow" id="snowWrap"><canvas id="cSnow" aria-label="${T('Profil en cinq axes', 'Five-axis profile')}"></canvas></div><p class="snowsum">${s.snow ? esc(shapeSummary(s)) : ''}</p></div>
      <div>${s.snow ? `<div class="axtabs" role="tablist">${AXK.map((k, i) => { const x = s.snow[k] || {}; return `<button type="button" role="tab" data-ax="${i}" aria-selected="${i === state.ax ? 'true' : 'false'}"><b>${T(AXN[k][0], AXN[k][1])}<span>${x.s == null ? '–' : x.ok + '/' + x.n}</span></b><span class="dots">${(x.c || []).map(c => `<i class="${c[1] === 1 ? 'ok' : c[1] === 0 ? 'no' : ''}"></i>`).join('')}</span></button>`; }).join('')}</div><div class="axd" id="axD"></div>`
      : `<div class="axes">${ax.map(([n, v, t, est]) => `<div title="${esc(t)}"><span>${n}</span><span class="t"><i style="width:${v ?? 0}%;background:var(${v == null ? '--line' : v >= 60 ? '--good' : v >= 40 ? '--warn' : '--bad'})"></i></span><span class="num">${v == null ? '…' : Math.round(v)}${est ? '<span class="est">≈</span>' : ''}</span></div>`).join('')}
      <p class="note" style="margin:4px 0 0">${T('Les critères détaillés arrivent à la prochaine mise à jour automatique.', 'Detailed checks arrive with the next automatic update.')}</p></div>`}</div></div>
    ${ratios.length ? `<div class="ratios">${ratios.map(([l, v]) => `<div><span class="lbl">${l}</span><div class="v">${v}</div></div>`).join('')}</div>` : ''}
    ${fvHtml}
    ${f?.rev ? `<div><span class="lbl">Des revenus aux profits${f.period ? ' · ' + esc(f.period) : ''}</span><div class="chartbox sm"><canvas id="cWater" aria-label="Revenus, coûts et profits"></canvas></div></div>` : '<p class="note" style="margin:0">Revenus, coûts et profits : ajoutés à la prochaine mise à jour automatique de ce titre.</p>'}
    ${(s.finHist || []).length > 1 ? `<div><span class="lbl">Historique des revenus et profits</span><div class="read" id="fRead"></div><div class="chartbox sm"><canvas id="cFin" aria-label="Historique des revenus, profits et flux de trésorerie"></canvas></div></div>` : ''}
  </div>`.replace('class="box">', `class="box" style="border-top:3px solid var(${colTok})">`);
}
function selectAxis(s, i, anim = true) {
  i = (i + AXK.length) % AXK.length;
  const changed = state.axSel !== i; state.axSel = i; state.ax = i;
  document.querySelectorAll('.axtabs button').forEach(b => b.setAttribute('aria-selected', String(+b.dataset.ax === i)));
  const k = AXK[i], a = s.snow[k] || { c: [] }, d = $('#axD');
  if (d && (changed || !d.innerHTML)) {
    d.innerHTML = `<h4>${T(AXN[k][0], AXN[k][1])}<span>${a.s == null ? T('données insuffisantes', 'not enough data') : `${a.ok}/${a.n} ${T('critères réussis', 'checks passed')}`}</span></h4><p>${T(AXQ[k][0], AXQ[k][1])} ${axisSummary(k, a)}</p>
      <ul class="ck">${a.c.map(c => { const [n, why] = ckText(c); const cl = c[1] === 1 ? 'ok' : c[1] === 0 ? 'no' : 'na'; return `<li class="${cl}"><svg class="i" aria-hidden="true"><use href="#i-${cl === 'ok' ? 'check' : cl === 'no' ? 'x' : 'na'}"/></svg><span>${esc(n)}<small>${esc(why)}</small></span></li>`; }).join('')}</ul>`;
    if (anim) { d.classList.remove('swap'); void d.offsetWidth; d.classList.add('swap'); }
  }
  const ch = charts.cSnow; if (!ch) return;
  if (!changed && state.axA === 1) return;
  cancelAnimationFrame(state.axRaf); const t0 = performance.now();
  const step = t => { state.axA = Math.min(1, (t - t0) / 220); ch.draw(); if (state.axA < 1) state.axRaf = requestAnimationFrame(step); };
  state.axRaf = requestAnimationFrame(step);
}
function setupAxes(s) {
  if (state.ax == null) state.ax = 0;
  state.axSel = null; state.axA = 0; selectAxis(s, state.ax, false);
  document.querySelectorAll('.axtabs button').forEach(b => { b.onmouseenter = b.onfocus = b.onclick = () => selectAxis(s, +b.dataset.ax); });
  const tl = $('.axtabs'); if (tl) tl.onkeydown = e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); selectAxis(s, state.axSel + (e.key === 'ArrowRight' ? 1 : -1)); $(`.axtabs button[data-ax="${state.axSel}"]`)?.focus(); } };
  const cv = $('#cSnow'), wrap = $('#snowWrap');
  const pick = e => { const ch = charts.cSnow, sc = ch?.scales.r; if (!sc) return; const r = cv.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e;
    const x = p.clientX - r.left - sc.xCenter, y = p.clientY - r.top - sc.yCenter; if (Math.hypot(x, y) > sc.drawingArea * 1.25) return;
    let ang = Math.atan2(y, x) + Math.PI / 2; if (ang < 0) ang += 2 * Math.PI; const i = Math.round(ang / (2 * Math.PI / AXK.length)) % AXK.length; selectAxis(s, i); };
  wrap.onmousemove = pick; wrap.onclick = pick; wrap.addEventListener('touchstart', pick, { passive: true });
}
function drawFund(s) {
  ['cSnow', 'cWater', 'cFin'].forEach(k => { if (charts[k]) { charts[k].destroy(); delete charts[k]; } });
  if (!window.Chart || s.etf) return;
  const th = themeOpts();
  const ax = snow(s); const tot = avgOf(ax.map(a => a[1]));
  const col = tot == null ? th.muted : tot >= 60 ? th.good : tot >= 42 ? th.warn : css('--bad');
  if ($('#cSnow')) {
    const hl = { id: 'axHl', beforeDatasetsDraw(ch) {
      const sc = ch.scales.r; if (!sc || state.axA == null) return; const c = ch.ctx, n = ax.length, i = state.axSel ?? 0;
      const a0 = sc.getIndexAngle(i) - Math.PI / 2, w = Math.PI / n;
      c.save(); c.globalAlpha = state.axA; c.fillStyle = th.accent + '26'; c.strokeStyle = th.accent; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(sc.xCenter, sc.yCenter); c.arc(sc.xCenter, sc.yCenter, sc.drawingArea, a0 - w, a0 + w); c.closePath(); c.fill(); c.globalAlpha = state.axA * .7; c.stroke(); c.restore(); } };
    charts.cSnow = new Chart($('#cSnow'), { type: 'radar', plugins: [hl], data: { labels: ax.map(a => a[0]), datasets: [{ data: ax.map(a => a[1] ?? 0), borderColor: col, backgroundColor: col + '66', borderWidth: 2, tension: .45, pointRadius: 0 }] },
      options: { maintainAspectRatio: false, animation: ANIM, events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { r: { min: 0, max: 100, ticks: { display: false, stepSize: 100 / 6 }, grid: { color: th.line }, angleLines: { color: th.line },
        pointLabels: { color: c => c.index === state.axSel ? th.accent : th.muted, font: c => ({ size: 11, weight: c.index === state.axSel ? '700' : '600' }) } } } } });
    if (s.snow) setupAxes(s);
  }
  const f = s.fin;
  if (f?.rev && $('#cWater')) {
    const gross = f.gross ?? (f.cogs != null ? f.rev - f.cogs : null);
    const steps = gross != null ? [['Revenus', [0, f.rev], th.accent], ['Coût des ventes', [gross, f.rev], css('--bad')], ['Profit brut', [0, gross], th.good], ['Autres dépenses', [f.ni, gross], css('--bad')], ['Profit net', [0, f.ni], th.mid]]
      : [['Revenus', [0, f.rev], th.accent], ['Dépenses', [f.ni, f.rev], css('--bad')], ['Profit net', [0, f.ni], th.mid]];
    charts.cWater = new Chart($('#cWater'), { type: 'bar', data: { labels: steps.map(x => x[0]), datasets: [{ data: steps.map(x => x[1]), backgroundColor: steps.map(x => x[2]), borderRadius: 3 }] },
      options: { maintainAspectRatio: false, animation: ANIM, plugins: { legend: { display: false }, tooltip: { backgroundColor: th.surface, titleColor: th.ink, bodyColor: th.ink, borderColor: th.line, borderWidth: 1, callbacks: { label: c => big(Math.abs(c.raw[1] - c.raw[0])) } } },
        scales: { y: { grid: { color: th.line }, ticks: { callback: v => big(v) } }, x: { grid: { display: false }, ticks: { font: { size: 10.5 } } } } } });
  }
  const h = (s.finHist || []).filter(x => x.rev);
  if (h.length > 1 && $('#cFin')) {
    const sets = [['Revenus', 'rev', th.accent], ['Profit net', 'ni', th.good], ['Flux de trésorerie libre', 'fcf', css('--bad')]].filter(([, k]) => h.some(x => x[k] != null));
    charts.cFin = new Chart($('#cFin'), { type: 'line', data: { labels: h.map(x => x.y), datasets: sets.map(([l, k, c]) => ({ label: l, data: h.map(x => x[k] ?? null), borderColor: c, backgroundColor: c + '22', fill: k === 'rev', tension: .3, pointRadius: 2, spanGaps: true })) },
      options: { maintainAspectRatio: false, animation: ANIM, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 2 } }, tooltip: { enabled: false },
          crosshair: { enabled: true, mode: 'index', dot: false, onMove: i => { const x = h[i ?? h.length - 1]; $('#fRead').innerHTML = `${esc(x.y)} · revenus <b>${big(x.rev)}</b>${x.ni != null ? ` · profit <b class="${x.ni >= 0 ? 'up' : 'down'}">${x.ni < 0 ? '−' : ''}${big(Math.abs(x.ni))}</b>` : ''}${x.fcf != null ? ` · flux libre <b class="${x.fcf >= 0 ? 'up' : 'down'}">${x.fcf < 0 ? '−' : ''}${big(Math.abs(x.fcf))}</b>` : ''}`; } } },
        scales: { y: { grid: { color: th.line }, ticks: { callback: v => (v < 0 ? '−' : '') + big(Math.abs(v)) } }, x: { grid: { display: false } } } } });
    charts.cFin.options.plugins.crosshair.onMove(null);
  }
}
function drawPrice(s, hold) {
  if (charts.cPrice) { charts.cPrice.destroy(); delete charts.cPrice; }
  const all = (s.hist || []).filter(p => p && p.p != null).map(p => ({ x: Date.parse(p.d + 'T12:00'), y: p.p })).filter(p => !isNaN(p.x)).sort((a, b) => a.x - b.x);
  const stats = $('#pStats');
  if (all.length < 2 || !window.Chart || !$('#cPrice')) { if (stats) stats.textContent = ''; return; }
  const span = { '3m': 92, '6m': 183, '1y': 366 }[state.range];
  const end = all[all.length - 1].x;
  let pts = span ? all.filter(p => p.x >= end - span * 864e5) : all;
  if (pts.length < 2) pts = all.slice(-2);
  const first = pts[0].y, last = pts[pts.length - 1].y, chg = last / first - 1;
  const hi = pts.reduce((m, p) => p.y > m.y ? p : m), lo = pts.reduce((m, p) => p.y < m.y ? p : m);
  const fd = x => new Date(x).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: '2-digit' });
  const spanDays = (all[all.length - 1].x - all[0].x) / 864e5;
  const avail = state.range === 'all' ? ` <span class="muted">(tout l'historique disponible : ${spanDays > 700 ? nf(spanDays / 365, 0) + ' ans' : nf(spanDays / 30.4, 0) + ' mois'})</span>` : (span && spanDays < span - 20 ? ` <span class="muted">(historique disponible depuis le ${fd(all[0].x)} seulement)</span>` : '');
  stats.innerHTML = `<span class="${chg >= 0 ? 'up' : 'down'}"><b>${pct(chg, 1)}</b></span> depuis le ${fd(pts[0].x)}${avail} · plus haut ${nf(hi.y)} (${fd(hi.x)}) · plus bas ${nf(lo.y)} (${fd(lo.x)})${hold ? ` · ton prix moyen ${nf(hold.h.avg)}` : ''}`;
  const th = themeOpts(); const col = chg >= 0 ? th.good : css('--bad');
  const ds = [{ label: 'Prix', data: pts, borderColor: col, backgroundColor: col + '1f', fill: true, tension: .2, borderWidth: 2, pointRadius: pts.length > 40 ? 0 : 2, pointHoverRadius: 4 }];
  if (hold) ds.push({ label: 'Ton prix moyen', data: [{ x: pts[0].x, y: hold.h.avg }, { x: end, y: hold.h.avg }], borderColor: th.accent, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, fill: false });
  if (s.target) ds.push({ label: 'Cible analystes', data: [{ x: pts[0].x, y: s.target }, { x: end, y: s.target }], borderColor: th.muted, borderDash: [2, 4], borderWidth: 1.2, pointRadius: 0, fill: false });
  const tip = { backgroundColor: th.surface, titleColor: th.ink, bodyColor: th.ink, borderColor: th.line, borderWidth: 1, padding: 10 };
  charts.cPrice = new Chart($('#cPrice'), { type: 'line', data: { datasets: ds },
    options: { maintainAspectRatio: false, animation: ANIM, interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: { legend: { display: ds.length > 1, position: 'bottom', labels: { boxWidth: 10, boxHeight: 2 } }, tooltip: { enabled: false },
        crosshair: { enabled: true, color: col, onMove: i => {
          const p = pts[i ?? pts.length - 1];
          $('#pRead').innerHTML = `${i == null ? 'Dernier cours · ' : ''}${fd(p.x)} · <b>${nf(p.y)}</b> · <span class="${p.y >= first ? 'up' : 'down'}">${pct(p.y / first - 1, 1)}</span> sur la période${hold ? ` · <span class="${p.y >= hold.h.avg ? 'up' : 'down'}">${pct(p.y / hold.h.avg - 1, 1)}</span> vs ton prix moyen` : ''}`;
        } } },
      scales: { x: { type: 'linear', min: pts[0].x, max: end, grid: { display: false }, ticks: { maxTicksLimit: 6, callback: v => new Date(v).toLocaleDateString('fr-CA', { month: 'short', year: '2-digit' }) } }, y: { grid: { color: th.line } } } } });
  charts.cPrice.options.plugins.crosshair.onMove(null);
}
function sellBox(s, a, pf) {
  if (!s.owned) return '';
  const sig = sellSignal(s, a, pf); const rows = sellPreview(s.ticker);
  if (!rows.length) return '';
  const tot = rows.reduce((t, r) => t + r.plCAD, 0);
  return `<div class="box ${sig ? 'b' : ''}">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><span class="lbl">Si tu vends aujourd'hui</span>${sig ? `<span class="pill ${sig.level === 'Vendre' ? 'v-avoid' : 'v-care'}">Signal : ${emo(sig.level)}</span>` : '<span class="pill v-watch">Aucun signal de vente</span>'}</div>
    ${sig ? `<ul class="reasons">${sig.reasons.map(r => `<li class="c">${esc(r)}</li>`).join('')}</ul>` : ''}
    <div class="num" style="font-size:16px">Total : <span class="${tot >= 0 ? 'up' : 'down'}">${tot >= 0 ? 'gain de +' : 'perte de −'}${money(Math.abs(tot))}</span></div>
    ${rows.map(r => `<div style="border-top:1px solid var(--line);padding-top:8px"><div><b>${esc(r.account)}</b> · ${nf(r.qty, 4)} act. · payé ${nf(r.avg)} → ${nf(r.price)} ${esc(r.cur)} · <span class="${r.pl >= 0 ? 'up' : 'down'}">${r.pl >= 0 ? 'gain' : 'PERTE'} ${r.pl >= 0 ? '+' : '−'}${nf(Math.abs(r.pl))} ${esc(r.cur)} (${pct(r.plPct, 1)})</span></div><div class="note">${esc(taxNote(r.account, r.pl))}</div></div>`).join('')}
    ${rows.some(r => r.cur === 'USD') ? '<p class="note" style="margin:0">Pour les titres en USD, le gain réel en CAD dépend aussi du taux de change le jour de l\'achat. Ce calcul utilise le taux d\'aujourd\'hui.</p>' : ''}
  </div>`;
}
function md(t) {
  const lines = esc(t).split('\n'); let out = '', inList = false;
  for (let l of lines) {
    l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    if (/^\s*[-*•]\s+/.test(l)) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + l.replace(/^\s*[-*•]\s+/, '') + '</li>'; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    if (/^#{1,4}\s/.test(l)) out += '<h4>' + l.replace(/^#{1,4}\s/, '') + '</h4>';
    else if (l.trim()) out += '<p>' + l + '</p>';
  }
  return out + (inList ? '</ul>' : '');
}
let sampleFn;
async function wireAi(s, a, hold) {
  const go = $('#aiGo'), stop = $('#aiStop'), out = $('#aiOut');
  if (sampleFn === null) { $('#aiBox').hidden = true; return; }
  go.onclick = async () => {
    if (!sampleFn) { out.innerHTML = '<span class="note">Claude n\'est pas disponible dans cette vue.</span>'; return; }
    aiCtl = new AbortController(); go.disabled = true; stop.hidden = false; out.innerHTML = '<span class="note">Claude réfléchit…</span>';
    const pf = portfolio();
    const ctx = { titre: s.name, symbole: s.ticker, secteur: s.sector, fnb: !!s.etf, prix: s.price, variation_jour: s.chg, sommet_52s: s.hi52, creux_52s: s.lo52, pe: s.pe, pe_prevu: s.fpe, beta: s.beta, capitalisation: s.mcap, cible_analystes: s.target, consensus_analystes: s.rating, scores_investisseurs: s.scores, score_radar: a.score, verdict_radar: a.verdict.t, raisons_pour: a.pros, raisons_contre: a.cons, nouvelles: s.news, resume: s.summary, donnees_du: s.updatedAt,
      ma_position: hold ? { actions: hold.h.qty, prix_moyen: hold.h.avg, devise: hold.h.cur, gain: hold.gain, poids: hold.w, comptes: hold.h.accounts } : null,
      mon_portefeuille: pf ? { valeur_cad: Math.round(pf.total), poids_par_secteur: Object.fromEntries(Object.entries(pf.sect).map(([k, v]) => [k, +(v * 100).toFixed(1)])), cibles: state.meta.sectorTargets } : null };
    const prompt = `Tu aides Evan, étudiant en génie à Montréal qui investit à long terme via Wealthsimple (CELI, CELIAPP, non-enregistré), à décider s'il devrait investir dans ce titre. Réponds en français québécois clair, sans jargon inutile, en 220 mots maximum, avec exactement ces sections en titres "## " : "## En une phrase", "## Ce qui est attirant", "## Ce qui doit faire hésiter", "## Pour ton portefeuille" (tiens compte de ses poids par secteur et de sa position actuelle), "## Ce que je surveillerais". Utilise des puces courtes. Base-toi uniquement sur les données fournies (datées de ${s.updatedAt}); si une donnée manque, dis-le. Termine par une ligne rappelant que ce n'est pas un conseil financier.\n\nDonnées (JSON):\n${JSON.stringify(ctx)}`;
    try {
      await sampleFn(prompt, { signal: aiCtl.signal, onText: ({ text }) => { out.innerHTML = md(text); } });
    } catch (e) {
      if (e.code === 'not_granted' || e.code === 'sampling_disabled' || e.code === 'not_declared' || e.code === 'capability_disabled') { sampleFn = null; $('#aiBox').hidden = true; }
      else if (e.code === 'cancelled') { out.innerHTML = e.text ? md(e.text) : '<span class="note">Analyse arrêtée.</span>'; }
      else if (e.code === 'rate_limited') out.innerHTML = (e.text ? md(e.text) : '') + '<p class="note">Trop de demandes pour le moment. Réessaie dans quelques minutes.</p>';
      else out.innerHTML = (e.text ? md(e.text) : '') + '<p class="note">L\'analyse a été interrompue. Clique « Analyser ce titre » pour réessayer.</p>';
    } finally { go.disabled = false; stop.hidden = true; }
  };
  stop.onclick = () => aiCtl?.abort();
}

/* ---------- transactions ---------- */
let DB = null;
const ACCOUNTS = ['CELI', 'CELIAPP', 'Non-enregistré'];
const docId = t => t.replace(/\./g, '_');
function openTxForm(prefill) {
  state.form = true; state.open = null;
  const d = $('#drawer'); d.dataset.t = '';
  const tickers = Object.values(state.stocks).map(s => s.ticker).sort();
  const today = new Date().toLocaleDateString('en-CA');
  d.innerHTML = `
    <div class="dh"><div><div class="lbl">Wealthsimple</div><h2 id="dName">Ajouter un achat ou une vente</h2></div><button class="close" id="xClose" aria-label="Fermer">×</button></div>
    <p class="note" style="margin:0">Entre la transaction telle qu'elle apparaît dans Wealthsimple. Ta position, ton prix moyen et tous les calculs se mettent à jour tout de suite. Les dividendes réinvestis sont ajoutés automatiquement : pas besoin de les entrer.</p>
    <form class="form box" id="txForm" novalidate>
      <label>Type<select id="txType"><option value="buy">Achat</option><option value="sell">Vente</option><option value="drip">Dividende réinvesti (correction)</option></select></label>
      <label>Compte<select id="txAcc">${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></label>
      <label class="full">Symbole<input type="text" id="txT" list="txTickers" placeholder="ex. AAPL, CNR.TO, VFV.TO" autocomplete="off" value="${esc(prefill || '')}"><datalist id="txTickers">${tickers.map(t => `<option value="${esc(t)}">${esc(nice(state.stocks[t]?.name || ''))}</option>`).join('')}</datalist></label>
      <label>Nombre d'actions<input type="number" id="txQty" step="any" min="0" inputmode="decimal" placeholder="ex. 2.5"></label>
      <label>Prix par action<input type="number" id="txPrice" step="any" min="0" inputmode="decimal"></label>
      <label>Devise<select id="txCur"><option>USD</option><option>CAD</option></select></label>
      <label>Date<input type="date" id="txDate" value="${today}"></label>
      <div class="full" id="txHint"></div>
      <div class="full" id="txMsg"></div>
      <div class="full" style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" id="txCancel">Annuler</button><button type="submit" class="btn primary" id="txSave">Enregistrer</button></div>
    </form>`;
  d.hidden = false; $('#scrim').hidden = false;
  $('#xClose').onclick = closeDrawer; $('#txCancel').onclick = closeDrawer;
  const hint = () => {
    const t = $('#txT').value.trim().toUpperCase(), acc = $('#txAcc').value;
    const s = state.stocks[t]; const p = (state.positions || []).find(p => p.t === t && p.account === acc);
    const cur = p?.cur || s?.cur || (/\.(TO|V|NE|CN)$/.test(t) ? 'CAD' : 'USD');
    $('#txCur').value = cur;
    if (s?.price && !$('#txPrice').dataset.touched) $('#txPrice').value = s.price;
    $('#txHint').innerHTML = t ? `<span class="note">${s ? esc(nice(s.name)) : 'Nouveau titre : il sera ajouté au radar et complété à la prochaine mise à jour.'}${p ? ` · tu as ${nf(p.qty, 4)} actions dans ${esc(acc)} (prix moyen ${nf(p.avg)} ${esc(p.cur)})` : ''}</span>` : '';
  };
  $('#txT').addEventListener('input', hint); $('#txAcc').addEventListener('change', hint);
  $('#txPrice').addEventListener('input', e => e.target.dataset.touched = '1');
  $('#txForm').addEventListener('submit', e => { e.preventDefault(); saveTx(); });
  hint(); $('#txT').focus();
}
async function saveTx() {
  const msg = $('#txMsg'); const err = m => { msg.innerHTML = `<div class="msg err">${esc(m)}</div>`; };
  const type = $('#txType').value, account = $('#txAcc').value, t = $('#txT').value.trim().toUpperCase();
  const qty = parseFloat($('#txQty').value), price = parseFloat($('#txPrice').value), cur = $('#txCur').value, date = $('#txDate').value;
  if (!/^[A-Z0-9.\-]{1,12}$/.test(t)) return err('Entre un symbole valide, par exemple AAPL ou CNR.TO.');
  if (!(qty > 0)) return err('Le nombre d\'actions doit être plus grand que 0.');
  if (!(price > 0)) return err('Le prix par action doit être plus grand que 0.');
  if (!date) return err('Choisis la date de la transaction.');
  if (!DB) return err('Déverrouille d\'abord tes données (cadenas en haut).');
  const list = (state.positions || []).map(p => ({ ...p }));
  const i = list.findIndex(p => p.t === t && p.account === account);
  const prev = i >= 0 ? { ...list[i] } : null;
  let realized = null;
  if (type === 'sell') {
    if (!prev || prev.qty < qty - 1e-9) return err(`Tu n'as que ${nf(prev?.qty || 0, 4)} actions de ${t} dans ${account}.`);
    realized = (price - prev.avg) * qty;
    const left = prev.qty - qty;
    if (left < 1e-6) list.splice(i, 1); else list[i].qty = +left.toFixed(6);
  } else if (prev) {
    const q = prev.qty + qty; list[i].avg = +((prev.avg * prev.qty + price * qty) / q).toFixed(4); list[i].qty = +q.toFixed(6);
  } else list.push({ t, account, qty: +qty.toFixed(6), avg: price, cur });
  const after = list.find(p => p.t === t && p.account === account) || null;
  $('#txSave').disabled = true; msg.innerHTML = '<div class="note">Enregistrement…</div>';
  try {
    await DB.doc('meta/positions').update({ positions: list, updatedAt: new Date().toISOString() });
    await DB.collection('transactions').add({ type, t, account, qty, price, cur, date, realized, prev, after, createdAt: new Date().toISOString() });
    if (!state.raw[t]) await DB.doc('stocks/' + docId(t)).set({ ticker: t, name: t, sector: 'Autre', cur, price, hist: [{ d: date, p: price }], scores: {}, green: [], red: [], pros: [], cons: [], news: [], etf: false, updatedAt: '2000-01-01T00:00:00Z', source: 'Ajouté par une transaction' });
    msg.innerHTML = `<div class="msg ok">${type === 'sell' ? 'Vente' : 'Achat'} de ${nf(qty, 4)} ${esc(t)} enregistré${realized != null ? ` · gain réalisé ${realized >= 0 ? '+' : ''}${nf(realized)} ${esc(cur)}` : ''}.</div>`;
    $('#txQty').value = ''; delete $('#txPrice').dataset.touched;
  } catch (e) {
    err(e?.code === 'no_token' ? 'Ajoute ton jeton GitHub dans Réglages pour pouvoir enregistrer.' : e?.code === 'not_allowed' ? 'Le jeton GitHub n\'a pas la permission d\'écrire dans le dépôt.' : 'L\'enregistrement a échoué. Réessaie dans un moment.');
  } finally { $('#txSave').disabled = false; }
}
async function undoLast() {
  if (!undoArm) { undoArm = true; renderTx(); setTimeout(() => { undoArm = false; renderTx(); }, 5000); return; }
  undoArm = false;
  const tx = state.txs[0]; if (!tx || !DB) return;
  const list = (state.positions || []).map(p => ({ ...p })).filter(p => !(p.t === tx.t && p.account === tx.account));
  if (tx.prev) list.push(tx.prev);
  try {
    await DB.doc('meta/positions').update({ positions: list, updatedAt: new Date().toISOString() });
    await DB.doc('transactions/' + tx._id).delete();
  } catch (e) { $('#txList').insertAdjacentHTML('afterbegin', '<div class="msg err">L\'annulation a échoué.</div>'); }
}
$('#txOpen').onclick = () => openTxForm();

/* ---------- investment planner ---------- */
let planAmt = null;
try { planAmt = parseFloat(localStorage.getItem('radar-plan')) || null; } catch (e) {}
function renderPlan() {
  const out = $('#planOut'); if (!out) return;
  if (!planAmt) { out.innerHTML = ''; return; }
  const { pf, items } = list(); if (!pf) return;
  const n = +$('#planN').value, mode = $('#planEtf').value, fx = fxRate();
  const tg = state.meta?.sectorTargets || {};
  const after = pf.total + planAmt;
  const keyOf = s => s.etf ? 'ETF' : s.sector;
  const ok = s => s.price > 0 && (mode === 'all' || (mode === 'etf') === !!s.etf);
  let gaps = Object.entries(tg).map(([k, t]) => ({ k, gap: t * after - (pf.sect[k] || 0) * pf.total })).filter(g => g.gap > 0 && items.some(x => keyOf(x.s) === g.k && ok(x.s) && x.a.score >= 50));
  const totGap = gaps.reduce((a, g) => a + g.gap, 0);
  let picks = [];
  if (totGap > 0) {
    gaps.sort((a, b) => b.gap - a.gap);
    for (const g of gaps) {
      const best = items.filter(x => keyOf(x.s) === g.k && ok(x.s)).sort((a, b) => b.a.score - a.a.score)[0];
      if (best) picks.push({ ...best, w: g.gap, why: `${g.k === 'ETF' ? 'Tes FNB' : 'Le secteur ' + g.k} : ${pct(pf.sect[g.k] || 0, 0, false)} aujourd'hui pour une cible de ${pct(tg[g.k], 0, false)}` });
    }
  }
  if (picks.length < n) {
    items.filter(x => ok(x.s) && !picks.some(p => p.s.ticker === x.s.ticker)).sort((a, b) => b.a.score - a.a.score).slice(0, n - picks.length)
      .forEach(x => picks.push({ ...x, w: (picks.reduce((a, p) => a + p.w, 0) || planAmt) / Math.max(1, picks.length) * 0.5, why: 'Parmi les meilleurs scores du radar' }));
  }
  picks = picks.slice(0, n);
  const W = picks.reduce((a, p) => a + p.w, 0) || 1;
  picks.forEach(p => { p.amt = planAmt * p.w / W; const r = p.s.cur === 'CAD' || /\.(TO|V)$/.test(p.s.ticker) || p.s.etf && /\.TO$/.test(p.s.ticker) ? 1 : fx; p.qty = p.amt / (p.s.price * r); p.curr = r === 1 ? 'CAD' : 'USD'; });
  out.innerHTML = picks.length ? `<div class="tw" style="margin-top:6px"><table class="plan" style="min-width:640px"><thead><tr><th>Titre</th><th class="r">Montant</th><th class="r">≈ Actions</th><th>Pourquoi</th><th>Verdict</th></tr></thead><tbody>${picks.map(p => `<tr data-t="${esc(p.s.ticker)}"><td><b>${esc(p.s.ticker)}</b> <span class="muted">${esc(nice(p.s.name))}</span></td><td class="r num">${money(p.amt, 0)}</td><td class="r num">${nf(p.qty, p.qty < 10 ? 3 : 1)} <span class="muted">à ${nf(p.s.price)} ${p.curr}</span></td><td style="white-space:normal;min-width:220px">${esc(p.why)}</td><td><span class="pill ${p.a.verdict.c}">${p.a.verdict.h}</span></td></tr>`).join('')}</tbody></table></div>
    <p class="note" style="margin:6px 0 0">Wealthsimple permet d'acheter des fractions d'actions pour la plupart des titres. Les titres en USD sont convertis au taux du jour (${nf(fx, 4)}); les frais de conversion de change ne sont pas inclus. Suggestion seulement : vérifie chaque fiche avant d'acheter.</p>` : '<p class="note">Aucun titre ne correspond à ces critères.</p>';
}
$('#planForm').addEventListener('submit', e => { e.preventDefault(); const v = parseFloat($('#planAmt').value); planAmt = v > 0 ? v : null; try { localStorage.setItem('radar-plan', planAmt || ''); } catch (err) {} renderPlan(); });
['#planN', '#planEtf'].forEach(id => $(id).addEventListener('change', renderPlan));
if (planAmt) $('#planAmt').value = planAmt;

/* ---------- import of a Wealthsimple activity export (read locally, never uploaded) ---------- */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === ';') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}
const num0 = v => { if (v == null) return null; const x = parseFloat(String(v).replace(/[\s$]/g, '').replace(/(\d),(\d{1,6})$/, '$1.$2').replace(/,/g, '')); return isNaN(x) ? null : x; };
function findCol(h, re) { return h.findIndex(x => re.test(x.trim().toLowerCase())); }
function normDate(v) { const t = String(v || '').trim(); let m = t.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; const d = new Date(t); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
function normAcc(v) { const t = String(v || '').toLowerCase(); if (/celiapp|fhsa/.test(t)) return 'CELIAPP'; if (/celi|tfsa/.test(t)) return 'CELI'; if (/non|personal|cash|individual|enregistr/.test(t)) return 'Non-enregistré'; return ''; }
function interpret(rows) {
  const h = rows[0].map(x => x.trim()), body = rows.slice(1);
  const c = { date: findCol(h, /^(transaction )?date|^date|settle/), type: findCol(h, /^(action|type|transaction|activity|activity type|sub-?type)$|type/), sym: findCol(h, /symbol|ticker|security|symbole/), qty: findCol(h, /quantity|qty|shares|quantité/), price: findCol(h, /^price|unit price|prix/), amount: findCol(h, /amount|net|total|montant/), cur: findCol(h, /currency|devise/), acc: findCol(h, /account|compte/), desc: findCol(h, /description|details|détails/) };
  const out = [];
  for (const r of body) {
    const raw = ((c.type >= 0 ? r[c.type] : '') + ' ' + (c.desc >= 0 ? r[c.desc] : '')).toLowerCase();
    let type = /reinvest|drip|réinvest/.test(raw) ? 'drip' : /\bbuy\b|bought|achat|purchase|market buy|limit buy/.test(raw) ? 'buy' : /\bsell\b|sold|vente/.test(raw) ? 'sell' : /div/.test(raw) ? 'cashdiv' : 'other';
    let t = c.sym >= 0 ? String(r[c.sym] || '').trim().toUpperCase() : '';
    if (!t && c.desc >= 0) { const m = String(r[c.desc]).match(/\b([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b/); if (m) t = m[1]; }
    const qty = Math.abs(num0(c.qty >= 0 ? r[c.qty] : null) || 0);
    let price = Math.abs(num0(c.price >= 0 ? r[c.price] : null) || 0);
    const amt = Math.abs(num0(c.amount >= 0 ? r[c.amount] : null) || 0);
    if (!price && qty && amt) price = amt / qty;
    const known = Store.uni[t] || Store.uni[t + '.TO'];
    if (!Store.uni[t] && Store.uni[t + '.TO']) t = t + '.TO';
    const cur = c.cur >= 0 && /cad|usd/i.test(r[c.cur]) ? String(r[c.cur]).toUpperCase().trim() : (/\.(TO|V)$/.test(t) ? 'CAD' : (known?.cur || 'USD'));
    out.push({ date: normDate(c.date >= 0 ? r[c.date] : ''), type, t, qty, price, cur, account: normAcc(c.acc >= 0 ? r[c.acc] : ''), ok: (type === 'buy' || type === 'sell' || type === 'drip') && t && qty > 0 && price > 0 });
  }
  return { cols: c, header: h, rows: out };
}
function isDup(x) { return (Store.priv?.transactions || []).some(y => y.t === x.t && y.date === x.date && Math.abs((y.qty || 0) - x.qty) < 1e-6 && (y.type === x.type || (x.type === 'drip' && y.type === 'drip')) && (!x.account || y.account === x.account)); }
let impData = null;
function openImport() {
  openPanel(`<div class="dh"><div><div class="lbl"><svg class="i" aria-hidden="true"><use href="#i-import"/></svg> Wealthsimple</div><h2 id="dName">Importer un relevé d'activités</h2></div><button class="close" id="xClose" aria-label="Fermer">×</button></div>
    <div class="box"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-shield"/></svg> Sécurité</span><p style="margin:0">Le fichier est lu <b>seulement dans ton navigateur</b> : il n'est jamais envoyé ni enregistré. Seules les transactions que tu coches sont ajoutées à ton coffre chiffré. Dès l'import terminé, la page oublie le fichier. Tu peux ensuite le supprimer de ton dossier Téléchargements.</p></div>
    <div class="box"><span class="lbl">1. Télécharge le relevé</span><p class="note" style="margin:0">Dans Wealthsimple : onglet Activité (icône d'horloge) → « Télécharger les activités » → choisis la période et le compte → fichier CSV.</p>
      <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500">2. Choisis le fichier CSV<input type="file" id="impFile" accept=".csv,text/csv"></label>
      <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500">Compte (si le fichier ne l'indique pas)<select id="impAcc">${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select></label></div>
    <div id="impOut"></div>`);
  $('#impFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5e6) { $('#impOut').innerHTML = '<div class="msg err">Ce fichier est trop gros pour un relevé (plus de 5 Mo).</div>'; return; }
    const rd = new FileReader();
    rd.onload = () => { try { impData = interpret(parseCSV(String(rd.result))); showImport(); } catch (err) { $('#impOut').innerHTML = '<div class="msg err">Ce fichier n\'a pas pu être lu. Vérifie que c\'est bien le CSV des activités Wealthsimple.</div>'; } e.target.value = ''; };
    rd.readAsText(f);
  });
  $('#impAcc').addEventListener('change', () => impData && showImport());
}
function showImport() {
  const acc = $('#impAcc').value;
  const rows = impData.rows.map((x, i) => ({ ...x, i, account: x.account || acc })).filter(x => x.type !== 'other');
  rows.forEach(x => { x.dup = isDup(x); x.sel = x.ok && !x.dup && x.type !== 'drip' && x.type !== 'cashdiv'; });
  const nOk = rows.filter(x => x.sel).length;
  const miss = ['date', 'sym', 'qty'].filter(k => impData.cols[k] < 0);
  $('#impOut').innerHTML = `<div class="box imp"><span class="lbl">3. Vérifie et importe</span>
    ${miss.length ? `<div class="msg err">Colonnes non reconnues : ${miss.join(', ')}. En-têtes trouvés : ${esc(impData.header.join(' | '))}</div>` : ''}
    <p class="note" style="margin:0">${rows.length} lignes reconnues. Les doublons (déjà dans ton journal), les dividendes en argent et les réinvestissements (déjà ajoutés automatiquement) sont décochés par défaut.</p>
    <div class="tw"><table><thead><tr><th></th><th>Date</th><th>Type</th><th>Titre</th><th class="r">Qté</th><th class="r">Prix</th><th>Compte</th><th>Note</th></tr></thead><tbody>
    ${rows.map(x => `<tr class="${x.dup ? 'dup' : ''}"><td><input type="checkbox" data-imp="${x.i}" ${x.sel ? 'checked' : ''} ${x.ok ? '' : 'disabled'}></td><td class="num">${esc(x.date)}</td><td>${({ buy: 'Achat', sell: 'Vente', drip: 'DRIP', cashdiv: 'Dividende' })[x.type] || x.type}</td><td><b>${esc(x.t)}</b></td><td class="r num">${nf(x.qty, 4)}</td><td class="r num">${x.price ? nf(x.price) + ' ' + esc(x.cur) : '–'}</td><td>${esc(x.account)}</td><td class="note">${x.dup ? 'déjà importé' : x.type === 'drip' ? 'déjà réinvesti auto.' : x.type === 'cashdiv' ? 'argent, pas d\'actions' : !x.ok ? 'incomplet' : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span class="note" id="impMsg">${nOk} transaction(s) cochée(s)</span><button class="btn primary" id="impGo">Importer les transactions cochées</button></div></div>`;
  $('#impGo').onclick = () => doImport(rows);
}
async function doImport(rows) {
  const pick = new Set([...document.querySelectorAll('[data-imp]:checked')].map(c => +c.dataset.imp));
  const list = rows.filter(x => pick.has(x.i)).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) { $('#impMsg').textContent = 'Coche au moins une transaction.'; return; }
  const apply = p => {
    p.transactions = p.transactions || [];
    for (const x of list) {
      const pos = p.positions; const i = pos.findIndex(q => q.t === x.t && q.account === x.account); const prev = i >= 0 ? { ...pos[i] } : null; let realized = null;
      if (x.type === 'sell') { if (!prev) continue; const q = Math.min(x.qty, prev.qty); realized = (x.price - prev.avg) * q; const left = prev.qty - q; if (left < 1e-6) pos.splice(i, 1); else pos[i].qty = +left.toFixed(6); }
      else if (prev) { const q = prev.qty + x.qty; pos[i].avg = +((prev.avg * prev.qty + x.price * x.qty) / q).toFixed(4); pos[i].qty = +q.toFixed(6); }
      else pos.push({ t: x.t, account: x.account, qty: +x.qty.toFixed(6), avg: x.price, cur: x.cur });
      p.transactions.unshift({ type: x.type, t: x.t, account: x.account, qty: x.qty, price: x.price, cur: x.cur, date: x.date, realized, prev, after: pos.find(q => q.t === x.t && q.account === x.account) || null, createdAt: new Date().toISOString(), source: 'import Wealthsimple', _id: uid() });
    }
  };
  $('#impGo').disabled = true; $('#impMsg').textContent = 'Import en cours…';
  try {
    await queue('priv', apply, `Import Wealthsimple (${list.length} transactions)`);
    const missing = [...new Set(list.map(x => x.t))].filter(t => !Store.uni[t]);
    for (const t of missing) await DB.doc('stocks/' + docId(t)).set({ ticker: t, name: t, sector: 'Autre', cur: list.find(x => x.t === t).cur, etf: false, addedBy: 'Import Wealthsimple' });
    impData = null;
    $('#impOut').innerHTML = `<div class="msg ok"><svg class="i up" aria-hidden="true"><use href="#i-check"/></svg> ${list.length} transaction(s) importée(s). Le fichier a été oublié par la page; tu peux le supprimer de ton ordinateur.</div>`;
  } catch (err) { $('#impGo').disabled = false; $('#impMsg').textContent = err?.code === 'no_token' ? 'Ajoute ton jeton GitHub dans les Réglages.' : 'L\'import a échoué. Réessaie.'; }
}
$('#impOpen').onclick = openImport;

/* ---------- colour styles ---------- */
function setPal(p, save) {
  if (p) document.documentElement.setAttribute('data-pal', p); else document.documentElement.removeAttribute('data-pal');
  document.querySelectorAll('#palMenu [data-pal]').forEach(b => b.setAttribute('aria-checked', (b.dataset.pal || '') === (p || '')));
  if (save) { try { localStorage.setItem('radar-pal', p || ''); } catch (e) {} }
  Object.keys(charts).forEach(k => { charts[k].destroy(); delete charts[k]; });
  render();
}
function togglePal(open) { $('#palMenu').hidden = !open; $('#palBtn').setAttribute('aria-expanded', open); }
$('#palBtn').onclick = e => { e.stopPropagation(); togglePal($('#palMenu').hidden); };
$('#palMenu').addEventListener('click', e => { const b = e.target.closest('[data-pal]'); if (b) { setPal(b.dataset.pal, true); togglePal(false); } });
document.addEventListener('click', e => { if (!e.target.closest('.pop')) togglePal(false); });
(() => { let p = ''; try { p = localStorage.getItem('radar-pal') || ''; } catch (e) {} if (p) document.documentElement.setAttribute('data-pal', p); document.querySelectorAll('#palMenu [data-pal]').forEach(b => b.setAttribute('aria-checked', (b.dataset.pal || '') === p)); })();
/* language of analyses and news */
state.lang = (() => { try { return localStorage.getItem('radar-lang') || 'fr'; } catch (e) { return 'fr'; } })();
function setLang(l) { state.lang = l; setTimeout(() => { renderWelcome(); updateLockUi(); }, 0); try { localStorage.setItem('radar-lang', l); } catch (e) {} $('#langBtn').textContent = l.toUpperCase(); $('#langBtn').title = l === 'fr' ? 'Analyses en français (cliquer pour l\'anglais)' : 'Analyses in English (click for French)'; document.querySelectorAll('#tabbar b').forEach(b => b.textContent = b.dataset[l] || b.textContent); if (typeof applyStores === 'function' && Store.uni) applyStores(); }
document.querySelectorAll('#tabbar b').forEach(b => b.textContent = b.dataset[state.lang] || b.textContent);
$('#langBtn').onclick = () => setLang(state.lang === 'fr' ? 'en' : 'fr');
$('#langBtn').textContent = state.lang.toUpperCase();

/* ---------- private mode ---------- */
function setPriv(on, save) {
  state.priv = !!on;
  document.documentElement.classList.toggle('private', state.priv);
  $('#privBtn').setAttribute('aria-checked', state.priv);
  $('#privLbl').textContent = state.priv ? 'Privé' : 'Public';
  if (save) { try { localStorage.setItem('radar-priv', state.priv ? '1' : '0'); } catch (e) {} }
  render();
}
$('#privBtn').onclick = () => { if (state.priv && !state.unlocked) { openUnlock(); return; } setPriv(!state.priv, true); };
(() => { let v = null; try { v = localStorage.getItem('radar-priv'); } catch (e) {} state.priv = v === '1'; document.documentElement.classList.toggle('private', state.priv); $('#privBtn').setAttribute('aria-checked', state.priv); $('#privLbl').textContent = state.priv ? 'Privé' : 'Public'; })();

/* ---------- table of contents ---------- */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function toggleToc(open) { const p = $('#tocPanel'); p.hidden = !open; $('#tocBtn').setAttribute('aria-expanded', open); }
$('#tocBtn').onclick = () => toggleToc($('#tocPanel').hidden);
document.addEventListener('click', e => {
  const a = e.target.closest('[data-go]'); if (!a) return;
  e.preventDefault();
  const el = document.getElementById(a.dataset.go); toggleToc(false);
  if (el) el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
});
const parts = ['aujourdhui', 'portefeuille', 'occasions', 'investisseurs', 'titres'];
const spy = new IntersectionObserver(es => {
  es.forEach(en => { if (en.isIntersecting) document.querySelectorAll('#toc a, #tabbar a').forEach(x => x.classList.toggle('on', x.dataset.go === en.target.id)); });
}, { rootMargin: '-80px 0px -70% 0px' });
parts.forEach(id => { const el = document.getElementById(id); if (el) spy.observe(el); });

/* ---------- manual watchlist ---------- */
$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#addMsg'); const say = (t, ok) => { msg.innerHTML = `<div class="msg ${ok ? 'ok' : 'err'}" style="margin-top:8px">${esc(t)}</div>`; };
  const t = $('#addT').value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(t)) return say('Entre un symbole boursier valide, par exemple COST, RY.TO ou BRK.B.');
  if (state.raw[t]) { say(`${t} est déjà dans ta liste.`, true); openDrawer(t); return; }
  if (!DB) return say('Déverrouille d\'abord tes données (cadenas en haut).');
  const btn = $('#addGo'); btn.disabled = true;
  let name = $('#addName').value.trim(), sector = $('#addSect').value, region = null, cur = /\.(TO|V|NE|CN)$/.test(t) ? 'CAD' : 'USD', etf = sector === 'ETF';
  if ((!name || !sector) && sampleFn) {
    msg.innerHTML = '<div class="note" style="margin-top:8px">Identification du titre…</div>';
    try {
      const info = await sampleFn.json(`Identify the publicly traded security with ticker symbol "${t}". Reply with only JSON: {"known": boolean, "name": official company or fund name, "sector": one of ["Technologie","Transport","Consommation","Industrie","Finance & Assurance","Santé","Énergie","Matériaux","ETF"], "region": country of headquarters in French (e.g. "États-Unis", "Canada", "Japon"), "currency": "USD" or "CAD", "etf": boolean}. If you are not confident the ticker exists, set "known": false.`, { modelTier: 'quick' });
      if (info && info.known === false && !name) { btn.disabled = false; return say(`Je ne reconnais pas le symbole ${t}. Vérifie-le ou écris le nom de l'entreprise, puis réessaie.`); }
      if (info) { name = name || info.name || ''; if (!sector) { sector = info.sector || ''; etf = info.etf === true || sector === 'ETF'; } region = info.region || null; if (info.currency === 'CAD' || info.currency === 'USD') cur = info.currency; }
    } catch (err) { /* identification is optional */ }
  }
  try {
    await DB.doc('stocks/' + docId(t)).set({ ticker: t, name: name || t, sector: etf ? 'ETF' : (sector || 'Autre'), region, cur, etf, price: null, chg: null, hist: [], scores: {}, consensus: null, green: [], red: [], pros: [], cons: [], news: [], summary: null, updatedAt: '2000-01-01T00:00:00Z', source: 'Ajouté manuellement — données à la prochaine mise à jour', addedBy: 'Ajouté à la main', addedAt: new Date().toISOString() });
    say(`${name || t} (${t}) est ajouté à ta liste. Une mise à jour de ses données est lancée : il sera complet dans environ 15 minutes.`, true);
    $('#addT').value = ''; $('#addName').value = ''; $('#addSect').value = '';
  } catch (err) {
    say(err?.code === 'no_token' ? 'Ajoute ton jeton GitHub dans Réglages pour pouvoir enregistrer.' : 'L\'ajout a échoué. Réessaie dans un moment.');
  } finally { btn.disabled = false; }
});
let delArm = null;
async function removeWatch(t, btn) {
  if (delArm !== t) { delArm = t; btn.textContent = 'Confirmer le retrait'; btn.classList.add('primary'); setTimeout(() => { if (delArm === t) { delArm = null; btn.textContent = 'Retirer de ma liste'; btn.classList.remove('primary'); } }, 5000); return; }
  delArm = null;
  try { await DB.doc('stocks/' + docId(t)).delete(); closeDrawer(); }
  catch (e) { btn.textContent = 'Le retrait a échoué'; }
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const of = e.target.closest('[data-of]');
  if (of) { state.oppF = of.dataset.of; render(); return; }
  const t = e.target.closest('[data-t]');
  if (t && !e.target.closest('#drawer')) { openWithTransition(t); return; }
  const f = e.target.closest('.seg button[data-f]');
  if (f) { state.filter = f.dataset.f; document.querySelectorAll('.seg button[data-f]').forEach(b => b.setAttribute('aria-pressed', b === f)); render(); return; }
  const th = e.target.closest('th[data-k]');
  if (th) { const key = th.closest('#tHold') ? 'sortHold' : 'sortAll'; const k = th.dataset.k; state[key] = { k, d: state[key].k === k ? -state[key].d : (k === 'name' ? 1 : -1) }; render(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.open) closeDrawer();
  if (e.key === 'Enter' && e.target.matches('[data-t]') && e.target.tagName !== 'BUTTON') openDrawer(e.target.dataset.t);
});
$('#scrim').onclick = closeDrawer;
$('#q').addEventListener('input', e => { state.q = e.target.value; renderAll(list().items); });
$('#fSect').addEventListener('change', e => { state.sect = e.target.value; renderAll(list().items); });
$('#fReg').addEventListener('change', e => { state.reg = e.target.value; renderAll(list().items); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/* ---------- data (version autonome : GitHub Pages + GitHub Actions) ---------- */
const GH = { owner: '999FlaminGoat', repo: 'radar-boursier', branch: 'main' };
const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
const Store = { uni: {}, market: { stocks: {} }, priv: null, pw: null, privBlob: null };
const DEFAULT_TARGETS = { Technologie: 0.30, Transport: 0.05, Consommation: 0.10, Industrie: 0.10, 'Finance & Assurance': 0.15, ETF: 0.30 };
let renderTimer;
const schedule = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); };
const token = () => LS.get('radar-gh-token');

// --- chiffrement compatible avec scripts/update.py (PBKDF2-SHA256 + AES-256-GCM)
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64e = u => { let s = ''; u.forEach(b => s += String.fromCharCode(b)); return btoa(s); };
async function aesKey(pw, salt, iter) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function decryptBlob(blob, pw) {
  const key = await aesKey(pw, b64d(blob.salt), blob.iter || 250000);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(blob.iv) }, key, b64d(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function encryptObj(obj, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(pw, salt, 600000);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: 600000, cipher: 'AES-256-GCM', salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
}

// --- GitHub API (seulement si un jeton est enregistré sur cet appareil)
async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}${path}`, { ...opts, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token()}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) } });
  if (!r.ok) { const e = new Error('github ' + r.status); e.status = r.status; e.code = r.status === 401 || r.status === 403 ? 'not_allowed' : 'github'; throw e; }
  return r.status === 204 ? null : r.json();
}
const utf8b64 = str => b64e(new TextEncoder().encode(str));
const b64utf8 = s => new TextDecoder().decode(b64d(s.replace(/\n/g, '')));
async function ghRead(file) { const j = await gh(`/contents/${file}?ref=${GH.branch}&t=${Date.now()}`); return { sha: j.sha, text: b64utf8(j.content) }; }
async function ghWrite(file, text, sha, message) { return gh(`/contents/${file}`, { method: 'PUT', body: JSON.stringify({ message, content: utf8b64(text), sha, branch: GH.branch }) }); }
async function dispatchUpdate(symbols) {
  if (!token()) return false;
  await gh('/actions/workflows/update.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: GH.branch, inputs: { symbols: (symbols || []).map(x => String(x).toUpperCase()).filter(x => /^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(x)).join(' ') } }) });
  return true;
}

// --- opérations en attente : réappliquées sur la version la plus récente du fichier avant d'écrire
const pending = { priv: [], uni: [] };
let flushP = null;
function queue(kind, fn, msg) { if (kind === 'priv' && !Store.priv) { const e = new Error('locked'); e.code = 'locked'; return Promise.reject(e); } if (!token()) { const e = new Error('no token'); e.code = 'no_token'; return Promise.reject(e); } if (kind === 'priv') msg = 'Coffre chiffré mis à jour'; /* message de commit public : ne rien révéler */ pending[kind].push({ fn, msg }); fn(kind === 'priv' ? Store.priv : Store.uni); applyStores(); return flush(); }
function flush() {
  if (flushP) return flushP;
  flushP = new Promise(res => setTimeout(res, 350)).then(async () => {
    try {
      if (!token()) { const e = new Error('no token'); e.code = 'no_token'; throw e; }
      for (const kind of ['priv', 'uni']) {
        const ops = pending[kind].splice(0); if (!ops.length) continue;
        const file = kind === 'priv' ? 'data/private.enc.json' : 'data/universe.json';
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const cur = await ghRead(file);
            let obj = kind === 'priv' ? await decryptBlob(JSON.parse(cur.text), Store.pw) : JSON.parse(cur.text);
            ops.forEach(o => o.fn(obj));
            const text = kind === 'priv' ? JSON.stringify(await encryptObj(obj, Store.pw)) : JSON.stringify(obj);
            await ghWrite(file, text, cur.sha, [...new Set(ops.map(o => o.msg))].join(' · ').slice(0, 200));
            if (kind === 'priv') Store.priv = obj; else Store.uni = obj;
            break;
          } catch (e) { if (attempt === 1 || e.status !== 409) throw e; }
        }
      }
      applyStores();
    } finally { flushP = null; }
  });
  return flushP;
}

// --- façade de base de données utilisée par le reste de la page
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
DB = {
  doc(path) {
    const [c, id] = path.split('/');
    return {
      update: async data => { if (c === 'meta' && id === 'positions') return queue('priv', p => { p.positions = JSON.parse(JSON.stringify(data.positions)); }, 'Positions mises à jour'); },
      set: async data => {
        if (c === 'stocks') { const t = data.ticker; return queue('uni', u => { u[t] = { ...(u[t] || {}), ticker: t, name: data.name || t, sector: data.sector, region: data.region || undefined, cur: data.cur, etf: !!data.etf, addedBy: data.addedBy || 'Ajouté à la main', h: [] }; }, `Ajout de ${t}`).then(() => dispatchUpdate([t]).catch(() => {})); }
        if (c === 'alerts') return queue('priv', p => { (p.alerts = p.alerts || {})[data.t] = data; }, `Alerte ${data.t}`);
      },
      delete: async () => {
        if (c === 'transactions') return queue('priv', p => { p.transactions = (p.transactions || []).filter(x => x._id !== id); }, 'Transaction annulée');
        if (c === 'stocks') { const t = Object.keys(Store.uni).find(k => docId(k) === id) || id; return queue('uni', u => { delete u[t]; }, `Retrait de ${t}`); }
        if (c === 'alerts') { const t = Object.keys(Store.priv?.alerts || {}).find(k => docId(k) === id) || id; return queue('priv', p => { if (p.alerts) delete p.alerts[t]; }, `Alerte ${t} retirée`); }
      }
    };
  },
  collection(c) {
    return { add: async data => { if (c === 'transactions') { const x = { ...data, _id: uid() }; return queue('priv', p => { (p.transactions = p.transactions || []).unshift(x); }, `${data.type === 'sell' ? 'Vente' : 'Achat'} ${data.t}`); } } };
  }
};

// --- fusion des sources en un état d'affichage
const NUMF = ['price', 'chg', 'chgDate', 'hi52', 'lo52', 'pe', 'fpe', 'mcap', 'beta', 'target', 'rating', 'divAnnual', 'lastDiv', 'nextEarnings', 'fin', 'finHist', 'cur'];
function merge(t, u, m) {
  const s = { ...u };
  for (const k of NUMF) if (m[k] !== undefined && m[k] !== null) s[k] = m[k];
  s.ticker = t;
  if (m.snow) s.snow = m.snow;
  if (!s.name || s.name === t) s.name = m.name || t;
  if (m.etf) s.etf = true;
  if (!s.sector || s.sector === 'Autre') s.sector = s.etf ? 'ETF' : (m.sectorAuto || 'Autre');
  if (!s.region && m.regionAuto) s.region = m.regionAuto;
  const h = (m.h && m.h.length > 1 ? m.h : u.h) || [];
  s.hist = h.map(([d, p]) => ({ d, p }));
  const L = state.lang || 'fr';
  const claudeFresh = u.updatedAt && Date.now() - Date.parse(u.updatedAt) < 30 * 864e5;
  const freshNews = (u.news || []).filter(n => n.d && Date.now() - Date.parse(n.d) < 21 * 864e5);
  const yNews = (m.newsAuto || []).map(n => ({ d: n.d, t: n.t + (L === 'fr' && n.lang === 'en' ? ' (EN)' : '') }));
  s.news = L === 'fr' ? (freshNews.length ? freshNews : yNews.length ? yNews : (u.news || [])) : (yNews.length ? yNews : (u.news || []));
  const ap = m.autoPros?.[L] || [], ac = m.autoCons?.[L] || [];
  s.pros = L === 'fr' ? [...(claudeFresh ? (u.pros || []) : []), ...ap] : ap;
  s.cons = L === 'fr' ? [...(claudeFresh ? (u.cons || []) : []), ...ac] : ac;
  s.summary = L === 'fr' ? (u.summary || m.autoSummary?.fr || null) : (m.about || m.autoSummary?.en || null);
  if (m.scoresAuto) { s.scoresExcel = u.scores; s.scores = { ...(u.scores || {}), ...m.scoresAuto }; s.consensus = m.consensusAuto ?? u.consensus; s.scoresAuto = true; }
  s.fairExt = u.fairValue ? { v: u.fairValue, src: u.fairValueSource } : null;
  if (m.fairValueAuto) { s.fairValue = m.fairValueAuto.value; s.fair = m.fairValueAuto; s.fairValueSource = null; }
  else { s.fair = null; s.fairValue = u.fairValue || null; s.fairValueSource = u.fairValueSource || null; }
  s.radarScore = m.radarScore;
  s.scoreHist = (Store.scores || {})[t] || [];
  s.updatedAt = m.updatedAt || u.updatedAt;
  s.source = m.updatedAt ? 'Yahoo Finance (mise à jour automatique)' + (u.pros?.length ? ' · analyse écrite par Claude le ' + String(u.updatedAt || '').slice(0, 10) : '') : (u.source || '–');
  return s;
}
function applyStores() {
  const m = Store.market.stocks || {};
  const o = {};
  for (const [t, u] of Object.entries(Store.uni)) o[t] = merge(t, u, m[t] || {});
  state.raw = o;
  const p = Store.priv;
  state.positions = p ? (p.positions || []) : [];
  state.meta = { fx: Store.market.fx || { USDCAD: 1.39 }, sectorTargets: p?.sectorTargets || DEFAULT_TARGETS, history: p?.history || [] };
  state.txs = p ? (p.transactions || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) : [];
  state.divs = p ? (p.dividends || []).slice().sort((a, b) => String(b.payDate).localeCompare(String(a.payDate))) : [];
  state.alerts = p ? (p.alerts || {}) : {};
  const pub = (Store.market.splits || []).filter(x => !(p?.splits || []).some(y => y.t === x.t && y.date === x.date));
  state.splits = [...(p?.splits || []), ...pub];
  state.status = { lastRun: Store.market.generatedAt, schedule: 'jours ouvrables vers 17 h 30 (GitHub Actions)', marketBrief: null, day: Store.market.day ? { ...Store.market.day } : null, note: Store.market.note };
  state.canWrite = !!(p && token());
  state.unlocked = !!p;
  document.documentElement.classList.toggle('locked', !p);
  if (!p && !state.priv) setPrivQuiet(true);
  updateLockUi();
  rebuild();
  schedule();
}
function setPrivQuiet(on) { state.priv = on; document.documentElement.classList.toggle('private', on); $('#privBtn').setAttribute('aria-checked', on); $('#privLbl').textContent = on ? 'Privé' : 'Public'; }

async function loadPublic() {
  const bust = '?t=' + Math.floor(Date.now() / 60000);
  const [u, m, inv] = await Promise.all([
    fetch('data/universe.json' + bust).then(r => r.json()),
    fetch('data/market.json' + bust).then(r => r.ok ? r.json() : { stocks: {} }).catch(() => ({ stocks: {} })),
    fetch('data/investors.json' + bust).then(r => r.json()).catch(() => [])
  ]);
  Store.uni = u; Store.market = m; state.investors = inv; invKey = null;
  const [sc, dv] = await Promise.all([fetch('data/scores.json' + bust).then(r => r.ok ? r.json() : {}).catch(() => ({})), fetch('data/discover.json' + bust).then(r => r.ok ? r.json() : {}).catch(() => ({}))]);
  Store.scores = sc; Store.discover = dv;
  Store.logos = await fetch('data/logos.json' + bust).then(r => r.ok ? r.json() : {}).catch(() => ({}));
}
async function loadPrivateBlob() {
  if (token()) { try { const r = await ghRead('data/private.enc.json'); return JSON.parse(r.text); } catch (e) { /* jeton invalide : lecture publique */ } }
  return fetch('data/private.enc.json?t=' + Date.now()).then(r => r.json());
}
// Visiteur ou propriétaire : un appareil devient « propriétaire » après un déverrouillage réussi.
const isOwner = () => !!(LS.get('radar-owner') || LS.get('radar-pw') || LS.get('radar-gh-token'));
function applyGuest() { document.documentElement.classList.toggle('guest', !isOwner()); }
async function unlock(pw, remember) {
  const blob = await loadPrivateBlob();
  const p = await decryptBlob(blob, pw); // lève une erreur si le mot de passe est mauvais
  Store.pw = pw; Store.priv = p;
  LS.set('radar-owner', '1'); applyGuest();
  if (remember) LS.set('radar-pw', pw); else LS.set('radar-pw', null);
  if (state.priv && LS.get('radar-priv') !== '1') setPrivQuiet(false);
  applyStores();
}
async function boot() {
  sampleFn = null;
  applyGuest(); renderWelcome();
  try { await loadPublic(); }
  catch (e) { showOffline('Les données n\'ont pas pu être chargées. Vérifie ta connexion, puis recharge la page.'); return; }
  dbFresh = true;
  applyStores();
  const pw = LS.get('radar-pw');
  if (pw) { try { await unlock(pw, true); } catch (e) { LS.set('radar-pw', null); } }
  setInterval(async () => { try { await loadPublic(); applyStores(); } catch (e) {} }, 10 * 60 * 1000);
}
function showOffline(msg) { $('#status').innerHTML = `<span class="dot"></span><span>${esc(msg)}</span>`; $('#opps').innerHTML = `<div class="empty">${esc(msg)}</div>`; }

/* ---------- verrou, réglages ---------- */
function updateLockUi() {
  const b = $('#lockBtn'); if (!b) return;
  b.innerHTML = state.unlocked ? '<svg class="i" aria-hidden="true"><use href="#i-unlock"/></svg>' : '<svg class="i" aria-hidden="true"><use href="#i-lock"/></svg><span class="hide-sm"> ' + (isOwner() ? T('Déverrouiller', 'Unlock') : T('Propriétaire', 'Owner')) + '</span>';
  b.title = state.unlocked ? 'Tes données personnelles sont déverrouillées sur cet appareil' : isOwner() ? 'Entre ton mot de passe pour voir ton portefeuille' : T('Accès réservé au propriétaire du radar', 'Owner access only');
}
function openPanel(html) { state.form = true; state.open = null; const d = $('#drawer'); d.dataset.t = ''; d.innerHTML = html; d.hidden = false; $('#scrim').hidden = false; $('#xClose').onclick = closeDrawer; }
function openUnlock() {
  openPanel(`<div class="dh"><div><div class="lbl"><svg class="i" aria-hidden="true"><use href="#i-vault"/></svg> Coffre chiffré</div><h2 id="dName">Déverrouiller mes données</h2></div><button class="close" id="xClose" aria-label="Fermer">×</button></div>
    <p class="note" style="margin:0">Tes positions, transactions, dividendes et alertes sont chiffrés (AES-256) dans ton dépôt GitHub. Seul ce mot de passe permet de les lire. Il n'est jamais envoyé nulle part.</p>
    <form class="form box" id="ulForm" novalidate><label class="full">Mot de passe<input type="password" id="ulPw" autocomplete="current-password" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"></label>
      <label class="full" style="flex-direction:row;align-items:center;gap:8px;font-weight:400"><input type="checkbox" id="ulRem" checked> Se souvenir sur cet appareil</label>
      <div class="full" id="ulMsg"></div><div class="full" style="display:flex;justify-content:flex-end"><button class="btn primary" type="submit" id="ulGo">Déverrouiller</button></div></form>`);
  $('#ulForm').addEventListener('submit', async e => {
    e.preventDefault(); $('#ulGo').disabled = true; $('#ulMsg').innerHTML = '<span class="note">Vérification…</span>';
    try { await unlock($('#ulPw').value.trim(), $('#ulRem').checked); closeDrawer(); }
    catch (err) { $('#ulMsg').innerHTML = '<div class="msg err">Mot de passe incorrect.</div>'; }
    finally { const g = $('#ulGo'); if (g) g.disabled = false; }
  });
  $('#ulPw').focus();
}
function openSettings() {
  const m = Store.market;
  openPanel(`<div class="dh"><div><div class="lbl"><svg class="i" aria-hidden="true"><use href="#i-gear"/></svg> Réglages</div><h2 id="dName">Réglages du radar</h2></div><button class="close" id="xClose" aria-label="Fermer">×</button></div>
    <div class="box"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-refresh"/></svg> Données</span>
      <p style="margin:0">Dernière mise à jour automatique : <b>${esc(fmtDate(m.generatedAt))}</b>${m.note ? ' · ' + esc(m.note) : ''}</p>
      ${(m.fails || []).length ? `<p class="note" style="margin:0">Titres non trouvés : ${esc(m.fails.join(', '))}</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="stRun">Mettre à jour maintenant</button><a class="btn" href="https://github.com/${GH.owner}/${GH.repo}/actions" target="_blank" rel="noopener">Voir les mises à jour sur GitHub</a></div>
      <span class="note" id="stRunMsg">La mise à jour prend environ 10 à 20 minutes; recharge ensuite la page.</span></div>
    <div class="box"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-key"/></svg> Jeton GitHub (pour enregistrer depuis cette page)</span>
      <p class="note" style="margin:0">Sans jeton, la page est en lecture seule. Avec un jeton, tes achats, ventes, alertes et ajouts de titres sont enregistrés dans ton dépôt. Crée un jeton « fine-grained » limité au dépôt <b>${GH.repo}</b>, avec les permissions <b>Contents : Read and write</b> et <b>Actions : Read and write</b>.</p>
      <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Créer un jeton sur GitHub ↗</a>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:13px">Jeton<input type="password" id="stTok" placeholder="github_pat_…" value="${token() ? '••••••••••••' : ''}"></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="stTokSave">Enregistrer le jeton</button><button class="btn" id="stTokDel">Retirer le jeton de cet appareil</button></div><span class="note" id="stTokMsg">${token() ? '<svg class="i up" aria-hidden="true"><use href="#i-check"/></svg> Un jeton est enregistré sur cet appareil.' : 'Aucun jeton sur cet appareil.'}</span></div>
    <div class="box"><span class="lbl"><svg class="i" aria-hidden="true"><use href="#i-vault"/></svg> Mot de passe du coffre</span>
      ${state.unlocked ? `<p class="note" style="margin:0">Après un changement, mets aussi à jour le secret <b>RADAR_PASSWORD</b> dans ton dépôt GitHub (Settings → Secrets and variables → Actions), sinon les dividendes ne seront plus réinvestis automatiquement.</p>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:13px">Nouveau mot de passe (12 caractères ou plus)<input type="password" id="stPw" autocomplete="new-password"></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="stPwSave">Changer le mot de passe</button><button class="btn" id="stForget">Oublier le mot de passe sur cet appareil</button></div><span class="note" id="stPwMsg"></span>` : '<p class="note" style="margin:0">Déverrouille d\'abord tes données.</p>'}</div>`);
  $('#stRun').onclick = async () => { try { $('#stRunMsg').textContent = (await dispatchUpdate([])) ? 'Mise à jour lancée. Recharge la page dans environ 15 minutes.' : 'Enregistre d\'abord un jeton GitHub ci-dessous.'; } catch (e) { $('#stRunMsg').textContent = 'Le lancement a échoué : vérifie que le jeton a la permission Actions.'; } };
  $('#stTokSave').onclick = async () => { const v = $('#stTok').value.trim(); if (!v || v.startsWith('••')) return; LS.set('radar-gh-token', v); try { await gh(''); $('#stTokMsg').textContent = 'Jeton valide et enregistré sur cet appareil.'; applyStores(); } catch (e) { $('#stTokMsg').textContent = 'Ce jeton ne donne pas accès au dépôt. Vérifie le dépôt choisi et les permissions.'; LS.set('radar-gh-token', null); } };
  $('#stTokDel').onclick = () => { LS.set('radar-gh-token', null); $('#stTokMsg').textContent = 'Jeton retiré de cet appareil.'; applyStores(); };
  const pwS = $('#stPwSave'); if (pwS) pwS.onclick = async () => {
    const v = $('#stPw').value; if (v.length < 12) { $('#stPwMsg').textContent = 'Choisis au moins 12 caractères.'; return; }
    if (!token()) { $('#stPwMsg').textContent = 'Un jeton GitHub est nécessaire pour enregistrer.'; return; }
    try { const cur = await ghRead('data/private.enc.json'); const obj = await decryptBlob(JSON.parse(cur.text), Store.pw); await ghWrite('data/private.enc.json', JSON.stringify(await encryptObj(obj, v)), cur.sha, 'Nouveau mot de passe du coffre'); Store.pw = v; if (LS.get('radar-pw')) LS.set('radar-pw', v); $('#stPwMsg').textContent = 'Mot de passe changé. Pense à mettre à jour le secret RADAR_PASSWORD sur GitHub.'; }
    catch (e) { $('#stPwMsg').textContent = 'Le changement a échoué.'; }
  };
  const fg = $('#stForget'); if (fg) fg.onclick = () => { LS.set('radar-pw', null); LS.set('radar-owner', null); $('#stPwMsg').textContent = 'Le mot de passe sera demandé à la prochaine visite.'; };
}
document.addEventListener('click', e => { if (e.target.closest('#lockBtn')) { state.unlocked ? openSettings() : openUnlock(); } if (e.target.closest('#gearBtn')) openSettings(); });
boot();

/* ---------- accueil des visiteurs et visite guidée ---------- */
function renderWelcome() {
  const w = $('#welcome'); if (!w) return;
  const hide = isOwner() || LS.get('radar-welcome') === 'hidden';
  w.hidden = hide; if (hide) return;
  const V = (ic, cls, t) => `<span class="pill ${cls}"><svg class="i" aria-hidden="true"><use href="#i-${ic}"/></svg> ${t}</span>`;
  w.innerHTML = `<button class="close wx" id="wClose" aria-label="${T('Fermer', 'Close')}">×</button>
    <span class="lbl">${T('Bienvenue', 'Welcome')}</span>
    <h2>${T('Un radar qui analyse la bourse tout seul', 'A radar that analyses the market on its own')}</h2>
    <p class="lead">${T('Ce site suit environ 130 entreprises du Canada, des États-Unis et d\'ailleurs. Chaque soir de semaine, il récupère leurs prix et leurs états financiers, les compare entre elles et donne à chacune un score de 0 à 100. Il ne s\'agit pas de conseils financiers : c\'est un projet personnel pour apprendre à analyser des entreprises.',
      'This site tracks about 130 companies from Canada, the US and elsewhere. Every weekday evening it fetches their prices and financial statements, compares them and gives each one a score from 0 to 100. This is not financial advice: it is a personal project to learn how to analyse companies.')}</p>
    <div class="wgrid">
      <div><svg class="i" aria-hidden="true"><use href="#i-binoculars"/></svg><b>${T('Ouvre une entreprise', 'Open a company')}</b><span>${T('Touche une carte ou une ligne du tableau : graphique du prix, profil en 5 axes, raisons d\'investir ou non.', 'Tap a card or a table row: price chart, five-axis profile, reasons to invest or not.')}</span></div>
      <div><svg class="i" aria-hidden="true"><use href="#i-profile"/></svg><b>${T('Lis le profil', 'Read the profile')}</b><span>${T('Survole ou touche chaque pointe de la forme pour voir les 30 critères réussis ou échoués.', 'Hover or tap each point of the shape to see the 30 passed or failed checks.')}</span></div>
      <div><svg class="i" aria-hidden="true"><use href="#i-landmark"/></svg><b>${T('Suis les grands investisseurs', 'Follow great investors')}</b><span>${T('Les positions déclarées de Buffett, Ackman, Burry et d\'autres, plus des découvertes chaque lundi.', 'Reported holdings of Buffett, Ackman, Burry and others, plus new finds every Monday.')}</span></div>
    </div>
    <div class="wlegend"><span class="lbl">${T('Les verdicts', 'Verdicts')}</span>${V('buy', 'v-buy', T('Achat intéressant', 'Attractive'))}${V('thumb', 'v-con', T('À considérer', 'Consider'))}${V('eye', 'v-watch', T('À surveiller', 'Watch'))}${V('alert', 'v-care', T('Prudence', 'Caution'))}${V('ban', 'v-avoid', T('Éviter', 'Avoid'))}</div>
    <div class="wact"><button class="btn primary" id="wTour">${T('Faire la visite guidée (1 min)', 'Take the guided tour (1 min)')}</button><button class="btn" id="wSkip">${T('Explorer tout seul', 'Explore on my own')}</button></div>
    <p class="note">${T('Le portefeuille personnel du propriétaire est chiffré et n\'est jamais visible ici.', 'The owner\'s personal portfolio is encrypted and never visible here.')}</p>`;
  const close = () => { LS.set('radar-welcome', 'hidden'); w.classList.add('bye'); setTimeout(() => { w.hidden = true; w.classList.remove('bye'); }, 250); };
  $('#wClose').onclick = close; $('#wSkip').onclick = close;
  $('#wTour').onclick = () => { close(); startTour(); };
}
const TOUR = () => [
  ['#journee', T('La journée', 'The day'), T('Comment le marché a bougé, et les plus fortes hausses et baisses parmi les titres suivis.', 'How the market moved, and the biggest gainers and losers among tracked stocks.')],
  ['#opps > :first-child', T('Une carte = une entreprise', 'One card = one company'), T('Le cercle est le score radar sur 100, la pastille le verdict. Touche la carte pour ouvrir sa fiche complète.', 'The ring is the radar score out of 100, the badge the verdict. Tap the card to open its full page.')],
  ['#decouvertes', T('Découvertes de la semaine', 'Weekly finds'), T('Chaque lundi, le radar fouille le S&P 500 et le TSX 60 et propose les meilleures entreprises qu\'il ne suit pas encore.', 'Every Monday the radar scans the S&P 500 and TSX 60 and suggests the best companies it does not track yet.')],
  ['#carte', T('Carte des occasions', 'Opportunity map'), T('En haut à droite : bon score et prix loin de son sommet. Touche un point pour ouvrir l\'entreprise.', 'Top right: good score and price far below its high. Tap a dot to open the company.')],
  ['#investisseurs + section', T('Les grands investisseurs', 'Great investors'), T('Ce que détiennent des investisseurs célèbres selon leurs déclarations officielles à la SEC.', 'What famous investors hold according to their official SEC filings.')],
  ['#tAll', T('Tous les titres', 'All stocks'), T('Cherche, trie par score ou par variation du jour, et touche une ligne pour la fiche.', 'Search, sort by score or daily change, and tap a row for details.')],
  ['#palBtn', T('À ton goût', 'Your way'), T('Change les couleurs ici, et la langue avec le bouton FR/EN juste à côté.', 'Change colours here, and the language with the FR/EN button next to it.')]
];
function startTour(i = 0) {
  const steps = TOUR().filter(([sel]) => { const e = $(sel); return e && e.offsetParent !== null; });
  let ov = $('#tour'); if (!ov) { ov = document.createElement('div'); ov.id = 'tour'; ov.innerHTML = '<div class="thole"></div><div class="tbub" role="dialog" aria-live="polite"></div>'; document.body.appendChild(ov); }
  const hole = ov.querySelector('.thole'), bub = ov.querySelector('.tbub');
  const end = () => { ov.remove(); removeEventListener('resize', place); document.removeEventListener('keydown', key); };
  const key = e => { if (e.key === 'Escape') end(); if (e.key === 'ArrowRight') go(i + 1); if (e.key === 'ArrowLeft') go(i - 1); };
  document.addEventListener('keydown', key);
  let el = null;
  function place() {
    if (!el) return; const r = el.getBoundingClientRect(), pad = 6;
    const top = Math.max(r.top - pad, 8), h = Math.min(r.height + pad * 2, innerHeight - top - 8);
    Object.assign(hole.style, { left: (r.left - pad) + 'px', top: top + 'px', width: (r.width + pad * 2) + 'px', height: h + 'px' });
    if (innerWidth <= 760) { Object.assign(bub.style, { left: '12px', right: '12px', top: '', bottom: 'calc(84px + env(safe-area-inset-bottom,0px))', width: '' }); return; }
    const bw = 340, below = top + h + 12 + 190 < innerHeight;
    Object.assign(bub.style, { width: bw + 'px', right: '', bottom: '', left: Math.min(Math.max(12, r.left), innerWidth - bw - 12) + 'px', top: (below ? top + h + 12 : Math.max(12, top - 12 - bub.offsetHeight)) + 'px' });
  }
  function go(n) {
    if (n < 0) return; if (n >= steps.length) return end(); i = n;
    const [sel, title, txt] = steps[i]; el = $(sel);
    const rect = el.getBoundingClientRect(); const fixed = getComputedStyle(el.closest('.topbar') || document.body).position === 'sticky' || el.closest('.topbar');
    if (!fixed) scrollTo({ top: scrollY + rect.top - Math.max(80, (innerHeight - Math.min(rect.height, innerHeight * .55)) / 3), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    bub.innerHTML = `<span class="lbl">${i + 1} / ${steps.length}</span><b>${esc(title)}</b><p>${esc(txt)}</p><div class="tnav"><button class="btn" id="tSkip">${T('Quitter', 'Skip')}</button><span></span>${i ? `<button class="btn" id="tPrev">${T('Retour', 'Back')}</button>` : ''}<button class="btn primary" id="tNext">${i === steps.length - 1 ? T('Terminer', 'Done') : T('Suivant', 'Next')}</button></div>`;
    $('#tSkip').onclick = end; $('#tNext').onclick = () => go(i + 1); if ($('#tPrev')) $('#tPrev').onclick = () => go(i - 1);
    bub.classList.remove('in'); void bub.offsetWidth; bub.classList.add('in');
    setTimeout(place, 380); place(); $('#tNext').focus({ preventScroll: true });
  }
  addEventListener('resize', place); addEventListener('scroll', place, { passive: true });
  ov.onclick = e => { if (e.target === ov) end(); };
  go(i);
}
document.addEventListener('click', e => { if (e.target.closest('#helpBtn')) { if (!isOwner()) { LS.set('radar-welcome', null); renderWelcome(); scrollTo({ top: 0, behavior: 'smooth' }); } else startTour(); } });

/* ---------- easter egg : un mème discret lors des très grosses journées ---------- */
const EGG = { crash: ['img/egg-crash.jpg', 'Mème : Warren Buffett qui conseille de tout vendre en panique', T => T('Très mauvaise journée en bourse. Respire : à long terme, ce n\'est presque jamais fini.', 'Very bad day on the market. Breathe: in the long run, it is almost never over.')],
  stonks: ['img/egg-stonks.jpg', 'Mème : Stonks, un homme en complet devant une flèche boursière qui monte', T => T('Très bonne journée en bourse.', 'Very good day on the market.')] };
function marketMove() {
  const fresh = Object.values(state.stocks).filter(s => s.chg != null && freshDate(s));
  if (!fresh.length) return null;
  const last = fresh.reduce((m, s) => freshDate(s) > m ? freshDate(s) : m, '');
  const d0 = state.status?.day;
  if (d0?.date === last && d0.indices?.length) return { date: last, chg: avgOf(d0.indices.map(i => i.chg)), idx: d0.indices };
  const v = fresh.filter(s => freshDate(s) === last).map(s => s.chg).sort((a, b) => a - b);
  return v.length >= 20 ? { date: last, chg: v[v.length >> 1], idx: [] } : null;
}
function maybeEgg() {
  if (state.eggChecked) return; const m = marketMove(); if (!m) return; state.eggChecked = true;
  const kind = m.chg <= -0.015 ? 'crash' : m.chg >= 0.015 ? 'stonks' : null;
  if (!kind || LS.get('radar-egg') === m.date) return;
  LS.set('radar-egg', m.date);
  setTimeout(() => showEgg(kind, m), 2500);
}
function showEgg(kind, m) {
  $('#egg')?.remove();
  const [src, alt, txt] = EGG[kind];
  const idx = (m?.idx || []).map(i => `${esc(i.n)} ${cp(i.chg)}`).join(' ');
  const el = document.createElement('aside'); el.id = 'egg'; el.className = 'egg ' + kind; el.setAttribute('role', 'status');
  el.innerHTML = `<button class="ex" type="button" aria-label="${T('Fermer', 'Close')}">×</button><img src="${src}" alt="${esc(alt)}" width="560" height="${kind === 'crash' ? 277 : 315}"><div class="et"><p>${esc(txt(T))}</p>${idx ? `<div class="ei num">${idx}</div>` : ''}</div><i class="eb"></i>`;
  document.body.appendChild(el);
  let left = 60000, t0 = performance.now(), timer;
  const bar = el.querySelector('.eb');
  const close = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  const run = () => { t0 = performance.now(); timer = setTimeout(close, left); bar.style.animationPlayState = 'running'; };
  const pause = () => { clearTimeout(timer); left -= performance.now() - t0; bar.style.animationPlayState = 'paused'; };
  el.querySelector('.ex').onclick = close;
  el.onmouseenter = pause; el.onmouseleave = run;
  run();
}
// codes secrets : tape « stonks » ou « buffett » n'importe où sur la page
(() => { let buf = ''; document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || e.key.length !== 1) return;
  buf = (buf + e.key.toLowerCase()).slice(-7);
  if (buf.endsWith('stonks')) { buf = ''; showEgg('stonks', marketMove()); } else if (buf.endsWith('buffett')) { buf = ''; showEgg('crash', marketMove()); }
}); })();

})();
