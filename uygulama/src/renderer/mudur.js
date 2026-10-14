'use strict';
/* Müdür ekranı: resepsiyondaki kasa programından yerel ağ üzerinden okur. Hiçbir kayıt değiştirmez. */
const $ = id => document.getElementById(id);
const SYM = { TL: 'TL', EUR: '€', USD: '$', GBP: '£' };
const CURS = ['TL', 'EUR', 'USD', 'GBP'];
const TAG = { satis: 'Satış', doviz: 'Para bozma', gider: 'Gider', patron: 'Cengiz Bey', avans: 'Oda avansı', tahsilat: 'Oda tahsilatı' };
const fmt = n => (Math.round((n || 0) * 100) / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kdate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const longDate = k => kdate(k).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = k => kdate(k).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeOf = s => (s || '').slice(11, 16);
let toastT; const toast = (m, err) => { const t = $('toast'); t.textContent = m; t.className = 'toast on' + (err ? ' err' : ''); clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 3000); };

let token = null; try { token = sessionStorage.getItem('bhk_t'); } catch (_) { /* yoksay */ }
let S = null, tab = 'bugun';

async function call(method, arg) {
  const r = await (await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, arg, token }) })).json();
  if (r.unpaired) { show('gPair'); throw new Error(r.error); }
  if (r.needPin) { token = null; show('gPin'); throw new Error(r.error); }
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
function show(id) { ['gPair', 'gPin', 'main'].forEach(x => $(x).classList.toggle('hidden', x !== id)); if (id === 'gPair') $('pairCode').focus(); if (id === 'gPin') { $('pin').value = ''; $('pin').focus(); } }

async function start() {
  let h; try { h = await call('hello'); } catch (e) { return toast('Kasa programına ulaşılamadı. Resepsiyon bilgisayarı açık mı?', true); }
  if (!h.paired) return show('gPair');
  if (!token) return show('gPin');
  enter();
}
$('pairOk').onclick = async () => {
  try { await call('pair', $('pairCode').value); $('pairErr').textContent = ''; show('gPin'); } catch (e) { $('pairErr').textContent = e.message; }
};
$('pairCode').onkeydown = e => { if (e.key === 'Enter') $('pairOk').click(); };
$('pinOk').onclick = async () => {
  try { const r = await call('verifyPin', $('pin').value); token = r.token; try { sessionStorage.setItem('bhk_t', token); } catch (_) { /* yoksay */ } enter(); }
  catch (e) { $('pinErr').textContent = e.message; $('pin').value = ''; }
};
$('pin').onkeydown = e => { if (e.key === 'Enter') $('pinOk').click(); };
$('lockBtn').onclick = () => { token = null; try { sessionStorage.removeItem('bhk_t'); } catch (_) { /* yoksay */ } show('gPin'); };

async function enter() { show('main'); await refresh(); }
async function refresh() {
  try { S = await call('viewState'); } catch (_) { return; }
  if (S.setupNeeded) { $('today').textContent = 'Kasa programında ilk kurulum yapılmamış.'; return; }
  $('today').textContent = longDate(S.day.date) + (S.version ? ` · v${S.version}` : '');
  $('upd').textContent = 'Güncellendi: ' + new Date().toLocaleTimeString('tr-TR');
  for (const c of CURS) $('b' + c).textContent = fmt(S.balances[c]) + ' ' + SYM[c];
  $('bCARD').textContent = fmt(S.cardToday) + ' TL';
  if (tab === 'bugun') renderToday();
}
setInterval(() => { if (token && !document.hidden && tab === 'bugun') refresh(); }, 30000);

$('caRoom').innerHTML = '<option value="">Tüm odalar</option>' + [1, 2, 3, 4, 5].map(k => `<optgroup label="${k}. kat">` + Array.from({ length: 8 }, (_, i) => `<option>${k * 100 + i + 1}</option>`).join('') + '</optgroup>').join('');
const closedAcc = mountClosedAcc({ call, toast });

$('tabs').onclick = e => {
  const t = e.target.closest('[data-t]'); if (!t) return; tab = t.dataset.t;
  [...$('tabs').children].forEach(b => b.classList.toggle('on', b === t));
  document.querySelectorAll('[data-v]').forEach(v => v.classList.toggle('hidden', v.dataset.v !== tab));
  if (tab === 'bugun') refresh(); if (tab === 'rapor') openReport(curPer); if (tab === 'gecmis') { hKey = null; renderHist(); } if (tab === 'excel') renderFiles(); if (tab === 'hesap') closedAcc.latest();
};

const cell = v => v ? `<td class="n ${v > 0 ? 'pos' : 'neg'}">${v > 0 ? '+' : ''}${fmt(v)}</td>` : '<td class="n dim">·</td>';
const rowHTML = x => `<tr class="${x.void ? 'void' : ''}"><td>${timeOf(x.created_at)}</td><td><span class="tag t-${x.type}">${TAG[x.type] || x.type}</span></td><td>${esc(x.room || '')}</td><td>${esc(x.description)}${x.void ? ' — iptal' : ''}</td>${cell(x.tl)}${cell(x.eur)}${cell(x.usd)}${cell(x.gbp)}<td class="n">${x.card_tl ? fmt(x.card_tl) : '<span class="dim">·</span>'}</td></tr>`;
function renderToday() {
  $('tx').innerHTML = S.tx.length ? S.tx.map(rowHTML).join('') : '<tr class="emptyrow"><td colspan="9">Bugün henüz işlem yok</td></tr>';
  $('accs').innerHTML = S.accounts.length ? '<table><thead><tr><th>Oda</th><th>Açılış</th><th>Kalem</th><th class="n">Kalan €</th><th class="n">Kalan TL</th></tr></thead><tbody>' +
    S.accounts.map(a => `<tr><td><b>${esc(a.room)}</b>${a.left_unpaid ? ' <span class="badge-left">Çıktı, ödenmedi</span>' : ''}</td><td>${shortDate(a.opened_day)}</td><td>${a.items.filter(i => i.kind !== 'not' && !i.paid_tx_id).map(i => esc(i.description)).join(', ')}</td><td class="n">${fmt(a.eurEq)}</td><td class="n">${fmt(a.tlEq)}</td></tr>`).join('') + '</tbody></table>'
    : '<p style="color:var(--muted)">Açık oda hesabı yok.</p>';
}

// ---- Rapor ----
let curPer = 'day';
$('rPer').onclick = e => { const p = e.target.dataset.p; if (p) openReport(p); };
function barsHTML(obj, unit) {
  const rows = Object.entries(obj).map(([k, v]) => typeof v === 'number' ? [k, v, null] : [k, v.e, v.q]).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = Math.max(1, ...rows.map(r => r[1]));
  return rows.length ? rows.map(([k, v, q]) => `<div class="bar"><span>${esc(k)}${q != null ? ` <span style="color:var(--muted)">×${fmt(q)}</span>` : ''}</span><div class="track"><div class="fill" style="width:${v / max * 100}%"></div></div><span style="text-align:right">${fmt(Math.round(v))} ${unit}</span></div>`).join('') : '<p style="color:var(--muted);margin:0">Kayıt yok.</p>';
}
async function openReport(per) {
  let A; try { A = await call('report', { period: per }); } catch (e) { return toast(e.message, true); }
  curPer = per;
  [...$('rPer').children].forEach(b => b.classList.toggle('on', b.dataset.p === per));
  const monthName = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' }); };
  $('rLabel').textContent = per === 'day' ? '— ' + longDate(S.day.date) : '— ' + monthName(A.label) + ` (${A.days} gün)`;
  const eurDx = (A.dx && A.dx.EUR) || { al: 0, sa: 0, alTL: 0 };
  const ownerOut = [A.owner.TLOUT ? `${fmt(A.owner.TLOUT)} TL` : null].concat(['EUR', 'USD', 'GBP'].filter(c => A.owner[c]).map(c => `${fmt(A.owner[c])} ${SYM[c]}`)).filter(Boolean).join(', ') || '0 €';
  $('rTiles').innerHTML = [
    ['Toplam satış', fmt(Math.round(A.sale)) + ' €', `${A.cnt} satış · ≈ ${fmt(Math.round(A.sale * S.rates.EUR.satis))} TL`],
    ['Kartla gelen', fmt(A.cardTL) + ' TL', 'satış ve oda tahsilatları'],
    ['Bozulan €', fmt(eurDx.al) + ' €', `${fmt(eurDx.alTL)} TL ödendi` + (eurDx.sa ? ` · ters: ${fmt(eurDx.sa)} €` : '')],
    ['Giderler', fmt(Math.round(A.giderTL)) + ' TL', `${Object.keys(A.gider).length} kategori`],
    ['Cengiz Bey', fmt(A.owner.TL) + ' TL getirdi' + (A.owner.EURIN ? ` · ${fmt(A.owner.EURIN)} €` : ''), `${ownerOut} aldı`],
    ['İndirimler', fmt(Math.round(A.disc)) + ' €', `${A.discN} indirimli satış`],
    ['Açık oda hesapları', fmt(A.openAccounts) + ' €', `${A.openAccountCount || 0} oda (şu an)`],
  ].map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
  $('rDailyP').classList.toggle('hidden', per === 'day');
  if (per !== 'day') {
    const [y, m] = A.label.split('-').map(Number), days = new Date(y, m, 0).getDate();
    const vals = Array.from({ length: days }, (_, i) => A.daily[i + 1] || 0), max = Math.max(1, ...vals), W = 640, H = 180, bw = W / days;
    $('rDaily').innerHTML = `<svg viewBox="0 0 ${W} ${H + 22}" style="width:100%;height:auto">` + vals.map((v, i) => { const h = v / max * H; return `<rect x="${i * bw + bw * 0.15}" y="${H - h}" width="${bw * 0.7}" height="${h}" rx="3" fill="#17699e"><title>${i + 1}: ${fmt(Math.round(v))} €</title></rect><text x="${i * bw + bw / 2}" y="${H + 16}" font-size="10" text-anchor="middle" fill="#6b7385">${i + 1}</text>`; }).join('') + '</svg>';
  }
  $('rCat').innerHTML = barsHTML(A.cat, '€'); $('rProd').innerHTML = barsHTML(A.prod, '€'); $('rGider').innerHTML = barsHTML(A.gider, 'TL');
  const P = A.pay, tot = P.EUR + P.TL + P.KART + P.ODA || 1, C = { EUR: '#17699e', TL: '#1d8a5a', KART: '#5b4bb7', ODA: '#f0a32a' }, L = { EUR: 'Nakit €', TL: 'Nakit TL', KART: 'Kart', ODA: 'Oda hesabına' };
  $('rPay').innerHTML = `<div class="stack">${Object.keys(P).map(k => `<div style="width:${P[k] / tot * 100}%;background:${C[k]}"></div>`).join('')}</div><div class="legend">${Object.keys(P).map(k => `<span><i style="background:${C[k]}"></i>${L[k]}: <b>${fmt(Math.round(P[k]))} €</b> (%${Math.round(P[k] / tot * 100)})</span>`).join('')}</div>`;
  const dxRows = Object.entries(A.dx || {});
  $('rDx').innerHTML = dxRows.length ? '<table><thead><tr><th>Para birimi</th><th class="n">Bozulan</th><th class="n">Ödenen TL</th><th class="n">Ters bozma</th><th class="n">Alınan TL</th><th class="n">İşlem</th></tr></thead><tbody>' +
    dxRows.map(([c, d]) => `<tr><td><b>${SYM[c]}</b></td><td class="n">${fmt(d.al)} ${SYM[c]}</td><td class="n">${fmt(d.alTL)} TL</td><td class="n">${fmt(d.sa)} ${SYM[c]}</td><td class="n">${fmt(d.saTL)} TL</td><td class="n">${d.n}</td></tr>`).join('') + '</tbody></table>' : '<p style="color:var(--muted);margin:0">Kayıt yok.</p>';
}

// ---- Geçmiş günler ----
let hKey = null, hKeys = [];
async function renderHist() {
  try { hKeys = await call('listClosedDays'); } catch (e) { return toast(e.message, true); }
  if (!hKeys.length) { $('hSel').innerHTML = ''; $('hBody').innerHTML = '<p style="color:var(--muted)">Henüz kapatılmış gün yok.</p>'; return; }
  if (!hKey || !hKeys.includes(hKey)) hKey = hKeys[0];
  const idx = hKeys.indexOf(hKey);
  $('hSel').innerHTML = hKeys.map(k => `<option value="${k}" ${k === hKey ? 'selected' : ''}>${longDate(k)}</option>`).join('');
  $('hOlder').disabled = idx >= hKeys.length - 1; $('hNewer').disabled = idx <= 0;
  let d; try { d = await call('getDayDetail', hKey); } catch (e) { return toast(e.message, true); }
  const used = CURS.filter(k => k === 'TL' || k === 'EUR' || d.devir[k] || d.inn[k] || d.out[k] || (d.kapanis && d.kapanis[k]));
  const kap = d.kapanis || d.expected;
  $('hBody').innerHTML = `<div class="hmeta"><span>İşlem: <b>${d.tx.length - d.nVoid}</b>${d.nVoid ? ` (${d.nVoid} iptal)` : ''}</span><span>Satış: <b>${d.nSale}</b></span><span>Kartla gelen: <b>${fmt(d.card)} TL</b></span></div>
   <table class="hsum"><thead><tr><th></th><th class="n">Devir</th><th class="n">Giren</th><th class="n">Çıkan</th><th class="n">Olması gereken</th><th class="n">Sayılan</th><th class="n">Fark</th></tr></thead><tbody>` +
    used.map(k => { const df = Math.round((kap[k] - d.expected[k]) * 100) / 100; return `<tr><td><b>${SYM[k]}</b></td><td class="n">${fmt(d.devir[k])}</td><td class="n pos">+${fmt(d.inn[k])}</td><td class="n neg">−${fmt(d.out[k])}</td><td class="n">${fmt(d.expected[k])}</td><td class="n"><b>${fmt(kap[k])}</b></td><td class="n ${df ? (df > 0 ? 'pos' : 'neg') : ''}">${df ? (df > 0 ? '+' : '') + fmt(df) : '✓'}</td></tr>`; }).join('') +
    `</tbody></table><table><thead><tr><th>Saat</th><th>Tür</th><th>Oda</th><th>Açıklama</th><th class="n">TL</th><th class="n">€</th><th class="n">$</th><th class="n">£</th><th class="n">Kart TL</th></tr></thead><tbody>` +
    (d.tx.length ? d.tx.map(rowHTML).join('') : '<tr class="emptyrow"><td colspan="9">Bu gün işlem yok</td></tr>') + '</tbody></table>';
}
$('hSel').onchange = () => { hKey = $('hSel').value; renderHist(); };
$('hOlder').onclick = () => { const i = hKeys.indexOf(hKey); if (i < hKeys.length - 1) { hKey = hKeys[i + 1]; renderHist(); } };
$('hNewer').onclick = () => { const i = hKeys.indexOf(hKey); if (i > 0) { hKey = hKeys[i - 1]; renderHist(); } };

// ---- Excel raporları ----
async function renderFiles() {
  let r; try { r = await call('listReports'); } catch (e) { return toast(e.message, true); }
  $('files').innerHTML = r.files.length ? r.files.map(f => `<tr><td><a href="/excel?f=${encodeURIComponent(f.name)}&t=${encodeURIComponent(token)}">📄 ${esc(f.name)}</a></td><td class="n">${new Date(f.mtime).toLocaleString('tr-TR')}</td><td class="n">${fmt(f.size / 1024)} KB</td></tr>`).join('')
    : '<tr class="emptyrow"><td colspan="3">Henüz rapor yok. İlk rapor bir sonraki gün sonunda oluşur.</td></tr>';
}

start();
