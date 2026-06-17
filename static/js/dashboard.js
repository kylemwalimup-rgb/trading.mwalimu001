/**
 * dashboard.js — main frontend controller
 *
 * Architecture
 * ────────────
 * buildGrid(n)
 *   └─ makePane(i)          → creates DOM + LW chart
 *       └─ loadChart(pane)  → fetches candles, draws main series, re-applies indicators
 *
 * Indicator system
 * ────────────────
 * addIndicator(pane, def)
 *   overlay  → line/area series on mainChart
 *   subPanel → new LW chart below main, time-synced
 *   custom   → runs PineEngine.run(), distributes plots to overlay or subPanel
 *
 * Symbol selector  →  searchable via text input that filters <datalist>
 * WS               →  single Hyperliquid connection fanned to all crypto panes
 * yfinance poll    →  /api/quote every 15 s for yfinance panes
 */

"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
let SYMBOL_LISTS = {}, INTERVALS = [];
let panes = [];
let hlSocket = null;
const POLL_MS = 15_000;

// ── Indicator catalogue ───────────────────────────────────────────────────────
const IND_CATALOGUE = [
  // Trend — overlay
  { id:"sma",    label:"SMA",              cat:"Trend",      overlay:true,
    defaults:{ period:20, color:"#ff9900" },
    params:[{k:"period",label:"Period",type:"number",min:1},{k:"color",label:"Color",type:"color"}]},
  { id:"ema",    label:"EMA",              cat:"Trend",      overlay:true,
    defaults:{ period:20, color:"#0099ff" },
    params:[{k:"period",label:"Period",type:"number",min:1},{k:"color",label:"Color",type:"color"}]},
  { id:"wma",    label:"WMA",              cat:"Trend",      overlay:true,
    defaults:{ period:20, color:"#cc44ff" },
    params:[{k:"period",label:"Period",type:"number",min:1},{k:"color",label:"Color",type:"color"}]},
  { id:"dema",   label:"DEMA",             cat:"Trend",      overlay:true,
    defaults:{ period:20, color:"#ff44cc" },
    params:[{k:"period",label:"Period",type:"number",min:1},{k:"color",label:"Color",type:"color"}]},
  { id:"tema",   label:"TEMA",             cat:"Trend",      overlay:true,
    defaults:{ period:20, color:"#44ffcc" },
    params:[{k:"period",label:"Period",type:"number",min:1},{k:"color",label:"Color",type:"color"}]},
  { id:"bb",     label:"Bollinger Bands",  cat:"Trend",      overlay:true,
    defaults:{ period:20, mult:2, color:"#4488ff" },
    params:[{k:"period",label:"Period",type:"number",min:1},{k:"mult",label:"Std Dev",type:"number",step:0.1},{k:"color",label:"Color",type:"color"}]},
  { id:"vwap",   label:"VWAP",             cat:"Trend",      overlay:true,
    defaults:{ color:"#ffcc00" },
    params:[{k:"color",label:"Color",type:"color"}]},
  { id:"supertrend", label:"Supertrend",   cat:"Trend",      overlay:true,
    defaults:{ period:10, mult:3 },
    params:[{k:"period",label:"Period",type:"number",min:1},{k:"mult",label:"Multiplier",type:"number",step:0.1}]},
  { id:"ichimoku", label:"Ichimoku Cloud", cat:"Trend",      overlay:true,
    defaults:{ tenkan:9, kijun:26, senkou:52 },
    params:[{k:"tenkan",label:"Tenkan",type:"number"},{k:"kijun",label:"Kijun",type:"number"},{k:"senkou",label:"Senkou",type:"number"}]},
  // Momentum — sub-panel
  { id:"rsi",    label:"RSI",              cat:"Momentum",   overlay:false,
    defaults:{ period:14, ob:70, os:30, color:"#a855f7" },
    params:[{k:"period",label:"Period",type:"number",min:1},{k:"ob",label:"Overbought",type:"number"},{k:"os",label:"Oversold",type:"number"},{k:"color",label:"Color",type:"color"}]},
  { id:"macd",   label:"MACD",             cat:"Momentum",   overlay:false,
    defaults:{ fast:12, slow:26, signal:9 },
    params:[{k:"fast",label:"Fast",type:"number"},{k:"slow",label:"Slow",type:"number"},{k:"signal",label:"Signal",type:"number"}]},
  { id:"stoch",  label:"Stochastic",       cat:"Momentum",   overlay:false,
    defaults:{ kp:14, sk:3, sd:3, ob:80, os:20 },
    params:[{k:"kp",label:"K Period",type:"number"},{k:"sk",label:"Smooth K",type:"number"},{k:"sd",label:"Smooth D",type:"number"}]},
  { id:"cci",    label:"CCI",              cat:"Momentum",   overlay:false,
    defaults:{ period:20, color:"#f97316" },
    params:[{k:"period",label:"Period",type:"number"},{k:"color",label:"Color",type:"color"}]},
  { id:"williamsr", label:"Williams %R",   cat:"Momentum",   overlay:false,
    defaults:{ period:14, color:"#ec4899" },
    params:[{k:"period",label:"Period",type:"number"},{k:"color",label:"Color",type:"color"}]},
  // Volume — sub-panel
  { id:"volume", label:"Volume",           cat:"Volume",     overlay:false, defaults:{}, params:[] },
  { id:"obv",    label:"OBV",              cat:"Volume",     overlay:false,
    defaults:{ color:"#22d3ee" }, params:[{k:"color",label:"Color",type:"color"}]},
  // Volatility — sub-panel
  { id:"atr",    label:"ATR",              cat:"Volatility", overlay:false,
    defaults:{ period:14, color:"#f59e0b" },
    params:[{k:"period",label:"Period",type:"number"},{k:"color",label:"Color",type:"color"}]},
  // Custom
  { id:"custom_js",   label:"JavaScript Custom",   cat:"Custom", overlay:false, defaults:{}, params:[], custom:true, mode:"js"   },
  { id:"custom_pine", label:"PineScript Custom",   cat:"Custom", overlay:false, defaults:{}, params:[], custom:true, mode:"pine" },
];
const IND_MAP = Object.fromEntries(IND_CATALOGUE.map(d => [d.id, d]));

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  const res = await fetch("/api/symbols");
  const data = await res.json();
  SYMBOL_LISTS = data.symbols;
  INTERVALS    = data.intervals;

  const saved = parseInt(localStorage.getItem("chartCount") || "4", 10);
  const sel   = document.getElementById("chart-count-select");
  sel.value   = String(saved);
  sel.addEventListener("change", () => {
    const n = parseInt(sel.value, 10);
    localStorage.setItem("chartCount", n);
    buildGrid(n);
  });

  buildGrid(saved);
  connectHyperliquid();
  startYFinancePoller();
})();

// ── Grid ──────────────────────────────────────────────────────────────────────
function buildGrid(n) {
  const grid = document.getElementById("grid");
  panes.forEach(p => destroyPane(p));
  panes = [];
  grid.innerHTML = "";
  grid.setAttribute("data-count", n);

  const tpl = document.getElementById("pane-tpl");
  for (let i = 0; i < n; i++) {
    const node = tpl.content.cloneNode(true);
    const el   = node.querySelector(".pane");
    grid.appendChild(el);
    const pane = makePane(i, el);
    panes.push(pane);
    loadChart(pane);
  }
}

function destroyPane(pane) {
  if (pane.mainChart) pane.mainChart.remove();
  for (const sp of pane.subPanels) if (sp.chart) sp.chart.remove();
}

// ── Pane factory ──────────────────────────────────────────────────────────────
function makePane(i, el) {
  const defaultSrc = i % 2 === 0 ? "hyperliquid" : "yfinance";

  const pane = {
    index:       i,
    el,
    source:      localStorage.getItem(`p${i}_src`) || defaultSrc,
    symbol:      localStorage.getItem(`p${i}_sym`) || null,
    interval:    localStorage.getItem(`p${i}_tf`)  || "1h",
    lastPrice:   null,
    rawBars:     [],
    mainChart:   null,
    mainSeries:  null,
    overlayInds: [],   // {uid, def, params, series:[]}
    subPanels:   [],   // {uid, def, params, chart, series:[], el}
    indUidSeq:   0,
  };

  // Restore saved indicators
  try {
    pane._savedInds = JSON.parse(localStorage.getItem(`p${i}_inds`) || "[]");
  } catch { pane._savedInds = []; }

  const srcSel = el.querySelector(".src-select");
  const symInp = el.querySelector(".sym-input");
  const symDl  = el.querySelector(".sym-datalist");
  // Stamp unique datalist id (required for <input list=> to work)
  const dlId = `sym-dl-${i}-${Date.now()}`;
  symInp.setAttribute("list", dlId);
  symDl.setAttribute("id", dlId);
  const tfSel  = el.querySelector(".tf-select");
  const indBtn = el.querySelector(".ind-btn");
  const indPop = el.querySelector(".ind-popup");

  srcSel.value = pane.source;
  populateSymbolDatalist(symDl, pane.source);
  symInp.value = pane.symbol || defaultSymbol(pane.source);
  pane.symbol  = symInp.value;
  populateIntervals(tfSel, pane.interval);

  srcSel.addEventListener("change", () => {
    pane.source = srcSel.value;
    populateSymbolDatalist(symDl, pane.source);
    symInp.value = defaultSymbol(pane.source);
    pane.symbol  = symInp.value;
    savePaneState(pane);
    loadChart(pane);
  });

  symInp.addEventListener("change", () => {
    pane.symbol = symInp.value.trim().toUpperCase() || pane.symbol;
    symInp.value = pane.symbol;
    savePaneState(pane);
    loadChart(pane);
  });
  // Allow Enter to commit
  symInp.addEventListener("keydown", e => { if (e.key === "Enter") symInp.blur(); });

  tfSel.addEventListener("change", () => {
    pane.interval = tfSel.value;
    savePaneState(pane);
    loadChart(pane);
  });

  // Indicator button
  indBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !indPop.classList.contains("hidden");
    document.querySelectorAll(".ind-popup").forEach(p => p.classList.add("hidden"));
    if (!open) indPop.classList.remove("hidden");
  });
  document.addEventListener("click", () => indPop.classList.add("hidden"));
  indPop.addEventListener("click", e => e.stopPropagation());

  buildIndicatorPopup(pane);
  return pane;
}

// ── Symbol datalist / dropdown ────────────────────────────────────────────────
function populateSymbolDatalist(dl, source) {
  dl.innerHTML = "";
  const groups = SYMBOL_LISTS[source] || {};
  for (const syms of Object.values(groups)) {
    for (const sym of syms) {
      const opt = document.createElement("option");
      opt.value = sym;
      dl.appendChild(opt);
    }
  }
}

function defaultSymbol(source) {
  const groups = SYMBOL_LISTS[source] || {};
  const first  = Object.values(groups)[0];
  return first?.[0] || "BTC";
}

function populateIntervals(sel, preferred) {
  sel.innerHTML = "";
  for (const iv of INTERVALS) {
    const o = document.createElement("option");
    o.value = iv; o.textContent = iv;
    sel.appendChild(o);
  }
  if (preferred) sel.value = preferred;
}

function savePaneState(pane) {
  const i = pane.index;
  localStorage.setItem(`p${i}_src`, pane.source);
  localStorage.setItem(`p${i}_sym`, pane.symbol);
  localStorage.setItem(`p${i}_tf`,  pane.interval);
}

function saveIndicatorState(pane) {
  const saved = [
    ...pane.overlayInds.map(ind => ({ uid:ind.uid, id:ind.def.id, params:ind.params })),
    ...pane.subPanels.map(sp   => ({ uid:sp.uid,   id:sp.def.id,  params:sp.params  })),
  ];
  localStorage.setItem(`p${pane.index}_inds`, JSON.stringify(saved));
}

// ── Chart load ────────────────────────────────────────────────────────────────
async function loadChart(pane) {
  // Remove old charts
  if (pane.mainChart)  pane.mainChart.remove();
  for (const sp of pane.subPanels) { if (sp.chart) sp.chart.remove(); sp.el.remove(); }
  pane.mainChart = null; pane.mainSeries = null;
  pane.overlayInds = []; pane.subPanels  = [];

  const stack = pane.el.querySelector(".charts-stack");
  // Clear sub-panel elements (main-chart-container stays)
  [...stack.querySelectorAll(".sub-panel")].forEach(e => e.remove());

  const container = stack.querySelector(".main-chart-container");

  pane.el.querySelector(".ticker-symbol").textContent = pane.symbol;
  pane.el.querySelector(".ticker-price").textContent  = "…";
  pane.el.querySelector(".ind-chips").innerHTML       = "";

  const chart = makeChart(container);
  const series = chart.addCandlestickSeries({
    upColor:"#3fb950", downColor:"#f85149",
    borderUpColor:"#3fb950", borderDownColor:"#f85149",
    wickUpColor:"#3fb950", wickDownColor:"#f85149",
  });
  pane.mainChart  = chart;
  pane.mainSeries = series;

  watchResize(container, chart);

  // Fetch candles
  try {
    const url = `/api/candles?source=${pane.source}&symbol=${encodeURIComponent(pane.symbol)}&interval=${pane.interval}&limit=300`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.bars?.length) {
      pane.rawBars = data.bars;
      series.setData(data.bars);
      chart.timeScale().fitContent();
      updateTicker(pane, data.bars[data.bars.length - 1].close, null);
    }
  } catch (e) { console.error("loadChart", e); }

  // Restore saved indicators
  const saved = pane._savedInds || [];
  pane._savedInds = [];
  for (const s of saved) addIndicator(pane, s.id, s.params, s.uid);
}

// ── Chart factory (consistent theme) ─────────────────────────────────────────
function makeChart(container, height) {
  const opts = {
    layout:   { background:{ color:"#161b22" }, textColor:"#e6edf3" },
    grid:     { vertLines:{ color:"#21262d" }, horzLines:{ color:"#21262d" } },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ borderColor:"#30363d" },
    timeScale:{ borderColor:"#30363d", timeVisible:true, secondsVisible:false },
    width:  container.clientWidth,
    height: height || container.clientHeight,
  };
  return LightweightCharts.createChart(container, opts);
}

function watchResize(container, chart) {
  new ResizeObserver(() => {
    if (chart) chart.resize(container.clientWidth, container.clientHeight);
  }).observe(container);
}

// ── Indicator picker popup ────────────────────────────────────────────────────
function buildIndicatorPopup(pane) {
  const pop = pane.el.querySelector(".ind-popup");
  const cats = {};
  for (const d of IND_CATALOGUE) {
    (cats[d.cat] = cats[d.cat] || []).push(d);
  }
  // Search box
  const searchHtml = `<input class="ind-search" placeholder="Search indicators…" />`;
  let html = searchHtml;
  for (const [cat, items] of Object.entries(cats)) {
    html += `<div class="ind-cat-label">${cat}</div>`;
    for (const d of items) {
      html += `<div class="ind-item" data-id="${d.id}">${d.label}</div>`;
    }
  }
  pop.innerHTML = html;

  pop.querySelector(".ind-search").addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    pop.querySelectorAll(".ind-item").forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
    pop.querySelectorAll(".ind-cat-label").forEach(el => {
      const sib = el.nextElementSibling;
      el.style.display = (sib && sib.style.display !== "none") ? "" : "none";
    });
  });

  pop.querySelectorAll(".ind-item").forEach(item => {
    item.addEventListener("click", () => {
      const def = IND_MAP[item.dataset.id];
      pop.classList.add("hidden");
      if (def.custom) {
        openCustomEditor(pane, def);
      } else {
        addIndicator(pane, def.id, { ...def.defaults });
      }
    });
  });
}

// ── Add indicator ─────────────────────────────────────────────────────────────
function addIndicator(pane, id, params = {}, uid = null) {
  const def = IND_MAP[id];
  if (!def || !pane.rawBars.length) return;
  uid = uid || `${id}_${++pane.indUidSeq}`;
  params = { ...def.defaults, ...params };

  if (def.overlay) {
    applyOverlayIndicator(pane, def, params, uid);
  } else {
    applySubPanelIndicator(pane, def, params, uid);
  }
  addChip(pane, uid, def, params);
  saveIndicatorState(pane);
}

// ── Overlay indicators ────────────────────────────────────────────────────────
function applyOverlayIndicator(pane, def, params, uid) {
  const bars  = pane.rawBars;
  const close = bars.map(b => b.close);
  const high  = bars.map(b => b.high);
  const low   = bars.map(b => b.low);
  const vol   = bars.map(b => b.volume);
  const toSeries = (vals, color = params.color || "#ffffff", lw = 1) => {
    const s = pane.mainChart.addLineSeries({ color, lineWidth: lw, priceLineVisible:false, lastValueVisible:false });
    s.setData(bars.map((b,i) => vals[i] != null ? { time:b.time, value:vals[i] } : null).filter(Boolean));
    return s;
  };
  const series = [];

  switch (def.id) {
    case "sma":  series.push(toSeries(Indicators.sma(close, params.period), params.color)); break;
    case "ema":  series.push(toSeries(Indicators.ema(close, params.period), params.color)); break;
    case "wma":  series.push(toSeries(Indicators.wma(close, params.period), params.color)); break;
    case "dema": series.push(toSeries(Indicators.dema(close, params.period), params.color)); break;
    case "tema": series.push(toSeries(Indicators.tema(close, params.period), params.color)); break;
    case "vwap": series.push(toSeries(Indicators.vwap(high, low, close, vol), params.color)); break;
    case "bb": {
      const { upper, middle, lower } = Indicators.bb(close, params.period, params.mult);
      series.push(toSeries(upper,  params.color, 1));
      series.push(toSeries(middle, params.color, 1));
      series.push(toSeries(lower,  params.color, 1));
      break;
    }
    case "supertrend": {
      const { supertrend: st, direction: dir } = Indicators.supertrend(high, low, close, params.period, params.mult);
      const upSeries = pane.mainChart.addLineSeries({ color:"#3fb950", lineWidth:2, priceLineVisible:false, lastValueVisible:false });
      const dnSeries = pane.mainChart.addLineSeries({ color:"#f85149", lineWidth:2, priceLineVisible:false, lastValueVisible:false });
      upSeries.setData(bars.map((b,i) => dir[i]===1 && st[i]!=null ? {time:b.time,value:st[i]} : null).filter(Boolean));
      dnSeries.setData(bars.map((b,i) => dir[i]===-1 && st[i]!=null ? {time:b.time,value:st[i]} : null).filter(Boolean));
      series.push(upSeries, dnSeries);
      break;
    }
    case "ichimoku": {
      const { tenkanSen, kijunSen, senkouA, senkouB } = Indicators.ichimoku(high, low, params.tenkan, params.kijun, params.senkou);
      series.push(toSeries(tenkanSen, "#e91e63", 1));
      series.push(toSeries(kijunSen,  "#2196F3", 1));
      series.push(toSeries(senkouA,   "rgba(67,160,71,0.3)", 1));
      series.push(toSeries(senkouB,   "rgba(239,83,80,0.3)", 1));
      break;
    }
  }
  pane.overlayInds.push({ uid, def, params, series });
}

// ── Sub-panel indicators ──────────────────────────────────────────────────────
function applySubPanelIndicator(pane, def, params, uid) {
  const bars  = pane.rawBars;
  const close = bars.map(b => b.close);
  const high  = bars.map(b => b.high);
  const low   = bars.map(b => b.low);
  const vol   = bars.map(b => b.volume);

  const panelEl = document.createElement("div");
  panelEl.className = "sub-panel";
  panelEl.dataset.uid = uid;
  const labelEl = document.createElement("div");
  labelEl.className = "sub-panel-label";
  labelEl.textContent = def.label;
  const closeBtn = document.createElement("button");
  closeBtn.className = "sub-panel-close"; closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => removeIndicator(pane, uid));
  labelEl.appendChild(closeBtn);
  const canvas = document.createElement("div");
  canvas.className = "sub-panel-canvas";
  panelEl.appendChild(labelEl);
  panelEl.appendChild(canvas);
  pane.el.querySelector(".charts-stack").appendChild(panelEl);

  const chart = makeChart(canvas, 130);
  watchResize(canvas, chart);
  chart.timeScale().applyOptions({ visible: false });

  // Sync time scale with main
  syncTimeScales(pane.mainChart, [chart, ...pane.subPanels.map(s => s.chart).filter(Boolean)]);

  const series = [];

  switch (def.id) {
    case "volume": {
      const vs = chart.addHistogramSeries({ priceFormat:{type:"volume"}, priceScaleId:"", lastValueVisible:false });
      vs.setData(bars.map(b => ({ time:b.time, value:b.volume, color: b.close>=b.open?"#3fb95088":"#f8514988" })));
      series.push(vs);
      break;
    }
    case "rsi": {
      const vals = Indicators.rsi(close, params.period);
      chart.addLineSeries({ color:"#888", lineWidth:1, lineStyle:2, priceLineVisible:false, lastValueVisible:false })
        .setData(bars.map((_,i) => ({time:bars[i].time, value:params.ob})).filter((_,i)=>vals[i]!=null));
      chart.addLineSeries({ color:"#888", lineWidth:1, lineStyle:2, priceLineVisible:false, lastValueVisible:false })
        .setData(bars.map((_,i) => ({time:bars[i].time, value:params.os})).filter((_,i)=>vals[i]!=null));
      const s = chart.addLineSeries({ color:params.color||"#a855f7", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      s.setData(bars.map((b,i)=>vals[i]!=null?{time:b.time,value:vals[i]}:null).filter(Boolean));
      series.push(s);
      break;
    }
    case "macd": {
      const { macd:ml, signal:sl, histogram:hl } = Indicators.macd(close, params.fast, params.slow, params.signal);
      const hist = chart.addHistogramSeries({ priceLineVisible:false, lastValueVisible:false });
      hist.setData(bars.map((b,i)=>hl[i]!=null?{time:b.time,value:hl[i],color:hl[i]>=0?"#3fb950aa":"#f85149aa"}:null).filter(Boolean));
      const ms = chart.addLineSeries({ color:"#2196F3", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      ms.setData(bars.map((b,i)=>ml[i]!=null?{time:b.time,value:ml[i]}:null).filter(Boolean));
      const ss = chart.addLineSeries({ color:"#FF9800", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      ss.setData(bars.map((b,i)=>sl[i]!=null?{time:b.time,value:sl[i]}:null).filter(Boolean));
      series.push(hist, ms, ss);
      break;
    }
    case "stoch": {
      const { k, d } = Indicators.stoch(high, low, close, params.kp, params.sk, params.sd);
      const ks = chart.addLineSeries({ color:"#2196F3", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      const ds = chart.addLineSeries({ color:"#FF9800", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      ks.setData(bars.map((b,i)=>k[i]!=null?{time:b.time,value:k[i]}:null).filter(Boolean));
      ds.setData(bars.map((b,i)=>d[i]!=null?{time:b.time,value:d[i]}:null).filter(Boolean));
      series.push(ks, ds);
      break;
    }
    case "cci": {
      const vals = Indicators.cci(high, low, close, params.period);
      const s = chart.addLineSeries({ color:params.color||"#f97316", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      s.setData(bars.map((b,i)=>vals[i]!=null?{time:b.time,value:vals[i]}:null).filter(Boolean));
      series.push(s);
      break;
    }
    case "williamsr": {
      const vals = Indicators.williamsR(high, low, close, params.period);
      const s = chart.addLineSeries({ color:params.color||"#ec4899", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      s.setData(bars.map((b,i)=>vals[i]!=null?{time:b.time,value:vals[i]}:null).filter(Boolean));
      series.push(s);
      break;
    }
    case "atr": {
      const vals = Indicators.atr(high, low, close, params.period);
      const s = chart.addLineSeries({ color:params.color||"#f59e0b", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      s.setData(bars.map((b,i)=>vals[i]!=null?{time:b.time,value:vals[i]}:null).filter(Boolean));
      series.push(s);
      break;
    }
    case "obv": {
      const vals = Indicators.obv(close, vol);
      const s = chart.addLineSeries({ color:params.color||"#22d3ee", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
      s.setData(bars.map((b,i)=>({time:b.time,value:vals[i]})));
      series.push(s);
      break;
    }
  }

  pane.subPanels.push({ uid, def, params, chart, series, el: panelEl });
}

// ── Remove indicator ──────────────────────────────────────────────────────────
function removeIndicator(pane, uid) {
  // Overlay
  const oi = pane.overlayInds.findIndex(d => d.uid === uid);
  if (oi !== -1) {
    for (const s of pane.overlayInds[oi].series) pane.mainChart.removeSeries(s);
    pane.overlayInds.splice(oi, 1);
  }
  // Sub-panel
  const si = pane.subPanels.findIndex(d => d.uid === uid);
  if (si !== -1) {
    pane.subPanels[si].chart.remove();
    pane.subPanels[si].el.remove();
    pane.subPanels.splice(si, 1);
  }
  pane.el.querySelector(`.ind-chip[data-uid="${uid}"]`)?.remove();
  saveIndicatorState(pane);
}

// ── Indicator chips ───────────────────────────────────────────────────────────
function addChip(pane, uid, def, params) {
  const chips = pane.el.querySelector(".ind-chips");
  const chip  = document.createElement("span");
  chip.className = "ind-chip";
  chip.dataset.uid = uid;
  const label = def.id === "sma" || def.id === "ema" || def.id === "wma" || def.id === "dema" || def.id === "tema"
    ? `${def.label}(${params.period})` : def.id === "rsi" ? `RSI(${params.period})`
    : def.id === "bb" ? `BB(${params.period},${params.mult})` : def.id === "macd"
    ? `MACD(${params.fast},${params.slow},${params.signal})` : def.label;
  chip.innerHTML = `<span class="chip-label">${label}</span><span class="chip-x" title="Remove">×</span>`;
  chip.querySelector(".chip-x").addEventListener("click", () => removeIndicator(pane, uid));
  chips.appendChild(chip);
}

// ── Custom indicator editor (JS + Pine) ───────────────────────────────────────
function openCustomEditor(pane, def) {
  const modal = document.getElementById("custom-modal");
  const tabJs   = modal.querySelector(".tab-js");
  const tabPine = modal.querySelector(".tab-pine");
  const editor  = modal.querySelector(".pine-editor");
  const errBox  = modal.querySelector(".pine-error");
  const applyBtn = modal.querySelector(".pine-apply");
  const cancelBtn = modal.querySelector(".pine-cancel");
  const transpiled = modal.querySelector(".pine-transpiled");

  let mode = def.mode || "js";

  const setTab = (m) => {
    mode = m;
    tabJs.classList.toggle("active",   m === "js");
    tabPine.classList.toggle("active", m === "pine");
    if (editor.value === PineEngine.JS_TEMPLATE || editor.value === PineEngine.PINE_TEMPLATE || !editor.value) {
      editor.value = m === "js" ? PineEngine.JS_TEMPLATE : PineEngine.PINE_TEMPLATE;
    }
    transpiled.style.display = "none";
  };

  tabJs.addEventListener("click",   () => setTab("js"));
  tabPine.addEventListener("click", () => setTab("pine"));
  setTab(mode);

  errBox.textContent      = "";
  transpiled.style.display = "none";

  modal.classList.remove("hidden");

  applyBtn.onclick = () => {
    const code = editor.value;
    if (!pane.rawBars.length) {
      errBox.textContent = "Load a chart first."; return;
    }
    const result = PineEngine.run(code, pane.rawBars, mode);
    if (!result.ok) {
      errBox.textContent = `Error: ${result.error}`;
      if (result.transpiled) {
        transpiled.style.display = "block";
        transpiled.textContent   = result.transpiled;
      }
      return;
    }
    errBox.textContent = "";
    if (result.transpiled) {
      transpiled.style.display = "block";
      transpiled.textContent   = result.transpiled;
    }

    // Register a custom indicator entry per plot
    for (const plot of result.plots) {
      const uid = `custom_${++pane.indUidSeq}`;
      applyCustomPlot(pane, uid, plot, result.hlines, pane.rawBars);
      const chipDef = { id:"custom", label: plot.title || "Custom" };
      addChip(pane, uid, chipDef, {});
    }
    modal.classList.add("hidden");
  };

  cancelBtn.onclick = () => modal.classList.add("hidden");
  modal.querySelector(".modal-close").onclick = () => modal.classList.add("hidden");
}

function applyCustomPlot(pane, uid, plot, hlines, bars) {
  if (plot.overlay) {
    const s = pane.mainChart.addLineSeries({
      color: plot.color, lineWidth: plot.lineWidth || 1,
      priceLineVisible:false, lastValueVisible:false,
    });
    s.setData(bars.map((b,i) => plot.data[i]!=null ? {time:b.time,value:plot.data[i]} : null).filter(Boolean));
    pane.overlayInds.push({ uid, def:{id:"custom",label:plot.title,overlay:true}, params:{}, series:[s] });
  } else {
    const panelEl = document.createElement("div");
    panelEl.className = "sub-panel"; panelEl.dataset.uid = uid;
    const labelEl = document.createElement("div");
    labelEl.className = "sub-panel-label"; labelEl.textContent = plot.title;
    const closeBtn = document.createElement("button");
    closeBtn.className = "sub-panel-close"; closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => removeIndicator(pane, uid));
    labelEl.appendChild(closeBtn);
    const canvas = document.createElement("div"); canvas.className = "sub-panel-canvas";
    panelEl.appendChild(labelEl); panelEl.appendChild(canvas);
    pane.el.querySelector(".charts-stack").appendChild(panelEl);

    const chart = makeChart(canvas, 130);
    watchResize(canvas, chart);
    chart.timeScale().applyOptions({ visible:false });
    syncTimeScales(pane.mainChart, [chart]);

    let s;
    if (plot.type === "histogram") {
      s = chart.addHistogramSeries({ color:plot.color, priceLineVisible:false, lastValueVisible:false });
    } else {
      s = chart.addLineSeries({ color:plot.color, lineWidth:plot.lineWidth||1, priceLineVisible:false, lastValueVisible:false });
    }
    s.setData(bars.map((b,i)=>plot.data[i]!=null?{time:b.time,value:plot.data[i]}:null).filter(Boolean));

    // Hlines
    for (const hl of (hlines||[])) {
      const hs = chart.addLineSeries({ color:hl.color||"#888", lineWidth:hl.lineWidth||1, lineStyle:2, priceLineVisible:false, lastValueVisible:false });
      hs.setData(bars.map(b=>({time:b.time,value:hl.value})));
    }

    pane.subPanels.push({ uid, def:{id:"custom",label:plot.title,overlay:false}, params:{}, chart, series:[s], el:panelEl });
  }
}

// ── Time scale sync ───────────────────────────────────────────────────────────
let _syncing = false;
function syncTimeScales(main, subs) {
  const all = [main, ...subs];
  const sync = (src, range) => {
    if (_syncing || !range) return;
    _syncing = true;
    for (const c of all) if (c !== src) {
      try { c.timeScale().setVisibleLogicalRange(range); } catch {}
    }
    _syncing = false;
  };
  for (const c of all) c.timeScale().subscribeVisibleLogicalRangeChange(r => sync(c, r));
}

// ── Ticker ────────────────────────────────────────────────────────────────────
function updateTicker(pane, newPrice, _changeStr) {
  const priceEl = pane.el.querySelector(".ticker-price");
  const prev    = pane.lastPrice;
  pane.lastPrice = newPrice;
  priceEl.textContent = fmtPrice(newPrice);
  priceEl.classList.remove("flash-green", "flash-red");
  if (prev !== null) {
    const cls = newPrice >= prev ? "flash-green" : "flash-red";
    priceEl.classList.add(cls);
    setTimeout(() => priceEl.classList.remove(cls), 600);
  }
}

function fmtPrice(p) {
  if (p == null) return "—";
  if (p >= 1000)  return p.toLocaleString("en-IN", { maximumFractionDigits:2 });
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

// ── Hyperliquid WebSocket ─────────────────────────────────────────────────────
function connectHyperliquid() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  hlSocket = new WebSocket(`${proto}//${location.host}/ws/hyperliquid`);

  hlSocket.addEventListener("message", (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.channel !== "allMids") return;
      const mids = msg.data.mids;
      for (const pane of panes) {
        if (pane.source !== "hyperliquid") continue;
        const price = parseFloat(mids[pane.symbol.toUpperCase()]);
        if (isNaN(price)) continue;
        updateTicker(pane, price, null);
        if (pane.mainSeries) {
          const now = Math.floor(Date.now() / 1000);
          try { pane.mainSeries.update({ time:now, open:price, high:price, low:price, close:price }); } catch {}
        }
      }
    } catch {}
  });

  hlSocket.addEventListener("close", () => setTimeout(connectHyperliquid, 3000));
}

// ── yfinance poller ───────────────────────────────────────────────────────────
function startYFinancePoller() {
  setInterval(async () => {
    for (const pane of panes) {
      if (pane.source !== "yfinance") continue;
      try {
        const r = await fetch(`/api/quote?source=yfinance&symbol=${encodeURIComponent(pane.symbol)}`);
        const d = await r.json();
        if (d.price != null) {
          updateTicker(pane, d.price, null);
          if (pane.mainSeries) {
            try { pane.mainSeries.update({ time: d.time || Math.floor(Date.now()/1000), open:d.price,high:d.price,low:d.price,close:d.price }); } catch {}
          }
        }
      } catch {}
    }
  }, POLL_MS);
}
