'use strict';
/* Blue Heaven Kasa — arayüz. Tüm hesap ve kayıtlar çekirdekte (main süreç) yapılır; burası sadece gösterir ve iletir. */

const $ = id => document.getElementById(id);
const SYM = { TL: 'TL', EUR: '€', USD: '$', GBP: '£' };
const CURS = ['TL', 'EUR', 'USD', 'GBP'];
const fmt = n => (Math.round((n || 0) * 100) / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kdate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const longDate = k => kdate(k).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = k => kdate(k).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeOf = s => (s || '').slice(11, 16);
const norm = s => String(s).toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '');

let toastT = null;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast on' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast' + (err ? ' err' : ''); }, err ? 3500 : 1800);
}

// Çekirdeğe çağrı (Electron'da IPC, geliştirmede HTTP)
async function api(method, arg) {
  const r = window.kasa ? await window.kasa.call(method, arg)
    : await (await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, arg }) })).json();
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
// Değişiklik yapan çağrılar: sonuç yeni durumdur; hata olursa kırmızı uyarı.
async function act(method, arg, okMsg) {
  try {
    const st = await api(method, arg);
    if (st && st.day) { S = st; render(); markSaved(); }
    if (okMsg) toast(okMsg);
    return st;
  } catch (e) { toast(e.message, true); return null; }
}
function markSaved() { $('saved').textContent = '✓ Kaydedildi · ' + new Date().toLocaleTimeString('tr-TR'); }


// Programın kendi onay penceresi (tarayıcının confirm() penceresi her ortamda görünmüyor)
function askConfirm(title, text, yes = 'Evet') {
  $('cfT').textContent = title; $('cfS').textContent = text || ''; $('cfYes').textContent = yes;
  $('mConfirm').classList.add('on'); setTimeout(() => $('cfYes').focus(), 30);
  return new Promise(res => {
    const done = v => { $('mConfirm').classList.remove('on'); $('cfYes').onclick = $('cfNo').onclick = null; res(v); };
    $('cfYes').onclick = () => done(true); $('cfNo').onclick = () => done(false);
  });
}

let S = null;          // çekirdekten gelen güncel durum
let pending = [];      // aynı misafire eklenen satırlar
let selProd = null;    // seçili ürün
let discOn = false;

/* ================= BAŞLANGIÇ ================= */
async function boot() {
  try { S = await api('getState'); } catch (e) { document.body.innerHTML = `<p style="padding:30px">Program açılamadı: ${esc(e.message)}</p>`; return; }
  if (S.setupNeeded) { $('setup').classList.remove('hidden'); $('suTL').focus(); return; }
  $('setup').classList.add('hidden'); $('main').classList.remove('hidden');
  initStatic(); render();
  if (window.kasa && window.kasa.onUpdateReady) window.kasa.onUpdateReady(showUpdate);
  $('saved').textContent = S.lastBackup ? 'Son yedek: ' + new Date(S.lastBackup.at).toLocaleString('tr-TR') : '';
}
$('suOk').onclick = async () => {
  const devir = {}; for (const c of CURS) devir[c] = $('su' + c).value || 0;
  const pin = $('suPin').value;
  if (!/^\d{4,12}$/.test(pin)) return toast('Şifre 4–12 rakam olmalı', true);
  if (pin !== $('suPin2').value) return toast('Şifreler aynı değil', true);
  if (!await askConfirm('İlk devir doğru mu?', `${fmt(devir.TL)} TL · ${fmt(devir.EUR)} € · ${fmt(devir.USD)} $ · ${fmt(devir.GBP)} £`, 'Evet, başla')) return;
  try { await api('setup', { devir, pin }); boot(); } catch (e) { toast(e.message, true); }
};

function showUpdate(v) {
  const b = $('upd');
  b.innerHTML = `🔄 Programın yeni sürümü (${esc(v)}) indirildi. Program kapatılınca kendiliğinden kurulur; verileriniz etkilenmez. <button class="hbtn mini" id="updNow">Şimdi yeniden başlat</button>`;
  b.classList.remove('hidden');
  $('updNow').onclick = async () => { if (await askConfirm('Program yeniden başlatılsın mı?', 'Yeni sürüm kurulup program tekrar açılacak. Kaydedilmiş işlemler korunur.', 'Yeniden başlat')) window.kasa.installUpdate(); };
}

let staticDone = false;
function roomOptions(first) {
  return `<option value="">${first}</option>` + [1, 2, 3, 4, 5].map(k => `<optgroup label="${k}. kat">` +
    Array.from({ length: 8 }, (_, i) => `<option>${k * 100 + i + 1}</option>`).join('') + '</optgroup>').join('');
}
function initStatic() {
  if (staticDone) return; staticDone = true;
  $('sRoom').innerHTML = roomOptions('— Yok —');
  $('aRoom').innerHTML = roomOptions('Seçin…');
  $('moveRoom').innerHTML = roomOptions('Seçin…');
  $('gCat').innerHTML = '<option value="">Seçin…</option>' + S.expenseCats.map(g => `<option>${esc(g)}</option>`).join('');
  dRate();
}

/* ================= GENEL ÇİZİM ================= */
const TAG = { satis: 'Satış', doviz: 'Para bozma', gider: 'Gider', patron: 'Cengiz Bey', avans: 'Oda avansı', tahsilat: 'Oda tahsilatı' };
const cell = v => v ? `<td class="n ${v > 0 ? 'pos' : 'neg'}">${v > 0 ? '+' : ''}${fmt(v)}</td>` : '<td class="n dim">·</td>';
const rowHTML = (x, editable) => `<tr class="${x.void ? 'void' : ''}"><td>${timeOf(x.created_at)}</td><td><span class="tag t-${x.type}">${TAG[x.type]}</span></td><td>${esc(x.room || '')}</td><td>${esc(x.description)}${x.void ? ' — iptal' : ''}</td>${cell(x.tl)}${cell(x.eur)}${cell(x.usd)}${cell(x.gbp)}<td class="n">${x.card_tl ? fmt(x.card_tl) : '<span class="dim">·</span>'}</td><td>${editable && !x.void ? `<button class="vbtn" data-v="${x.id}">İptal</button>` : ''}</td></tr>`;

function render() {
  if (!S || !S.day) return;
  $('today').textContent = longDate(S.day.date);
  $('verTag').textContent = S.version ? 'v' + S.version : '';
  document.querySelectorAll('.dateRo').forEach(e => { e.textContent = shortDate(S.day.date); });
  for (const c of CURS) $('b' + c).textContent = fmt(S.balances[c]) + ' ' + SYM[c];
  $('bCARD').textContent = fmt(S.cardToday) + ' TL';
  $('rateChip').textContent = `€ alış ${S.rates.EUR.alis} · satış ${S.rates.EUR.satis}`;
  // Kapatılmamış gün uyarısı
  const st = $('stale');
  if (S.stale) { st.innerHTML = `⚠️ <b>${longDate(S.day.date)}</b> günü henüz kapatılmadı. Gün sonu yapılana kadar girilen işlemler bu güne yazılır. <button class="hbtn mini" id="staleEod">Gün sonunu yap</button>`; st.classList.remove('hidden'); $('staleEod').onclick = openEod; }
  else st.classList.add('hidden');
  renderTx();
  renderAcc(); updSale(); dRate(true);
}

// İşlem listesi: Para Bozma sekmesinde sadece para bozma işlemleri görünür
// Para Bozma sekmesindeki günlük özet: her para birimi için alınan/verilen ve net
function renderDxSum() {
  const T = {};
  S.tx.filter(x => x.type === 'doviz' && !x.void && x.meta && x.meta.cur).forEach(x => {
    const m = x.meta, t = T[m.cur] || (T[m.cur] = { alD: 0, alTL: 0, saD: 0, saTL: 0, n: 0 });
    t.n++;
    if (m.dir === 'alis') { t.alD += m.amount; t.alTL += m.tl; } else { t.saD += m.amount; t.saTL += m.tl; }
  });
  const curs = ['EUR', 'USD', 'GBP'].filter(c => T[c]);
  if (!curs.length) { $('dxSum').innerHTML = ''; return; }
  let netTL = 0;
  const rows = curs.map(c => {
    const t = T[c], s = SYM[c], nD = t.alD - t.saD, nT = t.saTL - t.alTL; netTL += nT;
    const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
    return `<tr><td><b>${s}</b></td>
      <td class="n">${t.alD ? `${fmt(t.alD)} ${s} alındı<br><span class="neg">${fmt(t.alTL)} TL verildi</span>` : '<span class="dim">·</span>'}</td>
      <td class="n">${t.saD ? `${fmt(t.saD)} ${s} verildi<br><span class="pos">${fmt(t.saTL)} TL alındı</span>` : '<span class="dim">·</span>'}</td>
      <td class="n"><b class="${nD >= 0 ? 'pos' : 'neg'}">${sign(nD)} ${s}</b><br><span class="${nT >= 0 ? 'pos' : 'neg'}">${sign(nT)} TL</span></td>
      <td class="n">${t.n}</td></tr>`;
  }).join('');
  $('dxSum').innerHTML = `<h3>Bugünün toplamı</h3><table><thead><tr><th></th><th class="n">Para bozma (döviz → TL)</th><th class="n">Ters bozma (TL → döviz)</th><th class="n">Kasaya net etki</th><th class="n">İşlem</th></tr></thead><tbody>${rows}</tbody></table>` +
    (curs.length > 1 ? `<div class="dxnet">Toplam TL etkisi: <b class="${netTL >= 0 ? 'pos' : 'neg'}">${netTL >= 0 ? '+' : '−'}${fmt(Math.abs(netTL))} TL</b></div>` : '');
}

function renderTx() {
  if (curTab === 'doviz') renderDxSum();
  const onlyDx = curTab === 'doviz', rows = onlyDx ? S.tx.filter(x => x.type === 'doviz') : S.tx;
  $('tx').innerHTML = rows.length ? rows.map(x => rowHTML(x, true)).join('')
    : `<tr class="emptyrow"><td colspan="10">${onlyDx ? 'Bugün henüz para bozma yok' : 'Bu gün henüz işlem yok'}</td></tr>`;
}

/* ================= SEKMELER ================= */
let curTab = 'satis';
$('tabs').onclick = e => {
  const t = e.target.closest('[data-t]'); if (!t) return;
  curTab = t.dataset.t;
  [...$('tabs').querySelectorAll('[data-t]')].forEach(b => b.classList.toggle('on', b === t));
  document.querySelectorAll('[data-form]').forEach(f => f.classList.toggle('hidden', f.dataset.form !== curTab));
  $('todayPanel').classList.toggle('hidden', curTab === 'gecmis' || curTab === 'hesap');
  if (curTab === 'gecmis') { hKey = null; renderHist(); }
  if (S && S.tx) renderTx();
  if (curTab === 'satis') $('sProdQ').focus();
};

/* ================= ÜRÜN ARAMA KUTUSU ================= */
const priceText = p => p.price == null ? 'tutar girilir' : (p.currency === 'EUR' ? p.price + ' €' : fmt(p.price) + ' TL') + (p.unit !== 'adet' ? ' / ' + p.unit : '');
let comboItems = [], comboAct = -1;
function comboShow() {
  const q = norm($('sProdQ').value.trim());
  const list = S.products.filter(p => !q || norm(p.name).includes(q) || norm(p.category).includes(q));
  comboItems = list; comboAct = list.length ? 0 : -1;
  let html = '', lastCat = null;
  list.forEach((p, i) => {
    if (p.category !== lastCat) { html += `<div class="grp">${esc(p.category)}</div>`; lastCat = p.category; }
    html += `<div class="opt${i === comboAct ? ' act' : ''}" data-i="${i}"><span>${esc(p.name)}</span><span class="pr">${priceText(p)}</span></div>`;
  });
  $('sProdL').innerHTML = html || '<div class="none">Eşleşen ürün yok</div>';
  $('sProdL').classList.remove('hidden');
}
function comboHide() { $('sProdL').classList.add('hidden'); }
function comboMove(d) {
  if (!comboItems.length) return;
  comboAct = (comboAct + d + comboItems.length) % comboItems.length;
  $('sProdL').querySelectorAll('.opt').forEach(o => o.classList.toggle('act', +o.dataset.i === comboAct));
  const a = $('sProdL').querySelector('.opt.act'); if (a) a.scrollIntoView({ block: 'nearest' });
}
function selectProd(p) {
  selProd = p; $('sProdQ').value = p ? p.name : ''; comboHide();
  if (discOn) setDisc(false);
  $('sQty').value = 1; $('sFree').value = '';
  if (p && p.price == null) { $('sFreeCur').value = p.currency; updSale(); $('sFree').focus(); }
  else { updSale(); if (p) { $('sQty').focus(); $('sQty').select(); } }
}
$('sProdQ').addEventListener('click', comboShow);
$('sProdQ').addEventListener('input', () => { selProd = null; comboShow(); updSale(); });
$('sProdQ').addEventListener('blur', () => setTimeout(comboHide, 150));
$('sProdQ').addEventListener('keydown', e => {
  const open = !$('sProdL').classList.contains('hidden');
  if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) comboShow(); else comboMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); comboMove(-1); }
  else if (e.key === 'Escape') comboHide();
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && comboAct >= 0 && (!selProd || $('sProdQ').value !== selProd.name)) selectProd(comboItems[comboAct]);
    else saveSale();
  }
});
$('sProdL').addEventListener('mousedown', e => { const o = e.target.closest('.opt'); if (o) { e.preventDefault(); selectProd(comboItems[+o.dataset.i]); } });

/* ================= SATIŞ ================= */
const UNIT_LABEL = { gece: 'Gece', 'gün': 'Gün', makine: 'Makine' };
function curLine() {
  const p = selProd; if (!p) return null;
  const qty = Math.max(1, Number($('sQty').value) || 1);
  if (p.price == null) { const v = Number($('sFree').value) || 0; return { p, qty, cur: $('sFreeCur').value, amt: v * qty, freeAmount: v, freeCurrency: $('sFreeCur').value }; }
  if (discOn && $('iPrice').value !== '') { const u = Number($('iPrice').value); return { p, qty, cur: p.currency, amt: u * qty, liste: p.price * qty, overridePrice: u, note: $('iNote').value.trim() }; }
  return { p, qty, cur: p.currency, amt: p.price * qty };
}
const rate = () => S.rates.EUR.satis;
const lineEUR = l => l.cur === 'EUR' ? l.amt : l.amt / rate();
const lineTL = l => l.cur === 'TL' ? l.amt : l.amt * rate();
const lname = l => l.p.name + (l.qty > 1 ? (l.p.unit === 'adet' ? ' ×' + l.qty : ' ' + l.qty + ' ' + l.p.unit) : '');
const discBad = l => l.liste != null && l.amt !== l.liste && !l.note;
function allLines() { const c = curLine(); return c && c.amt ? [...pending, c] : [...pending]; }
function totals() { const ls = allLines(); return { eur: Math.round(ls.reduce((s, l) => s + lineEUR(l), 0) * 100) / 100, tl: Math.round(ls.reduce((s, l) => s + lineTL(l), 0)) }; }

function updSale() {
  if (!S || !S.day) return;
  const p = selProd;
  $('sQtyL').textContent = p && p.unit !== 'adet' ? UNIT_LABEL[p.unit] || 'Adet' : 'Adet';
  $('sFreeF').classList.toggle('hidden', !(p && p.price == null));
  if (p && p.price != null) $('iSym').textContent = p.currency === 'EUR' ? '€' : 'TL';
  const { eur, tl } = totals(), cl = curLine();
  const strike = cl && cl.liste != null && cl.amt !== cl.liste ? `<span class="strike">${fmt(cl.liste)} ${cl.cur === 'EUR' ? '€' : 'TL'}</span>` : '';
  $('sSum').innerHTML = allLines().length ? `${strike}${fmt(eur)} €<small>= ${fmt(tl)} TL</small>` : '—';
  $('pending').innerHTML = pending.map((l, k) => `<span>${esc(lname(l))} · ${l.cur === 'EUR' ? fmt(l.amt) + ' €' : fmt(l.amt) + ' TL'}${l.liste != null && l.amt !== l.liste ? ' (indirimli)' : ''}<button data-k="${k}">×</button></span>`).join('');
  $('split').classList.toggle('on', $('sPay').value === 'SPLIT');
  const paid = (Number($('pEUR').value) || 0) * rate() + (Number($('pTL').value) || 0) + (Number($('pCARD').value) || 0), r = Math.round(tl - paid);
  $('pRest').textContent = !tl ? '—' : r === 0 ? '✓' : r > 0 ? fmt(r) + ' TL' : 'fazla ' + fmt(-r) + ' TL';
  $('pRest').style.color = r === 0 ? 'var(--green)' : 'var(--red)';
}
['sQty', 'sFree', 'sFreeCur', 'sPay', 'pEUR', 'pTL', 'pCARD', 'iPrice', 'iNote'].forEach(id => { $(id).addEventListener('input', updSale); $(id).addEventListener('change', updSale); });
['sQty', 'sFree', 'pEUR', 'pTL', 'pCARD', 'iPrice', 'iNote'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveSale(); } }));

function setDisc(on) { discOn = on; $('disc').classList.toggle('on', on); if (!on) { $('iPrice').value = ''; $('iNote').value = ''; } updSale(); }
$('sDisc').onclick = () => { if (!selProd || selProd.price == null) return toast('Önce sabit fiyatlı bir ürün seçin', true); setDisc(true); $('iPrice').focus(); };
$('iCancel').onclick = () => setDisc(false);
$('pending').onclick = e => { const k = e.target.dataset.k; if (k != null) { pending.splice(+k, 1); updSale(); } };
$('sAdd').onclick = () => {
  const c = curLine(); if (!c) return toast('Önce ürün seçin', true); if (!c.amt) return toast('Tutar girin', true); if (discBad(c)) return toast('İndirim için açıklama yazın', true);
  pending.push(c); selectProd(null); $('sHint').textContent = 'Ürün eklendi — sıradakini seçin veya Kaydet’e basın.'; $('sProdQ').focus();
};
function resetSale() { pending = []; selectProd(null); $('sRoom').value = ''; $('sPay').value = 'EUR'; ['pEUR', 'pTL', 'pCARD'].forEach(i => { $(i).value = ''; }); $('sHint').textContent = ''; updSale(); }

// Odaya yazarken: odada açık hesap varsa "aynı misafir mi" sorulur. Sonuç: {mode:'existing',id} | {mode:'new'} | null(vazgeçildi)
async function chooseAccount(room) {
  const open = await api('openAccountsForRoom', room);
  if (!open.length) return { mode: 'new' };
  const a = open[0];
  $('sameT').textContent = `${room} numaralı odada açık hesap var`;
  $('sameS').textContent = `${shortDate(a.opened_day)} tarihinden beri açık, borç ${fmt(a.eurEq)} € (${fmt(a.tlEq)} TL). Aynı misafire mi yazılsın, yoksa odaya yeni misafir mi girdi? Yeni misafir seçilirse eski hesap “çıktı, ödenmedi” olarak listede kalır.`;
  $('mSame').classList.add('on');
  return new Promise(res => {
    const done = v => { $('mSame').classList.remove('on'); $('sameOld').onclick = $('sameNew').onclick = null; $('mSame').querySelector('[data-close]').onclick = closeModal; res(v); };
    $('sameOld').onclick = () => done({ mode: 'existing', id: a.id });
    $('sameNew').onclick = () => done({ mode: 'new' });
    $('mSame').querySelector('[data-close]').onclick = () => done(null);
  });
}

let busy = false;
async function saveSale() {
  if (busy) return;
  const ls = allLines(); if (!ls.length) return toast('Ürün seçin', true);
  const c = curLine(); if (c && !c.amt) return toast('Tutar girin', true);
  if (ls.some(discBad)) return toast('İndirim için açıklama yazın', true);
  const pay = $('sPay').value, room = $('sRoom').value;
  const payment = { method: pay, eur: $('pEUR').value, tl: $('pTL').value, card: $('pCARD').value };
  let account = null;
  busy = true;
  try {
    if (pay === 'ODA') {
      if (!room) return toast('Oda hesabı için oda seçin', true);
      account = await chooseAccount(room); if (!account) return;
    }
    const lines = ls.map(l => ({ productId: l.p.id, qty: l.qty, freeAmount: l.freeAmount, freeCurrency: l.freeCurrency, overridePrice: l.overridePrice, note: l.note }));
    const st = await act('addSale', { room, lines, payment, account }, pay === 'ODA' ? `${room} hesabına yazıldı` : 'Satış kaydedildi');
    if (st) { resetSale(); $('sProdQ').focus(); }
  } catch (e) { toast(e.message, true); } finally { busy = false; }
}
$('sSave').onclick = saveSale;

/* ================= PARA BOZMA ================= */
function dRate(keep) {
  if (!S || !S.rates) return;
  const s = SYM[$('dCur').value];
  $('dDir').options[0].text = `Para bozma (${s} → TL)`; $('dDir').options[1].text = `Ters bozma (TL → ${s})`; $('dSym').textContent = s;
  if (!keep || !$('dRate').value) $('dRate').value = S.rates[$('dCur').value][$('dDir').value];
  dCalc();
}
function dCalc() {
  const a = Number($('dAmt').value) || 0, r = Number($('dRate').value) || 0;
  $('dResL').textContent = $('dDir').value === 'alis' ? 'Misafire verilecek TL' : 'Misafirden alınacak TL';
  $('dRes').textContent = a ? fmt(Math.round(a * r)) + ' TL' : '—';
}
$('dDir').onchange = () => dRate(); $('dCur').onchange = () => dRate(); $('dAmt').oninput = dCalc; $('dRate').oninput = dCalc;
const enterTo = (ids, fn) => ids.forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } }));
async function saveDx() {
  const st = await act('addExchange', { dir: $('dDir').value, cur: $('dCur').value, amount: $('dAmt').value, rate: $('dRate').value }, 'Para bozma kaydedildi');
  if (st) { $('dAmt').value = ''; dCalc(); $('dAmt').focus(); }
}
$('dSave').onclick = saveDx; enterTo(['dAmt', 'dRate'], saveDx);

/* ================= GİDER ================= */
async function saveExp() {
  const st = await act('addExpense', { category: $('gCat').value, desc: $('gDesc').value, currency: $('gCur').value, amount: $('gAmt').value }, 'Gider kaydedildi');
  if (st) { $('gAmt').value = ''; $('gDesc').value = ''; $('gCat').value = ''; }
}
// Sevgi Hanım'a ödeme neredeyse hep € ile yapılıyor; diğer giderler TL
$('gCat').onchange = () => { $('gCur').value = $('gCat').value.startsWith('Masaj terapisti') ? 'EUR' : 'TL'; };
$('gSave').onclick = saveExp; enterTo(['gDesc', 'gAmt'], saveExp);

/* ================= CENGİZ BEY ================= */
async function saveOwner() {
  const st = await act('addOwner', { tl: $('cTL').value, eurIn: $('cEURIN').value, tlOut: $('cTLOUT').value, eur: $('cEUR').value, usd: $('cUSD').value, gbp: $('cGBP').value }, 'Kaydedildi');
  if (st) ['cTL', 'cEURIN', 'cTLOUT', 'cEUR', 'cUSD', 'cGBP'].forEach(k => { $(k).value = ''; });
}
$('cFx').onclick = () => { const show = $('cFxF').classList.contains('hidden'); $('cFxF').classList.toggle('hidden', !show); $('cFxF2').classList.toggle('hidden', !show); $('cFx').textContent = show ? '− Dolar / Sterlin' : '+ Dolar / Sterlin'; if (show) $('cUSD').focus(); };
$('cSave').onclick = saveOwner; enterTo(['cTL', 'cEURIN', 'cTLOUT', 'cEUR', 'cUSD', 'cGBP'], saveOwner);

/* ================= İPTAL ================= */
$('tx').onclick = async e => {
  const id = e.target.dataset.v; if (!id) return;
  if (!await askConfirm('Bu işlem iptal edilsin mi?', 'Kayıt silinmez, listede üstü çizili kalır.', 'Evet, iptal et')) return;
  act('voidTx', { id: Number(id) }, 'İşlem iptal edildi');
};

/* ================= ODA HESAPLARI ================= */
function renderAcc() {
  const L = S.accounts || [];
  $('accCount').textContent = L.length || '';
  $('accList').innerHTML = L.length ? L.map(a => `<div class="acc"><div class="ah"><span class="room">${esc(a.room)}</span><span class="since">${shortDate(a.opened_day)}’den beri · ${a.items.filter(i => i.kind !== 'not').length} kalem</span>${a.left_unpaid ? '<span class="badge-left">Çıktı, ödenmedi</span>' : ''}<span class="tot">${a.items.some(i => i.paid_tx_id) ? '<small style="margin-right:6px">kalan</small>' : ''}${fmt(a.eurEq)} €<small>= ${fmt(a.tlEq)} TL</small></span></div>
    <table><tbody>${a.items.map(i => `<tr class="${i.paid_tx_id ? 'paid' : ''}"><td style="width:120px;color:var(--muted)">${shortDate(i.day).slice(0, 5)} ${timeOf(i.created_at)}</td><td>${esc(i.description)}${i.paid_tx_id ? ' <span class="paidtag">✓ ödendi</span>' : ''}</td><td class="n">${i.kind === 'not' ? '' : fmt(i.amount) + ' ' + SYM[i.currency]}</td></tr>`).join('')}</tbody></table>
    <div class="acts"><button class="hbtn main" data-close-acc="${a.id}">Tahsil et</button><button class="hbtn" data-fix="${a.id}">Düzeltme</button><button class="hbtn" data-move="${a.id}">Oda değiştir</button></div></div>`).join('')
    : '<p style="color:var(--muted)">Açık oda hesabı yok.</p>';
}
let accSel = null;
$('accList').onclick = e => {
  const d = e.target.dataset; const id = Number(d.closeAcc || d.fix || d.move); if (!id) return;
  accSel = S.accounts.find(a => a.id === id); if (!accSel) return;
  if (d.closeAcc) {
    $('accT').textContent = `${accSel.room} — tahsilat`;
    const due = accSel.items.filter(i => i.kind !== 'not' && !i.paid_tx_id);
    $('accItems').innerHTML = `<table class="pick"><thead><tr><th style="width:34px"><input type="checkbox" id="accAll" checked></th><th>Kalem</th><th class="n">Tutar</th></tr></thead><tbody>` +
      due.map(i => `<tr><td><input type="checkbox" class="accPick" value="${i.id}" checked></td><td>${esc(i.description)}</td><td class="n">${fmt(i.amount)} ${SYM[i.currency]}</td></tr>`).join('') +
      `</tbody></table><div class="accSel" id="accSelTot"></div>`;
    $('accAll').onchange = () => { document.querySelectorAll('.accPick').forEach(c => { c.checked = $('accAll').checked; }); updAccSel(); };
    document.querySelectorAll('.accPick').forEach(c => { c.onchange = updAccSel; });
    updAccSel();
    $('accPay').value = 'EUR'; $('accSplit').classList.remove('on'); ['qEUR', 'qTL', 'qCARD'].forEach(i => { $(i).value = ''; });
    $('mAcc').classList.add('on');
  } else if (d.fix) {
    $('fixT').textContent = `${accSel.room} — hesap düzeltme`; $('fixDesc').value = ''; $('fixAmt').value = ''; $('fixCur').value = 'TL';
    $('mFix').classList.add('on'); $('fixDesc').focus();
  } else {
    $('moveT').textContent = `${accSel.room} hesabını başka odaya taşı`; $('moveRoom').value = '';
    $('mMove').classList.add('on');
  }
};
$('accPay').onchange = () => $('accSplit').classList.toggle('on', $('accPay').value === 'SPLIT');
// Seçilen kalemlerin toplamı; hepsi seçiliyse hesap kapanır
function accPicked() {
  const ids = [...document.querySelectorAll('.accPick')].filter(c => c.checked).map(c => Number(c.value));
  const items = accSel.items.filter(i => ids.includes(i.id)), r = S.rates.EUR.satis;
  const t = { TL: 0, EUR: 0 }; items.forEach(i => { t[i.currency] += i.amount; });
  const total = document.querySelectorAll('.accPick').length;
  return { ids, all: ids.length === total, eur: Math.round((t.EUR + t.TL / r) * 100) / 100, tl: Math.round(t.TL + t.EUR * r) };
}
function updAccSel() {
  const p = accPicked();
  $('accAll').checked = p.all;
  $('accSelTot').innerHTML = p.ids.length ? `${p.all ? 'Tümü' : p.ids.length + ' kalem'} seçili: <b>${fmt(p.eur)} € = ${fmt(p.tl)} TL</b>` : 'Tahsil edilecek kalemleri seçin.';
  $('accOk').textContent = p.all ? 'Tahsil et ve hesabı kapat' : 'Seçilenleri tahsil et';
  $('accOk').disabled = !p.ids.length;
}
$('accOk').onclick = async () => {
  const p = accPicked();
  const st = await act('payAccount', { accountId: accSel.id, itemIds: p.all ? null : p.ids, payment: { method: $('accPay').value, eur: $('qEUR').value, tl: $('qTL').value, card: $('qCARD').value } }, p.all ? `${accSel.room} hesabı kapatıldı` : `${accSel.room}: ${p.ids.length} kalem tahsil edildi`);
  if (st) $('mAcc').classList.remove('on');
};
$('fixOk').onclick = async () => {
  const st = await act('correctAccount', { accountId: accSel.id, desc: $('fixDesc').value, currency: $('fixCur').value, amount: $('fixAmt').value }, 'Düzeltme kaydedildi');
  if (st) $('mFix').classList.remove('on');
};
$('moveOk').onclick = async () => {
  const st = await act('moveAccount', { accountId: accSel.id, room: $('moveRoom').value }, 'Hesap taşındı');
  if (st) $('mMove').classList.remove('on');
};
$('aSave').onclick = async () => {
  const room = $('aRoom').value; if (!room) return toast('Oda seçin', true);
  if (!$('aDesc').value.trim()) return toast('Açıklama yazın', true);
  if (!(Number($('aAmt').value) > 0)) return toast('Tutar girin', true);
  const account = await chooseAccount(room); if (!account) return;
  const st = await act('addAvans', { room, desc: $('aDesc').value, currency: $('aCur').value, amount: $('aAmt').value, account }, `${room} hesabına yazıldı`);
  if (st) { $('aDesc').value = ''; $('aAmt').value = ''; }
};

/* ================= GEÇMİŞ GÜNLER ================= */
let hKey = null, hKeys = [];
async function renderHist() {
  try { hKeys = await api('listClosedDays'); } catch (e) { return toast(e.message, true); }
  if (!hKeys.length) { $('hSel').innerHTML = ''; $('hBody').innerHTML = '<p style="color:var(--muted)">Henüz kapatılmış gün yok.</p>'; $('hOlder').disabled = $('hNewer').disabled = true; return; }
  if (!hKey || !hKeys.includes(hKey)) hKey = hKeys[0];
  const idx = hKeys.indexOf(hKey);
  $('hSel').innerHTML = hKeys.map(k => `<option value="${k}" ${k === hKey ? 'selected' : ''}>${longDate(k)}</option>`).join('');
  $('hOlder').disabled = idx >= hKeys.length - 1; $('hNewer').disabled = idx <= 0;
  let d; try { d = await api('getDayDetail', hKey); } catch (e) { return toast(e.message, true); }
  const used = CURS.filter(k => k === 'TL' || k === 'EUR' || d.devir[k] || d.inn[k] || d.out[k] || (d.kapanis && d.kapanis[k]));
  const kap = d.kapanis || d.expected;
  $('hBody').innerHTML = `<div class="hmeta"><span>İşlem: <b>${d.tx.length - d.nVoid}</b>${d.nVoid ? ` (${d.nVoid} iptal)` : ''}</span><span>Satış: <b>${d.nSale}</b></span><span>Kartla gelen: <b>${fmt(d.card)} TL</b></span></div>
   <table class="hsum"><thead><tr><th></th><th class="n">Devir</th><th class="n">Giren</th><th class="n">Çıkan</th><th class="n">Olması gereken</th><th class="n">Sayılan (kapanış)</th><th class="n">Fark</th></tr></thead><tbody>` +
    used.map(k => { const df = Math.round((kap[k] - d.expected[k]) * 100) / 100; return `<tr><td><b>${SYM[k]}</b></td><td class="n">${fmt(d.devir[k])}</td><td class="n pos">+${fmt(d.inn[k])}</td><td class="n neg">−${fmt(d.out[k])}</td><td class="n">${fmt(d.expected[k])}</td><td class="n"><b>${fmt(kap[k])}</b></td><td class="n ${df ? (df > 0 ? 'pos' : 'neg') : ''}">${df ? (df > 0 ? '+' : '') + fmt(df) : '✓'}</td></tr>`; }).join('') +
    `</tbody></table><table><thead><tr><th>Saat</th><th>Tür</th><th>Oda</th><th>Açıklama</th><th class="n">TL</th><th class="n">€</th><th class="n">$</th><th class="n">£</th><th class="n">Kart TL</th><th></th></tr></thead><tbody>` +
    (d.tx.length ? d.tx.map(x => rowHTML(x, false)).join('') : '<tr class="emptyrow"><td colspan="10">Bu gün işlem yok</td></tr>') + '</tbody></table>';
}
$('hSel').onchange = () => { hKey = $('hSel').value; renderHist(); };
$('hOlder').onclick = () => { const i = hKeys.indexOf(hKey); if (i < hKeys.length - 1) { hKey = hKeys[i + 1]; renderHist(); } };
$('hNewer').onclick = () => { const i = hKeys.indexOf(hKey); if (i > 0) { hKey = hKeys[i - 1]; renderHist(); } };

/* ================= GÜN SONU ================= */
function closeModal(e) { e.target.closest('.modal').classList.remove('on'); }
document.querySelectorAll('[data-close]').forEach(b => { b.onclick = closeModal; });
function openEod() {
  const b = S.balances;
  $('eod').innerHTML = '<span></span><span class="h" style="text-align:right">Olması gereken</span><span class="h">Sayılan</span><span class="h" style="text-align:right">Fark</span>' +
    CURS.map(k => `<b>${SYM[k]}</b><span class="exp">${fmt(b[k])}</span><input data-k="${k}" type="number"><span class="d" id="d${k}"></span>`).join('');
  $('eod').querySelectorAll('input').forEach(inp => {
    inp.oninput = () => {
      const k = inp.dataset.k, d = (Number(inp.value) || 0) - b[k], el = $('d' + k);
      if (inp.value === '') { el.textContent = ''; return; }
      el.textContent = Math.abs(d) < 0.01 ? '✓' : (d > 0 ? '+' : '') + fmt(d); el.className = 'd ' + (Math.abs(d) < 0.01 || d > 0 ? 'pos' : 'neg');
    };
  });
  const oa = S.accounts || [], ot = oa.reduce((x, a) => x + a.eurEq, 0);
  $('eodAcc').classList.toggle('hidden', !oa.length);
  $('eodAcc').innerHTML = `Açık oda hesaplarında <b>${fmt(ot)} €</b> alacak var (${oa.map(a => esc(a.room)).join(', ')}). Bu para henüz kasada değil, sayıma dahil edilmez.`;
  $('mEod').classList.add('on');
  const first = $('eod').querySelector('input'); if (first) first.focus();
}
$('openEod').onclick = openEod;
$('eodOk').onclick = async () => {
  const counts = {}; $('eod').querySelectorAll('input').forEach(i => { counts[i.dataset.k] = i.value; });
  if (Object.values(counts).some(v => v === '')) return toast('Tüm para birimlerini sayıp yazın (yoksa 0)', true);
  const old = S.day.date;
  const st = await act('closeDay', { counts });
  if (st) { $('mEod').classList.remove('on'); toast(`${shortDate(old)} kapatıldı — ${shortDate(st.day.date)} açıldı`); }
};

/* ================= ŞİFRE / RAPOR / AYARLAR ================= */
let token = null, pinFor = null;
function askPin(forWhat) {
  pinFor = forWhat;
  $('pinT').textContent = forWhat === 'rep' ? '🔒 Rapor' : '🔒 Ayarlar';
  $('pin').value = ''; $('pinErr').textContent = ''; $('mPin').classList.add('on'); setTimeout(() => $('pin').focus(), 30);
}
$('openRep').onclick = () => askPin('rep');
$('openSet').onclick = () => askPin('set');
$('pinOk').onclick = async () => {
  let r; try { r = await api('verifyPin', $('pin').value); } catch (e) { return toast(e.message, true); }
  if (!r.ok) { $('pinErr').textContent = 'Şifre yanlış'; $('pin').value = ''; $('pin').focus(); return; }
  token = r.token; $('mPin').classList.remove('on');
  if (pinFor === 'rep') openReport('day'); else openSettings();
};
$('pin').onkeydown = e => { if (e.key === 'Enter') $('pinOk').click(); if (e.key === 'Escape') $('mPin').classList.remove('on'); };
async function lockOut() { if (token) { try { await api('lock', token); } catch (_) { /* yoksay */ } token = null; } }
$('repClose').onclick = async () => { $('rep').classList.remove('on'); await lockOut(); };
$('setClose').onclick = async () => { $('set').classList.remove('on'); await lockOut(); S = await api('getState'); render(); };
$('rPer').onclick = e => { const p = e.target.dataset.p; if (p) openReport(p); };

let repPer = 'day', repLabel = null;
$('repXlsx').onclick = async () => {
  try {
    const r = repPer === 'day' ? await api('exportDay', { token, date: S.day.date }) : await api('exportMonth', { token, month: repLabel });
    const name = r.file.split(/[\\/]/).pop();
    $('repXlsxInfo').innerHTML = `✓ Kaydedildi: <b>${esc(name)}</b> — Belgeler › BlueHeavenKasa-Raporlar. Gün sonlarında günün ve ayın raporu buraya kendiliğinden kaydedilir.`;
    toast('Excel raporu kaydedildi');
  } catch (e) { toast(e.message, true); }
};
$('repDir').onclick = () => { if (window.kasa && window.kasa.openReports) window.kasa.openReports(); else toast('Klasör sadece kurulu programda açılır', true); };

function barsHTML(obj, unit) {
  const rows = Object.entries(obj).map(([k, v]) => typeof v === 'number' ? [k, v, null] : [k, v.e, v.q]).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = Math.max(1, ...rows.map(r => r[1]));
  return rows.length ? rows.map(([k, v, q]) => `<div class="bar"><span>${esc(k)}${q != null ? ` <span style="color:var(--muted)">×${fmt(q)}</span>` : ''}</span><div class="track"><div class="fill" style="width:${v / max * 100}%"></div></div><span style="text-align:right">${fmt(Math.round(v))} ${unit}</span></div>`).join('') : '<p style="color:var(--muted);margin:0">Kayıt yok.</p>';
}
async function openReport(per) {
  let A; try { A = await api('report', { token, period: per }); } catch (e) { toast(e.message, true); return; }
  repPer = per; repLabel = A.label; $('repXlsxInfo').textContent = '';
  $('repXlsx').textContent = per === 'day' ? '📄 Günü Excel’e kaydet' : '📄 Ayı Excel’e kaydet';
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
    $('rDaily').innerHTML = `<svg viewBox="0 0 ${W} ${H + 22}" style="width:100%;height:auto">` + vals.map((v, i) => {
      const h = v / max * H;
      return `<rect x="${i * bw + bw * 0.15}" y="${H - h}" width="${bw * 0.7}" height="${h}" rx="3" fill="#17699e"><title>${i + 1}: ${fmt(Math.round(v))} €</title></rect><text x="${i * bw + bw / 2}" y="${H + 16}" font-size="10" text-anchor="middle" fill="#6b7385">${i + 1}</text>`;
    }).join('') + '</svg>';
  }
  $('rCat').innerHTML = barsHTML(A.cat, '€'); $('rProd').innerHTML = barsHTML(A.prod, '€'); $('rGider').innerHTML = barsHTML(A.gider, 'TL');
  const P = A.pay, tot = P.EUR + P.TL + P.KART + P.ODA || 1, C = { EUR: '#17699e', TL: '#1d8a5a', KART: '#5b4bb7', ODA: '#f0a32a' }, L = { EUR: 'Nakit €', TL: 'Nakit TL', KART: 'Kart', ODA: 'Oda hesabına' };
  $('rPay').innerHTML = `<div class="stack">${Object.keys(P).map(k => `<div style="width:${P[k] / tot * 100}%;background:${C[k]}"></div>`).join('')}</div><div class="legend">${Object.keys(P).map(k => `<span><i style="background:${C[k]}"></i>${L[k]}: <b>${fmt(Math.round(P[k]))} €</b> (%${Math.round(P[k] / tot * 100)})</span>`).join('')}</div>`;
  const dxRows = Object.entries(A.dx || {});
  $('rDx').innerHTML = dxRows.length ? '<table><thead><tr><th>Para birimi</th><th class="n">Bozulan (döviz → TL)</th><th class="n">Ödenen TL</th><th class="n">Ters bozma (TL → döviz)</th><th class="n">Alınan TL</th><th class="n">İşlem</th></tr></thead><tbody>' +
    dxRows.map(([c, d]) => `<tr><td><b>${SYM[c]}</b></td><td class="n">${fmt(d.al)} ${SYM[c]}</td><td class="n">${fmt(d.alTL)} TL</td><td class="n">${fmt(d.sa)} ${SYM[c]}</td><td class="n">${fmt(d.saTL)} TL</td><td class="n">${d.n}</td></tr>`).join('') + '</tbody></table>'
    : '<p style="color:var(--muted);margin:0">Kayıt yok.</p>';
  $('rep').classList.add('on'); $('rep').scrollTop = 0;
}

// --- Ayarlar ---
let SET = null;
async function openSettings() {
  try { SET = await api('getSettings', { token }); } catch (e) { return toast(e.message, true); }
  renderSettings(); $('set').classList.add('on'); $('set').scrollTop = 0;
}
const opt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label || v)}</option>`;
function prodRow(p) {
  const id = p.id || '';
  return `<tr data-id="${id}"><td><input data-f="name" value="${esc(p.name || '')}" placeholder="Yeni ürün adı"></td>
    <td><select data-f="category">${SET.categories.map(c => opt(c, p.category)).join('')}</select></td>
    <td><select data-f="currency">${opt('EUR', p.currency, '€')}${opt('TL', p.currency, 'TL')}</select></td>
    <td><input data-f="price" type="number" step="0.01" value="${p.price == null ? '' : p.price}" placeholder="serbest" style="width:100px"></td>
    <td><select data-f="unit">${['adet', 'gece', 'gün', 'makine'].map(u => opt(u, p.unit || 'adet')).join('')}</select></td>
    <td style="text-align:center"><input data-f="active" type="checkbox" ${p.active !== 0 ? 'checked' : ''} style="width:18px;height:18px"></td>
    <td><button class="hbtn mini" data-save-prod>${id ? 'Kaydet' : 'Ekle'}</button></td></tr>`;
}
function updText(u) {
  if (!u) return '';
  const cur = `Kurulu sürüm: <b>${esc(u.version)}</b>`;
  const m = {
    dev: 'Geliştirme sürümü — güncelleme denetlenmez.',
    idle: 'Henüz denetlenmedi.',
    checking: 'Denetleniyor…',
    none: '✓ Program güncel.',
    downloading: `Yeni sürüm <b>${esc(u.next || '')}</b> indiriliyor… %${u.percent || 0}`,
    ready: `✓ Yeni sürüm <b>${esc(u.next || '')}</b> indirildi. Program kapatılınca kurulur.`,
    error: '⚠️ ' + esc(u.error || 'Denetlenemedi.'),
  }[u.state] || '';
  return `${cur} · ${m}`;
}
async function refreshUpd(force) {
  if (!window.kasa || !window.kasa.updateStatus) { $('updStatus').innerHTML = 'Güncelleme sadece kurulu programda çalışır.'; $('updCheck').classList.add('hidden'); return; }
  $('updStatus').innerHTML = updText({ ...(await window.kasa.updateStatus()), ...(force ? { state: 'checking' } : {}) });
  const u = force ? await window.kasa.checkUpdate() : await window.kasa.updateStatus();
  $('updStatus').innerHTML = updText(u);
  $('updInstall').classList.toggle('hidden', u.state !== 'ready');
}
$('updCheck').onclick = () => refreshUpd(true);
$('updInstall').onclick = async () => { if (await askConfirm('Program yeniden başlatılsın mı?', 'Yeni sürüm kurulup program tekrar açılacak. Kaydedilmiş işlemler korunur.', 'Yeniden başlat')) window.kasa.installUpdate(); };

// --- Müdür bilgisayarından erişim ---
let LAN = null;
async function loadLan() { try { LAN = await api('lanStatus', { token }); renderLan(); } catch (e) { $('lanBody').innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p>`; } }
function renderLan() {
  const L = LAN, on = L.enabled;
  const addr = L.running && L.addresses.length ? L.addresses.map(a => `<b style="font-size:16px">${esc(a)}</b>`).join(' &nbsp;veya&nbsp; ') : '';
  $('lanBody').innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <span>Durum: <b style="color:${on ? 'var(--green)' : 'var(--muted)'}">${on ? (L.running ? 'Açık' : 'Açılıyor / port kullanımda') : 'Kapalı'}</b></span>
      <button class="hbtn mini" id="lanToggle">${on ? 'Kapat' : 'Aç'}</button>
    </div>
    ${on ? `<div style="margin-bottom:12px">Müdür bilgisayarında Chrome’a şu adresi yazın: ${addr || '<i>adres bulunamadı (ağ bağlantısını kontrol edin)</i>'}</div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <button class="hbtn main mini" id="lanCode">Yeni cihaz eşleştir</button>
      ${L.code ? `<span>Eşleştirme kodu: <b style="font-size:24px;letter-spacing:4px">${esc(L.code.code)}</b> <span class="hint">(${Math.max(0, Math.round((L.code.expires - Date.now()) / 60000))} dk geçerli, tek kullanımlık)</span></span>` : ''}
    </div>
    <table><thead><tr><th>Eşleşmiş cihaz</th><th>Eşleşme</th><th>Son erişim</th><th></th></tr></thead><tbody>
      ${L.devices.length ? L.devices.map(d => `<tr><td>${esc(d.ip || '')}</td><td>${esc(d.created)}</td><td>${esc(d.lastSeen)}</td><td><button class="hbtn mini" data-rmdev="${esc(d.id)}">Kaldır</button></td></tr>`).join('') : '<tr><td colspan="4" style="color:var(--muted)">Henüz eşleşmiş cihaz yok.</td></tr>'}
    </tbody></table>
    <div class="hint" style="margin:8px 0 0">İlk açılışta Windows “ağ erişimine izin verilsin mi” diye sorarsa <b>İzin ver</b>’i seçin.</div>` : ''}`;
  if ($('lanToggle')) $('lanToggle').onclick = async () => { try { LAN = await api('lanSetEnabled', { token, enabled: !on }); setTimeout(loadLan, 600); renderLan(); } catch (e) { toast(e.message, true); } };
  if ($('lanCode')) $('lanCode').onclick = async () => { try { LAN = await api('lanNewCode', { token }); renderLan(); } catch (e) { toast(e.message, true); } };
  $('lanBody').querySelectorAll('[data-rmdev]').forEach(b => { b.onclick = async () => { if (!await askConfirm('Cihaz kaldırılsın mı?', 'Bu cihaz tekrar girmek için yeniden eşleştirilmesi gerekecek.', 'Kaldır')) return; try { LAN = await api('lanRemoveDevice', { token, id: b.dataset.rmdev }); renderLan(); } catch (e) { toast(e.message, true); } }; });
}

function renderSettings() {
  refreshUpd(false);
  loadLan();
  $('verLbl').textContent = S && S.version ? 'Sürüm ' + S.version : '';
  $('setRates').innerHTML = ['EUR', 'USD', 'GBP'].map(c => `<tr><td><b>${SYM[c]}</b></td><td><input data-c="${c}" data-k="alis" type="number" step="0.01" value="${SET.rates[c].alis}"></td><td><input data-c="${c}" data-k="satis" type="number" step="0.01" value="${SET.rates[c].satis}"></td></tr>`).join('');
  $('setProds').innerHTML = SET.products.map(prodRow).join('') + prodRow({ category: SET.categories[0], currency: 'EUR', unit: 'adet', active: 1 });
  const lb = SET.backups[0];
  $('bkInfo').innerHTML = `Yedek klasörleri:<br>${SET.backupDirs.map(d => '• ' + esc(d)).join('<br>')}` + (lb ? `<br>Son yedek: <b>${esc(lb.name)}</b>` : '');
  $('bkDirClear').classList.toggle('hidden', !SET.backupDir2);
  $('bkDir').classList.toggle('hidden', !window.kasa);
  $('bkList').innerHTML = SET.backups.map(b => `<tr><td style="font-size:13px">${esc(b.name)}</td><td class="n" style="font-size:13px;color:var(--muted)">${fmt(b.size / 1024)} KB</td><td><button class="hbtn mini" data-restore="${esc(b.name)}">Geri yükle</button></td></tr>`).join('') || '<tr><td style="color:var(--muted)">Henüz yedek yok.</td></tr>';
}
$('setRatesOk').onclick = async () => {
  const rates = { EUR: {}, USD: {}, GBP: {} };
  $('setRates').querySelectorAll('input').forEach(i => { rates[i.dataset.c][i.dataset.k] = i.value; });
  try { SET = await api('setRates', { token, rates }); renderSettings(); toast('Kurlar kaydedildi'); } catch (e) { toast(e.message, true); }
};
$('setProds').onclick = async e => {
  if (!e.target.hasAttribute('data-save-prod')) return;
  const tr = e.target.closest('tr'), g = f => tr.querySelector(`[data-f="${f}"]`);
  const product = { id: tr.dataset.id ? Number(tr.dataset.id) : null, name: g('name').value, category: g('category').value, currency: g('currency').value, price: g('price').value, unit: g('unit').value, active: g('active').checked };
  try { SET = await api('saveProduct', { token, product }); renderSettings(); toast(product.id ? 'Ürün kaydedildi' : 'Ürün eklendi'); } catch (er) { toast(er.message, true); }
};
$('pwOk').onclick = async () => {
  if ($('pwNew').value !== $('pwNew2').value) return toast('Yeni şifreler aynı değil', true);
  try { await api('changePin', { token, oldPin: $('pwOld').value, newPin: $('pwNew').value }); ['pwOld', 'pwNew', 'pwNew2'].forEach(i => { $(i).value = ''; }); toast('Şifre değiştirildi'); } catch (e) { toast(e.message, true); }
};
$('bkNow').onclick = async () => { try { SET = await api('backupNow', { token }); renderSettings(); toast('Yedek alındı'); } catch (e) { toast(e.message, true); } };
$('bkDir').onclick = async () => { const dir = await window.kasa.pickDir(); if (!dir) return; try { SET = await api('setBackupDir2', { token, dir }); renderSettings(); toast('İkinci yedek klasörü ayarlandı'); } catch (e) { toast(e.message, true); } };
$('bkDirClear').onclick = async () => { try { SET = await api('setBackupDir2', { token, dir: null }); renderSettings(); } catch (e) { toast(e.message, true); } };
$('resetAll').onclick = async () => {
  if (!await askConfirm('Tüm veriler sıfırlansın mı?', 'Bütün işlemler, günler, devirler ve oda hesapları silinecek. Program ilk kurulum ekranına dönecek.\n\nÜrünler, fiyatlar ve kurlar korunur. Silmeden önce yedek alınır.', 'Devam')) return;
  if (!await askConfirm('Emin misiniz?', 'Bu işlemden sonra kasa devri ve şifre yeniden girilecek.', 'Evet, sıfırla')) return;
  try {
    await api('resetAll', { token });
    token = null; $('set').classList.remove('on'); $('main').classList.add('hidden');
    ['suTL', 'suEUR', 'suUSD', 'suGBP', 'suPin', 'suPin2'].forEach(i => { $(i).value = ''; });
    toast('Veriler sıfırlandı'); boot();
  } catch (e) { toast(e.message, true); }
};
$('bkList').onclick = async e => {
  const name = e.target.dataset.restore; if (!name) return;
  if (!await askConfirm('Yedek geri yüklensin mi?', `${name}\n\nŞu anki veriler bu yedekteki haline döner. Geri yüklemeden önce mevcut durumun da yedeği alınır.`, 'Devam')) return;
  if (!await askConfirm('Emin misiniz?', 'Bu yedekten sonra girilen işlemler görünmez olacak.', 'Evet, geri yükle')) return;
  try { S = await api('restoreBackup', { token, name }); SET = await api('getSettings', { token }); renderSettings(); render(); toast('Yedek geri yüklendi'); } catch (er) { toast(er.message, true); }
};

boot();
