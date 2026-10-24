'use strict';
/* 計算ロジック。画面にもDBにも依存しない（nodeでテストできる）。
   data = { wallets, categories, records, fixed, reserves, settings } */
const Core = (() => {
  const pad = n => String(n).padStart(2, '0');
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const lastDay = (y, m) => new Date(y, m, 0).getDate(); // m は 1〜12
  const ymd = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
  const splitYm = ym => ym.split('-').map(Number);
  const addMonths = (ym, n) => { const [y, m] = splitYm(ym), t = y * 12 + (m - 1) + n; return Math.floor(t / 12) + '-' + pad(t % 12 + 1); };
  const todayStr = () => { const d = new Date(); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); };

  /* ---------- カード：この利用日は、いつ・どの引き落としに入るか ---------- */
  function billFor(card, dateStr) {
    const { y, m, d } = parse(dateStr);
    const c = card.closing === 'eom' ? lastDay(y, m) : card.closing;
    const closeYm = d <= c ? y + '-' + pad(m) : addMonths(y + '-' + pad(m), 1); // 締め日当日は含む
    const [cy, cm] = splitYm(closeYm);
    const closeDay = card.closing === 'eom' ? lastDay(cy, cm) : card.closing;
    const dueYm = addMonths(closeYm, card.dueMonths);
    const [dy, dm] = splitYm(dueYm);
    return { closeDate: ymd(cy, cm, closeDay), dueDate: ymd(dy, dm, Math.min(card.dueDay, lastDay(dy, dm))), billMonth: dueYm };
  }

  /* ---------- 給料日区切りのサイクル（キーは開始月 'YYYY-MM'） ---------- */
  function cycleOf(dateStr, payday) {
    const { y, m, d } = parse(dateStr), ym = y + '-' + pad(m);
    return d >= payday ? ym : addMonths(ym, -1);
  }
  function cycleRange(cycle, payday) {
    const [y, m] = splitYm(cycle), [ey, em] = splitYm(addMonths(cycle, 1));
    return { start: ymd(y, m, payday), end: payday === 1 ? ymd(y, m, lastDay(y, m)) : ymd(ey, em, payday - 1) };
  }

  /* ---------- 残高（口座・現金・プリペイド。カードは財布に入れない） ---------- */
  function balances(d) {
    const b = {};
    d.wallets.forEach(w => { if (w.type !== 'card') b[w.id] = w.opening || 0; });
    const add = (id, n) => { if (id in b) b[id] += n; };
    d.records.forEach(r => {
      if (r.kind === 'out') add(r.wallet, -r.amount);        // カード払いは b に無いので無視される
      else if (r.kind === 'in') add(r.wallet, r.amount);
      else if (r.kind === 'xfer') { add(r.from, -r.amount); add(r.to, r.amount); }
      else if (r.kind === 'settle') add(r.wallet, -r.amount); // wallet = 引き落とし口座
    });
    return b;
  }

  /* ---------- カードの請求（引き落とし月ごと） ---------- */
  function bills(d) {
    const cards = {}, map = {};
    d.wallets.filter(w => w.type === 'card').forEach(w => { cards[w.id] = w; });
    d.records.forEach(r => {
      if (r.kind === 'out' && cards[r.wallet]) {
        const bf = billFor(cards[r.wallet], r.date), k = r.wallet + '|' + bf.billMonth;
        if (!map[k]) map[k] = { card: r.wallet, billMonth: bf.billMonth, closeDate: bf.closeDate, dueDate: bf.dueDate, calc: 0, settled: false };
        map[k].calc += r.amount;
      }
    });
    d.records.forEach(r => {
      if (r.kind !== 'settle') return;
      const k = r.card + '|' + r.billMonth;
      if (!map[k]) map[k] = { card: r.card, billMonth: r.billMonth, closeDate: null, dueDate: r.date, calc: 0 };
      Object.assign(map[k], { settled: true, actual: r.amount, settleDate: r.date, settleId: r.id });
    });
    return Object.values(map).map(b => ({ ...b, diff: b.settled ? b.actual - b.calc : null }))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.card.localeCompare(b.card));
  }
  // 精算済みの請求は未払い0として扱う（精算後に同じ月分を追加入力しても未払いには戻さない）
  const unpaid = d => bills(d).filter(b => !b.settled).reduce((t, b) => t + b.calc, 0);

  /* ---------- 固定費の取り置き ---------- */
  // 同じ固定費は、古い取り置きから順に、固定費つきの支出1件ごとに外れる
  function outstandingReserves(d) {
    const by = {}, res = [];
    d.reserves.forEach(r => { (by[r.fixedId] = by[r.fixedId] || []).push(r); });
    Object.keys(by).forEach(fid => {
      const left = by[fid].sort((a, b) => a.cycle.localeCompare(b.cycle));
      // 支払いは日付順に、「そのサイクルの開始日以降」の最も古い取り置きを1つ外す（早払いは外さない）
      d.records.filter(r => r.kind === 'out' && r.fixedId === fid).sort((a, b) => a.date.localeCompare(b.date)).forEach(r => {
        const i = left.findIndex(x => cycleRange(x.cycle, d.settings.payday).start <= r.date);
        if (i >= 0) left.splice(i, 1);
      });
      res.push(...left);
    });
    return res;
  }
  const reserved = d => outstandingReserves(d).reduce((t, r) => t + r.amount, 0);
  // アプリを開いたとき：今のサイクルの取り置きがなければ、作るべきものを返す（保存は呼ぶ側）
  function ensureReserves(d, today) {
    if (!d.settings.reserveEnabled) return [];
    const cycle = cycleOf(today, d.settings.payday);
    return d.fixed.filter(f => !f.hidden && (!f.startCycle || cycle >= f.startCycle) && !d.reserves.some(r => r.cycle === cycle && r.fixedId === f.id))
      .map(f => ({ id: uid(), cycle, fixedId: f.id, amount: f.amount }));
  }

  /* ---------- ホームに出す4つの数字 ---------- */
  function overview(d) {
    const total = Object.values(balances(d)).reduce((t, n) => t + n, 0), u = unpaid(d), r = reserved(d);
    return { total, unpaid: u, reserved: r, real: total - u - r };
  }

  /* ---------- サイクルごとの集計（振替・精算・取り置きは入れない） ---------- */
  function summary(d, cycle) {
    const s = { in: 0, out: 0, byCat: { out: {}, in: {} } };
    d.records.forEach(r => {
      if ((r.kind !== 'out' && r.kind !== 'in') || cycleOf(r.date, d.settings.payday) !== cycle) return;
      s[r.kind] += r.amount;
      s.byCat[r.kind][r.cat] = (s.byCat[r.kind][r.cat] || 0) + r.amount;
    });
    return s;
  }

  /* ---------- 初期データ（idは固定。後から追加する分はuid） ---------- */
  function defaults() {
    const w = (id, name, type, extra) => ({ id, name, type, opening: 0, hidden: false, ...extra });
    const card = (id, name, closing, dueDay) => w(id, name, 'card', { closing, dueMonths: 1, dueDay, payAccount: null });
    const c = (id, name, kind) => ({ id, name, kind, hidden: false });
    return {
      wallets: [
        w('acc1', '口座1', 'account'), w('acc2', '口座2', 'account'), w('acc3', '口座3', 'account'),
        w('cash', '現金', 'cash'), w('paypay', 'PayPay', 'prepaid'), w('pasmo', 'PASMO', 'prepaid'), w('kyash', 'KYASH', 'prepaid'),
        card('card_paypay', 'PayPayカード', 'eom', 27), card('card_aeon', 'AEONカード', 10, 2), card('card_tokyu', '東急カード', 15, 10)
      ],
      categories: [
        ...['食費', '日用品', '交通費', '住居', '光熱費', '通信費', '医療', '娯楽', '衣類', 'その他'].map((n, i) => c('o' + i, n, 'out')),
        ...['給料', 'その他'].map((n, i) => c('i' + i, n, 'in'))
      ],
      records: [], fixed: [], reserves: [],
      settings: { key: 'main', version: 1, payday: 25, lastBackup: null, created: todayStr(), setupDone: false, reserveEnabled: false }
    };
  }

  return { uid, todayStr, addMonths, billFor, cycleOf, cycleRange, balances, bills, unpaid, outstandingReserves, reserved, ensureReserves, overview, summary, defaults };
})();
if (typeof module !== 'undefined') module.exports = Core;
