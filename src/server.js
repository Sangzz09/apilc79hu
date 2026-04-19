/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║      SIC-BO EXPERT PREDICTOR  v4.0  —  Phân Tích Cầu Chuyên Gia   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * TRIẾT LÝ:
 *  - Nhận diện CẦU bằng phân tích khối (block analysis) — cách chuyên gia thực sự dùng
 *  - Xác nhận cầu bằng thống kê Markov, Bayesian, AutoCorr
 *  - Phân tích XÚC XẮC thực tế: tổng, phân phối, hot/cold
 *  - Ensemble có trọng số thích nghi (tự học từ kết quả thực)
 *  - Độ tin cậy thực tế: 50%–80% (không thổi phồng)
 *  - Chỉ dự đoán 1 phiên kế tiếp
 */

"use strict";
const https = require("https");
const http  = require("http");

const SOURCE_URL  = "https://wtx.tele68.com/v1/tx/lite-sessions?cp=R&cl=R&pf=web&at=405f18b5220fdd5674e8bb74bd0d5d14";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 600;

let history = []; // newest → oldest: { phien, dice:[d1,d2,d3], tong, type:"T"|"X" }

// ══════════════════════════════════════════════════════════════════════
//  FETCH & PARSE
// ══════════════════════════════════════════════════════════════════════

function fetchSource() {
  return new Promise((resolve, reject) => {
    const u   = new URL(SOURCE_URL);
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

function parseSession(s) {
  if (!s || typeof s !== "object") return null;
  const phien = String(s.id ?? s._id ?? s.phien ?? s.sessionId ?? s.session_id ?? "?");

  let dice = null;
  for (const f of ["dices","dice","xucXac","xuc_xac","cubes","cube","results"]) {
    if (Array.isArray(s[f]) && s[f].length >= 3) {
      const d = s[f].slice(0,3).map(Number);
      if (d.every(x => x >= 1 && x <= 6)) { dice = d; break; }
    }
  }
  if (!dice && s.d1 && s.d2 && s.d3) {
    const d = [Number(s.d1), Number(s.d2), Number(s.d3)];
    if (d.every(x => x >= 1 && x <= 6)) dice = d;
  }
  if (!dice) return null;

  const tong = typeof s.point === "number" ? s.point
             : typeof s.total === "number" ? s.total
             : typeof s.sum   === "number" ? s.sum
             : dice.reduce((a,b) => a+b, 0);

  const r = (s.resultTruyenThong ?? s.result ?? s.ketQua ?? s.ket_qua ?? s.type ?? "").toString().toUpperCase();
  let type = null;
  if (r.includes("TAI") || r.includes("TÀI") || r === "T" || r === "BIG"  || r === "1") type = "T";
  else if (r.includes("XIU") || r.includes("XỈU") || r === "X" || r === "SMALL" || r === "0") type = "X";
  else type = tong >= 11 ? "T" : "X";

  return { phien, dice, tong, type };
}

function ingest(list) {
  const existing = new Set(history.map(h => h.phien));
  for (const item of list.map(parseSession).filter(Boolean)) {
    if (!existing.has(item.phien)) { history.push(item); existing.add(item.phien); }
  }
  history.sort((a,b) => Number(b.phien) - Number(a.phien));
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
}

// ══════════════════════════════════════════════════════════════════════
//  SELF-CALIBRATING WEIGHTS — tự học độ chính xác từng thuật toán
// ══════════════════════════════════════════════════════════════════════

const ALGO_NAMES = [
  "cauBlock",       // nhận diện cầu theo khối (block analysis)
  "markov4",        // Markov bậc 4
  "markov3",        // Markov bậc 3
  "markov2",        // Markov bậc 2
  "markov1",        // Markov bậc 1
  "bayesian",       // Bayesian multi-window
  "freq3window",    // tần suất 3 cửa sổ
  "chiSq",          // Chi-Square transition
  "autoCorr",       // auto-correlation
  "streakBreak",    // phân tích độ dài bệt → gãy hay tiếp
  "diceSum",        // phân tích tổng xúc xắc
  "diceHot",        // hot number xúc xắc
  "diceBalance",    // cân bằng lệch
  "momentum",       // momentum ngắn/dài
  "entropy",        // entropy chuỗi
  "cycleDetect",    // phát hiện chu kỳ tự động
  "transMatrix",    // ma trận chuyển đổi 4 trạng thái
  "wavePhase",      // phân tích pha sóng
  "runLength",      // phân phối độ dài run
  "reversion",      // mean reversion xác suất
];

// Khởi tạo acc với prior trung lập (50% accuracy)
const acc = {};
for (const n of ALGO_NAMES) acc[n] = { c: 15, t: 30 }; // 50% prior

function updateAcc(name, pred, actual) {
  if (!acc[name]) return;
  acc[name].t++;
  if (pred === actual) acc[name].c++;
  // Sliding window: giảm dần weight của dữ liệu cũ
  if (acc[name].t > 100) {
    acc[name].c = acc[name].c * 0.95 + (pred === actual ? 0.05 : 0);
    acc[name].t = 100;
  }
}

// Trọng số thích nghi: chỉ dương nếu accuracy > 50%, tuyến tính
function adaptiveWeight(name) {
  const a = acc[name];
  if (!a || a.t < 10) return 1.0; // chưa đủ dữ liệu → trọng số trung bình
  const r = a.c / a.t;
  // Tuyến tính: 0% tại 45%, 100% tại 55%, 200% tại 65%
  return Math.max(0.0, (r - 0.45) / 0.10);
}

let lastPreds = {};

function recordActual(actual) {
  for (const [name, pred] of Object.entries(lastPreds)) {
    updateAcc(name, pred, actual);
  }
  lastPreds = {};
}

// ══════════════════════════════════════════════════════════════════════
//  BLOCK ANALYSIS — nền tảng của phân tích cầu chuyên gia
//  Chuyển chuỗi T/X thành các "khối" liên tiếp
// ══════════════════════════════════════════════════════════════════════

/**
 * Tạo mảng khối từ chuỗi seq (newest → oldest)
 * Kết quả: [{v:"T"|"X", len:number}, ...]  newest block first
 */
function buildBlocks(seq, maxItems = 50) {
  if (!seq.length) return [];
  const blocks = [];
  let val = seq[0], len = 1;
  for (let i = 1; i < Math.min(seq.length, maxItems); i++) {
    if (seq[i] === val) len++;
    else { blocks.push({ v: val, len }); val = seq[i]; len = 1; }
  }
  blocks.push({ v: val, len });
  return blocks;
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 1 — NHẬN DIỆN CẦU THEO KHỐI (BLOCK CAU ANALYSIS)
//  Đây là cách chuyên gia thực sự đọc bảng cầu
// ══════════════════════════════════════════════════════════════════════

function algoCauBlock(seq) {
  if (seq.length < 6) return null;
  const blocks = buildBlocks(seq, 60);
  if (blocks.length < 2) return null;

  const b  = blocks; // b[0] = khối mới nhất
  const B0 = b[0], B1 = b[1], B2 = b[2] ?? null, B3 = b[3] ?? null;

  // ─────────────────────────────────────────────────────────
  // 1. CẦU 1-1 — xen kẽ mỗi phiên (ưu tiên kiểm tra trước)
  // ─────────────────────────────────────────────────────────
  {
    let alt1Count = 0;
    for (let i = 0; i < Math.min(b.length, 12); i++) {
      if (b[i].len === 1) alt1Count++;
      else break;
    }
    if (alt1Count >= 6) {
      return { name: `Cầu 1-1 (${alt1Count} khối)`, next: B0.v==="T"?"X":"T", conf: Math.min(0.55 + alt1Count*0.025, 0.80) };
    }
    if (alt1Count >= 4) {
      return { name: `Cầu 1-1 (${alt1Count} khối)`, next: B0.v==="T"?"X":"T", conf: 0.62 };
    }
    if (alt1Count >= 3) {
      return { name: `Cầu 1-1 (${alt1Count} khối)`, next: B0.v==="T"?"X":"T", conf: 0.57 };
    }
  }

  // ─────────────────────────────────────────────────────────
  // 2. CẦU L-L — khối đều nhau (tên theo độ dài khối)
  //    Duyệt từ nhiều chu kỳ nhất → ít nhất để ưu tiên pattern rõ hơn
  // ─────────────────────────────────────────────────────────
  for (const cycles of [4, 3, 2]) {
    const needed = cycles * 2;
    if (b.length < needed) continue;
    const lens   = b.slice(0, needed).map(x => x.len);
    const refLen = lens[0];
    const isUniform = lens.every(l => Math.abs(l - refLen) <= 1) && refLen >= 2;
    if (!isUniform) continue;

    const L         = refLen;
    const remaining = L - B0.len;
    if (remaining > 0) {
      return {
        name: `Cầu ${L}-${L} (${cycles} chu kỳ) — Còn ${remaining} phiên`,
        next: B0.v,
        conf: Math.min(0.54 + cycles * 0.03, 0.76)
      };
    } else {
      return {
        name: `Cầu ${L}-${L} (${cycles} chu kỳ) — Đổi chiều`,
        next: B0.v === "T" ? "X" : "T",
        conf: Math.min(0.56 + cycles * 0.03, 0.78)
      };
    }
  }

  // ─────────────────────────────────────────────────────────
  // 3. CẦU BỆT — block dài liên tục (sau khi loại trừ N-N)
  // ─────────────────────────────────────────────────────────
  if (B0.len >= 3) {
    // Thống kê lịch sử: bệt cùng loại thường dài bao nhiêu?
    const sameStreaks = b.slice(1).filter(blk => blk.v === B0.v && blk.len >= 2).map(blk => blk.len);
    const avgBreakLen = sameStreaks.length >= 2
      ? sameStreaks.reduce((s,x)=>s+x,0) / sameStreaks.length
      : 5;

    if (B0.len >= Math.ceil(avgBreakLen * 1.2)) {
      return {
        name: `Bệt ${B0.v==="T"?"Tài":"Xỉu"} ${B0.len} — Sắp Gãy (tb=${avgBreakLen.toFixed(1)})`,
        next: B0.v === "T" ? "X" : "T",
        conf: Math.min(0.54 + (B0.len - avgBreakLen) * 0.025, 0.78),
        mu: `avg=${avgBreakLen.toFixed(1)}`
      };
    }
    return {
      name: `Bệt ${B0.v==="T"?"Tài":"Xỉu"} ${B0.len} — Tiếp (tb=${avgBreakLen.toFixed(1)})`,
      next: B0.v,
      conf: Math.min(0.52 + B0.len * 0.03, 0.72),
      mu: `avg=${avgBreakLen.toFixed(1)}`
    };
  }

  // ─────────────────────────────────────────────────────────
  // 4. CẦU N-M — khối xen kẽ không đều (nhưng có chu kỳ)
  // ─────────────────────────────────────────────────────────
  if (b.length >= 6) {
    // Tách nhịp: [len_T, len_X, len_T, len_X, ...]
    // Lấy 6 khối gần nhất, nhóm theo loại xen kẽ
    const even = [b[0].len, b[2]?.len, b[4]?.len].filter(Boolean); // cùng loại với B0
    const odd  = [b[1].len, b[3]?.len, b[5]?.len].filter(Boolean); // loại kia

    const avgEven = even.reduce((s,x)=>s+x,0)/even.length;
    const avgOdd  = odd.reduce((s,x)=>s+x,0)/odd.length;

    // Cầu N-M rõ ràng
    const roundE = Math.round(avgEven), roundO = Math.round(avgOdd);
    if (roundE !== roundO && roundE >= 1 && roundO >= 1) {
      const remaining = roundE - B0.len;
      if (remaining > 0) {
        return {
          name: `Cầu ${roundE}-${roundO} — Khối hiện tại còn ${remaining}`,
          next: B0.v,
          conf: 0.60
        };
      } else {
        return {
          name: `Cầu ${roundE}-${roundO} — Đổi sang ${B0.v==="T"?"Xỉu":"Tài"}`,
          next: B0.v === "T" ? "X" : "T",
          conf: 0.62
        };
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // 5. CẦU CHU KỲ — phát hiện chuỗi lặp ở cấp ký tự
  // ─────────────────────────────────────────────────────────
  {
    const s = seq.join("");
    for (const p of [2, 3, 4, 5, 6]) {
      if (s.length < p * 3) continue;
      const unit = s.slice(0, p);
      let match = 0;
      for (let k = 1; k < 3; k++) {
        const chunk = s.slice(k * p, (k+1) * p);
        let m = 0;
        for (let i = 0; i < p; i++) if (chunk[i] === unit[i]) m++;
        if (m / p >= 0.75) match++;
      }
      if (match >= 2) {
        const pos = (b[0].len - 1 + (b.length > 1 ? (p - (b.slice(0,p).reduce((s,x)=>s+x.len,0) % p) + p) % p : 0)) % p;
        const next = unit[pos % p] ?? B0.v;
        return {
          name: `Chu Kỳ ${p} (${unit})`,
          next,
          conf: 0.62
        };
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // 6. CẦU PHỤC HỒI — sau gãy dài, xem lịch sử
  // ─────────────────────────────────────────────────────────
  if (B0.len === 1 && B1 && B1.len >= 3) {
    // Vừa gãy sau một bệt dài → thường có bệt nhỏ theo chiều mới
    return {
      name: `Vừa gãy bệt ${B1.v==="T"?"Tài":"Xỉu"} ${B1.len} — Tiếp chiều mới`,
      next: B0.v,
      conf: 0.57
    };
  }

  // ─────────────────────────────────────────────────────────
  // 7. CẦU NGẮN — không đủ pattern rõ ràng
  // ─────────────────────────────────────────────────────────
  return null;
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 2 — THỐNG KÊ & XÁC SUẤT
// ══════════════════════════════════════════════════════════════════════

// Markov bậc N — tổng quát
function markovN(seq, order) {
  if (seq.length < order * 3 + 5) return null;
  const table = {};
  for (let i = 0; i < seq.length - order; i++) {
    const state = seq.slice(i + 1, i + 1 + order).join(""); // state = order items AFTER i
    if (!table[state]) table[state] = { T: 0, X: 0 };
    table[state][seq[i]]++;
  }
  const state = seq.slice(0, order).join("");
  const row   = table[state];
  if (!row) return null;
  const tot = row.T + row.X;
  if (tot < 5) return null;
  const pT = row.T / tot, pX = row.X / tot;
  if (pT > pX + 0.10) return { next: "T", conf: 0.50 + (pT - 0.50) * 0.65 };
  if (pX > pT + 0.10) return { next: "X", conf: 0.50 + (pX - 0.50) * 0.65 };
  return null;
}

function algoMarkov4(seq) { return markovN(seq, 4); }
function algoMarkov3(seq) { return markovN(seq, 3); }
function algoMarkov2(seq) { return markovN(seq, 2); }
function algoMarkov1(seq) { return markovN(seq, 1); }

// Bayesian multi-window: cập nhật prior từ nhiều cửa sổ
function algoBayesian(seq) {
  if (seq.length < 12) return null;
  // Fibonacci windows để bao phủ nhiều tầm nhìn
  const windows = [3, 5, 8, 13, 21].filter(w => w <= seq.length);
  let logOdds = 0;
  const weights = windows.map((_, i) => 1 / (i + 1));
  const wSum    = weights.reduce((s,w)=>s+w, 0);

  for (let i = 0; i < windows.length; i++) {
    const sub = seq.slice(0, windows[i]);
    const nT  = sub.filter(x=>x==="T").length;
    // Laplace smoothing
    const pT  = (nT + 1) / (sub.length + 2);
    logOdds  += Math.log(pT / (1 - pT)) * (weights[i] / wSum);
  }

  const pT = 1 / (1 + Math.exp(-logOdds));
  if (pT > 0.56) return { next: "T", conf: 0.50 + (pT - 0.50) * 0.75 };
  if (pT < 0.44) return { next: "X", conf: 0.50 + (0.50 - pT) * 0.75 };
  return null;
}

// Tần suất 3 cửa sổ — ngắn, vừa, dài — hồi quy về trung bình
function algoFreq3Window(seq) {
  if (seq.length < 10) return null;
  const w = [
    { n: 8,  wt: 0.50 },
    { n: 20, wt: 0.30 },
    { n: 50, wt: 0.20 }
  ].filter(({n}) => n <= seq.length);

  let totWt = 0;
  let wRateT = 0;
  for (const {n, wt} of w) {
    const sub = seq.slice(0, n);
    wRateT += (sub.filter(x=>x==="T").length / sub.length) * wt;
    totWt  += wt;
  }
  const rT = wRateT / totWt;
  const rX = 1 - rT;

  // Mean reversion: nếu lệch mạnh → dự đoán chiều ngược
  if (rT > 0.62) return { next: "X", conf: 0.50 + (rT - 0.50) * 0.55 };
  if (rX > 0.62) return { next: "T", conf: 0.50 + (rX - 0.50) * 0.55 };
  return null;
}

// Chi-Square transition analysis — ma trận TT/TX/XT/XX
function algoChiSq(seq) {
  if (seq.length < 25) return null;
  const obs = { TT:0, TX:0, XT:0, XX:0 };
  for (let i = 0; i < seq.length - 1; i++) {
    const k = seq[i+1] + seq[i];
    if (k in obs) obs[k]++;
  }
  const n   = obs.TT + obs.TX + obs.XT + obs.XX;
  const exp = n / 4;
  const chi2 = Object.values(obs).reduce((s,o) => s + (o-exp)**2/exp, 0);
  if (chi2 < 3.84) return null; // không có cấu trúc

  // Xác suất chuyển trạng thái thực sự
  const pTT = obs.TT / (obs.TT + obs.TX + 1e-6);
  const pXT = obs.XT / (obs.XT + obs.XX + 1e-6);
  const pXX = obs.XX / (obs.XT + obs.XX + 1e-6);
  const pTX = obs.TX / (obs.TT + obs.TX + 1e-6);

  const cur = seq[0];
  if (cur === "T") {
    if (pTT > 0.55) return { next: "T", conf: 0.50 + (pTT-0.50)*0.60 };
    if (pTX > 0.55) return { next: "X", conf: 0.50 + (pTX-0.50)*0.60 };
  } else {
    if (pXX > 0.55) return { next: "X", conf: 0.50 + (pXX-0.50)*0.60 };
    if (pXT > 0.55) return { next: "T", conf: 0.50 + (pXT-0.50)*0.60 };
  }
  return null;
}

// Ma trận chuyển đổi 4 trạng thái: TT, TX, XT, XX → dự đoán kế
function algoTransMatrix(seq) {
  if (seq.length < 30) return null;
  // State = 2 phiên gần nhất
  const states = ["TT","TX","XT","XX"];
  const trans  = {};
  for (const s of states) trans[s] = { T:0, X:0 };

  for (let i = 0; i < seq.length - 2; i++) {
    const state = seq[i+2] + seq[i+1]; // 2 phiên trước (older first)
    const next  = seq[i];
    if (trans[state]) trans[state][next]++;
  }

  const curState = seq[1] + seq[0]; // 2 phiên mới nhất (older first)
  if (!(curState in trans)) return null;
  const row = trans[curState];
  const tot = row.T + row.X;
  if (tot < 5) return null;

  const pT = row.T / tot;
  if (pT > 0.58) return { next: "T", conf: 0.50 + (pT - 0.50) * 0.60 };
  if (pT < 0.42) return { next: "X", conf: 0.50 + (0.50 - pT) * 0.60 };
  return null;
}

// Auto-correlation lag 1 và 2
function algoAutoCorr(seq) {
  if (seq.length < 20) return null;
  const n = Math.min(seq.length, 50);
  const v = seq.slice(0,n).map(x => x==="T" ? 1 : 0);
  const mean = v.reduce((a,b)=>a+b,0) / n;
  let denom=0, ac1=0, ac2=0;
  for (let i = 0; i < n; i++) denom += (v[i]-mean)**2;
  if (denom < 1e-9) return null;
  for (let i = 1; i < n;   i++) ac1 += (v[i]-mean)*(v[i-1]-mean);
  for (let i = 2; i < n;   i++) ac2 += (v[i]-mean)*(v[i-2]-mean);
  ac1 /= denom; ac2 /= denom;

  // ac1 > 0 → xu hướng tiếp diễn; ac1 < 0 → xen kẽ
  if (ac1 >  0.15) return { next: seq[0],           conf: 0.50 + Math.min(ac1*0.35, 0.12) };
  if (ac1 < -0.15) return { next: seq[0]==="T"?"X":"T", conf: 0.50 + Math.min(-ac1*0.35, 0.12) };
  if (ac2 >  0.18) return { next: seq[1] ?? seq[0], conf: 0.52 };
  return null;
}

// ── STREAK BREAK: phân tích thống kê độ dài bệt → gãy hay tiếp?
function algoStreakBreak(seq) {
  if (seq.length < 20) return null;
  // Đo streak hiện tại
  let curLen = 1;
  while (curLen < seq.length && seq[curLen] === seq[0]) curLen++;

  // Thu thập lịch sử độ dài bệt cùng loại
  const blocks   = buildBlocks(seq, 100);
  const sameLens = blocks.slice(1).filter(b => b.v === seq[0]).map(b => b.len);
  if (sameLens.length < 3) return null;

  sameLens.sort((a,b)=>a-b);
  const median = sameLens[Math.floor(sameLens.length / 2)];
  const q75    = sameLens[Math.floor(sameLens.length * 0.75)];
  const q90    = sameLens[Math.floor(sameLens.length * 0.90)] ?? q75;

  if (curLen >= q90) {
    // Top 10% → rất có khả năng gãy
    return { next: seq[0]==="T"?"X":"T", conf: Math.min(0.52 + (curLen-q90)*0.03, 0.74) };
  }
  if (curLen >= q75) {
    // Top 25% → nghiêng về gãy
    return { next: seq[0]==="T"?"X":"T", conf: 0.57 };
  }
  if (curLen < median * 0.5 && curLen <= 2) {
    // Còn ngắn → tiếp tục
    return { next: seq[0], conf: 0.54 };
  }
  return null;
}

// Momentum: so sánh tốc độ thay đổi ngắn vs dài
function algoMomentum(seq) {
  if (seq.length < 20) return null;
  const short = seq.slice(0,5).filter(x=>x==="T").length / 5;
  const mid   = seq.slice(0,10).filter(x=>x==="T").length / 10;
  const long  = seq.slice(0,20).filter(x=>x==="T").length / 20;

  const diff = short - long;
  const accel = (short - mid) - (mid - long); // gia tốc thay đổi

  if (diff > 0.28 && accel >= 0) return { next:"T", conf: 0.50 + Math.min(diff*0.25, 0.12) };
  if (diff < -0.28 && accel <= 0) return { next:"X", conf: 0.50 + Math.min(-diff*0.25, 0.12) };
  // Momentum đảo chiều (divergence)
  if (diff > 0.20 && accel < -0.10) return { next:"X", conf: 0.53 };
  if (diff < -0.20 && accel >  0.10) return { next:"T", conf: 0.53 };
  return null;
}

// Entropy: chuỗi hỗn loạn hay có cấu trúc?
function algoEntropy(seq) {
  if (seq.length < 15) return null;
  const n   = Math.min(seq.length, 25);
  const sub = seq.slice(0, n);
  let tr    = 0;
  for (let i = 1; i < sub.length; i++) if (sub[i] !== sub[i-1]) tr++;
  const e = tr / (n - 1); // tỉ lệ đổi chiều

  // e thấp → cầu bệt → tiếp tục; e cao → cầu 1-1 → xen kẽ
  if (e < 0.25) return { next: sub[0],           conf: 0.60 };
  if (e > 0.75) return { next: sub[0]==="T"?"X":"T", conf: 0.58 };
  // e trung bình → không rõ
  return null;
}

// Phát hiện chu kỳ tự động (cycle detect) — thuật toán tốt nhất cho cầu lặp
function algoCycleDetect(seq) {
  if (seq.length < 15) return null;
  const s   = seq.join("");
  let best  = null;

  for (let period = 2; period <= 8; period++) {
    if (s.length < period * 3) continue;
    const pattern = s.slice(0, period);
    let totalMatch = 0, totalChars = 0;

    // So sánh pattern với các lần xuất hiện tiếp theo
    for (let k = 1; k * period < s.length; k++) {
      const slice = s.slice(k * period, (k+1) * period);
      for (let i = 0; i < Math.min(slice.length, period); i++) {
        totalChars++;
        if (slice[i] === pattern[i % period]) totalMatch++;
      }
    }

    if (totalChars < 10) continue;
    const matchRate = totalMatch / totalChars;
    if (matchRate < 0.70) continue;

    // Tính vị trí hiện tại trong chu kỳ
    const pos  = seq.length % period;
    const pred = pattern[(period - pos) % period];
    const conf = 0.50 + (matchRate - 0.70) * 0.70;

    if (!best || conf > best.conf) {
      best = {
        name: `Chu Kỳ ${period} [${pattern}] match=${Math.round(matchRate*100)}%`,
        next: pred,
        conf: Math.min(conf, 0.76)
      };
    }
  }
  return best;
}

// Wave phase — phân tích pha sóng bằng Fourier đơn giản
function algoWavePhase(seq) {
  if (seq.length < 16) return null;
  const n = Math.min(seq.length, 32);
  const v = seq.slice(0,n).map(x => x==="T" ? 1 : -1);

  // Tính correlation với sóng sin chu kỳ 4,6,8
  let bestPred = null, bestStrength = 0;
  for (const T of [4, 6, 8]) {
    let sinCor = 0, cosCor = 0;
    for (let i = 0; i < n; i++) {
      sinCor += v[i] * Math.sin(2*Math.PI*i/T);
      cosCor += v[i] * Math.cos(2*Math.PI*i/T);
    }
    const amplitude = Math.sqrt(sinCor**2 + cosCor**2) / n;
    if (amplitude < 0.15) continue;

    // Dự đoán phiên kế bằng pha
    const nextPhase = 2 * Math.PI * n / T;
    const nextVal   = Math.cos(nextPhase + Math.atan2(sinCor, cosCor));
    if (amplitude > bestStrength) {
      bestStrength = amplitude;
      bestPred     = { next: nextVal > 0 ? "T" : "X", conf: 0.50 + amplitude * 0.30 };
    }
  }
  return bestPred ? { ...bestPred, conf: Math.min(bestPred.conf, 0.64) } : null;
}

// Run Length — phân phối độ dài chuỗi để xác định "hành vi trung bình"
function algoRunLength(seq) {
  if (seq.length < 25) return null;
  const blocks  = buildBlocks(seq, 80);
  const lengths = blocks.slice(1).map(b => b.len); // bỏ qua khối đang chạy
  if (lengths.length < 5) return null;

  const mean = lengths.reduce((s,x)=>s+x,0) / lengths.length;
  const cur  = blocks[0].len;

  // So sánh vị trí hiện tại trong phân phối
  const longerCount = lengths.filter(l => l >= cur).length;
  const prob_continue = longerCount / lengths.length;

  if (prob_continue < 0.30) {
    // Lịch sử: ít khi dài hơn → nghiêng về gãy
    return { next: seq[0]==="T"?"X":"T", conf: 0.50 + (0.30 - prob_continue) * 0.80 };
  }
  if (cur < mean * 0.5) {
    // Còn rất ngắn → tiếp tục
    return { next: seq[0], conf: 0.54 };
  }
  return null;
}

// Mean Reversion — xác suất trở về trung bình
function algoReversion(seq) {
  if (seq.length < 15) return null;
  const n5  = Math.min(5,  seq.length);
  const n30 = Math.min(30, seq.length);
  const r5  = seq.slice(0,n5).filter(x=>x==="T").length  / n5;
  const r30 = seq.slice(0,n30).filter(x=>x==="T").length / n30;
  const dev = r5 - 0.50; // độ lệch khỏi 50%

  // Nếu ngắn hạn lệch xa và dài hạn gần 50% → khả năng hồi quy
  if (Math.abs(dev) > 0.35 && Math.abs(r30 - 0.50) < 0.15) {
    return {
      next: dev > 0 ? "X" : "T",
      conf: 0.50 + Math.min(Math.abs(dev) * 0.25, 0.13)
    };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
//  LAYER 3 — PHÂN TÍCH XÚC XẮC THỰC TẾ
// ══════════════════════════════════════════════════════════════════════

// Phân tích tổng xúc xắc: trung bình, phân phối, xu hướng
function algoDiceSum(hist) {
  if (hist.length < 12) return null;
  const recent = hist.slice(0, 15);
  const all    = hist.slice(0, 40);

  const avgR = recent.reduce((s,h)=>s+h.tong,0) / recent.length;
  const avgA = all.reduce((s,h)=>s+h.tong,0)    / all.length;

  // Tổng lý thuyết trung bình ≈ 10.5
  const bias = avgR - 10.5;
  const pull = avgA - 10.5; // pull dài hạn

  // Xu hướng ngắn hạn mạnh → hồi quy
  if (bias > 1.5 && pull < 0.5)  return { next:"X", conf: 0.50 + Math.min(bias*0.03, 0.12) };
  if (bias < -1.5 && pull > -0.5) return { next:"T", conf: 0.50 + Math.min(-bias*0.03, 0.12) };

  // Xu hướng dài hạn
  if (avgA > 11.2) return { next:"T", conf: 0.53 };
  if (avgA < 9.8)  return { next:"X", conf: 0.53 };

  return null;
}

// Hot number analysis — mặt xúc xắc nào hay xuất hiện gần đây?
function algoDiceHot(hist) {
  if (hist.length < 15) return null;
  const recent = hist.slice(0, 15);

  // Đếm tần suất mỗi mặt (1-6)
  const freq = Array(7).fill(0);
  for (const h of recent) {
    for (const d of h.dice) freq[d]++;
  }

  const total = recent.length * 3;
  const expFreq = total / 6;

  // Mặt nào hot (xuất hiện > 1.4x trung bình)?
  const hotFaces  = [];
  const coldFaces = [];
  for (let f = 1; f <= 6; f++) {
    if (freq[f] > expFreq * 1.4) hotFaces.push(f);
    if (freq[f] < expFreq * 0.6) coldFaces.push(f);
  }

  // Tổng kỳ vọng nếu các mặt hot tiếp tục
  const hotSum = hotFaces.reduce((s,f)=>s+f,0);
  if (hotFaces.length >= 2) {
    const avgHot = hotSum / hotFaces.length;
    if (avgHot > 4.5) return { next:"T", conf: 0.54 };
    if (avgHot < 2.5) return { next:"X", conf: 0.54 };
  }

  // Cold → mean reversion về 3.5 trung bình
  if (coldFaces.length >= 2) {
    const avgCold = coldFaces.reduce((s,f)=>s+f,0) / coldFaces.length;
    if (avgCold > 4.5) return { next:"T", conf: 0.52 };
    if (avgCold < 2.5) return { next:"X", conf: 0.52 };
  }

  return null;
}

// Dice Balance — cân bằng T/X từ phân phối xúc xắc thực tế
function algoDiceBalance(hist) {
  if (hist.length < 20) return null;
  const recent = hist.slice(0, 20);
  const variances = recent.map(h => {
    const mean = h.tong / 3;
    return h.dice.reduce((s,d) => s + (d-mean)**2, 0) / 3;
  });

  const avgVar = variances.reduce((s,v)=>s+v,0) / variances.length;
  const seq    = hist.map(h=>h.type);

  // Variance thấp (các viên xúc xắc gần nhau) → tổng tập trung → ít biến động
  if (avgVar < 1.5) {
    // Tổng dao động ít → xu hướng rõ hơn
    const rT = recent.filter(h=>h.type==="T").length / recent.length;
    if (rT > 0.6) return { next:"T", conf: 0.55 };
    if (rT < 0.4) return { next:"X", conf: 0.55 };
  }

  // Variance cao → tổng biến động mạnh → đảo chiều
  if (avgVar > 3.5 && seq.length > 0) {
    return { next: seq[0]==="T"?"X":"T", conf: 0.52 };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
//  ENSEMBLE — tổng hợp có trọng số thích nghi
// ══════════════════════════════════════════════════════════════════════

// Clamp confidence vào khoảng thực tế [0.50, 0.80]
function clampConf(c) {
  return Math.min(Math.max(c, 0.50), 0.80);
}

function predict(hist) {
  if (hist.length < 5) return {
    next: "?", nextDisplay: "Chưa đủ dữ liệu",
    conf: 50, confDisplay: "50%",
    cauName: "Chưa đủ dữ liệu", cauDetail: "",
    votesT: 0, votesX: 0, totalAlgos: 0,
    algoDetail: {}
  };

  const seq    = hist.map(h => h.type);
  const wSum   = { T: 0.0, X: 0.0 };
  const detail = {};
  const votes  = [];

  /**
   * Đăng ký kết quả của một thuật toán vào ensemble
   * @param {string} name   - tên algo
   * @param {object|null} res - { next:"T"|"X", conf:0-1 }
   * @param {number} baseW  - trọng số cơ bản
   */
  const add = (name, res, baseW) => {
    if (!res || !res.next || !res.conf) { detail[name] = null; return; }
    res.conf = clampConf(res.conf);
    lastPreds[name] = res.next;
    const aw = baseW * adaptiveWeight(name);
    wSum[res.next] += res.conf * aw;
    detail[name] = {
      du_doan:    res.next === "T" ? "Tài" : "Xỉu",
      do_tin_cay: Math.round(res.conf * 100) + "%",
      trong_so:   Math.round(aw * 100) / 100,
      ghi_chu:    res.name ?? ""
    };
    votes.push({ pred: res.next, conf: res.conf, w: aw });
  };

  // ── Gọi tất cả thuật toán ─────────────────────────────────
  // Layer 1: Cầu (trọng số cao nhất — đây là cốt lõi)
  const cauRes = algoCauBlock(seq);
  add("cauBlock",    cauRes,                         6.0);

  // Layer 2: Markov chains (quan trọng thứ hai)
  add("markov4",     algoMarkov4(seq),                3.0);
  add("markov3",     algoMarkov3(seq),                3.5);
  add("markov2",     algoMarkov2(seq),                3.0);
  add("markov1",     algoMarkov1(seq),                2.0);

  // Layer 2: Xác suất & thống kê
  add("bayesian",    algoBayesian(seq),               2.5);
  add("freq3window", algoFreq3Window(seq),            2.0);
  add("chiSq",       algoChiSq(seq),                  2.0);
  add("autoCorr",    algoAutoCorr(seq),               1.8);
  add("transMatrix", algoTransMatrix(seq),            2.0);

  // Layer 2: Streak & Pattern
  add("streakBreak", algoStreakBreak(seq),            2.5);
  add("entropy",     algoEntropy(seq),                1.5);
  add("cycleDetect", algoCycleDetect(seq),            2.0);
  add("wavePhase",   algoWavePhase(seq),              1.2);
  add("runLength",   algoRunLength(seq),              1.8);
  add("momentum",    algoMomentum(seq),               1.5);
  add("reversion",   algoReversion(seq),              1.5);

  // Layer 3: Dice analysis
  add("diceSum",     algoDiceSum(hist),               1.5);
  add("diceHot",     algoDiceHot(hist),               1.0);
  add("diceBalance", algoDiceBalance(hist),           0.8);

  // ── Tổng hợp ─────────────────────────────────────────────
  const tot = wSum.T + wSum.X;
  let next = "T", rawConf = 0.50;
  if (tot > 1e-9) {
    if (wSum.X >= wSum.T) { next = "X"; rawConf = wSum.X / tot; }
    else                   { next = "T"; rawConf = wSum.T / tot; }
  }

  // Điều chỉnh độ tin cậy thực tế: không thổi phồng
  // rawConf từ ensemble thường > 0.5 chỉ đơn thuần vì có nhiều vote
  // Remap: [0.50, 1.0] → [0.50, 0.80]
  const conf = 0.50 + (rawConf - 0.50) * 0.65;
  const finalConf = clampConf(conf);

  const votesT = votes.filter(v => v.pred === "T").length;
  const votesX = votes.filter(v => v.pred === "X").length;

  // Nếu vote rất sít → giảm confidence
  const voteRatio = Math.max(votesT, votesX) / Math.max(votesT + votesX, 1);
  const voteAdj   = voteRatio < 0.55 ? -0.03 : 0;

  const trueConf  = clampConf(finalConf + voteAdj);

  // Tên cầu hiển thị
  const cauName = cauRes?.name
    ?? (next === "T" && rawConf > 0.55 ? "Nghiêng Tài"
      : next === "X" && rawConf > 0.55 ? "Nghiêng Xỉu"
      : "Tín hiệu yếu");

  return {
    next:        next,
    nextDisplay: next === "T" ? "Tài" : "Xỉu",
    conf:        Math.round(trueConf * 100),
    confDisplay: Math.round(trueConf * 100) + "%",
    cauName,
    cauDetail: cauRes?.mu ?? "",
    pattern16: seq.slice(0,16).join(""),
    votesT,
    votesX,
    totalAlgos: votes.length,
    algoDetail: detail,
    _raw: { wSum, rawConf: Math.round(rawConf*100)/100 }
  };
}

// ══════════════════════════════════════════════════════════════════════
//  SYNC — lấy dữ liệu & cập nhật accuracy
// ══════════════════════════════════════════════════════════════════════

let prevTopPhien = null;

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

    // Phiên mới xuất hiện → dùng kết quả thực để cập nhật accuracy
    if (before && after !== before && prevTopPhien === before && history.length >= 2) {
      recordActual(history[1].type); // history[1] là phiên TRƯỚC phiên mới nhất
    }
    prevTopPhien = after;
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════════════

http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // ══ GET / hoặc /predict ═══════════════════════════════════
  if (url.pathname === "/" || url.pathname === "/predict") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ loi: "Chưa có dữ liệu từ nguồn" }));
      return;
    }

    const h    = history[0];
    const pred = predict(history);

    res.writeHead(200);
    res.end(JSON.stringify({
      // ── Phiên hiện tại
      phien_hien_tai:  h.phien,
      xuc_xac:         h.dice,
      tong_hien_tai:   h.tong,
      ket_qua_hien:    h.type === "T" ? "Tài" : "Xỉu",

      // ── Dự đoán 1 phiên tới
      phien_du_doan:   String(Number(h.phien) + 1),
      du_doan:         pred.nextDisplay,
      do_tin_cay:      pred.confDisplay,
      loai_cau:        pred.cauName,

      // ── Thông tin vote
      phieu_tai:       pred.votesT,
      phieu_xiu:       pred.votesX,
      tong_thuat_toan: pred.totalAlgos,

      // ── Pattern
      pattern_16:      pred.pattern16,
    }));
    return;
  }

  // ══ GET /predict/detail ═══════════════════════════════════
  if (url.pathname === "/predict/detail") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ loi: "Chưa có dữ liệu" }));
      return;
    }

    const h    = history[0];
    const pred = predict(history);

    res.writeHead(200);
    res.end(JSON.stringify({
      phien_du_doan:   String(Number(h.phien) + 1),
      du_doan:         pred.nextDisplay,
      do_tin_cay:      pred.confDisplay,
      loai_cau:        pred.cauName,
      phieu_tai:       pred.votesT,
      phieu_xiu:       pred.votesX,
      chi_tiet_thuat_toan: pred.algoDetail
    }));
    return;
  }

  // ══ GET /history ══════════════════════════════════════════
  if (url.pathname === "/history") {
    await syncHistory();
    const lim = Math.min(parseInt(url.searchParams.get("limit") || "20"), 200);
    res.writeHead(200);
    res.end(JSON.stringify({
      tong_so: history.length,
      du_lieu: history.slice(0, lim).map(h => ({
        phien:   h.phien,
        xuc_xac: h.dice,
        tong:    h.tong,
        ket_qua: h.type === "T" ? "Tài" : "Xỉu"
      }))
    }));
    return;
  }

  // ══ GET /pattern ══════════════════════════════════════════
  if (url.pathname === "/pattern") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ loi: "Chưa có dữ liệu" }));
      return;
    }

    const seq    = history.map(h => h.type);
    const cauRes = algoCauBlock(seq);
    const blocks = buildBlocks(seq, 40);

    res.writeHead(200);
    res.end(JSON.stringify({
      pattern_20:      seq.slice(0,20).join(""),
      cau_hien_tai:    cauRes ? cauRes.name : "Không rõ cầu",
      do_tin_cay_cau:  cauRes ? Math.round(cauRes.conf*100) + "%" : "N/A",
      du_doan_cau:     cauRes ? (cauRes.next === "T" ? "Tài" : "Xỉu") : "?",
      chuoi_khoi: blocks.slice(0, 10).map(b => ({
        ket_qua:  b.v === "T" ? "Tài" : "Xỉu",
        so_phien: b.len
      }))
    }));
    return;
  }

  // ══ GET /stats ════════════════════════════════════════════
  if (url.pathname === "/stats") {
    const out = {};
    for (const name of ALGO_NAMES) {
      const a = acc[name];
      out[name] = {
        chinh_xac:  a.t > 0 ? Math.round(a.c/a.t*100) + "%" : "N/A",
        trong_so:   Math.round(adaptiveWeight(name)*100)/100,
        so_mau:     Math.round(a.t)
      };
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      thong_ke_thuat_toan: out,
      so_lich_su:          history.length,
      nguon:               SOURCE_URL
    }));
    return;
  }

  // ══ GET /debug ════════════════════════════════════════════
  if (url.pathname === "/debug") {
    const r = await fetchSource().catch(e => ({ loi: e.message }));
    res.writeHead(200);
    res.end(JSON.stringify(r, null, 2));
    return;
  }

  // ══ 404 ═══════════════════════════════════════════════════
  res.writeHead(404);
  res.end(JSON.stringify({
    loi: "Không tìm thấy endpoint",
    endpoints: ["/predict", "/predict/detail", "/history", "/pattern", "/stats", "/debug"]
  }));

}).listen(PORT, () => {
  console.log("✅  Sic-Bo Expert Predictor v4.0 — port " + PORT);
  console.log("    Nguồn: " + SOURCE_URL);
  syncHistory();
  setInterval(syncHistory, 12000);
});
