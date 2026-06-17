/**
 * pine.js — Two-mode custom indicator engine
 *
 * Mode 1 – JavaScript (primary):
 *   Users write JS directly. Available globals:
 *     close, open, high, low, volume  (Float64Array-like plain arrays)
 *     ta.*   (all Indicators functions)
 *     plot(arr, opts)   opts: {title, color, lineWidth, overlay, type}
 *     hline(value, opts) opts: {title, color, lineWidth}
 *     input(name, defaultVal)  → returns defaultVal (rendered as labelled inputs later)
 *     vadd/vsub/vmul/vdiv/vabs/vmax/vmin/nz  (vectorised helpers)
 *
 * Mode 2 – PineScript (beta transpiler):
 *   Handles the most common Pine v5 patterns via text substitution then eval.
 *   Limitations noted inline.
 */

"use strict";

const PineEngine = (() => {

  // ── PineScript → JS transpiler ────────────────────────────────────────────

  const PINE_COLORS = {
    "color.red":     "#ef5350", "color.green":   "#26a69a", "color.blue":    "#2196F3",
    "color.orange":  "#FF9800", "color.yellow":  "#FFEB3B", "color.purple":  "#9C27B0",
    "color.fuchsia": "#E91E63", "color.lime":    "#8BC34A", "color.aqua":    "#00BCD4",
    "color.teal":    "#009688", "color.white":   "#FAFAFA", "color.black":   "#212121",
    "color.gray":    "#9E9E9E", "color.silver":  "#BDBDBD", "color.maroon":  "#880E4F",
    "color.navy":    "#1A237E", "color.olive":   "#827717", "color.new(color.red,80)":   "rgba(239,83,80,0.2)",
    "color.new(color.green,80)": "rgba(38,166,154,0.2)", "color.new(color.blue,80)": "rgba(33,150,243,0.2)",
  };

  function transpilePine(script) {
    let js = script;

    // Strip version and study/indicator declarations
    js = js.replace(/\/\/@version=\d+\s*/g, "");
    js = js.replace(/^(study|indicator|strategy)\s*\([^)]*\)\s*/gm, "");

    // Comments: // and /* */ stay valid JS

    // color.new(color.X, transparency)
    js = js.replace(/color\.new\s*\(([^,)]+),\s*(\d+)\)/g, (_, c, t) => {
      const base = PINE_COLORS[c.trim()] || "#888";
      const alpha = Math.round((1 - parseInt(t) / 100) * 255).toString(16).padStart(2, "0");
      return `"${base}${alpha}"`;
    });

    // Named colors
    for (const [k, v] of Object.entries(PINE_COLORS)) {
      js = js.split(k).join(`"${v}"`);
    }

    // input.* → __input(name, default)
    js = js.replace(/input\.(int|float|bool|string|source)\s*\(([^,)]+)(?:,\s*(?:title\s*=\s*)?"([^"]*)")?\s*(?:,[^)]*)?\)/g,
      (_, type, def, title) => `__input("${title || def}", ${def})`);
    js = js.replace(/input\s*\(([^,)]+)(?:,\s*"([^"]*)")?\s*(?:,[^)]*)?\)/g,
      (_, def, title) => `__input("${title || def}", ${def})`);

    // na → null
    js = js.replace(/\bna\b/g, "null");

    // nz(x) / nz(x, y)
    js = js.replace(/\bnz\s*\(([^,)]+)(?:,\s*([^)]+))?\)/g,
      (_, x, y) => `nz(${x}${y ? ", " + y : ""})`);

    // math.* → Math.*
    js = js.replace(/\bmath\./g, "Math.");

    // ta.* — keep as-is (our ta namespace matches Pine's ta namespace)

    // series[n] back-indexing: close[1] → shift(close, 1)
    js = js.replace(/(\w+)\[(\d+)\]/g, (_, s, n) => `shift(${s}, ${parseInt(n)})`);

    // hline(price, "title", color) → hline(price, {title:"title", color:color})
    js = js.replace(/\bhline\s*\(([^,)]+)(?:,\s*"([^"]*)")?(?:,\s*([^)]+))?\)/g,
      (_, val, title, color) =>
        `__hline(${val}, {title:"${title||""}", color:${color||'"#888"'}})`);

    // plot(series, "title", color, lw) → plot(series, {title, color, lineWidth})
    js = js.replace(/\bplot\s*\(([^,)]+)(?:,\s*"([^"]*)")?(?:,\s*([^,)]+))?(?:,\s*(\d+))?\s*\)/g,
      (_, s, title, color, lw) =>
        `__plot(${s}, {title:"${title||""}", color:${color||'"#2196F3"'}, lineWidth:${lw||1}})`);

    // plotshape / plotarrow — basic stub
    js = js.replace(/\bplotshape\b[^)]*\)/g, "/* plotshape not supported */");
    js = js.replace(/\bplotarrow\b[^)]*\)/g, "/* plotarrow not supported */");

    // bgcolor — stub
    js = js.replace(/\bbgcolor\b[^)]*\)/g, "/* bgcolor not supported */");

    // fill — stub
    js = js.replace(/\bfill\b[^)]*\)/g, "/* fill not supported */");

    // var keyword (persistent) → let (JS; full persistence across bars not emulated)
    js = js.replace(/\bvar\s+(float|int|bool|string|line|label|box)?\s*/g, "let ");
    js = js.replace(/\b(float|int|bool|series)\s+/g, "let ");

    // Pine assignment without keyword: allow implicitly if no let/const/var prefix
    // Convert plain assignments that aren't already prefixed
    // (Simple heuristic: if a line starts with an identifier =, prefix with let)
    js = js.replace(/^([a-zA-Z_]\w*)\s*=/gm, (m, id) => {
      const keywords = new Set(["let","const","var","if","else","for","while","return","function"]);
      return keywords.has(id) ? m : `let ${id} =`;
    });

    // ternary ? : already valid JS

    // Operators: and/or/not
    js = js.replace(/\band\b/g, "&&").replace(/\bor\b/g, "||").replace(/\bnot\b/g, "!");

    return js;
  }

  // ── Execution sandbox ──────────────────────────────────────────────────────

  function run(code, bars, mode = "js") {
    const close  = bars.map(b => b.close);
    const open   = bars.map(b => b.open);
    const high   = bars.map(b => b.high);
    const low    = bars.map(b => b.low);
    const volume = bars.map(b => b.volume);
    const times  = bars.map(b => b.time);

    const hl2   = bars.map(b => (b.high + b.low) / 2);
    const hlc3  = bars.map(b => (b.high + b.low + b.close) / 3);
    const ohlc4 = bars.map(b => (b.open + b.high + b.low + b.close) / 4);

    const plots  = [];
    const hlines = [];
    const inputs = {};

    const __plot = (arr, opts = {}) => {
      if (!Array.isArray(arr)) return;
      plots.push({
        data:      arr,
        title:     opts.title     || `Plot ${plots.length + 1}`,
        color:     opts.color     || "#2196F3",
        lineWidth: opts.lineWidth || 1,
        overlay:   opts.overlay   !== undefined ? opts.overlay : true,
        type:      opts.type      || "line",   // line | histogram | area
        paneIndex: opts.pane      || 0,        // 0=main, 1+=sub
      });
    };

    const __hline = (value, opts = {}) => {
      hlines.push({
        value,
        title:     opts.title     || "",
        color:     opts.color     || "#888888",
        lineWidth: opts.lineWidth || 1,
      });
    };

    const __input = (title, defaultVal) => {
      inputs[title] = defaultVal;
      return defaultVal;
    };

    // Build ta namespace from Indicators
    const ta = {
      sma:        (s, p)             => Indicators.sma(s, p),
      ema:        (s, p)             => Indicators.ema(s, p),
      wma:        (s, p)             => Indicators.wma(s, p),
      dema:       (s, p)             => Indicators.dema(s, p),
      tema:       (s, p)             => Indicators.tema(s, p),
      rma:        (s, p)             => Indicators.rma(s, p),
      vwap:       (h, l, c, v)       => Indicators.vwap(h||high, l||low, c||close, v||volume),
      rsi:        (s, p)             => Indicators.rsi(s, p),
      macd:       (s, f, sl, sig)    => Indicators.macd(s, f, sl, sig),
      stoch:      (h, l, c, kp,sk,sd)=> Indicators.stoch(h||high, l||low, c||close, kp, sk, sd),
      cci:        (h, l, c, p)       => Indicators.cci(h||high, l||low, c||close, p),
      atr:        (h, l, c, p)       => Indicators.atr(h||high, l||low, c||close, p),
      bb:         (s, p, m)          => Indicators.bb(s, p, m),
      obv:        (c, v)             => Indicators.obv(c||close, v||volume),
      highest:    (s, p)             => Indicators.highest(s, p),
      lowest:     (s, p)             => Indicators.lowest(s, p),
      cross:      (a, b)             => Indicators.cross(a, b),
      crossover:  (a, b)             => Indicators.cross(a, b).map(v => v === 1  ? true : false),
      crossunder: (a, b)             => Indicators.cross(a, b).map(v => v === -1 ? true : false),
      change:     (s, l=1)           => s.map((v,i) => i<l ? null : v-s[i-l]),
      mom:        (s, l)             => s.map((v,i) => i<l ? null : v-s[i-l]),
      roc:        (s, l)             => s.map((v,i) => i<l||s[i-l]===0 ? null : (v-s[i-l])/s[i-l]*100),
    };

    // Helpers in scope
    const { vadd, vsub, vmul, vdiv, vabs, vmax, vmin, nz, shift } = Indicators;

    // Math shortcuts often used in Pine
    const abs = Math.abs, max = Math.max, min = Math.min,
          floor = Math.floor, ceil = Math.ceil, round = Math.round,
          sqrt = Math.sqrt, log = Math.log, pow = Math.pow, exp = Math.exp;

    let src = mode === "pine" ? transpilePine(code) : code;

    try {
      // eslint-disable-next-line no-new-func
      new Function(
        "close","open","high","low","volume","times",
        "hl2","hlc3","ohlc4",
        "ta","plot","hline","input","shift","vadd","vsub","vmul","vdiv","vabs","vmax","vmin","nz",
        "__plot","__hline","__input",
        "abs","max","min","floor","ceil","round","sqrt","log","pow","exp",
        src
      )(
        close, open, high, low, volume, times,
        hl2, hlc3, ohlc4,
        ta, __plot, __hline, __input, shift, vadd, vsub, vmul, vdiv, vabs, vmax, vmin, nz,
        __plot, __hline, __input,
        abs, max, min, floor, ceil, round, sqrt, log, pow, exp
      );

      return { ok: true, plots, hlines, inputs, transpiled: mode === "pine" ? src : null };
    } catch (err) {
      return { ok: false, error: err.message, transpiled: mode === "pine" ? src : null };
    }
  }

  // ── Built-in indicator templates ───────────────────────────────────────────

  const JS_TEMPLATE = `// Available series: close, open, high, low, volume
// ta.sma(src, period) | ta.ema | ta.rsi | ta.macd | ta.bb | ta.stoch | ta.atr | ta.obv | ta.vwap
// plot(array, {title, color, overlay: true/false, type: 'line'|'histogram'})
// hline(value, {title, color})
// Vectorised helpers: vadd(a,b) vsub vmul vdiv vabs vmax vmin nz(arr, default)

const ema20 = ta.ema(close, 20);
const ema50 = ta.ema(close, 50);

plot(ema20, { title: 'EMA 20', color: '#ff9900', overlay: true });
plot(ema50, { title: 'EMA 50', color: '#0099ff', overlay: true });
`;

  const PINE_TEMPLATE = `// PineScript-lite (beta) — transpiled to JS
// Supported: ta.*, plot(), hline(), input(), color.*, na, nz(), math.*
// Limitations: series arithmetic (close+sma) → use vadd(close, sma)
//              var persistence, arrays, strategies NOT supported

//@version=5
indicator("My Custom Indicator", overlay=false)

length = input(14, "RSI Length")
rsiVal = ta.rsi(close, length)

plot(rsiVal, "RSI", color.blue, 1)
hline(70, "Overbought", color.red)
hline(50, "Midline",    color.gray)
hline(30, "Oversold",   color.green)
`;

  return { run, JS_TEMPLATE, PINE_TEMPLATE, transpilePine };
})();
