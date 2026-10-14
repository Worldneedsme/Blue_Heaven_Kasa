// Kapanan oda hesapları listesi — resepsiyon ekranı ve müdür sayfası ortak kullanır (sadece görüntüleme).
(function () {
  const SYM = { TL: 'TL', EUR: '€', USD: '$', GBP: '£' };
  const METHOD = { EUR: 'Nakit €', TL: 'Nakit TL', KART: 'Kart', SPLIT: 'Bölünmüş' };
  const fmt = n => (Math.round((n || 0) * 100) / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dmy = k => { const [y, m, d] = String(k).slice(0, 10).split('-'); return `${d}.${m}.${y}`; };
  const hm = s => (s || '').slice(11, 16);
  const money = t => [t.EUR ? fmt(t.EUR) + ' €' : '', t.TL ? fmt(t.TL) + ' TL' : ''].filter(Boolean).join(' + ') || '0';
  // Tahsilatta kasaya ne girdi: "20 € + 400 TL kart"
  const paidParts = p => [p.eur ? fmt(p.eur) + ' €' : '', p.tl ? fmt(p.tl) + ' TL' : '', p.usd ? fmt(p.usd) + ' $' : '', p.gbp ? fmt(p.gbp) + ' £' : '', p.card_tl ? fmt(p.card_tl) + ' TL kart' : ''].filter(Boolean).join(' + ') || 'ödeme alınmadı';

  function card(a) {
    const pno = {}; a.payments.forEach((p, k) => { pno[p.id] = k + 1; });
    const multi = a.payments.length > 1;
    const methods = [...new Set(a.payments.map(p => METHOD[p.method] || 'ödemesiz'))].join(' + ');
    const nItems = a.items.filter(i => i.kind !== 'not').length;
    const items = a.items.map(i => `<tr><td style="width:120px;color:var(--muted)">${dmy(i.day).slice(0, 5)} ${hm(i.created_at)}</td><td>${esc(i.description)}${multi && pno[i.paid_tx_id] ? ` <span class="ptag">${pno[i.paid_tx_id]}. tahsilat</span>` : ''}</td><td class="n">${i.kind === 'not' ? '' : fmt(i.amount) + ' ' + SYM[i.currency]}</td></tr>`).join('');
    const pays = a.payments.map((p, k) => `<tr><td style="width:120px;color:var(--muted)">${dmy(p.day).slice(0, 5)} ${hm(p.created_at)}</td><td>${multi ? `<b>${k + 1}.</b> ` : ''}${METHOD[p.method] || 'Ödemesiz'} — ${paidParts(p)}</td><td class="n"><b>${fmt(p.eurEq)} €</b> <small style="color:var(--muted)">= ${fmt(p.tlEq)} TL</small></td></tr>`).join('');
    return `<details class="acc cacc"><summary class="ah"><span class="room">${esc(a.room)}</span>
      <span class="since">${dmy(a.opened_day)} → ${dmy(a.closed_day || a.closed_at)} · ${nItems} kalem · ${esc(methods)}</span>${a.left_unpaid ? '<span class="badge-left">Çıkıştan sonra ödendi</span>' : ''}
      <span class="tot">${fmt(a.paidEur)} €<small>${money(a.totals)}</small></span></summary>
      <table><tbody>${items}</tbody></table>
      <h4 class="ch">Tahsilat${multi ? 'lar' : ''}</h4>
      <table><tbody>${pays || '<tr><td class="dim">Tahsilat kaydı yok</td></tr>'}</tbody></table></details>`;
  }
  window.closedAccHTML = list => list.length ? list.map(card).join('') : '<p style="color:var(--muted)">Kapanan hesap bulunamadı.</p>';

  // Gün gün gezinme (◀ gün ▶). Oda seçilirse o odanın bütün günlerdeki kapanan hesapları listelenir.
  const longDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
  window.mountClosedAcc = ({ call, toast }) => {
    const $ = id => document.getElementById(id);
    let days = [], cur = null;
    const sum = list => `${list.length} hesap · tahsil edilen ${fmt(list.reduce((s, a) => s + a.paidEur, 0))} €`;
    async function refresh() {
      try {
        const room = $('caRoom').value;
        $('caNav').classList.toggle('hidden', !!room);
        if (room) {
          const list = await call('closedAccounts', { room, limit: 500 });
          $('caSum').textContent = `${room} numaralı oda, bütün günler — ${sum(list)}`;
          $('caList').innerHTML = closedAccHTML(list); return;
        }
        days = await call('closedAccountDays');
        if (!days.length) { $('caNav').classList.add('hidden'); $('caSum').textContent = ''; $('caList').innerHTML = '<p style="color:var(--muted)">Henüz kapanan hesap yok.</p>'; return; }
        if (!cur || !days.some(d => d.day === cur)) cur = days[0].day;
        const i = days.findIndex(d => d.day === cur);
        $('caDay').innerHTML = days.map(d => `<option value="${d.day}"${d.day === cur ? ' selected' : ''}>${longDate(d.day)} — ${d.n} hesap</option>`).join('');
        $('caOlder').disabled = i >= days.length - 1; $('caNewer').disabled = i <= 0;
        const list = await call('closedAccounts', { day: cur, limit: 500 });
        $('caSum').textContent = `Bu gün kapanan: ${sum(list)}`;
        $('caList').innerHTML = closedAccHTML(list);
      } catch (e) { toast(e.message, true); }
    }
    const step = d => { const i = days.findIndex(x => x.day === cur) + d; if (days[i]) { cur = days[i].day; refresh(); } };
    $('caDay').onchange = () => { cur = $('caDay').value; refresh(); };
    $('caOlder').onclick = () => step(1);
    $('caNewer').onclick = () => step(-1);
    $('caRoom').onchange = refresh;
    return { refresh, latest: () => { cur = null; return refresh(); } };
  };
})();
