// 順打注音 — 選字引擎與組字狀態機
// 不依賴網頁，Node 也能直接載入測試；之後搬到 Windows 時這層邏輯可以照搬。
(function (root) {
  'use strict';

  const INITIALS = 'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ';
  const MEDIALS = 'ㄧㄨㄩ';
  const FINALS = 'ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ';
  const TONES = 'ˊˇˋ˙';
  const MAX_PHRASE = 9;

  // 標準（大千）注音鍵盤，用實體按鍵位置對應，不受系統鍵盤配置影響
  const KEYMAP = {
    Digit1: 'ㄅ', KeyQ: 'ㄆ', KeyA: 'ㄇ', KeyZ: 'ㄈ',
    Digit2: 'ㄉ', KeyW: 'ㄊ', KeyS: 'ㄋ', KeyX: 'ㄌ',
    Digit3: 'ˇ', KeyE: 'ㄍ', KeyD: 'ㄎ', KeyC: 'ㄏ',
    Digit4: 'ˋ', KeyR: 'ㄐ', KeyF: 'ㄑ', KeyV: 'ㄒ',
    Digit5: 'ㄓ', KeyT: 'ㄔ', KeyG: 'ㄕ', KeyB: 'ㄖ',
    Digit6: 'ˊ', KeyY: 'ㄗ', KeyH: 'ㄘ', KeyN: 'ㄙ',
    Digit7: '˙', KeyU: 'ㄧ', KeyJ: 'ㄨ', KeyM: 'ㄩ',
    Digit8: 'ㄚ', KeyI: 'ㄛ', KeyK: 'ㄜ', Comma: 'ㄝ',
    Digit9: 'ㄞ', KeyO: 'ㄟ', KeyL: 'ㄠ', Period: 'ㄡ',
    Digit0: 'ㄢ', KeyP: 'ㄣ', Semicolon: 'ㄤ', Slash: 'ㄥ',
    Minus: 'ㄦ',
  };

  // 中文模式下的快速標點：Shift 是半形（跟英文鍵盤一樣），Ctrl 是全形中文標點
  const PUNCT = {
    'Quote': '、', 'BracketLeft': '「', 'BracketRight': '」', 'Equal': '＝', 'Backslash': '＼',
    'Shift+Comma': '<', 'Shift+Period': '>', 'Shift+Slash': '?', 'Shift+Semicolon': ':', 'Shift+Quote': '"',
    'Shift+BracketLeft': '{', 'Shift+BracketRight': '}', 'Shift+Backslash': '|', 'Shift+Backquote': '~',
    'Shift+Digit1': '!', 'Shift+Digit2': '@', 'Shift+Digit3': '#', 'Shift+Digit4': '$', 'Shift+Digit5': '%',
    'Shift+Digit6': '^', 'Shift+Digit7': '&', 'Shift+Digit8': '*', 'Shift+Digit9': '(', 'Shift+Digit0': ')',
    'Shift+Minus': '_', 'Shift+Equal': '+',
    'Ctrl+Comma': '，', 'Ctrl+Period': '。', 'Ctrl+Slash': '？', 'Ctrl+Semicolon': '：', 'Ctrl+Quote': '、',
    'Ctrl+BracketLeft': '『', 'Ctrl+BracketRight': '』', 'Ctrl+Backslash': '｜', 'Ctrl+Backquote': '～',
    'Ctrl+Digit1': '！', 'Ctrl+Digit6': '…', 'Ctrl+Digit9': '（', 'Ctrl+Digit0': '）', 'Ctrl+Minus': '——',
  };
  // 英文模式下按鍵打出的字（美式鍵盤），組字區有字時放進組字區用
  const EN_PLAIN = { Space: ' ', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' };
  function enCharOf(k) {
    if (k.ctrl || k.alt || k.meta) return undefined;
    if (/^Key[A-Z]$/.test(k.code)) return k.shift ? k.code.slice(3) : k.code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(k.code)) return k.shift ? PUNCT['Shift+' + k.code] : k.code.slice(5);
    if (/^Numpad\d$/.test(k.code)) return k.code.slice(6);
    return k.shift ? PUNCT['Shift+' + k.code] : EN_PLAIN[k.code];
  }

  // 這個按鍵組合對應到哪個標點（沒有就是 undefined）；Ctrl 和 Shift 一起按、或有 Alt/Win 都不算
  function punctOf(k) {
    if (k.alt || k.meta || (k.ctrl && k.shift)) return undefined;
    return PUNCT[(k.ctrl ? 'Ctrl+' : k.shift ? 'Shift+' : '') + k.code];
  }

  const SYMBOLS = [
    { name: '標點', items: '，。、；：？！…—「」『』（）《》〈〉【】〔〕‧·～＿／＼｜'.split('') },
    { name: '數學', items: '＋－×÷＝≠≒≦≧＜＞±√∞∴∵∠⊥∩∪∫％‰°℃'.split('') },
    { name: '箭頭', items: '←→↑↓↖↗↘↙⇒⇔↔↕'.split('') },
    { name: '符號', items: '★☆●○◎◆◇■□▲△▼▽※✓✗♥♡♪§¶©®™＃＆＠＊'.split('') },
    { name: '單位', items: '㎜㎝㎞㎡㎏㏄＄￥￡€元年月日時分秒'.split('') },
    { name: '數字', items: '①②③④⑤⑥⑦⑧⑨⑩ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ'.split('') },
  ];

  function slotOf(ch) {
    if (INITIALS.includes(ch)) return 0;
    if (MEDIALS.includes(ch)) return 1;
    if (FINALS.includes(ch)) return 2;
    if (TONES.includes(ch)) return 3;
    return -1;
  }

  function splitTone(s) {
    const last = s[s.length - 1];
    return TONES.includes(last) ? [s.slice(0, -1), last] : [s, ''];
  }

  // 輸入音節：{ body: 'ㄓ', tone: null | '' | 'ˊ' ... }，tone 為 null 表示沒打聲調
  function sylText(s) { return s.body + (s.tone || ''); }
  function isInitialOnly(body) { return body.length === 1 && slotOf(body) === 0; }
  // 簡拼（只打第一個注音）：聲母，或沒有聲母的字的介音 ㄧㄨㄩ（為 ㄨㄟˋ、問 ㄨㄣˋ、我 ㄨㄛˇ 只能打 ㄨ）
  // 沒打聲調的「ㄨ」同時也可以是完整的音（無、五），兩種都配，交給前後文決定
  // 口語裡常常單獨出現的字（只打聲母時不重扣）
  const EASY_SINGLES = '我你妳他她它要在是的了去有就也都會不很想說這那好嗎吧呢啊再跟和給讓把被到來還又才';
  function isAbbr(body) { return isInitialOnly(body) || (body.length === 1 && MEDIALS.includes(body)); }

  // 測試題用的寫法：音節以空白分隔，沒聲調記號＝一聲，結尾加 * ＝省略聲調
  function parseReading(str) {
    return str.trim().split(/\s+/).filter(Boolean).map((t) => {
      if (t.endsWith('*')) return { body: t.slice(0, -1), tone: null };
      const [body, tone] = splitTone(t);
      // 沒聲調記號＝用空白鍵打的一聲
      return tone ? { body, tone } : { body, tone: '', loose: true };
    });
  }

  // 用空白鍵打一聲、但詞庫是其他聲調時要扣的分
  // 另外：沒打聲調的 ㄧ／ㄨ／ㄩ 可能是完整的音（午 ㄨˇ），也可能是簡拼（為 ㄨㄟˋ）。
  // 旁邊是完整注音（ㄒㄧㄚ ㄨ → 下午）時完整的音優先；整段都只打一個字母（ㄐㄧ → 加油）就不扣
  function tonePenalty(part, e) {
    let p = 0;
    const mixed = part.some((s) => s.body.length > 1);
    part.forEach((s, k) => {
      if (s.loose && TONES.includes(e.syl[k].slice(-1))) p -= Engine.TONE_MISS;
      else if (mixed && s.tone === null && MEDIALS.includes(s.body) && splitTone(e.syl[k])[0] !== s.body) p -= Engine.MEDIAL_ABBR;
    });
    return p;
  }
  function formatReading(syls) {
    return syls.map((s) => s.body + (s.tone === null ? '*' : s.tone)).join(' ');
  }

  // 用空白鍵打的一聲（loose）：優先配一聲，其他聲調也能配，但在 Engine 裡扣分
  function sylMatches(input, dictSyl) {
    const [db, dt] = splitTone(dictSyl);
    if (input.loose) return db === input.body;
    if (input.tone === null) {
      // 只打聲母（例如 ㄓㄉ → 知道）就用開頭比對，其他沒打聲調就忽略聲調
      return isAbbr(input.body) ? db.startsWith(input.body) : db === input.body;
    }
    return db === input.body && dt === input.tone;
  }

  // ───────────────────────── 詞庫 ─────────────────────────
  class Dictionary {
    constructor(text) {
      this.byReading = new Map();
      this.byAbbr = new Map();
      const best = new Map(); // 詞 → 最常見讀音的分數
      for (const line of text.split('\n')) {
        const [w, r, s, chat, cs] = line.split('\t');
        if (!w || !r) continue;
        const syl = r.split(' ');
        const e = { w, r, syl, s: Number(s) };
        if (chat === '1') e.chat = true; // 聊天常用短語（data/chat-phrases.txt）
        if (cs) e.cs = Number(cs); // 口語詞頻（只打聲母時用）
        // 破音字的少見讀音（「會」ㄎㄨㄞˋ、「吃」ㄐㄧˊ）：前後文模型只記字不記音，搭配次數要按讀音比例打折
        if (best.has(w)) e.minor = e.s - best.get(w); else best.set(w, e.s);
        push(this.byReading, r, e);
        push(this.byAbbr, syl.map((x) => x[0]).join(''), e);
      }
      // 資料已依分數排序，所以每個桶子裡也是由高到低
    }

    // 這串注音是不是某個國語音的開頭（ㄐㄧ 是，ㄗㄧ 不是）
    isSyllablePrefix(body) {
      if (!this.prefixes) {
        this.prefixes = new Set();
        for (const r of this.byReading.keys()) {
          if (r.includes(' ')) continue;
          const b = splitTone(r)[0];
          for (let k = 1; k <= b.length; k++) this.prefixes.add(b.slice(0, k));
        }
      }
      return this.prefixes.has(body);
    }

    // 不管打的順序，這幾個符號湊得出國語的音嗎（ㄈㄦ、ㄅㄩ 就湊不出來）
    canFormSyllable(body) {
      if (!this.slotSets) {
        this.slotSets = new Set();
        for (const r of this.byReading.keys()) {
          if (r.includes(' ')) continue;
          const slots = ['', '', ''];
          for (const ch of splitTone(r)[0]) if (slotOf(ch) >= 0 && slotOf(ch) < 3) slots[slotOf(ch)] = ch;
          for (let m = 1; m < 8; m++) this.slotSets.add(slots.map((c, k) => (m >> k & 1 ? c : '')).join('|'));
        }
      }
      const slots = ['', '', ''];
      for (const ch of body) slots[slotOf(ch)] = ch;
      return this.slotSets.has(slots.join('|'));
    }

    lookup(syls) {
      if (syls.every((s) => s.tone !== null && !s.loose)) {
        return this.byReading.get(syls.map(sylText).join(' ')) || [];
      }
      const bucket = this.byAbbr.get(syls.map((s) => s.body[0]).join(''));
      if (!bucket) return [];
      return bucket.filter((e) => e.syl.every((d, k) => sylMatches(syls[k], d)));
    }
  }

  function push(map, k, v) {
    const a = map.get(k);
    if (a) a.push(v); else map.set(k, [v]);
  }

  // ───────────────────────── 使用者學習 ─────────────────────────
  // 全部存在本機，不上傳。
  //   picks：某個注音最後選了哪個詞（不看前後文，加分小，避免「在」「再」學過頭）
  //   left / right：在某個前一個詞／後一個詞旁邊選了哪個詞（看前後文，加分大）
  //   usage：常用的詞，微幅加分
  // 分兩層：base 是內建預設（擁有者訓練好、打包進網頁的），個人學習疊在上面。
  // 同一筆資料取兩層中比較大的次數，不相加，避免擁有者自己的紀錄被算兩次。
  const KINDS = ['picks', 'left', 'right', 'usage', 'phrases'];

  class UserModel {
    constructor(data, base) {
      this.base = {};
      for (const k of KINDS) this.base[k] = (base && base[k]) || {};
      this.load(data);
    }

    count(kind, key) { return Math.max(this[kind][key] || 0, this.base[kind][key] || 0); }

    // 預設＋個人合併後的結果（上傳成新的預設時用）
    merged() {
      const out = { v: 1 };
      for (const k of KINDS) {
        out[k] = Object.assign({}, this.base[k]);
        for (const [key, n] of Object.entries(this[k])) out[k][key] = Math.max(n, out[k][key] || 0);
      }
      return out;
    }

    load(data) {
      data = data || {};
      this.picks = data.picks || {};
      this.left = data.left || {};
      this.right = data.right || {};
      this.usage = data.usage || {};
      // 自己造的詞：手動選字後組出來的詞（例如「大家」＋「好」→「大家好」），key：注音|詞
      this.phrases = data.phrases || {};
      this.phraseIndex = null;
    }

    toJSON() { return { v: 1, picks: this.picks, left: this.left, right: this.right, usage: this.usage, phrases: this.phrases }; }

    // 依音節數分組，查詢時只比對同長度的詞
    phrasesOfLength(n) {
      if (!this.phraseIndex) {
        this.phraseIndex = new Map();
        const all = new Set([...Object.keys(this.base.phrases), ...Object.keys(this.phrases)]);
        for (const k of all) {
          const count = this.count('phrases', k);
          const [r, w] = k.split('|');
          const syl = r.split(' ');
          // 用過越多次分數越高；基本分約等於很常用的詞
          push(this.phraseIndex, syl.length, { w, r, syl, s: -6 + Math.min(3, Math.log1p(count)), user: true });
        }
      }
      return this.phraseIndex.get(n) || [];
    }

    addPhrase(r, w) {
      inc(this.phrases, r + '|' + w);
      this.phraseIndex = null;
    }

    unigramBonus(e) {
      let b = 0;
      const p = this.count('picks', e.r + '|' + e.w);
      if (p) b += Math.min(3, 0.6 * Math.log1p(p));
      const u = this.count('usage', e.w);
      if (u) b += Math.min(1, 0.15 * Math.log1p(u));
      return b;
    }

    // prev / next：{ w, r }
    contextBonus(prev, e) {
      if (!prev || !prev.w) return 0;
      let b = 0;
      const l = this.count('left', prev.w + '|' + e.r + '|' + e.w);
      if (l) b += 6 + Math.log1p(l);
      if (prev.r) {
        const r = this.count('right', prev.r + '|' + prev.w + '|' + e.w);
        if (r) b += 6 + Math.log1p(r);
      }
      return b;
    }

    // nodes：這次送出的結果；picked：使用者手動選過的節點
    learn(nodes, leftWord) {
      nodes.forEach((n, i) => {
        if (n.fallback) return;
        inc(this.usage, n.w);
        if (!n.picked) return;
        inc(this.picks, n.r + '|' + n.w);
        const prev = i > 0 ? nodes[i - 1] : (leftWord ? { w: leftWord } : null);
        if (prev && prev.w) inc(this.left, prev.w + '|' + n.r + '|' + n.w);
        const next = nodes[i + 1];
        // 記「選的詞後面接什麼」，下次後面接一樣的詞時，前面也會選對
        if (next && !next.fallback) inc(this.right, n.r + '|' + n.w + '|' + next.w);
        // 把手動選的詞和前後的詞連成一個新詞記下來（例如 大家＋好 → 大家好），最多 6 個字
        const prevNode = i > 0 ? nodes[i - 1] : null;
        const group = [prevNode, n, next].filter((x) => x && !x.fallback);
        const tryAdd = (list) => {
          const w = list.map((x) => x.w).join('');
          if (list.length < 2 || [...w].length > 6) return false;
          this.addPhrase(list.map((x) => x.r).join(' '), w);
          return true;
        };
        if (!tryAdd(group)) {
          if (!(prevNode && !prevNode.fallback && tryAdd([prevNode, n]))) {
            if (next && !next.fallback) tryAdd([n, next]);
          }
        }
      });
    }

    forget(kind, key) { delete this[kind][key]; if (kind === 'phrases') this.phraseIndex = null; }
    clear() { this.load(null); }
  }

  function inc(obj, k) { obj[k] = (obj[k] || 0) + 1; }

  // ───────────────────────── 前後文模型 ─────────────────────────
  // 從維基百科統計的「前一個詞 → 下一個詞」次數（tools/build-lm.js 產生）。
  // 每行：前詞<TAB>前詞總次數<TAB>退回用的次數<TAB>詞:次數,詞:次數...（tools/prune-lm.js 精簡後的格式）
  // 用「絕對折扣」把搭配次數和單詞機率混合：常一起出現就加分，前詞很常見卻從沒接過這個詞就扣分。
  class LanguageModel {
    constructor(lm) {
      this.raw = new Map();
      this.cache = new Map();
      for (const line of (lm && lm.data ? lm.data.split('\n') : [])) {
        const t = line.indexOf('\t');
        if (t > 0) this.raw.set(line.slice(0, t), line);
      }
    }

    get size() { return this.raw.size; }

    entry(prev) {
      let e = this.cache.get(prev);
      if (e !== undefined) return e;
      const line = this.raw.get(prev);
      e = null;
      if (line) {
        const [, f, k, list] = line.split('\t');
        const next = new Map();
        for (const item of list.split(',')) {
          const i = item.lastIndexOf(':');
          next.set(item.slice(0, i), Number(item.slice(i + 1)));
        }
        e = { f: Number(f), b: Number(k), next };
      }
      this.cache.set(prev, e);
      return e;
    }

    // logUni：這個詞原本的分數（自然對數機率）。回傳要加減的分數
    // minor：少見讀音比最常見讀音低多少（自然對數，0 或負數）
    bonus(prevWord, word, logUni, minor) {
      if (!prevWord) return 0;
      const e = this.entry(prevWord);
      // 也看前一個詞的最後一個字：
      // 「不在＋公司」「不再＋公司」都太少見，但「在＋公司」很常見、「再＋公司」幾乎沒有
      const last = prevWord.length > 1 ? this.entry(prevWord.slice(-1)) : null;
      const mode = LanguageModel.CHAR_MODE;
      if (last && mode === 'fallback' && (!e || !e.next.has(word))) return this.score(last, word, logUni, minor);
      if (last && mode === 'mix') {
        const cs = this.score(last, word, logUni, minor);
        return e ? (this.score(e, word, logUni, minor) + cs) / 2 : cs;
      }
      return e ? this.score(e, word, logUni, minor) : 0;
    }

    score(e, word, logUni, minor) {
      const D = LanguageModel.DISCOUNT;
      const c = (e.next.get(word) || 0) * (minor ? Math.exp(minor) : 1);
      const p = Math.max(c - D, 0) / e.f + (e.b / e.f) * Math.exp(logUni);
      const b = LanguageModel.WEIGHT * (Math.log(p) - logUni);
      return Math.max(-LanguageModel.MAX_PENALTY, Math.min(LanguageModel.MAX_BOOST, b));
    }
  }
  LanguageModel.DISCOUNT = 0.75;
  LanguageModel.WEIGHT = 1;
  LanguageModel.MAX_PENALTY = 6;
  LanguageModel.MAX_BOOST = 8;
  LanguageModel.CHAR_MODE = 'none'; // none｜fallback｜mix

  // ───────────────────────── 選字（找最佳斷詞） ─────────────────────────
  class Engine {
    constructor(dict, user, lm) {
      this.dict = dict;
      this.user = user || new UserModel();
      this.lm = lm || null;
    }

    spanEntries(syls, i, j) {
      const part = syls.slice(i, j);
      // 組字區裡的標點：只能單獨成一段，字就是標點本身
      if (part.some((x) => x.punct)) return j - i === 1 ? [{ w: part[0].body, r: part[0].body, syl: [part[0].body], s: 0, punct: true }] : [];
      let list = this.dict.lookup(part);
      const mine = this.user.phrasesOfLength(j - i).filter((e) => e.syl.every((d, k) => sylMatches(part[k], d)));
      if (mine.length) {
        // 自己造的詞放進來；如果詞庫也有同一個詞，用分數高的那個
        const words = new Set(mine.map((e) => e.w));
        list = mine.concat(list.filter((e) => !words.has(e.w))).sort((a, b) => b.s - a.s);
      }
      if (list.length || j - i > 1) return list;
      // 打錯或詞庫沒有的音節，直接顯示注音，確保一定有結果
      return [{ w: sylText(part[0]), r: sylText(part[0]), syl: [sylText(part[0])], s: -30, fallback: true }];
    }

    // 只打聲母時，單字太容易亂湊（「這」「的」頻率太高），所以扣分讓詞優先
    // 另外每切一段固定扣分：單字的詞頻包含了它出現在詞裡的次數，不扣的話兩個單字常會贏過真正的詞（再見 → 在間）
    penalty(syls, i, j) {
      let abbr = 0;
      for (let k = i; k < j; k++) if (syls[k].tone === null && isAbbr(syls[k].body)) abbr++;
      const seg = Engine.SEGMENT_COST;
      if (!abbr) return seg;
      return seg + (j - i === 1 ? -Engine.ABBR_SINGLE : -0.5 * abbr);
    }

    // locks：[{ s, e, w }] 使用者手動選過的區段
    // only：只接受這句文字（用來替 AI 產生的句子算統計分數），沒有路徑就回傳空結果
    // 組字區裡的空白不切斷前後文：先拿掉空白整句判斷（「你要再 試試看」還是看得到後面的「試試看」），再把空白放回原位
    convert(syls, opts) {
      const isSpace = (x) => x.punct && x.body === ' ';
      if (!syls.some(isSpace)) return this.convertCore(syls, opts);
      opts = opts || {};
      const keep = []; // 拿掉空白後第 k 個音節，原本在第幾個
      syls.forEach((x, i) => { if (!isSpace(x)) keep.push(i); });
      if (!keep.length) return this.convertCore(syls, opts);
      const back = new Map(keep.map((orig, k) => [orig, k]));
      const sub = Object.assign({}, opts);
      if (opts.locks) sub.locks = opts.locks.filter((L) => back.has(L.s) && back.has(L.e - 1) && back.get(L.e - 1) - back.get(L.s) === L.e - 1 - L.s)
        .map((L) => Object.assign({}, L, { s: back.get(L.s), e: back.get(L.e - 1) + 1 }));
      if (opts.only) { const only = [...opts.only]; sub.only = keep.map((i) => only[i]); }
      const spread = (nodes) => {
        const out = [];
        for (const nd of nodes) {
          const chars = [...nd.w];
          // 字數跟音節數對不上（詞庫沒有、顯示注音的音節）就整段放回去
          if (chars.length !== nd.e - nd.s) { out.push(Object.assign({}, nd, { s: keep[nd.s], e: keep[nd.e - 1] + 1 })); continue; }
          // 一個詞橫跨空白（「再試」中間按了空白）：在空白處切開
          let from = nd.s;
          for (let k = nd.s + 1; k <= nd.e; k++) {
            if (k < nd.e && keep[k] === keep[k - 1] + 1) continue;
            out.push(Object.assign({}, nd, { s: keep[from], e: keep[k - 1] + 1, w: chars.slice(from - nd.s, k - nd.s).join('') }));
            from = k;
          }
        }
        syls.forEach((x, i) => { if (isSpace(x)) out.push({ s: i, e: i + 1, w: ' ', r: ' ' }); });
        out.sort((p, q) => p.s - q.s);
        return out;
      };
      const r = this.convertCore(keep.map((i) => syls[i]), sub);
      const nodes = spread(r.nodes);
      const res = { nodes, text: nodes.map((x) => x.w).join(''), score: r.score };
      if (r.nbest) res.nbest = r.nbest.map((c) => { const nd = spread(c.nodes); return { text: nd.map((x) => x.w).join(''), score: c.score, nodes: nd }; });
      return res;
    }

    convertCore(syls, opts) {
      opts = opts || {};
      const only = opts.only ? [...opts.only] : null;
      if (only && only.length !== syls.length) return { nodes: [], text: '' };
      const locks = opts.locks || [];
      const useUser = opts.useUser !== false;
      const left = opts.leftWord ? { w: opts.leftWord, r: '' } : null;
      const n = syls.length;
      if (!n) return { nodes: [], text: '' };

      const PER_SPAN = 30;
      const beamSize = opts.beam || 8;
      const perState = opts.perState || 1;
      const cache = new Map();
      const candidates = (i, j) => {
        const key = i * 64 + j;
        if (cache.has(key)) return cache.get(key);
        let res = null;
        for (const L of locks) {
          if (L.s === i && L.e === j) {
            const found = this.spanEntries(syls, i, j).find((e) => e.w === L.w);
            res = [Object.assign({}, found || { w: L.w, r: formatReading(syls.slice(i, j)), syl: [], s: -5 }, { picked: true })];
            break;
          }
          if (i < L.e && j > L.s) { res = []; break; } // 跟手動選的區段部分重疊，不允許
        }
        if (res && only) res = res.filter((e) => e.w === only.slice(i, j).join(''));
        if (!res) {
          const pen = this.penalty(syls, i, j);
          const part = syls.slice(i, j);
          // 只打聲母時，聊天常用短語優先（ㄒㄒ → 謝謝，不是學校）；打完整注音不影響
          const chatBonus = part.some((s) => s.tone === null && isAbbr(s.body)) ? Engine.CHAT_BONUS : 0;
          // 「常不常見」只佔 UNIGRAM_WEIGHT 的比重，其餘交給前後文判斷（前後文模型的分數已經包含跟前一個詞的搭配）
          const uw = this.lm ? Engine.UNIGRAM_WEIGHT : 1;
          // 只打聲母的單字一律扣分（避免亂湊），但「我、要、在、的…」這種口語常用字只扣一點（ㄨㄒㄗㄧㄕㄐ → 我現在要睡覺）
          const easy = j - i === 1 && part[0].tone === null && isAbbr(part[0].body) ? Engine.EASY_REFUND : 0;
          let list = this.spanEntries(syls, i, j);
          if (only) { const want = only.slice(i, j).join(''); list = list.filter((e) => e.w === want); }
          // 只打聲母多半是在聊天：詞頻改成書面語和口語各半（「驚濤駭浪」在口語裡幾乎不出現）
          const abbrSpan = part.some((s) => s.tone === null && isAbbr(s.body));
          const floor = typeof globalThis !== 'undefined' && globalThis.ZHUYIN_COLLOQ_FLOOR != null ? globalThis.ZHUYIN_COLLOQ_FLOOR : -14;
          const freq = (e) => (abbrSpan ? (1 - Engine.COLLOQ_WEIGHT) * e.s + Engine.COLLOQ_WEIGHT * (e.cs != null ? e.cs : floor) : e.s);
          // 簡拼時口語常用的詞可能排在書面語詞頻很後面，要多看一些
          res = list.slice(0, abbrSpan ? PER_SPAN * 40 : PER_SPAN * 8)
            .map((e) => ({ e, base: uw * freq(e) + (e.minor < -Engine.MINOR_GAP && e.w.length === 1 ? -Engine.MINOR_SINGLE : 0) + pen + tonePenalty(part, e) + (e.chat ? chatBonus : 0) + (easy && EASY_SINGLES.includes(e.w) ? easy : 0) + (useUser ? this.user.unigramBonus(e) : 0) }))
            .sort((a, b) => b.base - a.base).slice(0, PER_SPAN)
            .map((x) => Object.assign({}, x.e, { base: x.base }));
        } else {
          res.forEach((e) => { e.base = e.s; });
        }
        cache.set(key, res);
        return res;
      };

      const beams = Array.from({ length: n + 1 }, () => []);
      beams[0].push({ score: 0, last: left, nodes: [] });
      for (let j = 1; j <= n; j++) {
        const next = [];
        for (let i = Math.max(0, j - MAX_PHRASE); i < j; i++) {
          if (!beams[i].length) continue;
          const cands = candidates(i, j);
          for (const path of beams[i]) {
            for (const c of cands) {
              const across = c.punct || (path.last && path.last.punct);
              const ctx = useUser && !across ? this.user.contextBonus(path.last, c) : 0;
              const lmb = this.lm && !c.fallback && !across && path.last ? this.lm.bonus(path.last.w, c.w, c.s, c.minor) : 0;
              next.push({ score: path.score + c.base + ctx + lmb, last: c, nodes: path.nodes.concat([{ s: i, e: j, w: c.w, r: c.r, picked: !!c.picked, fallback: !!c.fallback }]) });
            }
          }
        }
        next.sort((a, b) => b.score - a.score);
        // 同樣結尾詞只留最好的幾條（perState），讓光束保有多樣性
        const seen = new Map();
        for (const p of next) {
          const c = seen.get(p.last.w) || 0;
          if (c >= perState) continue;
          seen.set(p.last.w, c + 1);
          beams[j].push(p);
          if (beams[j].length >= beamSize) break;
        }
      }
      // 整句完成後再套用字規則（再／在、台灣慣用字；要看整句的前後文，逐詞計分時看不到）
      // 違反規則的句子扣分，並補一個改好的版本（只改字、不改切法，比原句多扣 FIX_COST）
      const finals = [];
      const seenText = new Set();
      const push = (nodes, score) => {
        const t = nodes.map((x) => x.w).join('');
        if (seenText.has(t)) return;
        seenText.add(t);
        finals.push({ nodes, text: t, score });
      };
      // 規則改的字要跟打的注音對得上（規則只看字，像「一程」的「程」可能被寫成任何 ㄔㄥˊ 的字）
      const sylAt = (nodes, i) => {
        let at = 0;
        for (const x of nodes) {
          const len = [...x.w].length;
          if (i < at + len) return len === x.e - x.s ? syls[x.s + i - at] : null;
          at += len;
        }
        return null;
      };
      const readable = new Map();
      const canWrite = (nodes, i, w) => [...w].every((ch, k) => {
        const syl = sylAt(nodes, i + k);
        if (!syl) return false;
        const key = sylText(syl) + (syl.loose ? '~' : '') + ch;
        if (!readable.has(key)) readable.set(key, this.dict.lookup([syl]).some((e) => e.w === ch));
        return readable.get(key);
      });
      beams[n].forEach((p, rank) => {
        const u = checkUsage(p.nodes, opts.leftWord, canWrite);
        push(p.nodes, p.score + u.bonus);
        if (u.fixes.length && rank < Engine.FIX_TOP) {
          const fixed = applyFixes(p.nodes, u.fixes);
          push(fixed, p.score - Engine.FIX_COST + checkUsage(fixed, opts.leftWord, canWrite).bonus);
        }
      });
      finals.sort((a, b) => b.score - a.score);
      const best = finals[0];
      if (!best) return { nodes: [], text: '' };
      const result = { nodes: best.nodes, text: best.text, score: best.score };
      // 前幾名候選句（給神經網路模型複審用）
      if (opts.nbest) {
        const texts = new Set();
        result.nbest = [];
        for (const p of finals) {
          const t = p.text;
          if (texts.has(t)) continue;
          texts.add(t);
          result.nbest.push({ text: t, score: p.score, nodes: p.nodes });
          if (result.nbest.length >= opts.nbest) break;
        }
      }
      return result;
    }

    // 每個位置可以放哪些字（給 AI 逐字產生句子用）：符合這個音（或簡拼字母）的單字；手動選過的區段固定
    charChoices(syls, locks) {
      const out = syls.map((s, k) => [...new Set(this.spanEntries(syls, k, k + 1)
        .filter((e) => !e.fallback && [...e.w].length === 1).map((e) => e.w))]);
      for (const L of locks || []) [...L.w].forEach((ch, k) => { out[L.s + k] = [ch]; });
      return out;
    }

    // 選字窗：游標在最後面時列出「結尾在這裡」的詞，否則列出「從游標開始」的詞，長的在前
    candidatesAt(syls, cursor) {
      const n = syls.length;
      const out = [];
      const seen = new Set();
      const spans = [];
      if (cursor >= n) {
        for (let len = Math.min(MAX_PHRASE, n); len >= 1; len--) spans.push([n - len, n]);
      } else {
        for (let len = Math.min(MAX_PHRASE, n - cursor); len >= 1; len--) spans.push([cursor, cursor + len]);
      }
      for (const [s, e] of spans) {
        const part = syls.slice(s, e);
        const list = this.spanEntries(syls, s, e)
          // 破音字的少見讀音（「和」ㄏㄢˋ）分數很低，但字本身很常用：選字清單裡往前排一些，不用翻頁找
          .map((x) => ({ x, sc: x.s + (x.minor && e - s === 1 ? -x.minor * 0.5 : 0) + tonePenalty(part, x) + this.user.unigramBonus(x) }))
          .sort((a, b) => b.sc - a.sc);
        for (const { x } of list) {
          const k = s + ':' + e + ':' + x.w;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ s, e, w: x.w, r: x.r });
          if (out.length > 400) break;
        }
        if (out.length > 400) break;
      }
      // 注音本身（ㄏㄠˇ）也能選：放在第一頁最後一個（第 9 個），候選少於 9 個就放最後
      const [zs] = spans[spans.length - 1];
      const zw = sylText(syls[zs]);
      if (!seen.has(zs + ':' + (zs + 1) + ':' + zw)) out.splice(Math.min(out.length, 8), 0, { s: zs, e: zs + 1, w: zw, r: zw, bpmf: true });
      return out;
    }
  }

  // ───────────────────────── 用字規則 ─────────────────────────
  // 同音、意思又接近的字，統計和神經網路只看附近幾個字常常分不出來，用文法線索和台灣慣用寫法補強。
  // 只扣「不符合線索」的寫法（符合的不加分）；使用者手動選過的字不動。
  //
  // 再／在：
  //   1. 又／還／正／都／也／一直／仍 + 在 → 進行中（他一直在說），語料裡 81～100% 是「在」
  //      （「又再一次」「又再度」例外）
  //   2. 下次／明天／改天／晚點／待會／有空／到時候 + 再 → 之後才做（有空再聊）
  //      想一想／看一看 + 再、先…再（先吃飯再走）也一樣
  //   3. 再 + 動作 + …一下／一次／一遍／看看 → 再做一次（再等我一下、再試一次）
  //      「在家休息一下」的「在」後面接地點，不是動作，所以不受影響
  //   4. 再 + 跟／和 + 某人 + 確認／討論／聯絡 → 之後去做（我再跟主管確認）
  const ZAI = {
    progressive: /(又|還|正|都|也|一直|仍|仍然|總是|老是)$/,
    notProgressive: /^(一次|一遍|度|次)/,
    later: /(下次|明天|改天|晚點|待會|待會兒|等一下|有空|到時|到時候|回頭|以後)$/,
    verb: /^(等|說|試|看|想|問|聊|來|去|確認|檢查|討論|吃|喝|找|做|寫|打|給|讀|算|改|加|學|練|回|走|睡|傳|講|聽|拿|買|用|跑|弄|查|約|告訴|通知|聯絡|處理|考慮|研究|商量|多|重)/,
    attempt: /(一下|一次|一遍|看看|試試)/,
    // 再 + 跟／和 + 某人 + 確認／討論／聯絡… → 之後去做（再跟主管確認、再和你討論）
    // 正在進行的通常會說「正在跟」「還在跟」，已經由第 1 條處理
    followUp: /^(跟|和|與|向).{1,5}?(確認|討論|聯絡|聯繫|商量|報告|回報|請教|確定|說明|溝通|約)/,
    // 會再通知你、要再確認、不要再說了（只收不會接地點的動詞，避免「要在學校」）
    modal: /(會|要|能|可以|別|不要|不會|不用|才|然後|之後)$/,
    modalVerb: /^(談|通知|告訴|聯絡|聯繫|處理|確認|檢查|討論|考慮|說|問|試|看看|想想|等|約|找|傳|寄|給|講|聊|回覆|回報|提醒|麻煩|打給|跟你|跟妳|和你|多|幫|來一|去一|吃一|喝一)/,
    // 想清楚再說、吃完再去、弄好再給我
    done: /(清楚|完|好|飽|過)$/,
  };
  function zaiWant(all, i) {
    const before = all.slice(0, i), after = all.slice(i + 1);
    const clause = after.split(/[，。！？、；：,.!?]/)[0];
    if (ZAI.progressive.test(before) && !ZAI.notProgressive.test(after)) return '在';
    // 我現在在跟他講（「現在再跟他試一次」有一下／一次，不受影響）
    if (/現在$/.test(before) && /^(跟|和)/.test(after) && !ZAI.attempt.test(clause)) return '在';
    // 在＋地點＋見：等等在出口見、明天在門口見（「再見」後面沒有地點，不受影響）
    if (/^[^，。！？]{1,4}見(吧|囉|喔)?$/.test(clause)) return '在';
    if (ZAI.later.test(before) || /(.)一\1$/.test(before)) return '再';
    const head = before.split(/[，。！？、；：,.!?]/).pop();
    if (/先./.test(head) && ZAI.verb.test(after)) return '再';
    if (ZAI.verb.test(after) && ZAI.attempt.test(clause.slice(0, 8))) return '再';
    if (ZAI.followUp.test(clause)) return '再';
    // 我再跟他講、再跟你說一聲（句子停在講／說；「在跟他講話／講電話」後面還有字，不受影響）
    if (!/現在$/.test(before) && /^(跟|和|向)[^，。！？]{1,4}?(講|說)(一下|一聲|看看)?(吧|啦|好了|喔)?$/.test(clause)) return '再';
    if (ZAI.modal.test(before) && ZAI.modalVerb.test(after)) return '再';
    if (ZAI.done.test(head) && ZAI.verb.test(after)) return '再';
    // 不行的話再想、不然再說（「下雨的話在家」後面接地點，不受影響）
    if (/(的話|不然)$/.test(before) && ZAI.verb.test(after)) return '再';
    // 再一局、再一次、再一杯（「在一家公司」「在一個地方」後面接地點，不受影響）
    if (/^一[局次遍杯碗份輪回把場盤題首]/.test(after)) return '再';
    return null;
  }

  // 台灣慣用字：bad 符合的寫法扣分（unless 整句符合時不扣），fix 是正確寫法（同音、同長度）。
  // 正確寫法可能根本不在候選名單裡（「寄」被「計／記／際」擠掉），所以會主動補一個改好的候選句
  const USAGE = [
    // 回覆＝答覆訊息；回復＝恢復（回復原狀、回復健康）
    { bad: /回復(?!原|正常|健康|平靜|記憶|狀態|體力|元氣|視力|功能|秩序|舊觀|期|到)/g, fix: '回覆' },
    // 紀錄＝名詞（會議紀錄、通話紀錄、紀錄片）；記錄＝動詞（記錄下來、把它記錄）
    { bad: /(?<=的|會議|通話|聊天|交易|歷史|購買|上課|出勤|打卡|就診|搜尋|瀏覽|消費|比賽|世界|最高|最佳|破)記錄|記錄(?=片|表|簿|檔)/g, fix: '紀錄' },
    { bad: /紀錄(?=下來|下|著)|(?<=把|請|幫我|幫忙)紀錄/g, fix: '記錄' },
    // 報到＝到場登記；新聞台灣用「報導」（不同音），「報道」幾乎只會是打錯
    { bad: /報道/g, fix: '報到' },
    // 盡早、盡快、盡量（教育部建議寫法）；「儘管」不受影響
    { bad: /儘(?=早|快|量)/g, fix: '盡' },
    // 念（唸是異體字）
    { bad: /唸/g, fix: '念' },
    // 星期用「週」：下週、每週、週一、週末；周圍、周邊、周到等不受影響
    { bad: /(?<=[上下本這每前隔])周(?![圍邊遭全到詳知])|周(?=[一二三四五六日末休])/g, fix: '週' },
    // 帳（入帳、帳號、算帳），台灣不用「賬」
    { bad: /賬/g, fix: '帳' },
    // 電器的「電」：手機的電快沒了、筆電沒電（ㄉㄧㄢˋ：店、墊、殿）
    { bad: /(?<=手機|電腦|筆電|平板|相機|耳機|電池|行動電源|充電)的?[店墊殿](?=快|沒|不夠|剩|用完)|(?<=沒|充|斷|停|省|耗|漏)[店墊殿](?!員|長|家|面|鋪|舖)/g, fix: '電' },
    // 紙：印表機沒有紙了、一張紙（ㄓˇ：指、只、址、止）
    { bad: /(?<=印表機|影印機|列印|印表機沒有|影印機沒有|缺|加|補|換)[指只址止](?=了|$|[，。！？])|(?<=張)[指只址止]/g, fix: '紙' },
    // 交：報告下午要交、作業交出去（ㄐㄧㄠ：叫、較、腳、角、教、焦、膠）；「主管叫我改」後面接人，不受影響
    { bad: /(?<=(報告|作業|資料|文件|報表|表格|申請書|申請|履歷|企劃|企劃書|稿子|功課|論文|考卷|單子|資料表)[^，。！？]{0,8})[叫較腳教焦膠角](?=給|出去|出來|上去|了|$|[，。！？]|嗎|吧)/g, fix: '交' },
    // 寄＝送出去（寄給、寄不出去、寄信）；記＝記住、寫下（記得、記下來、忘記）
    // （ㄐㄧˋ 的同音字很多：記、計、紀、季、既、繼、技、際…，送東西的情境一律要「寄」）
    { bad: /[記計紀季既繼技際濟忌劑跡績祭](?=給|不出|出去|回去|回來|信|包裹|送|快遞|掛號|錯地址)|(?<=快遞|郵局|宅配|包裹|掛號|郵件)[記計紀季既繼技際濟忌劑跡績祭](?!得|住|錄|憶|者|算|畫|劃)/g, fix: '寄' },
    { bad: /寄(?=得|憶|下來|性)|(?<=筆|牢|忘|登|日|標|印|速|默|惦)寄/g, fix: '記' },
    // 本州是日本的地名，其他時候是「本週」
    { bad: /本州/g, unless: /日本/, fix: '本週' },
    // 量詞：一支筆、兩支手機（花才用「枝」）
    { bad: /(?<=[一二兩三四五六七八九十幾這那每半])枝(?![花葉玫])/g, fix: '支' },
    { bad: /(?<=[一二兩三四五六七八九十幾這那每半])[支隻](?=花|玫瑰)/g, fix: '枝' },
    // 計畫（教育部建議寫法）；規劃、企劃不受影響
    { bad: /計劃/g, fix: '計畫' },
    // 「好幾」後面一定接東西（好幾個、好幾天），句尾的 ㄏㄠˇ ㄐㄧˇ 是「好擠」
    { bad: /好幾(?=$|[，。！？]|喔|耶|啊|欸)/g, fix: '好擠' },
    // 煮：我來煮、要煮飯（ㄓㄨˇ：主、住…）
    { bad: /(?<=[來要先去再在會想幫你我他她自己])主(?=$|[，。！？]|飯|麵|湯|咖啡|開水|一下|好了)/g, fix: '煮' },
    // 訂：訂票、訂位、把票訂好（ㄉㄧㄥˋ：定）；決定、確定等不受影響
    { bad: /(?<![決確固約規肯穩一預])定(?=票|位|房間|機票|車票|飯店|旅館|便當|餐廳|蛋糕)|(?<=(票|位子|座位|房間|飯店|機票|車票|餐廳|蛋糕|便當|桌|披薩|花束)[^，。！？]{0,3})(?<![決確固約規肯穩一預])定(?=好|了|$|[，。！？])/g, fix: '訂' },
    // 交作業（作業在後面）：明天要交美術作業
    { bad: /[叫較腳教焦膠角](?=(美術|數學|英文|國文|自然|社會|歷史|地理|物理|化學|生物|音樂|體育|暑假|寒假|回家|期末|期中)?(作業|報告|功課|考卷|論文))/g, fix: '交' },
    // 胃：我胃不舒服、胃痛（ㄨㄟˋ：為、位、味…）
    { bad: /(?<=^|[我你他她的有])[為位味未衛謂喂](?=不太舒服|不舒服|很痛|好痛|在痛|痛(?!苦)|酸|潰瘍|食道|鏡|藥|口不好|口很好)/g, fix: '胃' },
    // 滷（教育部寫法）：滷肉飯、滷蛋、滷味
    { bad: /魯(?=肉飯|肉|味|蛋|汁|豆腐|雞腿|白菜)/g, fix: '滷' },
    // 痠（肌肉、身體）：腰很痠、痠痛；酸辣、酸味不受影響
    { bad: /(?<=(腰|腳|腿|肩膀|脖子|手臂|手|背|肌肉|眼睛|全身|小腿|打完針|打針)[^，。！？]{0,4})酸(?![辣甜味奶性雨菜梅])|酸(?=痛|麻|軟)/g, fix: '痠' },
    // 請人教：可以教我寫、能不能教我怎麼做
    { bad: /(?<=可以|能不能|可不可以|會不會)叫(?=我|你)(?=.(怎麼|寫|做|煮|彈|畫|唱|念|算|用|開|游|騎|拍|修|說))/g, fix: '教' },
    // 比價：比過價、比較過價
    { bad: /(?<=比過|比較過)架/g, fix: '價' },
    // 我買禮物給我媽（我給我自己不會用「嗎」問）
    { bad: /(?<=^我[^你您妳，。！？]{0,12}給我)嗎$/g, fix: '媽' },
    // 請人坐：要不要先坐一下、請坐一下（後面沒有接事情時）
    { bad: /(?<=要不要先?|請先?|先進來)做(?=一下吧?(?:$|[，。！？]))/g, fix: '坐' },
    // 坐位置：這個位置可以坐嗎、椅子可以坐
    { bad: /(?<=(位置|位子|座位|空位|椅子|沙發|板凳)[^，。！？]{0,4})做(?=嗎|吧|$|[，。！？]|下|著)/g, fix: '坐' },
    // 變瘦：你最近是不是瘦了（受傷、受了苦後面有接東西，不受影響）
    { bad: /(?<=變|是不是|好像|又|真的|最近|有|沒有)受(?=了(?:$|[，。！？]|嗎|耶|喔|吧|呢|[一二三四五六七八九十幾\d]+公斤))/g, fix: '瘦' },
    // 嚐嚐看：要不要嚐嚐看、你可以嚐嚐
    { bad: /(?<=要不要|可以|來|先|幫我|讓我|給我)常常(?=看?(?:$|[，。！？]|吧|嗎|喔))/g, fix: '嚐嚐' },
    // 吃藥：這個藥飯後吃、這種藥一天吃三次
    { bad: /(?<=這個|這種|那個|那種|這包|這顆|這瓶|那包|那顆)要(?=(飯後|飯前|睡前|空腹|一天|每天|早晚|三餐)[^，。！？]{0,6}(吃|服|擦|用|喝|點|抹))/g, fix: '藥' },
    // 約見面：我們機場見、明天門口見（房間、時間、中間等不受影響）
    { bad: /(?<=^(我們|你們|大家|那就|那我們|明天|今天|晚上|下午|早上|待會|等一下|等等|晚點|改天|週末|下週|到時候)[^，。！？]{0,6})(?<![房時中空之期瞬夜晚民人區世田洗衛隔車套單雙樓])間(?=$|[，。！？]|囉|喔|吧)/g, fix: '見' },
    // 電腦程式：程式一直出現錯誤、寫程式
    { bad: /城市(?=[^，。！？]{0,4}(錯誤|當掉|閃退|bug|BUG|跑不動|執行|編譯|碼))|(?<=寫|跑|執行|安裝|改)城市/g, fix: '程式' },
    // 搬東西：我來幫你搬、一起搬家
    { bad: /(?<=幫你|幫妳|幫我|幫他|幫她|幫忙|一起|我來)班(?=$|[，。！？]|家|東西|走|過去|過來|上去|下來|進來|出去|吧|嗎)/g, fix: '搬' },
    // 漲價：油價又漲了、房租一直漲
    { bad: /(?<=(價|價格|房租|租金|薪水|學費|電費|水費|股票|股價)(又|一直|再|都|也|竟然|突然|又再)?)長(?=了|到|得|很|好|$|[，。！？]|價|幅)/g, fix: '漲' },
    // 搭車坐過頭、坐過站
    { bad: /做(?=過站)|(?<=^[我你他她]?)做(?=過頭了?$)/g, fix: '坐' },
    // 整晚沒睡、一夜沒睡
    { bad: /(?<=(整晚|整夜|昨晚|一整晚|通宵|一夜|一整天|幾天)[^，。！？]{0,3}沒有?)說/g, fix: '睡' },
    // 簽收包裹：幫你簽收、代簽收
    { bad: /(?<=幫你|幫妳|幫我|幫忙|代為?)牽手|牽手(?=包裹|快遞|掛號|貨)/g, fix: '簽收' },
    // 洗碗：碗我來洗、洗碗（今晚洗澡等不受影響）
    { bad: /(?<![今昨明傍每當夜])晚(?=(我|你|他|她|就|都|先)?(來|去)?洗)|(?<=洗)晚(?=$|[，。！？]|了|吧|嗎|盤|筷)/g, fix: '碗' },
    // 先墊錢：我先墊一下、幫你墊
    { bad: /(?<=先|幫你|幫妳|幫我|我來|你先)電(?=一下|著|錢)|電(?=付)/g, fix: '墊' },
    // 付錢：我們分開付、我來付（ㄈㄨˋ：父、婦、副…）
    { bad: /(?<=分開|一起|我來|你來|誰|自己|現金|刷卡|線上|手機|先|要|再)[父婦副負腹傅赴](?=$|[，。！？]|錢|款|帳|費|了|吧|嗎|就好)/g, fix: '付' },
    // 繳稅、稅要記得繳
    { bad: /^[說睡](?=要?記得[繳腳攪狡]|要[繳腳攪狡]|繳)|(?<=繳|報|所得|營業|退|扣)[說睡]/g, fix: '稅' },
    { bad: /(?<=(稅|費|帳單|罰單|貸款|房租)[^，。！？]{0,6})[腳攪狡](?=$|[，。！？]|了|嗎|吧)/g, fix: '繳' },
    // 修東西的師傅（拜師的才是師父）
    { bad: /(?<!拜|我的|大)師父(?=[^，。！？]{0,8}(會來|來修|來裝|修|裝|到了|弄))|(?<=水電|冷氣|裝潢|修理|搬家|計程車|油漆|廚房)師父/g, fix: '師傅' },
    // 花枯了：陽台的花枯了、草都枯掉了
    { bad: /(?<=(陽台|花園|院子|花盆|花瓶|窗台)的?)話(?=[^，。！？]{0,3}(哭|枯|開|謝|凋|澆|死))/g, fix: '花' },
    { bad: /(?<=([花草樹]|葉子|盆栽|植物|話)(都|快|又|已經)?)哭(?=了|掉|萎|死)/g, fix: '枯' },
    // 帶人：帶他熟悉環境、帶你去參觀
    { bad: /待(?=(他|她|你|妳|我|他們|你們|大家|新人)(熟悉|參觀|認識|逛|出去玩|去看|去玩|去吃|去逛))/g, fix: '帶' },
    // 背書：背單字、背課文
    { bad: /被(?=[^，。！？]{0,3}(單字|課文|台詞|公式|乘法|書))/g, fix: '背' },
    // 頭暈
    { bad: /(?<=頭(好|很|有點|一直|會|超)?)運/g, fix: '暈' },
    // 湯要趁熱喝（中藥的湯藥另外有線索）
    { bad: /湯藥/g, unless: /中藥|草藥|煎|藥材|中醫/, fix: '湯要' },
    // 麵：這個麵有嚼勁、麵條、麵包
    { bad: /(?<=這個|這碗|那碗|吃|煮|的)面(?=[^，。！？]{0,3}(嚼勁|Q|好吃|太軟|太硬|糊|湯))|面(?=條|線|包|粉|攤|店)/g, fix: '麵' },
    // 坐車：坐我的車、坐公車（做模型不受影響）
    { bad: /做(?=([我你他她]的)?(車|公車|捷運|火車|高鐵|飛機|計程車|船)(?!模型|的模型))/g, fix: '坐' },
    // 訂（口語的預約、訂購）：被訂走、一起訂、訂一個小的、已經訂好了；「時間定好了」前面有主詞，不受影響
    { bad: /(?<=被)定(?=走)|(?<=一起|誰要|誰想|幫我|幫你)定(?=$|[，。！？]|嗎|吧)|定(?=一?[個份盒張間桌組][大小中]?的?$)|(?<=^(已經|都|我|我們|你|有|還沒|先)?)定好(?=了|$|嗎)/g, fix: '訂' },
    // 再＋重疊動詞：我們再想想、再看看（「在想想」不是正常說法）
    { bad: /在(?=(想想|看看|試試|問問|聊聊|說說|找找|算算|查查|考慮考慮|研究研究|討論討論))/g, fix: '再' },
    // 有消息再跟你說、確定了再告訴我（「我在跟你說」前面沒有這些，不受影響）
    { bad: /(?<=(消息|結果|確定|決定|到了|回來|之後|以後|看完|弄好|好了|知道|有空|有結果)[^，。！？]{0,2})在(?=(跟|和|告訴|通知|回)(你|我|他|妳|大家))/g, fix: '再' },
    // 洗好再還你（喜好 → 洗好）
    { bad: /喜好[在再](?=[還給拿放用穿])/g, fix: '洗好再' },
    { bad: /(?<=[洗修弄寫用看吃做煮])好在(?=[還給拿放用說去來寄傳])/g, fix: '好再' },
    // 響：鬧鐘沒響、電話一直響
    { bad: /(?<=(鬧鐘|電話|手機|門鈴|鈴聲|警報|鈴|喇叭)[^，。！？]{0,4})想(?=了|起|$|[，。！？]|個不停|很久|好久)/g, fix: '響' },
    // 報：報手機號碼、報房號、報名字
    { bad: /抱(?=(手機|電話|號碼|房號|名字|身分證|生日|會員|地址|帳號|姓名|統編|學號))/g, fix: '報' },
    // 牌（品牌）：要買哪一牌的、平常那牌就好
    { bad: /(?<=(平常|常用|習慣|一樣|同一|原本|之前|你|我)[那這的]?)排(?=的|就好|比較|嗎|呢|$)|(?<=(買|用|喝|吃|要|挑|選)[^，。！？]{0,3}[哪那這]一?)排/g, fix: '牌' },
    // 紙箱要壓扁、紙箱拿去回收
    { bad: /只想(?=要?(壓扁|回收|拆開|拆掉|丟掉|收起來|拿去))/g, fix: '紙箱' },
    // 戴：戴安全帽、戴口罩、戴首飾
    { bad: /帶(?=好?(安全帽|帽子|口罩|眼鏡|隱形眼鏡|手錶|戒指|項鍊|耳環|首飾|手套|假牙|牙套)(?!去|來|回|給|出))/g, fix: '戴' },
    // 載我一程
    { bad: /(?<=送)([我你他她]|你們|我們)?一[成城]/g, fix: (m) => m.slice(0, -1) + '程' },
    { bad: /[載宰再在]([我你他她]|你們|我們)?一[^程，。！？](?=$|[，。！？]|吧|嗎|喔|好嗎)/g, fix: (m) => '載' + m.slice(1, -1) + '程' },
    // 等等在出口見：「再」和「見」要一起改（fix 可以是函式，照原長度換字）
    { bad: /(?<=^(等等|等一下|待會|晚點|明天|今天|晚上|下午|早上|我們|大家))[再在][^，。！？再在]{1,4}?[件間建鍵劍艦健漸箭賤薦踐濺鑑鑒澗](?=$|[，。！？]|囉|喔|吧)/g, fix: (m) => '在' + m.slice(1, -1) + '見' },
    // 打針：打完針手好痠
    { bad: /(?<=打完?|打了)真(?=$|[，。！？]|後|以後|之後|手)/g, fix: '針' },
    // 倒水：要倒水、幫我倒水
    { bad: /(?<=[要去幫來先我你]|記得)到(?=水(?:$|[，。！？]|了|吧|嗎|給|喝))/g, fix: '倒' },
    // 沒有線索時，第三人稱用「他」、第二人稱用「你」；有女性線索才留「她」「妳」
    { bad: /她/g, unless: /[女媽姐姊妹婆嫂姨姑娘妻奶孕裙]|太太|小姐|老婆|公主|化妝|口紅|求婚|嫁/, fix: '他' },
    { bad: /妳/g, unless: /[女媽姐姊妹婆嫂姨姑娘妻奶孕裙]|太太|小姐|老婆|公主|化妝|口紅|求婚|嫁/, fix: '你' },
  ];

  // 檢查整句：回傳 { bonus：加減分, fixes：[{ i：在 text 裡的位置, w：正確寫法 }] }
  // canWrite(nodes, i, w)：text 第 i 個字起換成 w 合不合注音；不合的規則不扣分也不補句
  function checkUsage(nodes, left, canWrite) {
    const text = nodes.map((x) => x.w).join('');
    const all = (left || '') + text;
    const off = all.length - text.length;
    const picked = new Array(all.length).fill(false);
    let pos = off;
    for (const x of nodes) { for (let k = 0; k < x.w.length; k++) picked[pos + k] = !!x.picked; pos += x.w.length; }
    let bonus = 0;
    const fixes = [];
    for (let i = off; i < all.length; i++) {
      const ch = all[i];
      if ((ch !== '再' && ch !== '在') || picked[i]) continue;
      const want = zaiWant(all, i);
      if (want && ch !== want && (!canWrite || canWrite(nodes, i - off, want))) { bonus -= Engine.USAGE_PENALTY; fixes.push({ i: i - off, w: want }); }
    }
    for (const rule of USAGE) {
      if (rule.unless && rule.unless.test(all)) continue;
      for (const m of all.matchAll(rule.bad)) {
        if (m.index < off) continue;
        let mine = false;
        for (let k = m.index; k < m.index + m[0].length; k++) mine = mine || picked[k];
        if (mine) continue;
        const w = typeof rule.fix === 'function' ? rule.fix(m[0]) : rule.fix;
        if (!w || w.length !== m[0].length) { bonus -= Engine.USAGE_PENALTY; continue; }
        // 只檢查真的有換掉的字
        let ok = true;
        for (let k = 0; k < w.length && ok; k++) if (w[k] !== m[0][k] && canWrite) ok = canWrite(nodes, m.index - off + k, w[k]);
        if (!ok) continue;
        bonus -= Engine.USAGE_PENALTY;
        fixes.push({ i: m.index - off, w });
      }
    }
    return { bonus, fixes };
  }

  // 把 fixes 套進候選句（詞的切法不變，只換字）
  function applyFixes(nodes, fixes) {
    const chars = [...nodes.map((x) => x.w).join('')];
    for (const f of fixes) [...f.w].forEach((c, k) => { chars[f.i + k] = c; });
    let at = 0;
    return nodes.map((x) => {
      const w = chars.slice(at, at + x.w.length).join('');
      at += x.w.length;
      return w === x.w ? x : Object.assign({}, x, { w });
    });
  }

  Engine.USAGE_PENALTY = 6;
  Engine.FIX_COST = 1; // 補出來的候選句：詞庫裡這樣寫的機會比較低，稍微扣一點
  // 單字的少見讀音（會 ㄎㄨㄞˋ 只在「會計」裡用）：比最常見讀音低 MINOR_GAP 以上就再扣 MINOR_SINGLE
  Engine.MINOR_GAP = 3;
  Engine.MINOR_SINGLE = 3;
  Engine.FIX_TOP = 20; // 只替前 20 名補
  Engine.SEGMENT_COST = -3;
  Engine.TONE_MISS = 5;
  Engine.CHAT_BONUS = 3;
  Engine.ABBR_SINGLE = 4; // 只打聲母的單字扣分（避免亂湊）
  Engine.COLLOQ_WEIGHT = 0.5; // 只打聲母時，口語詞頻佔的比重
  Engine.EASY_REFUND = 4; // 口語常用單字（我、要、在…）只打聲母時不扣單字分
  Engine.MEDIAL_ABBR = 2; // 沒打聲調的 ㄧㄨㄩ 當簡拼（不是完整的音）時扣分
  // 「常不常見」的權重：1＝完全照統計機率；越小越以「跟前後文搭不搭」為主
  Engine.UNIGRAM_WEIGHT = 1;

  // ───────────────────────── 組字狀態機 ─────────────────────────
  // 處理按鍵 → 更新狀態 → 回傳要送出的文字。網頁和之後的 Windows 版共用。
  class Composer {
    constructor(engine, opts) {
      this.engine = engine;
      this.opts = Object.assign({ autoCommitAt: 24, pageSize: 9 }, opts || {});
      this.mode = 'zh';
      this.lastCommittedWord = '';
      this.stats = { chars: 0, picks: 0, commits: 0, cleanCommits: 0 };
      this.reset();
    }

    reset() {
      this.syls = [];
      this.cursor = 0;
      this.pending = '';
      this.locks = [];
      this.cand = null; // { list, page, hi }
      this.symbol = null; // { cat, page }
      this.picksThisRound = 0;
      this.result = { nodes: [], text: '' };
    }

    get composing() { return this.syls.length > 0 || this.pending.length > 0; }

    recompute() {
      this.result = this.engine.convert(this.syls, { locks: this.symbolLock(this.syls, this.locks), leftWord: this.lastCommittedWord });
    }

    // 打注音本身：ㄏ空白 先顯示「ㄏ」，接著一個一個加空白（ㄠ空白、再按 3）會連成「ㄏㄠˇ」。
    // 整個組字區都是這種一個符號的音（lit）才這樣顯示；中間打了一般的字，就照平常組字
    symbolLock(syls, locks) {
      if (locks.length || !syls.length || !syls.every((x) => x.lit)) return locks;
      return syls.map((x, i) => ({ s: i, e: i + 1, w: sylText(x) }));
    }

    // 這個剛打完的音要不要當成注音符號本身：第一個必須是不能單獨成音的聲母（ㄏ空白），之後只要前面都是，一個符號的音都算
    isLiteral(body, tone, before) {
      if (!this.opts.strict || [...body].length !== 1 || !before.every((x) => x.lit)) return false;  // 不打聲調的打法要靠聲母簡拼，不適用
      return before.length > 0 || (tone === null && isInitialOnly(body));
    }

    // 畫面要顯示的內容：還在打的那個音也先當成「沒打聲調」轉成字，
    // 這樣只打聲母（ㄉㄐㄏ）時不用按 Enter 就看得到「大家好」，可以直接按 ↓ 選字。
    // 回傳 { nodes, cursor, pendingIndex }，pendingIndex 是還在打的那個音的位置（沒有就是 -1）
    view() {
      if (!this.pending) return { nodes: this.result.nodes, cursor: this.cursor, pendingIndex: -1 };
      const at = this.cursor;
      const syls = this.syls.slice();
      const body = this.orderedPending();
      syls.splice(at, 0, { body, tone: null, lit: this.isLiteral(body, null, this.syls) });
      const locks = this.locks.filter((L) => !(L.s < at && L.e > at)).map((L) => (L.s >= at ? { s: L.s + 1, e: L.e + 1, w: L.w } : L));
      const res = this.engine.convert(syls, { locks: this.symbolLock(syls, locks), leftWord: this.lastCommittedWord });
      return { nodes: res.nodes, cursor: at + 1, pendingIndex: at };
    }

    orderedPending() { return [...this.pending].sort((a, b) => slotOf(a) - slotOf(b)).join(''); }

    // 回傳 { handled, commit }
    handleKey(k) {
      const out = { handled: false, commit: '' };
      const combo = (k.shift ? 'Shift+' : '') + k.code;

      if (k.ctrl || k.alt || k.meta) {
        if (k.ctrl && k.code === 'Space') { this.toggleMode(out); out.handled = true; }
        else if (k.ctrl && !this.symbol && !this.cand && punctOf(k)) {
          // Ctrl＋標點打全形符號，英文模式也可以（英文模式沒在打字就直接送出，不開組字區）
          if (this.mode === 'en' && !this.composing) out.commit += punctOf(k);
          else this.typePunct(punctOf(k), out);
          out.handled = true;
        }
        return out;
      }

      if (this.symbol) return this.handleSymbolKey(k, out);
      if (this.cand) return this.handleCandKey(k, out);

      if (this.mode === 'en') {
        // 英文模式：沒在打字就交給程式；組字區有字就把英文接在後面，前面的中文之後還能選字
        if (!this.composing) return out;
        const ch = enCharOf(k);
        if (ch !== undefined) {
          this.insertSyllable({ body: ch, tone: '', punct: true });
          this.maybeAutoCommit(out);
          out.handled = true;
          return out;
        }
      } else {
        if (k.code === 'Backquote' && !k.shift) {
          this.symbol = { cat: 0, page: 0 };
          out.handled = true;
          return out;
        }

        const sym = !k.shift && KEYMAP[k.code];
        if (sym) {
          this.typeSymbol(sym, out);
          out.handled = true;
          return out;
        }

        if (punctOf(k)) {
          this.typePunct(punctOf(k), out);
          out.handled = true;
          return out;
        }

        if ((k.shift && /^Key[A-Z]$/.test(k.code)) || /^Numpad\d$/.test(k.code)) {
          // Shift＋字母打大寫英文、數字鍵盤打數字：組字區有字就接在後面（前面的字還能選），沒有就直接送出
          this.typePunct(enCharOf(k), out);
          out.handled = true;
          return out;
        }
      }

      switch (k.code) {
        case 'Space':
          out.handled = true;
          // 打到一半按空白是一聲；組字區有字時空白放進組字區（不送出，要送出按 Enter），沒在打字時直接打出空白
          if (this.pending) this.finishSyllable('');
          else if (this.composing) this.typePunct(' ', out);
          else out.commit += ' ';
          break;
        case 'Enter':
        case 'NumpadEnter':
          if (!this.composing) break;
          this.commitAll(out);
          out.handled = true;
          break;
        case 'Backspace':
          if (!this.composing) break;
          out.handled = true;
          if (this.pending) this.pending = this.pending.slice(0, -1);
          else if (this.cursor > 0) this.removeSyllable(this.cursor - 1);
          break;
        case 'Delete':
          if (!this.composing) break;
          out.handled = true;
          if (!this.pending && this.cursor < this.syls.length) this.removeSyllable(this.cursor);
          break;
        case 'Escape':
          if (!this.composing) break;
          out.handled = true;
          if (this.pending) this.pending = '';
          else this.reset();
          break;
        case 'ArrowLeft':
          if (!this.composing) break;
          out.handled = true;
          this.flushPending();
          this.cursor = Math.max(0, this.cursor - 1);
          break;
        case 'ArrowRight':
          if (!this.composing) break;
          out.handled = true;
          this.flushPending();
          this.cursor = Math.min(this.syls.length, this.cursor + 1);
          break;
        case 'Home':
          if (!this.composing) break;
          out.handled = true; this.flushPending(); this.cursor = 0;
          break;
        case 'End':
          if (!this.composing) break;
          out.handled = true; this.flushPending(); this.cursor = this.syls.length;
          break;
        case 'ArrowDown':
          if (!this.composing) break;
          out.handled = true;
          this.flushPending();
          this.openCandidates();
          break;
        case 'ArrowUp':
          if (this.composing) out.handled = true;
          break;
        default:
          // 其他按鍵（例如 Tab）：先把組字區送出，再交給原本的行為
          if (this.composing && !k.shift && k.code !== 'ShiftLeft' && k.code !== 'ShiftRight') {
            this.commitAll(out);
          }
      }
      return out;
    }

    // 標點：放進組字區（跟微軟注音一樣有底線，前面的字之後還能選），按 Enter 才送出
    typePunct(p, out) {
      this.flushPending();
      this.insertSyllable({ body: p, tone: '', punct: true });
      this.maybeAutoCommit(out);
    }

    typeSymbol(sym, out) {
      const slot = slotOf(sym);
      if (slot === 3) {
        if (this.pending) { this.finishSyllable(sym); return; }
        // 沒有正在打的音，就幫前一個沒聲調的音補上聲調
        const prev = this.syls[this.cursor - 1];
        if (prev && prev.punct) {
          this.commitAll(out);
          out.commit += sym;
        } else if (prev && (prev.tone === null || (prev.lit && prev.tone === ''))) {
          prev.tone = sym;
          delete prev.loose;
          this.dropLocksTouching(this.cursor - 1, this.cursor);
          this.recompute();
        } else if (prev && prev.tone === '' && this.opts.strict) {
          // 空白鍵打完的字再按聲調鍵：把這個字換成注音本身（ㄨㄛ空白 3 → ㄨㄛˇ）
          prev.tone = sym;
          delete prev.loose;
          this.dropLocksTouching(this.cursor - 1, this.cursor);
          this.locks.push({ s: this.cursor - 1, e: this.cursor, w: prev.body + sym });
          this.recompute();
        } else if (prev && this.opts.strict) {
          // 已經打好聲調的字後面再按聲調鍵：送出組字區，接著打出聲調符號（我ˇ）
          this.commitAll(out);
          out.commit += sym;
        } else if (!this.syls.length) {
          out.commit += sym;  // 沒在打字時單按聲調鍵：直接打出聲調符號（跟微軟注音一樣；數字用右邊數字鍵盤）
        }
        return;
      }
      // 微軟打法：一個音要按聲調或空白鍵才結束，打到同一個位置（聲母、介音、韻母）的符號就換掉原本的，
      // 所以 ㄊㄨㄢ 再按 ㄍ 會變 ㄍㄨㄢ，先打 ㄜ 再打 ㄇ 也會排成 ㄇㄜ
      // 換上去之後湊不出國語的音（ㄈㄦ）就不收這個符號，回報 beep 讓外殼發出提示音
      if (this.opts.strict) {
        const next = [...this.pending].filter((c) => slotOf(c) !== slot).join('') + sym;
        if (!this.engine.dict.canFormSyllable(next)) { out.beep = true; return; }
        this.pending = next;
        this.maybeAutoCommit(out);
        return;
      }
      // 新的符號放不進目前的音（例如連打兩個聲母），就把目前的音當成沒聲調送進組字區
      // 放得進、但拼起來不是國語會有的音（ㄗ＋ㄧ、ㄅ＋ㄩ），也一樣：前一個當簡拼，新的符號開始下一個字
      const filled = [...this.pending].map(slotOf);
      const joined = [...this.pending + sym].sort((a, b) => slotOf(a) - slotOf(b)).join('');
      if (filled.some((s) => s >= slot) || (this.pending && !this.engine.dict.isSyllablePrefix(joined))) this.finishSyllable(null);
      this.pending += sym;
      this.maybeAutoCommit(out);
    }

    finishSyllable(tone) {
      if (!this.pending) return;
      const body = this.orderedPending();
      // 只打聲母再按空白鍵：ㄓ、ㄗ 這類本身就是一個音的照一聲處理（知、資），
      // ㄉ、ㄐ、ㄏ 這類不能單獨成音的就當成聲母縮寫，結束這個音但保留組字區讓你選字
      // （詞庫把注音符號本身也收成字，例如「ㄏ」，所以要排除掉）
      if (tone === '' && isInitialOnly(body) && !(this.engine.dict.byReading.get(body) || []).some((e) => e.w !== body)) tone = null;
      // 空白鍵的一聲是「優先一聲」，其他聲調也可能（例如 ㄩ空白 也能配到「魚」）
      const syl = tone === '' ? { body, tone, loose: true } : { body, tone };
      if (this.isLiteral(body, tone, this.syls)) syl.lit = true;
      this.insertSyllable(syl);
      this.pending = '';
    }

    flushPending() { if (this.pending) this.finishSyllable(null); }

    insertSyllable(syl) {
      const at = this.cursor;
      this.locks = this.locks.filter((L) => !(L.s < at && L.e > at)).map((L) => (L.s >= at ? { s: L.s + 1, e: L.e + 1, w: L.w } : L));
      this.syls.splice(at, 0, syl);
      this.cursor = at + 1;
      this.recompute();
    }

    removeSyllable(idx) {
      this.locks = this.locks.filter((L) => !(L.s <= idx && L.e > idx)).map((L) => (L.s > idx ? { s: L.s - 1, e: L.e - 1, w: L.w } : L));
      this.syls.splice(idx, 1);
      if (this.cursor > idx) this.cursor--;
      this.recompute();
    }

    dropLocksTouching(s, e) { this.locks = this.locks.filter((L) => !(L.s < e && L.e > s)); }

    maybeAutoCommit(out) {
      // 組字區太長就把最前面的詞先送出，跟一般輸入法一樣
      while (this.syls.length >= this.opts.autoCommitAt && this.result.nodes.length > 1) {
        const first = this.result.nodes[0];
        this.engine.user.learn([first], this.lastCommittedWord);
        this.countStats(first.e - first.s, first.picked ? 1 : 0, false);
        out.commit += first.w;
        this.lastCommittedWord = first.w;
        const len = first.e - first.s;
        this.syls.splice(0, len);
        this.cursor = Math.max(0, this.cursor - len);
        this.locks = this.locks.filter((L) => L.s >= len).map((L) => ({ s: L.s - len, e: L.e - len, w: L.w }));
        this.recompute();
      }
    }

    commitAll(out) {
      this.flushPending();
      if (!this.syls.length) { this.reset(); return; }
      const res = this.result;
      // 注音符號本身（ㄏ、ㄏㄠˇ）不當成用字習慣學起來
      const learnable = res.nodes.filter((nd) => !/[ㄅ-ㄩˊˇˋ˙]/.test(nd.w) && !this.syls[nd.s].punct);
      if (learnable.length) this.engine.user.learn(learnable, this.lastCommittedWord);
      this.countStats(this.syls.length, this.picksThisRound, true);
      this.lastSubmission = { reading: formatReading(this.syls), text: res.text, picks: this.picksThisRound };
      out.commit += res.text;
      const last = res.nodes[res.nodes.length - 1];
      this.lastCommittedWord = last ? last.w : '';
      this.reset();
    }

    countStats(chars, picks, isRound) {
      this.stats.chars += chars;
      if (isRound) {
        this.stats.commits++;
        if (!picks) this.stats.cleanCommits++;
      }
    }

    // 切換中英不送出組字區，英文接在後面，最後按 Enter 一起送出。
    // 打到一半還沒打聲調的注音丟掉：通常是想打英文卻打成注音（打 apple 變成ㄇㄣ），切英文時順便清掉
    toggleMode(out) {
      this.pending = '';
      this.cand = null;
      this.symbol = null;
      this.mode = this.mode === 'zh' ? 'en' : 'zh';
    }

    // ── 選字窗 ──
    openCandidates() {
      if (!this.syls.length) return;
      const list = this.engine.candidatesAt(this.syls, this.cursor);
      if (!list.length) return;
      // 目前結果用的那個詞排第一個高亮，方便看出現在選的是什麼
      const cur = this.result.nodes.find((n) => list.some((c) => c.s === n.s && c.e === n.e));
      const hi = cur ? Math.max(0, list.findIndex((c) => c.s === cur.s && c.e === cur.e && c.w === cur.w)) : 0;
      this.cand = { list, page: Math.floor(hi / this.opts.pageSize), hi };
    }

    candPage() {
      const ps = this.opts.pageSize;
      const { list, page } = this.cand;
      return list.slice(page * ps, page * ps + ps);
    }

    selectCandidate(c) {
      this.locks = this.locks.filter((L) => !(L.s < c.e && L.e > c.s));
      this.locks.push({ s: c.s, e: c.e, w: c.w });
      this.picksThisRound++;
      this.stats.picks++;
      this.cand = null;
      if (this.cursor < this.syls.length) this.cursor = c.e;
      this.recompute();
    }

    handleCandKey(k, out) {
      out.handled = true;
      const ps = this.opts.pageSize;
      const c = this.cand;
      const pages = Math.ceil(c.list.length / ps);
      const digit = /^(Digit|Numpad)([1-9])$/.exec(k.code);
      if (digit && !k.shift) {
        const item = this.candPage()[Number(digit[2]) - 1];
        if (item) this.selectCandidate(item);
        return out;
      }
      switch (k.code) {
        case 'Escape': this.cand = null; break;
        case 'Enter': case 'NumpadEnter': this.selectCandidate(c.list[c.hi]); break;
        case 'ArrowDown': c.hi = Math.min(c.list.length - 1, c.hi + 1); c.page = Math.floor(c.hi / ps); break;
        case 'ArrowUp': c.hi = Math.max(0, c.hi - 1); c.page = Math.floor(c.hi / ps); break;
        case 'Space': case 'PageDown': case 'ArrowRight':
          c.page = (c.page + 1) % pages; c.hi = c.page * ps; break;
        case 'PageUp': case 'ArrowLeft':
          c.page = (c.page - 1 + pages) % pages; c.hi = c.page * ps; break;
        default: {
          // 直接繼續打注音：關掉選字窗並把這個鍵當成新的輸入
          this.cand = null;
          return this.handleKey(k);
        }
      }
      return out;
    }

    // ── 符號面板 ──
    symbolPage() {
      const s = this.symbol;
      const items = SYMBOLS[s.cat].items;
      return items.slice(s.page * this.opts.pageSize, s.page * this.opts.pageSize + this.opts.pageSize);
    }

    // 符號面板選的符號跟標點一樣：組字區有字就放進組字區，沒有就直接送出
    pickSymbol(ch, out) {
      this.symbol = null;
      this.typePunct(ch, out);
    }

    handleSymbolKey(k, out) {
      out.handled = true;
      const s = this.symbol;
      const ps = this.opts.pageSize;
      const pages = Math.ceil(SYMBOLS[s.cat].items.length / ps);
      const digit = /^(Digit|Numpad)([1-9])$/.exec(k.code);
      if (digit) {
        const ch = this.symbolPage()[Number(digit[2]) - 1];
        if (ch) this.pickSymbol(ch, out);
        return out;
      }
      switch (k.code) {
        case 'Escape': case 'Backquote': this.symbol = null; break;
        case 'Tab': case 'ArrowDown': s.cat = (s.cat + (k.shift ? SYMBOLS.length - 1 : 1)) % SYMBOLS.length; s.page = 0; break;
        case 'ArrowUp': s.cat = (s.cat + SYMBOLS.length - 1) % SYMBOLS.length; s.page = 0; break;
        case 'Space': case 'ArrowRight': case 'PageDown': s.page = (s.page + 1) % pages; break;
        case 'ArrowLeft': case 'PageUp': s.page = (s.page - 1 + pages) % pages; break;
        default: break;
      }
      return out;
    }
  }

  // 有沒有只打聲母（簡拼）的音節
  const hasAbbr = (syls) => syls.some((s) => s.tone === null && isAbbr(s.body));
  const api = { Dictionary, UserModel, LanguageModel, Engine, Composer, KEYMAP, PUNCT, punctOf, SYMBOLS, parseReading, formatReading, slotOf, hasAbbr };
  root.ShunDa = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
