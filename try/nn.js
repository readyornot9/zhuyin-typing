// 順打注音 — 神經網路語言模型（判斷一句話通不通順），瀏覽器內建功能推論，不需要額外函式庫
// 最花時間的矩陣乘法用 WebAssembly SIMD（一次算 4 個數），不支援的環境自動改用純 JavaScript
// 模型：字元層級 Transformer（tools/nn/model.py），權重來自 nnlm.wasm（8 位元壓縮，tools/nn/export.py 產生）
// 用法：const lm = new NeuralLM(nnlm.wasm 的內容（ArrayBuffer／Uint8Array）); lm.score(['他現在不在公司', ...]) → 每句的 log 機率
(function (root) {
  'use strict';

  // 解析 nnlm.wasm：'SDNN' + 表頭長度 + 表頭 JSON + 權重資料
  function parseBinary(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'SDNN') throw new Error('不是順打注音的模型檔');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
    meta.data = bytes.subarray(8 + len);
    return meta;
  }

  // target：二維權重要放的位置（WebAssembly 記憶體裡的一段），沒給就另外配置
  function loadTensor(data, t, target) {
    // 複製一份，確保 Float32Array 對齊
    const part = ([at, n]) => Uint8Array.prototype.slice.call(data, at, at + n).buffer; // Node 的 Buffer.slice 不會複製
    if (t.f) return new Float32Array(part(t.f));
    const q = new Int8Array(part(t.q));
    const scale = new Float32Array(part(t.scale));
    const [rows, cols] = t.shape;
    const w = target || new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const s = scale[r];
      for (let c = 0; c < cols; c++) w[r * cols + c] = q[r * cols + c] * s;
    }
    return w;
  }

  // WebAssembly 矩陣乘法核心（手寫位元組碼，約 300 位元組）：
  // mm(W, X, out, rows, cols, B)：out[i*rows+r] = Σc W[r*cols+c]·X[i*cols+c]，三個參數都是記憶體位址，cols 須為 4 的倍數
  function uleb(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
  function makeKernel(pages) {
    const g = (i) => [0x20, i], s = (i) => [0x21, i]; // local.get／local.set
    const addr = (base, idx) => [...g(base), ...g(idx), ...g(4), 0x6c, 0x41, 2, 0x74, 0x6a]; // base + idx*cols*4
    const body = [2, 5, 0x7f, 1, 0x7b, // 區域變數：r i c wrow xp（i32）、acc（v128）
      0x41, 0, ...s(6), 0x02, 0x40, 0x03, 0x40, // for r
      ...g(6), ...g(3), 0x4f, 0x0d, 1, ...addr(0, 6), ...s(9),
      0x41, 0, ...s(7), 0x02, 0x40, 0x03, 0x40, // for i
      ...g(7), ...g(5), 0x4f, 0x0d, 1, ...addr(1, 7), ...s(10),
      0xfd, 0x0c, ...new Array(16).fill(0), ...s(11), 0x41, 0, ...s(8),
      0x03, 0x40, // for c（位元組位移，每次 16）：acc += W[..]×X[..]
      ...g(11), ...g(9), ...g(8), 0x6a, 0xfd, 0, 2, 0, ...g(10), ...g(8), 0x6a, 0xfd, 0, 2, 0, 0xfd, 0xe6, 1, 0xfd, 0xe4, 1, ...s(11),
      ...g(8), 0x41, 0x10, 0x6a, 0x22, 8, ...g(4), 0x41, 2, 0x74, 0x49, 0x0d, 0, 0x0b,
      ...g(2), ...g(7), ...g(3), 0x6c, ...g(6), 0x6a, 0x41, 2, 0x74, 0x6a, // &out[i*rows+r] = 四格相加
      ...g(11), 0xfd, 0x1f, 0, ...g(11), 0xfd, 0x1f, 1, 0x92, ...g(11), 0xfd, 0x1f, 2, 0x92, ...g(11), 0xfd, 0x1f, 3, 0x92, 0x38, 2, 0,
      ...g(7), 0x41, 1, 0x6a, ...s(7), 0x0c, 0, 0x0b, 0x0b,
      ...g(6), 0x41, 1, 0x6a, ...s(6), 0x0c, 0, 0x0b, 0x0b, 0x0b];
    const sec = (id, b) => [id, ...uleb(b.length), ...b];
    const bytes = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
      ...sec(1, [1, 0x60, 6, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0]), // (i32×6) → ()
      ...sec(2, [1, 1, 0x65, 1, 0x6d, 2, 0, ...uleb(pages)]), // 匯入記憶體 e.m
      ...sec(3, [1, 0]), ...sec(7, [1, 2, 0x6d, 0x6d, 0, 0]), // 匯出 mm
      ...sec(10, [1, ...uleb(body.length), ...body])];
    const mem = new WebAssembly.Memory({ initial: pages });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), { e: { m: mem } });
    return { mem, mm: inst.exports.mm };
  }

  // 純 JavaScript 版（沒有 WebAssembly SIMD 時用）：out[i,r] = W[r,:]·X[i,:]，W 為 rows×cols、X 為 B×cols
  // W 的同一列連續拿來乘 B 個向量，留在快取裡重複用，比一句一句算快很多
  function matmulJS(W, X, B, rows, cols, out) {
    for (let r = 0; r < rows; r++) {
      const o = r * cols;
      for (let i = 0; i < B; i++) {
        const xo = i * cols;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        let c = 0;
        for (; c + 3 < cols; c += 4) {
          s0 += W[o + c] * X[xo + c];
          s1 += W[o + c + 1] * X[xo + c + 1];
          s2 += W[o + c + 2] * X[xo + c + 2];
          s3 += W[o + c + 3] * X[xo + c + 3];
        }
        for (; c < cols; c++) s0 += W[o + c] * X[xo + c];
        out[i * rows + r] = s0 + s1 + s2 + s3;
      }
    }
    return out;
  }

  function layerNorm(x, g, b, out) {
    const n = x.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = x[i] - mean; v += d * d; }
    const inv = 1 / Math.sqrt(v / n + 1e-5);
    for (let i = 0; i < n; i++) out[i] = (x[i] - mean) * inv * g[i] + b[i];
    return out;
  }

  // 精確 GELU（跟 PyTorch 預設相同），erf 用高精度近似
  function erf(x) {
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function gelu(x) { return 0.5 * x * (1 + erf(x / Math.SQRT2)); }

  class NeuralLM {
    constructor(binary) {
      const data = parseBinary(binary);
      const cfg = data.config;
      this.d = cfg.d; this.L = cfg.layers; this.H = cfg.heads; this.ff = cfg.ff; this.ctx = cfg.ctx;
      this.hd = this.d / this.H;
      this.vocab = new Map();
      [...data.vocab].forEach((ch, i) => this.vocab.set(ch, i + 2)); // 0＝句首/句尾、1＝罕用字
      this.V = data.vocab.length + 2;
      // 二維權重全部放進 WebAssembly 記憶體（後面接一塊暫存區），矩陣乘法直接用位址
      const shapes = Object.values(data.tensors).filter((t) => t.shape.length === 2);
      const wsize = shapes.reduce((a, t) => a + t.shape[0] * t.shape[1], 0);
      const CHUNK = NeuralLM.CHUNK, maxCols = Math.max(...shapes.map((t) => t.shape[1]));
      const total = wsize + CHUNK * maxCols + CHUNK * this.V;
      this.k = null;
      try {
        this.k = makeKernel(Math.ceil(total * 4 / 65536));
      } catch (e) { /* 不支援 WebAssembly SIMD */ }
      let at = 0;
      const alloc = (n) => {
        if (!this.k) return new Float32Array(n);
        const v = new Float32Array(this.k.mem.buffer, at * 4, n);
        at += n;
        return v;
      };
      const T = (n) => {
        const t = data.tensors[n];
        return loadTensor(data.data, t, t.shape.length === 2 ? alloc(t.shape[0] * t.shape[1]) : null);
      };
      this.emb = T('emb.weight');
      this.pos = T('pos.weight');
      this.layers = [];
      for (let i = 0; i < this.L; i++) {
        const p = `blocks.layers.${i}.`;
        this.layers.push({
          ln1g: T(p + 'norm1.weight'), ln1b: T(p + 'norm1.bias'),
          inW: T(p + 'self_attn.in_proj_weight'), inB: T(p + 'self_attn.in_proj_bias'),
          outW: T(p + 'self_attn.out_proj.weight'), outB: T(p + 'self_attn.out_proj.bias'),
          ln2g: T(p + 'norm2.weight'), ln2b: T(p + 'norm2.bias'),
          w1: T(p + 'linear1.weight'), b1: T(p + 'linear1.bias'),
          w2: T(p + 'linear2.weight'), b2: T(p + 'linear2.bias'),
        });
      }
      this.lnfG = T('norm.weight');
      this.lnfB = T('norm.bias');
      this.Xs = alloc(CHUNK * maxCols);
      this.Os = alloc(CHUNK * this.V);
    }

    // out[i,r] = W[r,:]·X[i,:] + b[r]（B 筆一起算，超過 CHUNK 筆就分段）
    matmul(W, b, X, B, rows, cols, out) {
      if (this.k) {
        const C = NeuralLM.CHUNK;
        for (let i0 = 0; i0 < B; i0 += C) {
          const n = Math.min(C, B - i0);
          this.Xs.set(X.subarray(i0 * cols, (i0 + n) * cols));
          this.k.mm(W.byteOffset, this.Xs.byteOffset, this.Os.byteOffset, rows, cols, n);
          out.set(this.Os.subarray(0, n * rows), i0 * rows);
        }
      } else {
        matmulJS(W, X, B, rows, cols, out);
      }
      if (b) for (let i = 0; i < B; i++) for (let r = 0; r < rows; r++) out[i * rows + r] += b[r];
      return out;
    }

    ids(text) { return [...text].map((ch) => this.vocab.get(ch) || 1); }

    // 一批前綴各往後算一個字：prevs[i] 是前一個狀態（各層的 K、V，句首為 null），toks[i] 是這個位置的字
    // 回傳新狀態，含這個位置的「下一個字」log 機率表（logits − lse）
    stepBatch(prevs, toks) {
      const { d, H, hd, ff, V } = this;
      const B = toks.length;
      const X = new Float32Array(B * d), Hn = new Float32Array(B * d), QKV = new Float32Array(B * 3 * d);
      const ATT = new Float32Array(B * d), O = new Float32Array(B * d), F = new Float32Array(B * ff);
      const row = (A, i, n) => A.subarray(i * n, (i + 1) * n);
      const lens = prevs.map((p) => (p ? p.len : 0));
      for (let i = 0; i < B; i++) {
        const t = lens[i], tok = toks[i];
        for (let j = 0; j < d; j++) X[i * d + j] = this.emb[tok * d + j] + this.pos[t * d + j];
      }
      const ks = prevs.map(() => []), vs = prevs.map(() => []);
      const scale = 1 / Math.sqrt(hd);
      for (let l = 0; l < this.L; l++) {
        const P = this.layers[l];
        for (let i = 0; i < B; i++) layerNorm(row(X, i, d), P.ln1g, P.ln1b, row(Hn, i, d));
        this.matmul(P.inW, P.inB, Hn, B, 3 * d, d, QKV);
        for (let i = 0; i < B; i++) {
          const qkv = row(QKV, i, 3 * d);
          const K = prevs[i] ? prevs[i].ks[l].concat([qkv.slice(d, 2 * d)]) : [qkv.slice(d, 2 * d)];
          const Vv = prevs[i] ? prevs[i].vs[l].concat([qkv.slice(2 * d)]) : [qkv.slice(2 * d)];
          ks[i].push(K); vs[i].push(Vv);
          const sc = new Float32Array(K.length);
          for (let h = 0; h < H; h++) {
            const off = h * hd;
            let mx = -Infinity;
            for (let j = 0; j < K.length; j++) {
              let s = 0;
              const k = K[j];
              for (let c = 0; c < hd; c++) s += qkv[off + c] * k[off + c];
              sc[j] = s * scale;
              if (sc[j] > mx) mx = sc[j];
            }
            let sum = 0;
            for (let j = 0; j < K.length; j++) { sc[j] = Math.exp(sc[j] - mx); sum += sc[j]; }
            for (let c = 0; c < hd; c++) {
              let a = 0;
              for (let j = 0; j < K.length; j++) a += sc[j] * Vv[j][off + c];
              ATT[i * d + off + c] = a / sum;
            }
          }
        }
        this.matmul(P.outW, P.outB, ATT, B, d, d, O);
        for (let j = 0; j < B * d; j++) X[j] += O[j];
        for (let i = 0; i < B; i++) layerNorm(row(X, i, d), P.ln2g, P.ln2b, row(Hn, i, d));
        this.matmul(P.w1, P.b1, Hn, B, ff, d, F);
        for (let j = 0; j < B * ff; j++) F[j] = gelu(F[j]);
        this.matmul(P.w2, P.b2, F, B, d, ff, O);
        for (let j = 0; j < B * d; j++) X[j] += O[j];
      }
      for (let i = 0; i < B; i++) layerNorm(row(X, i, d), this.lnfG, this.lnfB, row(Hn, i, d));
      const logits = this.matmul(this.emb, null, Hn, B, V, d, new Float32Array(B * V));
      return prevs.map((p, i) => {
        const lg = row(logits, i, V);
        let mx = -Infinity;
        for (let j = 0; j < V; j++) if (lg[j] > mx) mx = lg[j];
        let sum = 0;
        for (let j = 0; j < V; j++) sum += Math.exp(lg[j] - mx);
        return { len: lens[i] + 1, ks: ks[i], vs: vs[i], logits: lg, lse: mx + Math.log(sum) };
      });
    }

    // 自己一個字一個字寫出句子（跟大型語言模型產生文字的方式一樣），但每個位置只能用 choices[t] 裡的字
    // （符合那個注音或簡拼字母的字）。保留最好的 width 條，回傳 [{ text, lp }]，lp 跟 score() 算法相同
    generate(choices, width, top) {
      width = width || NeuralLM.GEN_WIDTH;
      top = top || NeuralLM.GEN_TOP;
      const n = choices.length;
      if (!n || n > this.ctx - 2) return [];
      const opts = choices.map((list) => list.map((ch) => [ch, this.vocab.get(ch)]).filter(([, id]) => id !== undefined));
      if (opts.some((o) => !o.length)) return [];
      let beams = [{ text: '', lp: 0, st: this.stepBatch([null], [0])[0] }];
      for (let t = 0; t < n; t++) {
        const cand = [];
        for (const b of beams) {
          const { logits, lse } = b.st;
          // 每條只留前幾名，避免簡拼時幾百個字全部展開
          const mine = opts[t].map(([ch, id]) => ({ b, ch, id, lp: b.lp + logits[id] - lse }))
            .sort((x, y) => y.lp - x.lp).slice(0, width);
          cand.push(...mine);
        }
        cand.sort((x, y) => y.lp - x.lp);
        const next = cand.slice(0, width);
        const states = this.stepBatch(next.map((c) => c.b.st), next.map((c) => c.id));
        beams = next.map((c, i) => ({ text: c.b.text + c.ch, lp: c.lp, st: states[i] }));
      }
      return beams.map((b) => ({ text: b.text, lp: b.lp + b.st.logits[0] - b.st.lse }))
        .sort((x, y) => y.lp - x.lp).slice(0, top);
    }

    // 回傳每句的 log 機率（含句尾）。所有句子的開頭整理成一棵樹：相同開頭只算一次，
    // 同樣長度的前綴一起成批計算
    score(texts) {
      const seqs = texts.map((t) => [...t].slice(0, this.ctx - 2));
      const states = new Map();
      const maxLen = Math.max(...seqs.map((c) => c.length));
      for (let n = 0; n <= maxLen; n++) {
        const todo = new Map();
        for (const c of seqs) {
          if (c.length < n) continue;
          const key = c.slice(0, n).join('');
          if (!todo.has(key) && !states.has(key)) todo.set(key, c);
        }
        if (!todo.size) continue;
        const keys = [...todo.keys()];
        const prevs = keys.map((k) => (n ? states.get(todo.get(k).slice(0, n - 1).join('')) : null));
        const toks = keys.map((k) => (n ? (this.vocab.get(todo.get(k)[n - 1]) || 1) : 0));
        this.stepBatch(prevs, toks).forEach((st, i) => states.set(keys[i], st));
      }
      return seqs.map((chars) => {
        let lp = 0;
        for (let i = 0; i <= chars.length; i++) {
          const st = states.get(chars.slice(0, i).join(''));
          const next = i < chars.length ? (this.vocab.get(chars[i]) || 1) : 0;
          lp += st.logits[next] - st.lse;
        }
        return lp;
      });
    }
  }

  // 複審規則（網頁和評估工具共用）：統計分數＋權重 × 神經網路分數，挑最高的
  // 太短的句子（少於 MIN_CHARS 個字）前後文不夠，神經網路容易誤判（ㄓㄉ：知道 → 直到），不複審
  NeuralLM.CHUNK = 32;
  // 前 12 名交給神經網路（中型模型 2026-10 評估：前 5 名權重 0.5 → 186/199；前 12 名權重 1（搜尋寬度 128、每格 16）→ 188/199、測試題 36 → 39）
  NeuralLM.WEIGHT = 1;
  NeuralLM.TOP = 12;
  NeuralLM.BEAM = 128;
  NeuralLM.PER_STATE = 16;
  NeuralLM.MIN_CHARS = 3;
  NeuralLM.shouldRerank = (nbest) => nbest && nbest.length > 1 && [...nbest[0].text].length >= NeuralLM.MIN_CHARS;
  // AI 自己寫的句子：替每句算統計分數（engine.convert 的 only），加進候選名單一起比
  // 統計上完全拼不出來的句子（沒有對應的詞）就不收
  NeuralLM.GEN_WIDTH = 32;
  NeuralLM.GEN_TOP = 8;
  NeuralLM.merge = (engine, syls, convOpts, nbest, scores, gen) => {
    const list = nbest.slice(), sc = scores.slice();
    const seen = new Set(list.map((c) => c.text));
    for (const g of gen) {
      if (seen.has(g.text)) continue;
      const r = engine.convert(syls, Object.assign({}, convOpts, { only: g.text, nbest: 0, beam: 8, perState: 4 }));
      if (r.text !== g.text) continue;
      seen.add(g.text);
      list.push({ text: r.text, score: r.score, nodes: r.nodes, generated: true });
      sc.push(g.lp);
    }
    return { list, scores: sc };
  };
  // 正反兩個方向的 AI 一起打分：rev 是從右往左讀的模型（沒有就只用正向）。
  // 兩邊各自算整句機率，照 REV_MIX 的比例平均
  NeuralLM.REV_MIX = 0.5;
  NeuralLM.both = (fwd, rev, texts) => {
    const f = fwd.score(texts);
    if (!rev || !texts.length) return f;
    const b = rev.score(texts.map((t) => [...t].reverse().join('')));
    const m = NeuralLM.REV_MIX;
    return f.map((x, i) => (1 - m) * x + m * b[i]);
  };
  NeuralLM.pick = (nbest, scores, weight) => {
    const w = weight == null ? NeuralLM.WEIGHT : weight;
    let best = 0;
    nbest.forEach((c, i) => { if (c.score + w * scores[i] > nbest[best].score + w * scores[best]) best = i; });
    return nbest[best];
  };

  root.NeuralLM = NeuralLM;
  if (typeof module !== 'undefined' && module.exports) module.exports = NeuralLM;
})(typeof globalThis !== 'undefined' ? globalThis : this);
