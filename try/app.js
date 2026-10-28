(function () {
  'use strict';
  const S = globalThis.ShunDa;
  const STORE_KEY = 'shunda.v1';
  const $ = (id) => document.getElementById(id);

  const ta = $('ta'), comp = $('comp'), candBox = $('cand');

  // ── 儲存 ──
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          user: user.toJSON(), stats: composer.stats, customTests, mode: composer.mode, strict: composer.opts.strict,
        }));
      } catch (e) { /* 私密視窗等情況存不了，不影響使用 */ }
    }, 300);
  }

  const stored = loadStore();
  const dict = new S.Dictionary(globalThis.ZHUYIN_DICT);
  const SEED = globalThis.ZHUYIN_SEED || { learning: {}, tests: [] };
  const user = new S.UserModel(stored.user, SEED.learning);
  const lm = globalThis.ZHUYIN_LM ? new S.LanguageModel(globalThis.ZHUYIN_LM) : null;
  const engine = new S.Engine(dict, user, lm);
  const composer = new S.Composer(engine, { strict: stored.strict !== false });
  if (stored.stats) Object.assign(composer.stats, stored.stats);
  if (stored.mode === 'en') composer.mode = 'en';
  let customTests = Array.isArray(stored.customTests) ? stored.customTests : [];
  $('loading').hidden = true;

  // ── 打字 ──
  let shiftTap = null;

  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.key === 'Process') { $('imeWarn').hidden = false; return; }
    if (e.key === 'Shift') {
      if (!e.repeat) shiftTap = { t: Date.now(), clean: true };
      return;
    }
    if (shiftTap) shiftTap.clean = false;
    if (['Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;

    const key = { code: e.code || codeFromKey(e.key), shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
    // 要送出（Enter、標點）但還沒複審過：先複審，等結果出來再送出
    if (willCommit(key) && nnNeedsRerank()) {
      e.preventDefault();
      composer.flushPending();
      rerankNow(() => doKey(key));
      return;
    }
    if (doKey(key)) e.preventDefault();
  });

  // 注音組合錯誤的提示音：很短、很小聲的「嗒」
  let audio = null;
  function beep(retry) {
    try {
      audio = audio || new AudioContext();
      // 瀏覽器可能先把聲音暫停（嵌在別的網頁裡、還沒互動過），要先叫醒再播
      if (audio.state !== 'running') { if (!retry) audio.resume().then(() => beep(true), () => {}); return; }
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + 0.07);
    } catch (e) { /* 不能發聲就算了 */ }
  }

  function doKey(key) {
    const res = composer.handleKey(key);
    if (res.beep) beep();
    if (res.commit) afterCommit(res.commit);
    render();
    scheduleRerank();
    return res.handled;
  }

  // ── 神經網路複審（在背景執行緒跑，nn-worker.js） ──
  const NN = { worker: null, ready: false, seq: 0, timer: 0, job: null, doneSig: '', fixes: 0, ms: 0 };
  const NN_DELAY = 150; // 名單長度、權重等規則在 nn.js（NeuralLM.TOP／WEIGHT）

  function setNNStatus(text, on) {
    $('nnStatus').textContent = text;
    $('nnStatus').classList.toggle('on', !!on);
  }

  try {
    NN.worker = new Worker('nn-worker.js');
    NN.worker.onmessage = (e) => {
      const m = e.data;
      if (m.ready) { NN.ready = true; setNNStatus(m.both ? 'AI 複審：已啟用（正反兩向）' : 'AI 複審：已啟用', true); scheduleRerank(); return; }
      if (m.error) { setNNStatus('AI 複審：載入失敗'); return; }
      finishRerank(m);
    };
    NN.worker.onerror = () => { NN.worker = null; setNNStatus('AI 複審：未啟用（請用網頁版開啟）'); };
  } catch (err) {
    setNNStatus('AI 複審：未啟用（請用網頁版開啟）');
  }

  function signature() {
    return composer.syls.map((s) => s.body + (s.tone === null ? '*' : s.tone)).join(' ') + '|' + JSON.stringify(composer.locks) + '|' + composer.lastCommittedWord;
  }

  function willCommit(k) {
    if (!composer.composing || composer.cand || composer.symbol || composer.mode !== 'zh' || k.alt || k.meta) return false;
    if (k.ctrl) return !!S.punctOf(k) && !composer.composing;
    return k.code === 'Enter' || k.code === 'NumpadEnter' || (k.code === 'Space' && !composer.pending) || (!!S.punctOf(k) && !composer.composing);
  }

  function nnNeedsRerank() {
    return NN.ready && composer.syls.length > 0 && NN.doneSig !== signature();
  }

  function scheduleRerank() {
    clearTimeout(NN.timer);
    if (!NN.ready || !composer.syls.length || composer.pending || composer.cand || composer.symbol) return;
    if (NN.doneSig === signature()) return;
    NN.timer = setTimeout(() => rerankNow(), NN_DELAY);
  }

  // done：複審完（或不需要複審、逾時）之後要做的事
  function rerankNow(done) {
    clearTimeout(NN.timer);
    const sig = signature();
    const r = engine.convert(composer.syls, { locks: composer.locks, leftWord: composer.lastCommittedWord, nbest: NeuralLM.TOP, beam: NeuralLM.BEAM, perState: NeuralLM.PER_STATE });
    if (!NeuralLM.shouldRerank(r.nbest)) {
      NN.doneSig = sig;
      if (done) done();
      return;
    }
    const id = ++NN.seq;
    const list = r.nbest;
    // 只打聲母時，另外讓 AI 一個字一個字自己寫句子（詞庫拼不出口語句時靠這個，例如 ㄨㄒㄗㄧㄕㄐ → 我現在要睡覺）
    const gen = S.hasAbbr(composer.syls);
    const syls = composer.syls.slice(), opts = { locks: composer.locks.slice(), leftWord: composer.lastCommittedWord };
    NN.job = { id, sig, nbest: list, syls, opts, done, timeout: done ? setTimeout(() => finishRerank({ id, timeout: true }), gen ? 1500 : 800) : 0 };
    NN.worker.postMessage({ id, texts: list.map((c) => c.text), choices: gen ? engine.charChoices(syls, opts.locks) : null });
  }

  function finishRerank(m) {
    const job = NN.job;
    if (!job || job.id !== m.id) return;
    NN.job = null;
    clearTimeout(job.timeout);
    if (!m.timeout && job.sig === signature()) {
      NN.ms = m.ms;
      const merged = m.gen && m.gen.length ? NeuralLM.merge(engine, job.syls, job.opts, job.nbest, m.scores, m.gen) : { list: job.nbest, scores: m.scores };
      const pick = NeuralLM.pick(merged.list, merged.scores);
      if (pick.text !== composer.result.text) {
        composer.result = { nodes: pick.nodes, text: pick.text, score: pick.score };
        NN.fixes++;
        comp.classList.remove('nnfix');
        void comp.offsetWidth; // 重新觸發提示動畫
        comp.classList.add('nnfix');
      }
      NN.doneSig = job.sig;
      setNNStatus(`AI 複審：已啟用（${Math.round(NN.ms)} ms）`, true);
      render();
      renderStats();
    }
    if (job.done) job.done();
  }

  // 少數環境（遠端桌面、自動化工具）不給實體按鍵代碼，改用按鍵字元推回來
  const KEY_CODES = {
    ';': 'Semicolon', ':': 'Semicolon', ',': 'Comma', '<': 'Comma', '.': 'Period', '>': 'Period',
    '/': 'Slash', '?': 'Slash', '-': 'Minus', '_': 'Minus', '=': 'Equal', '+': 'Equal',
    "'": 'Quote', '"': 'Quote', '[': 'BracketLeft', '{': 'BracketLeft', ']': 'BracketRight', '}': 'BracketRight',
    '\\': 'Backslash', '|': 'Backslash', '`': 'Backquote', '~': 'Backquote', ' ': 'Space',
    '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
  };
  function codeFromKey(key) {
    if (!key) return '';
    if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
    if (/^\d$/.test(key)) return 'Digit' + key;
    return KEY_CODES[key] || key;
  }

  ta.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && shiftTap && shiftTap.clean && Date.now() - shiftTap.t < 500) toggleMode();
    if (e.key === 'Shift') shiftTap = null;
  });

  ta.addEventListener('mousedown', () => {
    // 點到別的位置之前，先把組字區送出到原本的位置
    if (composer.composing) { const out = { commit: '' }; composer.commitAll(out); afterCommit(out.commit); render(); }
  });
  ta.addEventListener('scroll', render);
  window.addEventListener('resize', render);

  function toggleMode() {
    const out = { commit: '' };
    composer.toggleMode(out);
    if (out.commit) afterCommit(out.commit);
    render();
    save();
  }
  $('strictChk').checked = composer.opts.strict;
  $('strictChk').addEventListener('change', (e) => { composer.flushPending(); composer.opts.strict = e.target.checked; save(); render(); ta.focus(); });
  $('modeBtn').addEventListener('mousedown', (e) => { e.preventDefault(); toggleMode(); ta.focus(); });

  function insert(text) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(text, s, e, 'end');
    ta.dispatchEvent(new Event('input'));
  }

  function afterCommit(text) {
    insert(text);
    if (composer.lastSubmission) {
      lastSubmission = composer.lastSubmission;
      composer.lastSubmission = null;
      renderAddLast();
    }
    renderStats();
    if (activeTab === 'learn') renderLearn();
    if (activeTab === 'tests' && $('useUser').checked) renderTests();
    save();
  }

  // ── 游標位置（用隱藏的鏡像元素量出 textarea 裡的游標座標） ──
  const MIRROR_PROPS = ['boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch',
    'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize'];
  function caretPos() {
    const cs = getComputedStyle(ta);
    const m = document.createElement('div');
    for (const p of MIRROR_PROPS) m.style[p] = cs[p];
    Object.assign(m.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
    m.textContent = ta.value.slice(0, ta.selectionStart);
    const mark = document.createElement('span');
    mark.textContent = '​';
    m.appendChild(mark);
    document.body.appendChild(m);
    const pos = { x: mark.offsetLeft - ta.scrollLeft, y: mark.offsetTop - ta.scrollTop, lh: parseFloat(cs.lineHeight) || 36 };
    m.remove();
    return pos;
  }

  // ── 畫面 ──
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    const zh = composer.mode === 'zh';
    $('modeLabel').textContent = zh ? '中' : '英';
    $('modeBtn').classList.toggle('en', !zh);

    const showComp = composer.composing;
    comp.hidden = !showComp;
    ta.classList.toggle('composing', showComp);
    if (showComp) renderComposition();

    const pos = caretPos();
    const padW = $('pad').clientWidth;
    if (showComp) {
      const left = Math.max(0, Math.min(pos.x, padW - comp.offsetWidth - 4));
      comp.style.left = left + 'px';
      comp.style.top = pos.y + 'px';
    }

    if (composer.cand) renderCandidates();
    else if (composer.symbol) renderSymbols();
    candBox.hidden = !composer.cand && !composer.symbol;
    if (!candBox.hidden) {
      const anchorX = showComp ? parseFloat(comp.style.left) : pos.x;
      candBox.style.left = Math.max(0, Math.min(anchorX, padW - candBox.offsetWidth - 4)) + 'px';
      candBox.style.top = (pos.y + pos.lh + 4) + 'px';
    }
  }

  function renderComposition() {
    comp.textContent = '';
    const { nodes, cursor, pendingIndex } = composer.view();
    const total = nodes.length ? nodes[nodes.length - 1].e : 0;
    const hl = composer.cand ? composer.cand.list[composer.cand.hi] : null;
    const putCaret = () => comp.appendChild(el('span', 'caret'));
    for (const n of nodes) {
      const cls = 'seg' + (n.picked ? ' picked' : '') + (n.fallback ? ' fallback' : '');
      // 一個字對一個音節；詞庫沒有的音節整段顯示注音
      const units = [...n.w].length === n.e - n.s ? [...n.w].map((ch, k) => [ch, n.s + k]) : [[n.w, n.s]];
      let seg = null;
      for (const [ch, i] of units) {
        if (i === cursor) { seg = null; putCaret(); }
        if (!seg) { seg = el('span', cls); comp.appendChild(seg); }
        const span = el('span', 'ch', ch);
        if (hl && i >= hl.s && i < hl.e) span.classList.add('hl');
        if (i === pendingIndex) {
          // 還在打的音：顯示猜到的字，上方小字標出目前打的注音
          span.classList.add('typing');
          span.dataset.bpmf = composer.orderedPending();
        }
        seg.appendChild(span);
      }
    }
    if (cursor >= total) putCaret();
  }

  function renderCandidates() {
    candBox.textContent = '';
    const c = composer.cand;
    const page = composer.candPage();
    page.forEach((item, k) => {
      const i = c.page * composer.opts.pageSize + k;
      const row = el('div', 'item' + (i === c.hi ? ' on' : ''));
      row.appendChild(el('span', 'n', String(k + 1)));
      row.appendChild(el('span', 'w', item.w));
      if (item.e - item.s > 1) row.appendChild(el('span', 'r', item.e - item.s + ' 字'));
      row.addEventListener('mousedown', (ev) => { ev.preventDefault(); composer.selectCandidate(item); render(); });
      candBox.appendChild(row);
    });
    const pages = Math.ceil(c.list.length / composer.opts.pageSize);
    const foot = el('div', 'foot');
    foot.appendChild(el('span', null, `${c.page + 1} / ${pages} 頁`));
    foot.appendChild(el('span', null, '數字選 · 空白翻頁 · Esc 關閉'));
    candBox.appendChild(foot);
  }

  function renderSymbols() {
    candBox.textContent = '';
    const s = composer.symbol;
    const cats = el('div', 'cats');
    S.SYMBOLS.forEach((cat, i) => {
      const t = el('span', i === s.cat ? 'on' : '', cat.name);
      t.addEventListener('mousedown', (ev) => { ev.preventDefault(); s.cat = i; s.page = 0; render(); });
      cats.appendChild(t);
    });
    candBox.appendChild(cats);
    const grid = el('div', 'grid');
    composer.symbolPage().forEach((ch, k) => {
      const row = el('div', 'item');
      row.appendChild(el('span', 'n', String(k + 1)));
      row.appendChild(el('span', 'w', ch));
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const out = { commit: '' };
        composer.pickSymbol(ch, out);
        afterCommit(out.commit);
        render();
      });
      grid.appendChild(row);
    });
    candBox.appendChild(grid);
    const pages = Math.ceil(S.SYMBOLS[s.cat].items.length / composer.opts.pageSize);
    const foot = el('div', 'foot');
    foot.appendChild(el('span', null, `${s.page + 1} / ${pages} 頁`));
    foot.appendChild(el('span', null, 'Tab 換類別 · 空白翻頁'));
    candBox.appendChild(foot);
  }

  function renderStats() {
    const st = composer.stats;
    const box = $('stats');
    box.textContent = '';
    const add = (val, label) => {
      const d = el('div', 'stat');
      d.appendChild(el('b', null, val));
      d.appendChild(el('span', null, label));
      box.appendChild(d);
    };
    add(String(st.chars), '打了幾個字');
    add(String(st.picks), '手動選字次數');
    add(st.chars ? (st.picks / st.chars * 100).toFixed(1) + '%' : '—', '每百字要選幾次');
    add(st.commits ? Math.round(st.cleanCommits / st.commits * 100) + '%' : '—', '整句一次就對');
    add(String(NN.fixes), 'AI 複審幫你改字');
    const r = el('button', 'stat reset', '歸零');
    r.addEventListener('click', () => { Object.assign(composer.stats, { chars: 0, picks: 0, commits: 0, cleanCommits: 0 }); renderStats(); save(); ta.focus(); });
    box.appendChild(r);
  }

  // ── 分頁 ──
  let activeTab = 'article';
  (function renderArticle() {
    const a = globalThis.ZHUYIN_ARTICLE;
    const box = $('articleBox');
    if (!a) return;
    box.appendChild(el('h3', null, a.title));
    for (const line of a.lines) box.appendChild(el('p', 'line', line));
  })();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== activeTab; });
    if (activeTab === 'tests') renderTests();
    if (activeTab === 'learn') renderLearn();
  }));

  // ── 測試題 ──
  let lastSubmission = null;
  $('useUser').addEventListener('change', renderTests);

  function diffMark(expect, got) {
    const f = document.createDocumentFragment();
    [...got].forEach((ch, i) => {
      if (ch === [...expect][i]) f.appendChild(document.createTextNode(ch));
      else f.appendChild(el('em', null, ch));
    });
    return f;
  }

  function renderTests() {
    const list = $('testList');
    list.textContent = '';
    const plain = new S.Engine(dict, new S.UserModel(), lm);
    const eng = $('useUser').checked ? engine : plain;
    const seedTests = (SEED.tests || []).map((t) => ({ group: '預設題目', builtin: true, expect: t.expect, reading: t.reading }));
    const seedKeys = new Set(seedTests.map((t) => t.reading + '|' + t.expect));
    const all = [
      ...globalThis.ZHUYIN_TESTS.map((t) => Object.assign({ builtin: true }, t)),
      ...seedTests,
      ...customTests.map((t, i) => Object.assign({ group: '我的題目', idx: i }, t)).filter((t) => !seedKeys.has(t.reading + '|' + t.expect)),
    ];
    let pass = 0, group = null;
    for (const t of all) {
      if (t.group !== group) { group = t.group; list.appendChild(el('h4', null, group)); }
      const got = eng.convert(S.parseReading(t.reading)).text;
      const ok = got === t.expect;
      if (ok) pass++;
      const li = el('li');
      li.appendChild(el('span', 'mark ' + (ok ? 'ok' : 'bad'), ok ? '✔' : '✘'));
      li.appendChild(el('span', 'exp', t.expect));
      if (t.builtin) li.appendChild(el('span'));
      else {
        const del = el('button', 'del', '刪除');
        del.addEventListener('click', () => { customTests.splice(t.idx, 1); save(); renderTests(); });
        li.appendChild(del);
      }
      if (!ok) { const g = el('span', 'got', '得到：'); g.appendChild(diffMark(t.expect, got)); li.appendChild(g); }
      li.appendChild(el('span', 'rd', t.reading));
      list.appendChild(li);
    }
    const sc = $('testScore');
    sc.textContent = `${pass} / ${all.length} 題正確 `;
    sc.appendChild(el('small', null, `(${Math.round(pass / all.length * 100)}%)`));
  }

  function renderAddLast() {
    const box = $('addLast');
    box.textContent = '';
    if (!lastSubmission) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('div', null, '把剛剛那句加入測試題？如果選字有錯，先把正確答案改好：'));
    const input = el('input');
    input.value = lastSubmission.text;
    box.appendChild(input);
    box.appendChild(el('div', 'rd', '注音：' + lastSubmission.reading));
    const acts = el('div', 'acts');
    const ok = el('button', 'primary', '加入');
    ok.addEventListener('click', () => {
      const expect = input.value.trim();
      if (!expect) return;
      customTests.push({ expect, reading: lastSubmission.reading });
      lastSubmission = null;
      save(); renderAddLast(); renderTests(); ta.focus();
    });
    const no = el('button', null, '不用');
    no.addEventListener('click', () => { lastSubmission = null; renderAddLast(); ta.focus(); });
    acts.append(ok, no);
    box.appendChild(acts);
  }

  // ── 學習紀錄 ──
  function renderLearn() {
    const box = $('learnList');
    box.textContent = '';
    const groups = [
      { kind: 'phrases', title: '自己造的詞', fmt: (k) => { const [r, w] = k.split('|'); return [w, r]; } },
      { kind: 'picks', title: '選過的字詞', fmt: (k) => { const [r, w] = k.split('|'); return [w, r]; } },
      { kind: 'left', title: '前面接什麼時選這個', fmt: (k) => { const [p, r, w] = k.split('|'); return [p + ' ＋ ' + w, r]; } },
      { kind: 'right', title: '後面接什麼時選這個', fmt: (k) => { const [r, w, n] = k.split('|'); return [w + ' ＋ ' + n, r]; } },
      { kind: 'usage', title: '常用詞', fmt: (k) => [k, ''] },
    ];
    let any = false;
    for (const g of groups) {
      const items = Object.entries(user[g.kind]).sort((a, b) => b[1] - a[1]).slice(0, 80);
      if (!items.length) continue;
      any = true;
      const sec = el('div', 'lgroup');
      sec.appendChild(el('h4', null, `${g.title}（${Object.keys(user[g.kind]).length}）`));
      for (const [k, n] of items) {
        const [label, rd] = g.fmt(k);
        const row = el('div', 'litem');
        row.appendChild(el('span', null, label));
        if (rd) row.appendChild(el('span', 'rd', rd));
        row.appendChild(el('span', 'cnt', '×' + n));
        const del = el('button', null, '✕');
        del.title = '忘掉這筆';
        del.addEventListener('click', () => { user.forget(g.kind, k); save(); renderLearn(); });
        row.appendChild(del);
        sec.appendChild(row);
      }
      box.appendChild(sec);
    }
    if (!any) box.appendChild(el('div', 'empty', '還沒有學習紀錄。打字時手動選過的字，會出現在這裡。'));
  }

  // 匯出：複製到剪貼簿（網頁版不一定能下載檔案），本機開啟時另外也存成檔案
  $('exportBtn').addEventListener('click', () => {
    const json = JSON.stringify({ user: user.toJSON(), customTests }, null, 1);
    const done = (msg) => { $('exportBtn').textContent = msg; setTimeout(() => { $('exportBtn').textContent = '匯出'; }, 2000); };
    if (location.protocol === 'file:') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = 'shunda-學習紀錄.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return done('已存檔');
    }
    try {
      navigator.clipboard.writeText(json).then(() => done('已複製'), () => done('複製失敗'));
    } catch (e) { done('複製失敗'); }
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      user.load(data.user);
      if (Array.isArray(data.customTests)) customTests = data.customTests;
      save(); renderLearn(); renderTests();
    } catch (err) { $('importBtn').textContent = '檔案格式不對'; setTimeout(() => { $('importBtn').textContent = '匯入'; }, 2500); }
    e.target.value = '';
  });
  // 按兩次才清除（網頁版不支援 confirm 對話框）
  let clearArmed = 0;
  $('clearBtn').addEventListener('click', () => {
    const btn = $('clearBtn');
    if (!clearArmed) {
      btn.textContent = '再按一次確定清除';
      clearArmed = setTimeout(() => { clearArmed = 0; btn.textContent = '清除我的紀錄'; }, 3000);
      return;
    }
    clearTimeout(clearArmed); clearArmed = 0;
    btn.textContent = '清除我的紀錄';
    user.clear(); save(); renderLearn(); renderTests();
  });

  // 手機、平板沒有實體鍵盤時無法測試，先講清楚
  if (window.matchMedia && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) {
    $('imeWarn').textContent = '這個測試台需要實體鍵盤（標準注音鍵盤排列），請用電腦開啟。';
    $('imeWarn').hidden = false;
  }

  // ── 預設學習 ──
  {
    const n = Object.values(SEED.learning || {}).reduce((s, v) => s + Object.keys(v || {}).length, 0);
    if (n) $('seedInfo').textContent = `另外已內建 ${n} 筆預設學習${SEED.updatedAt ? `（${new Date(SEED.updatedAt).toLocaleDateString('zh-TW')} 更新）` : ''}，清除只會清掉你自己的部分。`;
  }

  // 擁有者才看得到：把學習紀錄上傳成所有人的預設（網頁版資料庫，Claude 讀取後打包進下一版）
  (async () => {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    const who = await window.claude.use('user');
    if (!who || !(await who.isOwner())) return;
    const db = await window.claude.use('db');
    if (!db) return;
    $('ownerBox').hidden = false;
    const status = $('seedStatus');
    try {
      const snap = await db.doc('seed/learning').get();
      if (snap.exists && snap.data().updatedAt) status.textContent = '上次上傳：' + new Date(snap.data().updatedAt).toLocaleString('zh-TW');
    } catch (e) { /* 讀不到就不顯示 */ }
    $('seedBtn').addEventListener('click', async () => {
      const btn = $('seedBtn');
      btn.disabled = true;
      status.textContent = '上傳中…';
      const tests = (SEED.tests || []).concat(customTests.map((t) => ({ expect: t.expect, reading: t.reading })));
      const seen = new Set();
      const payload = {
        learning: user.merged(),
        tests: tests.filter((t) => { const k = t.reading + '|' + t.expect; if (seen.has(k)) return false; seen.add(k); return true; }),
      };
      try {
        await db.doc('seed/learning').set({ json: JSON.stringify(payload), updatedAt: Date.now() });
        status.textContent = '已上傳。跟 Claude 說「更新預設」就會內建到下一版。';
      } catch (e) {
        status.textContent = e && e.code === 'invalid_argument' ? '資料太大，上傳失敗（上限 256 KB），請告訴 Claude。' : '上傳失敗，請再試一次。';
      }
      btn.disabled = false;
    });
  })();

  renderStats();
  renderTests();
  render();
  ta.focus();
})();
