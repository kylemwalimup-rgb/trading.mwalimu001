/**
 * indicators.js — pure vectorised indicator math
 * All functions accept/return plain arrays; nulls mark "not enough data".
 */
"use strict";

const Indicators = (() => {
  const N = (n) => Array(n).fill(null);
  const ok = (v) => v !== null && v !== undefined && !isNaN(v) && isFinite(v);

  // ── Moving Averages ────────────────────────────────────────────────────────

  function sma(src, p) {
    const out = N(src.length);
    for (let i = p - 1; i < src.length; i++) {
      let s = 0, c = 0;
      for (let j = i - p + 1; j <= i; j++) if (ok(src[j])) { s += src[j]; c++; }
      if (c === p) out[i] = s / p;
    }
    return out;
  }

  function ema(src, p) {
    const out = N(src.length);
    const k = 2 / (p + 1);
    let prev = null, seeded = false, sum = 0, cnt = 0;
    for (let i = 0; i < src.length; i++) {
      if (!ok(src[i])) continue;
      if (!seeded) {
        sum += src[i]; cnt++;
        if (cnt === p) { prev = sum / p; out[i] = prev; seeded = true; }
      } else {
        prev = src[i] * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  function wma(src, p) {
    const out = N(src.length);
    const denom = p * (p + 1) / 2;
    for (let i = p - 1; i < src.length; i++) {
      let s = 0;
      for (let j = 0; j < p; j++) s += src[i - j] * (p - j);
      out[i] = s / denom;
    }
    return out;
  }

  function dema(src, p) {
    const e = ema(src, p), e2 = ema(e.map(v => v ?? NaN), p);
    return src.map((_, i) => ok(e[i]) && ok(e2[i]) ? 2 * e[i] - e2[i] : null);
  }

  function tema(src, p) {
    const e = ema(src, p);
    const e2 = ema(e.map(v => v ?? NaN), p);
    const e3 = ema(e2.map(v => v ?? NaN), p);
    return src.map((_, i) =>
      ok(e[i]) && ok(e2[i]) && ok(e3[i]) ? 3 * e[i] - 3 * e2[i] + e3[i] : null);
  }

  // Wilder RMA (used by ATR, RSI)
  function rma(src, p) {
    const out = N(src.length);
    let prev = null, sum = 0, cnt = 0;
    for (let i = 0; i < src.length; i++) {
      if (!ok(src[i])) continue;
      if (prev === null) {
        sum += src[i]; cnt++;
        if (cnt === p) { prev = sum / p; out[i] = prev; }
      } else {
        prev = (prev * (p - 1) + src[i]) / p;
        out[i] = prev;
      }
    }
    return out;
  }

  // VWAP — resets from bar 0 (session VWAP reset logic not applicable without session data)
  function vwap(high, low, close, volume) {
    let cumTV = 0, cumV = 0;
    return close.map((_, i) => {
      const tp = (high[i] + low[i] + close[i]) / 3;
      cumTV += tp * volume[i]; cumV += volume[i];
      return cumV > 0 ? cumTV / cumV : null;
    });
  }

  // ── Oscillators ────────────────────────────────────────────────────────────

  function rsi(src, p = 14) {
    const out = N(src.length);
    let ag = 0, al = 0;
    for (let i = 1; i <= p && i < src.length; i++) {
      const d = src[i] - src[i - 1];
      d > 0 ? ag += d : al -= d;
    }
    ag /= p; al /= p;
    if (p < src.length) out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = p + 1; i < src.length; i++) {
      const d = src[i] - src[i - 1];
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      ag = (ag * (p - 1) + g) / p;
      al = (al * (p - 1) + l) / p;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  function macd(src, fast = 12, slow = 26, signal = 9) {
    const fe = ema(src, fast), se = ema(src, slow);
    const line = src.map((_, i) => ok(fe[i]) && ok(se[i]) ? fe[i] - se[i] : null);
    const sig  = ema(line.map(v => v ?? NaN), signal);
    const hist = line.map((v, i) => ok(v) && ok(sig[i]) ? v - sig[i] : null);
    return { macd: line, signal: sig, histogram: hist };
  }

  function stoch(high, low, close, kp = 14, sk = 3, sd = 3) {
    const raw = N(close.length);
    for (let i = kp - 1; i < close.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - kp + 1; j <= i; j++) { hh = Math.max(hh, high[j]); ll = Math.min(ll, low[j]); }
      raw[i] = hh === ll ? 50 : 100 * (close[i] - ll) / (hh - ll);
    }
    const k = sma(raw.map(v => v ?? NaN), sk);
    const d = sma(k.map(v => v ?? NaN), sd);
    return { k, d };
  }

  function cci(high, low, close, p = 20) {
    const out = N(close.length);
    for (let i = p - 1; i < close.length; i++) {
      let tp = 0;
      for (let j = i - p + 1; j <= i; j++) tp += (high[j] + low[j] + close[j]) / 3;
      const mean = tp / p;
      let dev = 0;
      for (let j = i - p + 1; j <= i; j++) dev += Math.abs((high[j] + low[j] + close[j]) / 3 - mean);
      out[i] = dev === 0 ? 0 : (((high[i] + low[i] + close[i]) / 3) - mean) / (0.015 * dev / p);
    }
    return out;
  }

  function williamsR(high, low, close, p = 14) {
    const out = N(close.length);
    for (let i = p - 1; i < close.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p + 1; j <= i; j++) { hh = Math.max(hh, high[j]); ll = Math.min(ll, low[j]); }
      out[i] = hh === ll ? -50 : -100 * (hh - close[i]) / (hh - ll);
    }
    return out;
  }

  // ── Volatility ─────────────────────────────────────────────────────────────

  function atr(high, low, close, p = 14) {
    const tr = N(close.length);
    for (let i = 1; i < close.length; i++)
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i-1]), Math.abs(low[i] - close[i-1]));
    return rma(tr.map(v => v ?? NaN), p);
  }

  function bb(src, p = 20, mult = 2) {
    const mid = sma(src, p);
    const upper = N(src.length), lower = N(src.length), bw = N(src.length), pct = N(src.length);
    for (let i = p - 1; i < src.length; i++) {
      if (!ok(mid[i])) continue;
      let v = 0;
      for (let j = i - p + 1; j <= i; j++) v += (src[j] - mid[i]) ** 2;
      const s = Math.sqrt(v / p);
      upper[i] = mid[i] + mult * s;
      lower[i] = mid[i] - mult * s;
      bw[i] = (upper[i] - lower[i]) / mid[i] * 100;
      pct[i] = upper[i] === lower[i] ? 0.5 : (src[i] - lower[i]) / (upper[i] - lower[i]);
    }
    return { upper, middle: mid, lower, bandwidth: bw, percentB: pct };
  }

  // ── Volume ─────────────────────────────────────────────────────────────────

  function obv(close, volume) {
    const out = [0];
    for (let i = 1; i < close.length; i++) {
      const prev = out[i - 1];
      if (close[i] > close[i-1])      out.push(prev + volume[i]);
      else if (close[i] < close[i-1]) out.push(prev - volume[i]);
      else                             out.push(prev);
    }
    return out;
  }

  // ── Trend ──────────────────────────────────────────────────────────────────

  function ichimoku(high, low, tenkan = 9, kijun = 26, senkou = 52) {
    const mid = (i, p, arr_h, arr_l) => {
      let hh = -Infinity, ll = Infinity;
      for (let j = Math.max(0, i - p + 1); j <= i; j++) { hh = Math.max(hh, arr_h[j]); ll = Math.min(ll, arr_l[j]); }
      return (hh + ll) / 2;
    };
    const n = high.length;
    const tenkanSen  = high.map((_, i) => i >= tenkan  - 1 ? mid(i, tenkan,  high, low) : null);
    const kijunSen   = high.map((_, i) => i >= kijun   - 1 ? mid(i, kijun,   high, low) : null);
    const senkouA    = tenkanSen.map((t, i) => ok(t) && ok(kijunSen[i]) ? (t + kijunSen[i]) / 2 : null);
    const senkouB    = high.map((_, i) => i >= senkou  - 1 ? mid(i, senkou,  high, low) : null);
    const chikouSpan = [...close];
    return { tenkanSen, kijunSen, senkouA, senkouB, chikouSpan };
  }

  function supertrend(high, low, close, p = 10, mult = 3) {
    const atrV = atr(high, low, close, p);
    const dir = N(close.length), st = N(close.length);
    let prevST = null, prevDir = 1;
    for (let i = p; i < close.length; i++) {
      if (!ok(atrV[i])) continue;
      const hl2 = (high[i] + low[i]) / 2;
      const ub = hl2 + mult * atrV[i];
      const lb = hl2 - mult * atrV[i];
      let curST, curDir;
      if (prevST === null) {
        curST = close[i] > hl2 ? lb : ub;
        curDir = close[i] > hl2 ? 1 : -1;
      } else if (prevDir === 1) {
        curST = Math.max(lb, prevST);
        curDir = close[i] >= curST ? 1 : -1;
        if (curDir === -1) curST = ub;
      } else {
        curST = Math.min(ub, prevST);
        curDir = close[i] <= curST ? -1 : 1;
        if (curDir === 1) curST = lb;
      }
      st[i] = curST; dir[i] = curDir;
      prevST = curST; prevDir = curDir;
    }
    return { supertrend: st, direction: dir };
  }

  function pivotPoints(high, low, close) {
    const n = close.length;
    const p = N(n), r1 = N(n), r2 = N(n), r3 = N(n);
    const s1 = N(n), s2 = N(n), s3 = N(n);
    for (let i = 1; i < n; i++) {
      const pp = (high[i-1] + low[i-1] + close[i-1]) / 3;
      p[i]  = pp;
      r1[i] = 2 * pp - low[i-1];
      s1[i] = 2 * pp - high[i-1];
      r2[i] = pp + (high[i-1] - low[i-1]);
      s2[i] = pp - (high[i-1] - low[i-1]);
      r3[i] = high[i-1] + 2 * (pp - low[i-1]);
      s3[i] = low[i-1]  - 2 * (high[i-1] - pp);
    }
    return { p, r1, r2, r3, s1, s2, s3 };
  }

  // ── Helpers exposed to pine.js ─────────────────────────────────────────────

  function shift(arr, n) {
    const out = N(arr.length);
    for (let i = n; i < arr.length; i++) out[i] = arr[i - n];
    return out;
  }

  function cross(a, b) {
    const out = N(a.length);
    for (let i = 1; i < a.length; i++)
      out[i] = (a[i-1] < b[i-1] && a[i] >= b[i]) ? 1 : (a[i-1] > b[i-1] && a[i] <= b[i]) ? -1 : 0;
    return out;
  }

  function highest(src, p) {
    const out = N(src.length);
    for (let i = p - 1; i < src.length; i++) {
      let m = -Infinity;
      for (let j = i - p + 1; j <= i; j++) if (ok(src[j])) m = Math.max(m, src[j]);
      out[i] = m === -Infinity ? null : m;
    }
    return out;
  }

  function lowest(src, p) {
    const out = N(src.length);
    for (let i = p - 1; i < src.length; i++) {
      let m = Infinity;
      for (let j = i - p + 1; j <= i; j++) if (ok(src[j])) m = Math.min(m, src[j]);
      out[i] = m === Infinity ? null : m;
    }
    return out;
  }

  // Vectorised arithmetic helpers
  function vadd(a, b) { return Array.isArray(a) ? a.map((v,i) => ok(v) && ok(Array.isArray(b)?b[i]:b) ? v+(Array.isArray(b)?b[i]:b) : null) : (Array.isArray(b) ? b.map(v=>v+a) : a+b); }
  function vsub(a, b) { return Array.isArray(a) ? a.map((v,i) => ok(v) && ok(Array.isArray(b)?b[i]:b) ? v-(Array.isArray(b)?b[i]:b) : null) : (Array.isArray(b) ? b.map(v=>a-v) : a-b); }
  function vmul(a, b) { return Array.isArray(a) ? a.map((v,i) => ok(v) && ok(Array.isArray(b)?b[i]:b) ? v*(Array.isArray(b)?b[i]:b) : null) : (Array.isArray(b) ? b.map(v=>v*a) : a*b); }
  function vdiv(a, b) { return Array.isArray(a) ? a.map((v,i) => { const d=Array.isArray(b)?b[i]:b; return ok(v)&&ok(d)&&d!==0?v/d:null; }) : (Array.isArray(b) ? b.map(v=>a/v) : a/b); }
  function vabs(a)    { return a.map(v => ok(v) ? Math.abs(v) : null); }
  function vmax(a, b) { return a.map((v,i) => { const w=Array.isArray(b)?b[i]:b; return ok(v)&&ok(w)?Math.max(v,w):null; }); }
  function vmin(a, b) { return a.map((v,i) => { const w=Array.isArray(b)?b[i]:b; return ok(v)&&ok(w)?Math.min(v,w):null; }); }
  function nz(a, def = 0) { return Array.isArray(a) ? a.map(v => ok(v) ? v : def) : (ok(a) ? a : def); }

  return {
    sma, ema, wma, dema, tema, rma, vwap,
    rsi, macd, stoch, cci, williamsR,
    atr, bb,
    obv,
    ichimoku, supertrend, pivotPoints,
    shift, cross, highest, lowest,
    vadd, vsub, vmul, vdiv, vabs, vmax, vmin, nz,
  };
})();
