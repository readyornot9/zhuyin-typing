// 背景執行緒：載入神經網路模型、幫候選句打分，打字時不會卡住畫面
importScripts('nn.js');
let lm = null, rev = null;
// 模型是純資料檔，副檔名用 .wasm 只是因為發布的網站只接受這類檔案
const load = (name) => fetch(name).then((r) => { if (!r.ok) throw new Error('下載模型失敗：' + r.status); return r.arrayBuffer(); });
// 反方向模型（從右往左讀）是選配的：下載失敗就只用正向
Promise.all([load('nnlm.wasm'), load('nnlm-rev.wasm').catch(() => null)])
  .then(([a, b]) => { lm = new self.NeuralLM(a); rev = b ? new self.NeuralLM(b) : null; postMessage({ ready: true, both: !!rev }); })
  .catch((e) => postMessage({ error: String(e) }));
onmessage = (e) => {
  const { id, texts, choices } = e.data;
  const t = performance.now();
  const scores = self.NeuralLM.both(lm, rev, texts);
  let gen = choices ? lm.generate(choices) : []; // 簡拼時讓 AI 自己寫句子
  if (rev && gen.length) {
    const s = self.NeuralLM.both(lm, rev, gen.map((g) => g.text));
    gen = gen.map((g, i) => ({ text: g.text, lp: s[i] }));
  }
  postMessage({ id, scores, gen, ms: performance.now() - t });
};
