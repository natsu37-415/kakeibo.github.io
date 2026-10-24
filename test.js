'use strict';
const C = require('./core.js');
let n = 0, ng = 0;
const eq = (a, b, msg) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { ng++; console.log('NG', msg, '\n  期待', JSON.stringify(b), '\n  結果', JSON.stringify(a)); } };
const rec = (d, r) => { d.records.push({ id: C.uid(), store: '', cat: 'o0', ...r }); };
const card = (d, id) => d.wallets.find(w => w.id === id);

// 1. カードの締め・引き落とし（要件定義書の表）
const D0 = C.defaults();
[
  ['card_paypay', '2026-10-05', '2026-10-31', '2026-11-27'],
  ['card_paypay', '2026-10-31', '2026-10-31', '2026-11-27'],
  ['card_paypay', '2026-11-01', '2026-11-30', '2026-12-27'],
  ['card_paypay', '2026-02-10', '2026-02-28', '2026-03-27'],
  ['card_aeon', '2026-10-10', '2026-10-10', '2026-11-02'],
  ['card_aeon', '2026-10-11', '2026-11-10', '2026-12-02'],
  ['card_tokyu', '2026-10-15', '2026-10-15', '2026-11-10'],
  ['card_tokyu', '2026-10-16', '2026-11-15', '2026-12-10'],
  ['card_tokyu', '2026-12-20', '2027-01-15', '2027-02-10']
].forEach(([id, use, close, due]) => {
  const b = C.billFor(card(D0, id), use);
  eq([b.closeDate, b.dueDate], [close, due], id + ' ' + use);
});

// 2. サイクル（給料日25日）
eq(C.cycleOf('2026-10-24', 25), '2026-09', '24日は前のサイクル');
eq(C.cycleOf('2026-10-25', 25), '2026-10', '25日から新サイクル');
eq(C.cycleOf('2026-01-05', 25), '2025-12', '年またぎ');
eq(C.cycleRange('2026-10', 25), { start: '2026-10-25', end: '2026-11-24' }, '範囲');
eq(C.cycleRange('2026-12', 25), { start: '2026-12-25', end: '2027-01-24' }, '年またぎ範囲');
eq(C.cycleRange('2026-10', 1), { start: '2026-10-01', end: '2026-10-31' }, '給料日1日');

// 3. 残高・振替・カード（未払い→精算）
const D = C.defaults();
rec(D, { date: '2026-10-25', kind: 'in', amount: 300000, wallet: 'acc1', cat: 'i0' });
eq(C.overview(D), { total: 300000, unpaid: 0, reserved: 0, real: 300000 }, '給料');
rec(D, { date: '2026-10-26', kind: 'xfer', amount: 5000, from: 'acc1', to: 'paypay' });
eq(C.overview(D).total, 300000, '振替は全財産が変わらない');
eq(C.balances(D).paypay, 5000, 'チャージ');
rec(D, { date: '2026-10-27', kind: 'out', amount: 1000, wallet: 'cash' });
eq(C.overview(D).total, 299000, '現金払い');
rec(D, { date: '2026-10-05', kind: 'out', amount: 10000, wallet: 'card_paypay' });
eq(C.overview(D), { total: 299000, unpaid: 10000, reserved: 0, real: 289000 }, 'カード払い：未払い+、現残高そのまま');
rec(D, { id: 's1', date: '2026-11-27', kind: 'settle', amount: 10000, wallet: 'acc1', card: 'card_paypay', billMonth: '2026-11' });
eq(C.overview(D), { total: 289000, unpaid: 0, reserved: 0, real: 289000 }, '精算：実残高は変わらない');
eq(C.bills(D).map(b => [b.billMonth, b.calc, b.settled, b.diff]), [['2026-11', 10000, true, 0]], '請求の状態');

// 4. 実額が計算額とズレたとき
const E = C.defaults();
rec(E, { date: '2026-10-25', kind: 'in', amount: 100000, wallet: 'acc1', cat: 'i0' });
rec(E, { date: '2026-10-10', kind: 'out', amount: 10000, wallet: 'card_aeon' });
rec(E, { date: '2026-10-11', kind: 'out', amount: 2000, wallet: 'card_aeon' });
eq(C.bills(E).map(b => [b.billMonth, b.calc]), [['2026-11', 10000], ['2026-12', 2000]], 'AEONは別の請求月');
rec(E, { date: '2026-11-02', kind: 'settle', amount: 10500, wallet: 'acc1', card: 'card_aeon', billMonth: '2026-11' });
eq(C.bills(E)[0].diff, 500, '差額');
eq(C.overview(E), { total: 89500, unpaid: 2000, reserved: 0, real: 87500 }, '差額は実残高に反映');

// 5. 固定費の取り置き（要件定義書の例：給料30万、家賃8万、電気1万）
const F = C.defaults();
F.settings.reserveEnabled = true;
F.fixed = [{ id: 'rent', name: '家賃', amount: 80000, cat: 'o3', wallet: 'acc1', day: 27 }, { id: 'elec', name: '電気', amount: 10000, cat: 'o4', wallet: 'acc1', day: 10 }];
rec(F, { date: '2026-10-25', kind: 'in', amount: 300000, wallet: 'acc1', cat: 'i0' });
const made = C.ensureReserves(F, '2026-10-25');
eq(made.length, 2, '取り置きを自動作成');
F.reserves.push(...made);
eq(C.ensureReserves(F, '2026-11-03').length, 0, '同じサイクルでは作り直さない');
eq(C.overview(F), { total: 300000, unpaid: 0, reserved: 90000, real: 210000 }, '給料日：取り置き');
rec(F, { date: '2026-10-27', kind: 'out', amount: 80000, wallet: 'acc1', fixedId: 'rent', cat: 'o3' });
eq(C.overview(F), { total: 220000, unpaid: 0, reserved: 10000, real: 210000 }, '家賃：実残高は変わらない');
rec(F, { date: '2026-11-10', kind: 'out', amount: 8500, wallet: 'acc1', fixedId: 'elec', cat: 'o4' });
eq(C.overview(F), { total: 211500, unpaid: 0, reserved: 0, real: 211500 }, '電気：余剰+1,500');
eq(C.ensureReserves(F, '2026-11-25').length, 2, '次の給料日でまた作る');
// 固定費をカードで払う（電気 8,500 / 予算 10,000）
const G = C.defaults();
G.settings.reserveEnabled = true;
G.fixed = [{ id: 'elec', name: '電気', amount: 10000, cat: 'o4', wallet: 'card_paypay', day: 10 }];
rec(G, { date: '2026-10-25', kind: 'in', amount: 50000, wallet: 'acc1', cat: 'i0' });
G.reserves.push(...C.ensureReserves(G, '2026-10-25'));
rec(G, { date: '2026-11-10', kind: 'out', amount: 8500, wallet: 'card_paypay', fixedId: 'elec', cat: 'o4' });
eq(C.overview(G), { total: 50000, unpaid: 8500, reserved: 0, real: 41500 }, 'カードで固定費：取り置きが外れ、未払いに入る');

// 6. 集計
const S = C.defaults();
rec(S, { date: '2026-10-25', kind: 'in', amount: 300000, wallet: 'acc1', cat: 'i0' });
rec(S, { date: '2026-10-30', kind: 'out', amount: 3000, wallet: 'cash', cat: 'o0' });
rec(S, { date: '2026-11-24', kind: 'out', amount: 2000, wallet: 'card_aeon', cat: 'o0' });
rec(S, { date: '2026-11-25', kind: 'out', amount: 700, wallet: 'cash', cat: 'o0' });
rec(S, { date: '2026-10-26', kind: 'xfer', amount: 9999, from: 'acc1', to: 'cash' });
rec(S, { date: '2026-12-02', kind: 'settle', amount: 2000, wallet: 'acc1', card: 'card_aeon', billMonth: '2026-12' });
const s = C.summary(S, '2026-10');
eq([s.in, s.out, s.byCat.out.o0], [300000, 5000, 5000], '集計：カードは使った日。振替・精算は入らない');
eq(C.summary(S, '2026-11').out, 700, '次のサイクル');

console.log(ng ? ng + '件失敗 / ' + n + '件' : 'すべて成功 (' + n + '件)');
process.exit(ng ? 1 : 0);
