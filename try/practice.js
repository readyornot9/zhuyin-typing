// 打字練習：用電腦上安裝的輸入法（Windows 版懂你注音）照題目打，量速度和選字正確率
// 這一區的輸入框不經過網頁內建引擎；紀錄只存在這台電腦的瀏覽器
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const KEY = 'shunda-practice';
  const MAX_RESULTS = 3000;
  const SETS = globalThis.PRACTICE_SETS || { fresh: [], old: [] };

  // 比對時忽略空白和標點，只看字
  const norm = (s) => [...s.replace(/[\s，。！？、；：「」『』（）,.!?;:'"()…—~～-]/g, '')];

  let state = { set: 'fresh', custom: [], queue: [], pos: 0, results: [] };
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* 沒有紀錄就從頭開始 */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 存不了就只留在這次 */ } };

  const pool = () => (state.set === 'custom' ? state.custom : SETS[state.set] || []);
  function shuffle(n) {
    const a = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function ensureQueue() {
    const n = pool().length;
    if (state.queue.length !== n || state.pos >= n) { state.queue = shuffle(n); state.pos = 0; }
  }
  const target = (k = 0) => { ensureQueue(); const n = pool().length; return n ? pool()[state.queue[(state.pos + k) % n]] : ''; };

  // 逐字對齊（編輯距離），回傳錯字數和要標紅的位置
  function compare(expect, got) {
    const a = norm(expect), b = norm(got);
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const bad = new Set();
    for (let i = a.length, j = b.length; i > 0 || j > 0;) {
      if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { if (a[i - 1] !== b[j - 1]) bad.add(j - 1); i--; j--; }
      else if (j > 0 && d[i][j] === d[i][j - 1] + 1) { bad.add(j - 1); j--; }
      else i--;
    }
    return { errors: d[a.length][b.length], chars: a.length, got: b, bad };
  }

  function marked(r) {
    const c = compare(r.t, r.g);
    const f = document.createDocumentFragment();
    c.got.forEach((ch, i) => f.appendChild(c.bad.has(i) ? el('em', null, ch) : document.createTextNode(ch)));
    if (!c.got.length) f.appendChild(el('em', null, '（空白）'));
    return f;
  }

  // ── 輸入 ──
  const pin = $('pin');
  let start = null, backs = 0, composing = false;

  function show() {
    $('pTarget').textContent = target() || '題庫是空的';
    const nx = pool().length > 1 ? target(1) : '';
    $('pNext').textContent = nx ? '下一句：' + nx : '';
    pin.value = '';
    start = null; backs = 0;
  }

  function submit() {
    const t = target();
    if (!t || !pin.value.trim()) return;
    const ms = start == null ? 0 : Math.round(performance.now() - start);
    const r = { t, g: pin.value.trim(), ms, bs: backs, at: Date.now() };
    state.results.push(r);
    if (state.results.length > MAX_RESULTS) state.results.splice(0, state.results.length - MAX_RESULTS);
    state.pos++;
    save();
    renderLast(r);
    show();
    renderStats();
    renderWrong();
  }

  function skip() { state.pos++; save(); show(); pin.focus(); }

  pin.addEventListener('compositionstart', () => { composing = true; if (start == null) start = performance.now(); });
  pin.addEventListener('compositionend', () => { composing = false; setTimeout(autoSubmit, 0); });
  pin.addEventListener('keydown', (e) => {
    const inIme = e.isComposing || e.keyCode === 229;
    if (start == null && !['Shift', 'Control', 'Alt', 'Meta', 'Enter', 'Escape', 'Tab'].includes(e.key)) start = performance.now();
    if (inIme) return;
    if (e.key === 'Backspace' && pin.value) backs++;
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && !pin.value) { e.preventDefault(); skip(); }
  });
  pin.addEventListener('input', () => { if (!composing) autoSubmit(); });
  // 打到跟題目一樣長就自動送出，不用多按 Enter
  function autoSubmit() {
    if (composing) return;
    const t = target();
    if (t && norm(pin.value).length >= norm(t).length) submit();
  }

  // ── 結果 ──
  function renderLast(r) {
    const box = $('pLast');
    box.replaceChildren();
    const c = compare(r.t, r.g);
    const ok = c.errors === 0;
    box.className = 'plast ' + (ok ? 'ok' : 'bad');
    const head = el('div', 'phead');
    head.appendChild(el('b', null, ok ? '全對' : `錯 ${c.errors} 字`));
    if (r.ms) head.appendChild(el('span', null, `${(r.ms / 1000).toFixed(1)} 秒・每分鐘 ${Math.round(c.chars / r.ms * 60000)} 字`));
    if (r.bs) head.appendChild(el('span', null, `倒退 ${r.bs} 次`));
    box.appendChild(head);
    if (!ok) {
      box.appendChild(el('div', 'pexp', r.t));
      const g = el('div', 'pgot'); g.appendChild(marked(r)); box.appendChild(g);
    }
    if (/[a-z]{2}/i.test(r.g)) box.appendChild(el('div', 'pwarn', '看起來打出了英文字母：請先把 Windows 的輸入法切到懂你注音（Win＋空白鍵），並確認是「中」模式。'));
  }

  function renderStats() {
    const box = $('pStats');
    box.replaceChildren();
    const rs = state.results;
    let chars = 0, errors = 0, perfect = 0, ms = 0, timed = 0, backsAll = 0;
    for (const r of rs) {
      const c = compare(r.t, r.g);
      chars += c.chars; errors += Math.min(c.errors, c.chars); backsAll += r.bs;
      if (c.errors === 0) perfect++;
      if (r.ms > 0) { ms += r.ms; timed += c.chars; }
    }
    const pct = (x) => (rs.length ? (x * 100).toFixed(1) + '%' : '—');
    const stat = (v, label) => { const s = el('div', 'stat'); s.appendChild(el('b', null, v)); s.appendChild(el('span', null, label)); box.appendChild(s); };
    stat(String(rs.length), '已打句數');
    stat(ms ? String(Math.round(timed / ms * 60000)) : '—', '每分鐘字數');
    stat(pct(chars ? 1 - errors / chars : 0), '字正確率');
    stat(pct(rs.length ? perfect / rs.length : 0), '整句全對');
    stat(chars ? (backsAll / chars * 100).toFixed(1) : '—', '每百字倒退次數');
  }

  const wrongs = () => state.results.filter((r) => compare(r.t, r.g).errors > 0);
  function renderWrong() {
    const list = $('pWrong');
    list.replaceChildren();
    const ws = wrongs();
    $('pWrongCount').textContent = ws.length ? `打錯的句子（${ws.length}）` : '還沒有打錯的句子';
    $('pCopy').disabled = !ws.length;
    for (const r of ws.slice(-200).reverse()) {
      const li = el('li');
      li.appendChild(el('span', 'mark bad', '✗'));
      li.appendChild(el('span', 'exp', r.t));
      li.appendChild(el('span', 'grp', r.ms ? `${(r.ms / 1000).toFixed(1)}s` : ''));
      const g = el('span', 'got'); g.appendChild(marked(r)); li.appendChild(g);
      list.appendChild(li);
    }
  }

  $('pCopy').addEventListener('click', async () => {
    const text = wrongs().map((r) => `${r.t} → ${r.g}`).join('\n');
    try { await navigator.clipboard.writeText(text); $('pCopyStatus').textContent = '已複製到剪貼簿（剪貼簿原本的內容被蓋掉了），直接貼給 Claude'; }
    catch (e) { $('pCopyStatus').textContent = '複製失敗，請手動選取下面的清單'; }
  });
  $('pClear').addEventListener('click', () => {
    if (!state.results.length || !confirm('清除所有練習紀錄？')) return;
    state.results = []; save(); renderStats(); renderWrong(); $('pLast').replaceChildren(); $('pLast').className = 'plast';
  });
  $('pSkip').addEventListener('click', skip);

  // ── 題庫 ──
  const setSel = $('pSet');
  setSel.value = state.set;
  function applySet() {
    $('pCustom').hidden = state.set !== 'custom' || state.custom.length > 0;
    $('pEditCustom').hidden = state.set !== 'custom' || !state.custom.length;
    $('pCount').textContent = `${pool().length} 句`;
    show();
  }
  setSel.addEventListener('change', () => { state.set = setSel.value; state.queue = []; save(); applySet(); pin.focus(); });
  $('pUse').addEventListener('click', () => {
    state.custom = [...new Set($('pText').value.split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => norm(s).length >= 2))];
    state.queue = []; save(); applySet(); pin.focus();
  });
  $('pEditCustom').addEventListener('click', () => { $('pText').value = state.custom.join('\n'); $('pCustom').hidden = false; $('pEditCustom').hidden = true; });

  // ── 切換到練習分頁時，左邊換成練習區 ──
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    const on = b.dataset.tab === 'practice';
    document.querySelector('.writer').hidden = on;
    $('practice').hidden = !on;
    $('modeBtn').style.visibility = on ? 'hidden' : '';
    if (on) { show(); pin.focus(); }
  }));

  applySet();
  renderStats();
  renderWrong();
})();
