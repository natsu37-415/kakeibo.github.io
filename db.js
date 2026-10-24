'use strict';
/* IndexedDB の薄いラッパー。core.js の後に読み込む。 */
const DB = (() => {
  const NAME = 'kakeibo', VER = 1;
  const STORES = ['wallets', 'categories', 'records', 'fixed', 'reserves'];
  let db = null;

  const open = () => db ? Promise.resolve(db) : new Promise((res, rej) => {
    const q = indexedDB.open(NAME, VER);
    q.onupgradeneeded = () => {
      const x = q.result;
      STORES.forEach(s => { const st = x.createObjectStore(s, { keyPath: 'id' }); if (s === 'records') st.createIndex('date', 'date'); });
      x.createObjectStore('settings', { keyPath: 'key' });
    };
    q.onsuccess = () => { db = q.result; res(db); };
    q.onerror = () => rej(q.error);
  });

  // fn(tx) が返したリクエストの結果を、トランザクション完了後に返す
  const run = (stores, mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(stores, mode); let req;
    t.oncomplete = () => res(req && req.result);
    t.onerror = t.onabort = () => rej(t.error);
    req = fn(t);
  }));

  const loadAll = () => run(STORES.concat('settings'), 'readonly', t => {
    const reqs = {};
    STORES.concat('settings').forEach(s => { reqs[s] = t.objectStore(s).getAll(); });
    return { get result() { const o = {}; STORES.forEach(s => { o[s] = reqs[s].result; }); o.settings = reqs.settings.result.find(x => x.key === 'main'); return o; } };
  });

  // 保存と削除を、まとめて1回のトランザクションで行う
  // puts = { records: [...], reserves: [...] }, dels = { records: [id, ...] }
  const commit = (puts, dels) => {
    const names = Object.keys(puts || {}).concat(Object.keys(dels || {}));
    if (!names.length) return Promise.resolve();
    return run([...new Set(names)], 'readwrite', t => {
      Object.entries(puts || {}).forEach(([s, list]) => list.forEach(o => t.objectStore(s).put(o)));
      Object.entries(dels || {}).forEach(([s, ids]) => ids.forEach(id => t.objectStore(s).delete(id)));
    });
  };
  const put = (store, obj) => commit({ [store]: [obj] });
  const remove = (store, id) => commit(null, { [store]: [id] });

  // 全部入れ替え（復元用）。途中で失敗したら、何も変わらない
  const replaceAll = data => run(STORES.concat('settings'), 'readwrite', t => {
    STORES.forEach(s => { const st = t.objectStore(s); st.clear(); (data[s] || []).forEach(o => st.put(o)); });
    const st = t.objectStore('settings'); st.clear(); st.put({ ...data.settings, key: 'main' });
  });

  // 初回起動：空なら初期データを入れて返す
  const init = async () => {
    try { navigator.storage && navigator.storage.persist && await navigator.storage.persist(); } catch (e) {}
    let data = await loadAll();
    if (!data.settings) { data = Core.defaults(); await replaceAll(data); }
    return data;
  };

  // バックアップ用
  const exportData = async () => JSON.stringify(await loadAll());
  const importData = async text => {
    const o = JSON.parse(text);
    if (!o || !o.settings || !Array.isArray(o.wallets) || !Array.isArray(o.records)) throw new Error('bad format');
    STORES.forEach(s => { if (!Array.isArray(o[s])) o[s] = []; });
    await replaceAll(o);
    return o;
  };

  return { init, loadAll, commit, put, remove, replaceAll, exportData, importData };
})();
