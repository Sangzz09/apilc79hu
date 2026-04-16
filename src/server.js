const https = require("https");
const http  = require("http");

const SOURCE_URL  = "https://wtx.tele68.com/v1/tx/lite-sessions?cp=R&cl=R&pf=web&at=405f18b5220fdd5674e8bb74bd0d5d14";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 500;

let history = []; // newest → oldest

// ══════════════════════════════════════════════════════════════
//  FETCH
// ══════════════════════════════════════════════════════════════
function fetchSource() {
  return new Promise((resolve, reject) => {
    const u = new URL(SOURCE_URL);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try   { resolve({ ok: true,  body: JSON.parse(raw) }); }
        catch { resolve({ ok: false, raw: raw.slice(0, 1200) }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(14000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ══════════════════════════════════════════════════════════════
//  PARSE — thử nhiều cấu trúc phổ biến
// ══════════════════════════════════════════════════════════════
function parseSession(s) {
  if (!s || typeof s !== "object") return null;

  const phien = String(s.id ?? s._id ?? s.phien ?? s.sessionId ?? s.session_id ?? "?");

  // Dice: thử nhiều field
  let dice = null;
  const diceFields = ["dices","dice","xucXac","xuc_xac","cubes","cube","results"];
  for (const f of diceFields) {
    if (Array.isArray(s[f]) && s[f].length >= 3) {
      const d = s[f].slice(0, 3).map(Number);
      if (d.every(x => x >= 1 && x <= 6)) { dice = d; break; }
    }
  }
  // Nếu có d1,d2,d3 riêng
  if (!dice && s.d1 && s.d2 && s.d3) {
    const d = [Number(s.d1), Number(s.d2), Number(s.d3)];
    if (d.every(x => x >= 1 && x <= 6)) dice = d;
  }
  if (!dice) return null;

  const tong = typeof s.point === "number" ? s.point
             : typeof s.total === "number" ? s.total
             : typeof s.sum   === "number" ? s.sum
             : dice.reduce((a,b) => a+b, 0);

  // Kết quả
  let type = null;
  const r = (s.resultTruyenThong ?? s.result ?? s.ketQua ?? s.ket_qua ?? s.type ?? "").toString().toUpperCase();
  if (r.includes("TAI") || r.includes("TÀI") || r === "T" || r === "BIG" || r === "1")
    type = "T";
  else if (r.includes("XIU") || r.includes("XỈU") || r.includes("XIU") || r === "X" || r === "SMALL" || r === "0")
    type = "X";
  else
    type = tong >= 11 ? "T" : "X";

  return { phien, dice, tong, type };
}

function ingest(list) {
  const existing = new Set(history.map(h => h.phien));
  const parsed   = list.map(parseSession).filter(Boolean);
  for (const item of parsed) {
    if (!existing.has(item.phien)) {
      history.push(item);
      existing.add(item.phien);
    }
  }
  history.sort((a,b) => Number(b.phien) - Number(a.phien));
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
}

// ══════════════════════════════════════════════════════════════
//  SELF-CALIBRATING WEIGHT
// ══════════════════════════════════════════════════════════════
const ALGOS = [
  "pattern","markov3","markov2","markov1",
  "freq","luong","dice","streak5","entropy",
  "chuky","zigzag","autocorr","momentum",
  "bayesian","ngram4","reversal","chiSq",
  "trendFollow","diceVar","streakLen"
];

const acc = {};
for (const n of ALGOS) acc[n] = { c: 20, t: 40 };

function updateAcc(name, pred, actual) {
  if (!acc[name]) return;
  acc[name].t++;
  if (pred === actual) acc[name].c++;
  if (acc[name].t > 80) {
    acc[name].c *= 80 / acc[name].t;
    acc[name].t  = 80;
  }
}

function weight(name) {
  const a = acc[name];
  if (!a || a.t < 8) return 1.0;
  const r = a.c / a.t;
  return Math.max(0, (r - 0.38) / 0.12);
}

let lastPreds = {};

function recordActual(actual) {
  for (const [name, pred] of Object.entries(lastPreds)) updateAcc(name, pred, actual);
  lastPreds = {};
}

// ══════════════════════════════════════════════════════════════
//  PATTERN DETECTION  (mở rộng nhiều loại cầu)
// ══════════════════════════════════════════════════════════════
function detectPattern(seq) {
  if (seq.length < 4) return null;
  const s = seq.join("");

  // ── Bệt ──────────────────────────────────────────────────
  const bm = s.match(/^(T{3,}|X{3,})/);
  if (bm) {
    const len  = bm[0].length;
    const same = bm[0][0];
    const next = len >= 7 ? (same==="T"?"X":"T") : same;
    const conf = len >= 7 ? 0.70 : Math.min(0.54 + len*0.03, 0.80);
    return { name: `Bệt ${same === "T" ? "Tài" : "Xỉu"} (${len})`, next, conf };
  }

  // ── Cầu 1-1 (xen kẽ) ─────────────────────────────────────
  let alt = 0;
  for (let i = 0; i < Math.min(seq.length, 12); i++) {
    if (i === 0 || seq[i] !== seq[i-1]) alt++;
    else break;
  }
  if (alt >= 6) return { name:"Cầu 1-1 (dài)", next: seq[0]==="T"?"X":"T", conf: 0.73 };
  if (alt >= 4) return { name:"Cầu 1-1",        next: seq[0]==="T"?"X":"T", conf: 0.64 };

  // ── Cầu 2-2 ──────────────────────────────────────────────
  if (s.length >= 8) {
    // TTXXTTXX... → tiếp tục khối hiện tại
    if (s[0]===s[1] && s[2]===s[3] && s[0]!==s[2] && s[4]===s[5] && s[0]===s[4]) {
      return { name:"Cầu 2-2", next: s[0], conf: 0.68 };
    }
    // Đang ở vị trí thứ 2 của khối
    if (s[0]!==s[1] && s[1]===s[2] && s[3]===s[4] && s[1]!==s[3]) {
      return { name:"Cầu 2-2 (giữa)", next: s[0]==="T"?"X":"T", conf: 0.63 };
    }
  }

  // ── Cầu 3-3 ──────────────────────────────────────────────
  if (s.length >= 6 && s[0]===s[1] && s[1]===s[2] && s[3]===s[4] && s[4]===s[5] && s[0]!==s[3]) {
    return { name:"Cầu 3-3", next: s[0], conf: 0.65 };
  }

  // ── Cầu 4-4 ──────────────────────────────────────────────
  if (s.length >= 8 && s.slice(0,4).split("").every(c=>c===s[0]) &&
      s.slice(4,8).split("").every(c=>c===s[4]) && s[0]!==s[4]) {
    return { name:"Cầu 4-4", next: s[0], conf: 0.66 };
  }

  // ── Cầu 1-2 (TXXTTXX) ────────────────────────────────────
  if (s.length >= 6 && s[0]!==s[1] && s[1]===s[2] && s[3]!==s[4] && s[4]===s[5]) {
    return { name:"Cầu 1-2", next: s[0], conf: 0.61 };
  }

  // ── Cầu 2-1 (TTXTTX) ─────────────────────────────────────
  if (s.length >= 6 && s[0]===s[1] && s[2]!==s[1] && s[3]===s[4] && s[5]!==s[4] && s[0]===s[3]) {
    return { name:"Cầu 2-1", next: s[0], conf: 0.62 };
  }

  // ── Cầu 3-1 (TTTXTTTX) ───────────────────────────────────
  if (s.length >= 8 && s[0]===s[1] && s[1]===s[2] && s[3]!==s[2] &&
      s[4]===s[5] && s[5]===s[6] && s[7]!==s[6] && s[0]===s[4]) {
    return { name:"Cầu 3-1", next: s[0], conf: 0.63 };
  }

  // ── Cầu 1-3 (TXXX) ───────────────────────────────────────
  if (s.length >= 8 && s[0]!==s[1] && s[1]===s[2] && s[2]===s[3] &&
      s[4]!==s[5] && s[5]===s[6] && s[6]===s[7] && s[0]===s[4]) {
    return { name:"Cầu 1-3", next: s[0], conf: 0.62 };
  }

  // ── Cầu gương (TXXXT) ─────────────────────────────────────
  if (s.length >= 5 && s[0]===s[4] && s[1]===s[3] && s[1]!==s[0]) {
    return { name:"Cầu Gương", next: s[1]==="T"?"X":"T", conf: 0.60 };
  }

  // ── Cầu lặp chu kỳ 3 ─────────────────────────────────────
  if (s.length >= 9) {
    const c = s.slice(0,3);
    if (s.slice(3,6)===c && s.slice(6,9)===c) {
      return { name:"Chu Kỳ 3", next: c[0], conf: 0.69 };
    }
  }

  // ── Cầu lặp chu kỳ 4 ─────────────────────────────────────
  if (s.length >= 12) {
    const c = s.slice(0,4);
    if (s.slice(4,8)===c && s.slice(8,12)===c) {
      return { name:"Chu Kỳ 4", next: c[0], conf: 0.71 };
    }
  }

  // ── Cầu lặp chu kỳ 2 ─────────────────────────────────────
  if (s.length >= 6) {
    const c = s.slice(0,2);
    if (s.slice(2,4)===c && s.slice(4,6)===c) {
      return { name:"Chu Kỳ 2", next: c[0], conf: 0.67 };
    }
  }

  // ── Cầu đảo chiều sau bệt 2 ──────────────────────────────
  if (s.length >= 5 && s[0]===s[1] && s[2]===s[3] && s[0]!==s[2]) {
    // Đang ở đầu khối mới (1 cái đầu), kỳ vọng tiếp tục
    return { name:"Cầu 2-2 (mới)", next: s[0], conf: 0.59 };
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
//  ALGORITHMS
// ══════════════════════════════════════════════════════════════

// Markov bậc 3
function algoMarkov3(seq) {
  if (seq.length < 20) return null;
  const t = {};
  for (let i = 0; i < seq.length - 3; i++) {
    const state = seq[i+3] + seq[i+2] + seq[i+1];
    if (!t[state]) t[state] = {T:0,X:0};
    t[state][seq[i]]++;
  }
  if (seq.length < 3) return null;
  const state = seq[2] + seq[1] + seq[0];
  const row = t[state];
  if (!row) return null;
  const tot = row.T + row.X;
  if (tot < 5) return null;
  if (row.T > row.X) return { next:"T", conf: 0.50 + (row.T/tot-0.50)*0.68 };
  if (row.X > row.T) return { next:"X", conf: 0.50 + (row.X/tot-0.50)*0.68 };
  return null;
}

// Markov bậc 2
function algoMarkov2(seq) {
  if (seq.length < 15) return null;
  const t = {};
  for (let i = 0; i < seq.length - 2; i++) {
    const state = seq[i+2] + seq[i+1];
    if (!t[state]) t[state] = {T:0,X:0};
    t[state][seq[i]]++;
  }
  const state = seq[1] + seq[0];
  const row = t[state];
  if (!row) return null;
  const tot = row.T + row.X;
  if (tot < 6) return null;
  if (row.T > row.X) return { next:"T", conf: 0.50 + (row.T/tot-0.50)*0.70 };
  if (row.X > row.T) return { next:"X", conf: 0.50 + (row.X/tot-0.50)*0.70 };
  return null;
}

// Markov bậc 1
function algoMarkov1(seq) {
  if (seq.length < 10) return null;
  const t = { T:{T:0,X:0}, X:{T:0,X:0} };
  for (let i = 0; i < seq.length - 1; i++) {
    t[seq[i+1]][seq[i]]++;
  }
  const row = t[seq[0]];
  const tot = row.T + row.X;
  if (tot < 6) return null;
  if (row.T > row.X) return { next:"T", conf: 0.50 + (row.T/tot-0.50)*0.65 };
  if (row.X > row.T) return { next:"X", conf: 0.50 + (row.X/tot-0.50)*0.65 };
  return null;
}

// Tần suất hồi quy (ngắn + dài)
function algoFreq(seq) {
  const n20  = Math.min(seq.length, 20);
  const n50  = Math.min(seq.length, 50);
  const rT20 = seq.slice(0,n20).filter(x=>x==="T").length / n20;
  const rT50 = seq.slice(0,n50).filter(x=>x==="T").length / n50;
  // Phối hợp ngắn hạn + dài hạn
  const rT   = rT20 * 0.6 + rT50 * 0.4;
  const rX   = 1 - rT;
  if (rT > 0.60) return { next:"X", conf: 0.50 + (rT-0.50)*0.60 };
  if (rX > 0.60) return { next:"T", conf: 0.50 + (rX-0.50)*0.60 };
  return null;
}

// Sóng / luồng 8 phiên
function algoLuong(seq) {
  if (seq.length < 8) return null;
  const w = seq.slice(0, 8);
  let tr = 0;
  for (let i = 1; i < w.length; i++) if (w[i]!==w[i-1]) tr++;
  if (tr <= 1) return { next: w[0],               conf: 0.64 };
  if (tr >= 7) return { next: w[0]==="T"?"X":"T", conf: 0.64 };
  return null;
}

// Dice sum bias
function algoDice(hist) {
  if (hist.length < 15) return null;
  const sub = hist.slice(0, 20);
  const avg = sub.reduce((a,b)=>a+b.tong,0) / sub.length;
  const vari = sub.reduce((s,b)=>s+(b.tong-avg)**2,0) / sub.length;
  if (avg < 9.5)  return { next:"X", conf: 0.57 + Math.min((9.5-avg)*0.02,0.08) };
  if (avg > 11.5) return { next:"T", conf: 0.57 + Math.min((avg-11.5)*0.02,0.08) };
  // Variance thấp → kém phân tán → mean reversion
  if (vari < 2.0 && avg >= 9.5 && avg <= 11.5) return null;
  return null;
}

// Streak-5 → kỳ vọng gãy
function algoStreak5(seq) {
  if (seq.length < 5) return null;
  const f = seq[0];
  if (seq.slice(0,5).every(x=>x===f)) return { next: f==="T"?"X":"T", conf: 0.67 };
  return null;
}

// Entropy
function algoEntropy(seq) {
  const n   = Math.min(seq.length, 20);
  const sub = seq.slice(0, n);
  let tr = 0;
  for (let i = 1; i < sub.length; i++) if (sub[i]!==sub[i-1]) tr++;
  const e = tr / (n-1);
  if (e > 0.38 && e < 0.62) return null;
  if (e <= 0.38) return { next: sub[0], conf: 0.61 };
  if (e >= 0.62) return { next: sub[0]==="T"?"X":"T", conf: 0.59 };
  return null;
}

// Chu kỳ: tìm chu kỳ lặp 2-6
function algoChuKy(seq) {
  if (seq.length < 12) return null;
  for (let p = 2; p <= 6; p++) {
    let match = 0, total = 0;
    for (let i = 0; i < Math.min(seq.length - p, 20); i++) {
      if (seq[i+p] !== undefined) {
        total++;
        if (seq[i] === seq[i+p]) match++;
      }
    }
    if (total >= 6 && match/total >= 0.75) {
      const pred = seq[p-1] ?? seq[0]; // kỳ vọng lặp lại
      return { next: pred, conf: 0.56 + (match/total - 0.75)*0.5 };
    }
  }
  return null;
}

// ZigZag: đếm số gãy gần đây để đoán trend
function algoZigZag(seq) {
  if (seq.length < 10) return null;
  const w = seq.slice(0, 10);
  // Đếm chuỗi tăng/giảm liên tiếp xen kẽ
  let zz = 0;
  for (let i = 1; i < w.length-1; i++) {
    if (w[i]!==w[i-1] && w[i]!==w[i+1] && w[i-1]===w[i+1]) zz++;
  }
  if (zz >= 3) return { next: seq[0]==="T"?"X":"T", conf: 0.59 };
  return null;
}

// Autocorrelation lag-1, lag-2
function algoAutoCorr(seq) {
  if (seq.length < 20) return null;
  const n = Math.min(seq.length, 40);
  const v = seq.slice(0,n).map(x => x==="T" ? 1 : 0);
  const mean = v.reduce((a,b)=>a+b,0)/n;
  let ac1 = 0, ac2 = 0, denom = 0;
  for (let i = 0; i < n; i++) denom += (v[i]-mean)**2;
  for (let i = 1; i < n; i++) ac1 += (v[i]-mean)*(v[i-1]-mean);
  for (let i = 2; i < n; i++) ac2 += (v[i]-mean)*(v[i-2]-mean);
  ac1 /= denom; ac2 /= denom;

  if (ac1 > 0.15) return { next: seq[0], conf: 0.54 + Math.min(ac1*0.4, 0.10) };
  if (ac1 < -0.15) return { next: seq[0]==="T"?"X":"T", conf: 0.54 + Math.min(-ac1*0.4, 0.10) };
  if (ac2 > 0.15) return { next: seq[1] ?? seq[0], conf: 0.53 };
  return null;
}

// Momentum: xu hướng ngắn vs dài hạn
function algoMomentum(seq) {
  if (seq.length < 30) return null;
  const short = seq.slice(0,5).filter(x=>x==="T").length / 5;
  const long  = seq.slice(0,20).filter(x=>x==="T").length / 20;
  const diff  = short - long;
  if (diff > 0.25)  return { next:"T", conf: 0.55 + Math.min(diff*0.3, 0.08) };
  if (diff < -0.25) return { next:"X", conf: 0.55 + Math.min(-diff*0.3, 0.08) };
  return null;
}

// Bayesian update: prior 50/50, update với window gần nhất
function algoBayesian(seq) {
  if (seq.length < 15) return null;
  const windows = [3, 5, 8, 13];
  let logOdds = 0; // log odds of T
  for (const w of windows) {
    const sub = seq.slice(0, Math.min(w, seq.length));
    const pT  = (sub.filter(x=>x==="T").length + 1) / (sub.length + 2);
    logOdds  += Math.log(pT / (1-pT)) * (1/windows.length);
  }
  const pT = 1 / (1 + Math.exp(-logOdds));
  if (pT > 0.58) return { next:"T", conf: 0.50 + (pT-0.50)*0.8 };
  if (pT < 0.42) return { next:"X", conf: 0.50 + (0.50-pT)*0.8 };
  return null;
}

// N-gram bậc 4
function algoNgram4(seq) {
  if (seq.length < 25) return null;
  const t = {};
  for (let i = 0; i < seq.length - 4; i++) {
    const k = seq[i+4]+seq[i+3]+seq[i+2]+seq[i+1];
    if (!t[k]) t[k] = {T:0,X:0};
    t[k][seq[i]]++;
  }
  if (seq.length < 4) return null;
  const k = seq[3]+seq[2]+seq[1]+seq[0];
  const row = t[k];
  if (!row) return null;
  const tot = row.T + row.X;
  if (tot < 4) return null;
  if (row.T > row.X) return { next:"T", conf: 0.50 + (row.T/tot-0.50)*0.72 };
  if (row.X > row.T) return { next:"X", conf: 0.50 + (row.X/tot-0.50)*0.72 };
  return null;
}

// Reversal: đếm số lần đảo chiều sau chuỗi dài
function algoReversal(seq) {
  if (seq.length < 20) return null;
  // Tìm streak hiện tại
  let sLen = 1;
  while (sLen < seq.length && seq[sLen] === seq[0]) sLen++;
  if (sLen < 2) return null;
  // Xem lịch sử: sau streak cùng độ dài, bao nhiêu lần gãy?
  let reversals = 0, samples = 0;
  for (let i = sLen; i < seq.length - sLen; i++) {
    if (seq.slice(i, i+sLen).every(x => x===seq[i])) {
      samples++;
      if (seq[i-1] !== seq[i]) reversals++;
      i += sLen - 1;
    }
  }
  if (samples < 3) return null;
  const pr = reversals / samples;
  if (pr > 0.65) return { next: seq[0]==="T"?"X":"T", conf: 0.52 + pr*0.10 };
  if (pr < 0.35) return { next: seq[0], conf: 0.52 + (1-pr)*0.10 };
  return null;
}

// Chi-Square: so sánh phân phối TT,TX,XT,XX
function algoChiSq(seq) {
  if (seq.length < 30) return null;
  const obs = {TT:0,TX:0,XT:0,XX:0};
  for (let i = 0; i < seq.length-1; i++) {
    const k = seq[i+1]+seq[i];
    if (obs[k] !== undefined) obs[k]++;
  }
  const n = obs.TT+obs.TX+obs.XT+obs.XX;
  const exp = n/4;
  const chi2 = Object.values(obs).reduce((s,o)=>s+(o-exp)**2/exp, 0);
  if (chi2 < 3.84) return null; // p>0.05 → ngẫu nhiên
  // Tìm transition xác suất cao nhất
  const pTgivenT = (obs.TT)/(obs.TT+obs.TX+0.001);
  const pXgivenX = (obs.XX)/(obs.XX+obs.XT+0.001);
  if (seq[0]==="T" && pTgivenT > 0.60) return { next:"T", conf: 0.52+pTgivenT*0.10 };
  if (seq[0]==="T" && pTgivenT < 0.40) return { next:"X", conf: 0.52+(1-pTgivenT)*0.10 };
  if (seq[0]==="X" && pXgivenX > 0.60) return { next:"X", conf: 0.52+pXgivenX*0.10 };
  if (seq[0]==="X" && pXgivenX < 0.40) return { next:"T", conf: 0.52+(1-pXgivenX)*0.10 };
  return null;
}

// Trend Following: EMA kiểu ngắn
function algoTrendFollow(seq) {
  if (seq.length < 12) return null;
  const v   = seq.slice(0, 20).map(x => x==="T" ? 1 : 0);
  const ema = (arr, alpha) => arr.reduce((e,x,i) => i===0 ? x : alpha*x+(1-alpha)*e, arr[0]);
  const e5  = ema(v.slice(0,5),  0.4);
  const e12 = ema(v.slice(0,12), 0.2);
  if (e5 > e12 + 0.08) return { next:"T", conf: 0.55 };
  if (e5 < e12 - 0.08) return { next:"X", conf: 0.55 };
  return null;
}

// Dice Variance: variance cao → phân tán, khó đoán; thấp → xu hướng rõ
function algoDiceVar(hist) {
  if (hist.length < 15) return null;
  const sub  = hist.slice(0, 15);
  const avg  = sub.reduce((a,b)=>a+b.tong,0)/sub.length;
  const vari = sub.reduce((s,b)=>s+(b.tong-avg)**2,0)/sub.length;
  const seq  = hist.map(h=>h.type);
  if (vari < 1.8) {
    // tổng ổn định → xu hướng T hay X rõ ràng hơn
    if (avg >= 11) return { next:"T", conf: 0.58 };
    if (avg <= 10) return { next:"X", conf: 0.58 };
  }
  if (vari > 4.5) {
    // tổng biến động mạnh → đảo chiều
    return { next: seq[0]==="T"?"X":"T", conf: 0.54 };
  }
  return null;
}

// Streak Length History: thống kê độ dài bệt trung bình
function algoStreakLen(seq) {
  if (seq.length < 20) return null;
  // Tách thành các streak
  const streaks = [];
  let cur = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i]===seq[i-1]) cur++;
    else { streaks.push(cur); cur = 1; }
  }
  streaks.push(cur);
  if (streaks.length < 4) return null;
  const avgLen = streaks.reduce((a,b)=>a+b,0) / streaks.length;
  // Đo streak hiện tại
  let curLen = 1;
  while (curLen < seq.length && seq[curLen]===seq[0]) curLen++;
  if (curLen >= Math.ceil(avgLen * 1.5)) {
    return { next: seq[0]==="T"?"X":"T", conf: 0.57 };
  }
  if (curLen < avgLen * 0.6 && curLen === 1) {
    return { next: seq[0], conf: 0.54 };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  ENSEMBLE
// ══════════════════════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 5) return {
    next:"?", conf:0, cauType:"Chưa đủ dữ liệu", pattern:"",
    votes:[], algoDetail:{}
  };

  const seq   = hist.map(h => h.type);
  const wSum  = { T:0, X:0 };
  const detail = {};
  const votes  = [];

  const add = (name, res, base) => {
    if (!res) { detail[name] = null; return; }
    lastPreds[name] = res.next;
    const w = base * weight(name);
    wSum[res.next] += res.conf * w;
    detail[name] = { next: res.next, conf: Math.round(res.conf*100), w: Math.round(w*100)/100 };
    votes.push({ algo: name, pred: res.next, conf: res.conf, w });
  };

  const pat = detectPattern(seq);
  add("pattern",    pat,                      5.0);
  add("markov3",    algoMarkov3(seq),          3.5);
  add("markov2",    algoMarkov2(seq),          3.0);
  add("markov1",    algoMarkov1(seq),          2.5);
  add("ngram4",     algoNgram4(seq),           2.5);
  add("bayesian",   algoBayesian(seq),         2.0);
  add("streak5",    algoStreak5(seq),          2.0);
  add("autocorr",   algoAutoCorr(seq),         1.8);
  add("chiSq",      algoChiSq(seq),            1.8);
  add("luong",      algoLuong(seq),            1.5);
  add("momentum",   algoMomentum(seq),         1.5);
  add("freq",       algoFreq(seq),             1.5);
  add("trendFollow",algoTrendFollow(seq),      1.2);
  add("chuky",      algoChuKy(seq),            1.2);
  add("entropy",    algoEntropy(seq),          1.0);
  add("reversal",   algoReversal(seq),         1.0);
  add("zigzag",     algoZigZag(seq),           0.8);
  add("dice",       algoDice(hist),            1.0);
  add("diceVar",    algoDiceVar(hist),         0.8);
  add("streakLen",  algoStreakLen(seq),        1.0);

  const tot = wSum.T + wSum.X;
  let next = "T", conf = 0.50;
  if (tot > 0) {
    if (wSum.X > wSum.T) { next = "X"; conf = wSum.X / tot; }
    else                  { next = "T"; conf = wSum.T / tot; }
  }
  conf = Math.min(Math.max(conf, 0.50), 0.90);

  const votesT = votes.filter(v=>v.pred==="T").length;
  const votesX = votes.filter(v=>v.pred==="X").length;

  const patStr  = seq.slice(0,16).join("");
  const cauType = pat ? pat.name
    : wSum.T > wSum.X ? "Nghiêng Tài"
    : wSum.X > wSum.T ? "Nghiêng Xỉu"
    : "Cân Bằng";

  return {
    next:    next==="T"?"Tài":"Xỉu",
    raw:     next,
    conf:    Math.round(conf*100),
    cauType,
    pattern: patStr,
    votesT,
    votesX,
    detail
  };
}

// ══════════════════════════════════════════════════════════════
//  MULTI-STEP PREDICTION (dự đoán 3 phiên tới)
// ══════════════════════════════════════════════════════════════
function predictMulti(hist, steps = 3) {
  const preds = [];
  let simHist = [...hist];
  for (let i = 0; i < steps; i++) {
    const p = predict(simHist);
    preds.push(p);
    // Tạo phiên giả với kết quả dự đoán để dự đoán tiếp theo
    const fake = {
      phien: String(Number(simHist[0].phien) + i + 1),
      dice:  [3,4,4],
      tong:  11,
      type:  p.raw
    };
    simHist = [fake, ...simHist];
  }
  return preds;
}

// ══════════════════════════════════════════════════════════════
//  SYNC
// ══════════════════════════════════════════════════════════════
let prevTop = null;

async function syncHistory() {
  try {
    const res = await fetchSource();
    if (!res.ok || !res.body) return;
    const body = res.body;

    const list = body.list ?? body.data?.list ?? body.data
              ?? body.sessions ?? body.items ?? [];
    if (!Array.isArray(list) || !list.length) return;

    const before = history[0]?.phien;
    ingest(list);
    const after = history[0]?.phien;

    if (before && after !== before && prevTop === before && history.length >= 2) {
      recordActual(history[1].type);
    }
    prevTop = after;
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // ── /predict  ─────────────────────────────────────────────
  if (url.pathname === "/predict" || url.pathname === "/") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ error:"Chưa có dữ liệu" }));
      return;
    }
    const h    = history[0];
    const pred = predict(history);
    const next3 = predictMulti(history, 3);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: h.phien,
      xuc_xac:        h.dice,
      tong:           h.tong,
      ket_qua_hien:   h.type === "T" ? "Tài" : "Xỉu",
      phien_tiep_theo: String(Number(h.phien) + 1),
      du_doan:        pred.next,
      do_tin_cay:     pred.conf + "%",
      loai_cau:       pred.cauType,
      pattern_14:     pred.pattern,
      phieu_T:        pred.votesT,
      phieu_X:        pred.votesX,
      du_doan_3_phien: next3.map((p,i) => ({
        phien: String(Number(h.phien) + 1 + i),
        du_doan: p.next,
        do_tin_cay: p.conf + "%"
      }))
    }));
    return;
  }

  // ── /predict/detail  ──────────────────────────────────────
  if (url.pathname === "/predict/detail") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ error:"Chưa có dữ liệu" }));
      return;
    }
    const pred = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan:    pred.next,
      do_tin_cay: pred.conf + "%",
      loai_cau:   pred.cauType,
      phieu_T:    pred.votesT,
      phieu_X:    pred.votesX,
      chi_tiet_algo: pred.detail
    }));
    return;
  }

  // ── /history  ─────────────────────────────────────────────
  if (url.pathname === "/history") {
    await syncHistory();
    const lim = Math.min(parseInt(url.searchParams.get("limit")||"20"),200);
    res.writeHead(200);
    res.end(JSON.stringify({
      total: history.length,
      data:  history.slice(0,lim).map(h=>({
        phien:   h.phien,
        xuc_xac: h.dice,
        tong:    h.tong,
        ket_qua: h.type==="T"?"Tài":"Xỉu",
      }))
    }));
    return;
  }

  // ── /stats  ───────────────────────────────────────────────
  if (url.pathname === "/stats") {
    const out = {};
    for (const n of ALGOS) {
      const a = acc[n];
      out[n] = {
        do_chinh_xac: a.t ? Math.round(a.c/a.t*100)+"%" : "N/A",
        trong_so:     Math.round(weight(n)*100)/100,
        mau:          Math.round(a.t),
      };
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      algo_stats:    out,
      history_count: history.length,
      source_url:    SOURCE_URL
    }));
    return;
  }

  // ── /pattern  ─────────────────────────────────────────────
  if (url.pathname === "/pattern") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ error:"Chưa có dữ liệu" }));
      return;
    }
    const seq = history.map(h=>h.type);
    const pat = detectPattern(seq);
    const last20 = seq.slice(0,20).join("");
    // Phân tích thêm
    const streaks = [];
    let cur = { v: seq[0], len: 1 };
    for (let i = 1; i < Math.min(seq.length,30); i++) {
      if (seq[i] === cur.v) cur.len++;
      else { streaks.push({...cur}); cur = { v: seq[i], len: 1 }; }
    }
    streaks.push(cur);
    res.writeHead(200);
    res.end(JSON.stringify({
      pattern_20: last20,
      cau_hien_tai: pat ? pat.name : "Không rõ cầu",
      do_tin_cay_cau: pat ? Math.round(pat.conf*100)+"%" : "N/A",
      chuoi_gan: streaks.slice(0,8).map(s=>({
        ket_qua: s.v==="T"?"Tài":"Xỉu",
        so_phien: s.len
      }))
    }));
    return;
  }

  // ── /debug  ───────────────────────────────────────────────
  if (url.pathname === "/debug") {
    const r = await fetchSource().catch(e=>({ error:e.message }));
    res.writeHead(200);
    res.end(JSON.stringify(r, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error:"Not found", endpoints:["/predict","/predict/detail","/history","/pattern","/stats","/debug"] }));

}).listen(PORT, () => {
  console.log("✅ Sic-bo Predictor running on port " + PORT);
  console.log("   Source: " + SOURCE_URL);
  syncHistory();
  setInterval(syncHistory, 12000);
});
