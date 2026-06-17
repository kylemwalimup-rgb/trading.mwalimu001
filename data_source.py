"""
Pluggable data source layer.

To add a new broker/exchange:
1. Implement fetch(symbol, interval, limit) -> list[dict]
   Each dict: {time (unix s), open, high, low, close, volume}
2. Register in DATA_SOURCES
3. Add symbols to SYMBOL_LISTS
"""

import os, time, requests
from datetime import datetime, timezone
import yfinance as yf
from tvDatafeed import TvDatafeed, Interval as TvInterval

# ── Hyperliquid ───────────────────────────────────────────────────────────────

_HL_INTERVAL_MAP = {
    "1m":"1m","5m":"5m","15m":"15m","30m":"30m",
    "1h":"1h","4h":"4h","1d":"1d",
}
_HL_MS = {"1m":60e3,"5m":300e3,"15m":900e3,"30m":1.8e6,"1h":3.6e6,"4h":14.4e6,"1d":86.4e6}

def _hl_fetch(symbol: str, interval: str, limit: int = 200) -> list[dict]:
    iv = _HL_INTERVAL_MAP.get(interval, "1h")
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - int(_HL_MS.get(iv, 3.6e6) * limit)
    payload = {"type":"candleSnapshot","req":{"coin":symbol.upper(),"interval":iv,"startTime":start_ms,"endTime":end_ms}}
    try:
        r = requests.post("https://api.hyperliquid.xyz/info", json=payload, timeout=10)
        r.raise_for_status()
        return [{"time":int(c["t"])//1000,"open":float(c["o"]),"high":float(c["h"]),
                 "low":float(c["l"]),"close":float(c["c"]),"volume":float(c["v"])}
                for c in r.json()[-limit:]]
    except Exception:
        return []

def _hl_all_coins() -> list[str]:
    try:
        r = requests.post("https://api.hyperliquid.xyz/info", json={"type":"meta"}, timeout=10)
        return sorted(a["name"] for a in r.json()["universe"])
    except Exception:
        return ["BTC","ETH","SOL","BNB","DOGE","XRP","AVAX","MATIC","LINK","ARB",
                "OP","SUI","APT","INJ","ATOM","DOT","LTC","BCH","ETC","FTM",
                "NEAR","SAND","MANA","AXS","THETA","GRT","AAVE","CRV","SNX","COMP",
                "MKR","UNI","1INCH","ZRX","BAT","ENJ","CHZ","IMX","GMX","BLUR",
                "PEPE","WIF","BONK","JTO","PYTH","TIA","SEI","MEME","ORDI","STX"]

# ── yfinance ──────────────────────────────────────────────────────────────────

_YF_IV = {"1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"60m","4h":"60m","1d":"1d","1w":"1wk"}

def _yf_fetch(symbol: str, interval: str, limit: int = 200) -> list[dict]:
    iv = _YF_IV.get(interval, "1d")
    period = "7d" if iv in ("1m","5m","15m","30m","60m") else "2y"
    try:
        df = yf.Ticker(symbol).history(period=period, interval=iv)
        if df.empty:
            return []
        df = df.tail(limit)
        return [{"time":int(ts.timestamp()),"open":round(float(r["Open"]),6),
                 "high":round(float(r["High"]),6),"low":round(float(r["Low"]),6),
                 "close":round(float(r["Close"]),6),"volume":int(r["Volume"])}
                for ts, r in df.iterrows()]
    except Exception:
        return []

# ── TradingView (tvDatafeed) ──────────────────────────────────────────────────
# No API key needed. Symbol format: "SYMBOL:EXCHANGE" e.g. "XAUUSD:FX_IDC"

_TV_IV = {
    "1m": TvInterval.in_1_minute,
    "5m": TvInterval.in_5_minute,
    "15m": TvInterval.in_15_minute,
    "30m": TvInterval.in_30_minute,
    "1h": TvInterval.in_1_hour,
    "4h": TvInterval.in_4_hour,
    "1d": TvInterval.in_daily,
    "1w": TvInterval.in_weekly,
}
_tv = None

def _get_tv():
    global _tv
    if _tv is None:
        _tv = TvDatafeed()
    return _tv

def _tv_fetch(symbol: str, interval: str, limit: int = 200) -> list[dict]:
    global _tv
    parts = symbol.split(":", 1)
    sym = parts[0]
    exchange = parts[1] if len(parts) > 1 else "FX_IDC"
    iv = _TV_IV.get(interval, TvInterval.in_1_hour)
    for attempt in range(2):
        try:
            df = _get_tv().get_hist(sym, exchange, interval=iv, n_bars=limit)
            if df is None or df.empty:
                if attempt == 0:
                    _tv = None  # force reconnect
                    continue
                return []
            return [
                {
                    "time":   int(ts.timestamp()),
                    "open":   round(float(row["open"]),  6),
                    "high":   round(float(row["high"]),  6),
                    "low":    round(float(row["low"]),   6),
                    "close":  round(float(row["close"]), 6),
                    "volume": int(float(row.get("volume") or 0)),
                }
                for ts, row in df.iterrows()
            ]
        except Exception:
            _tv = None  # force reconnect on next attempt
    return []


# ── Twelve Data ───────────────────────────────────────────────────────────────
# Free tier: 800 calls/day, 8 calls/min. Set TWELVEDATA_API_KEY env var.

_TD_IV = {
    "1m":"1min","5m":"5min","15m":"15min","30m":"30min",
    "1h":"1h","4h":"4h","1d":"1day","1w":"1week",
}

def _td_fetch(symbol: str, interval: str, limit: int = 200) -> list[dict]:
    api_key = os.environ.get("TWELVEDATA_API_KEY", "")
    if not api_key:
        raise ValueError("TWELVEDATA_API_KEY environment variable not set. "
                         "Get a free key at https://twelvedata.com/pricing")
    iv = _TD_IV.get(interval, "1h")
    params = {
        "symbol": symbol,
        "interval": iv,
        "outputsize": limit,
        "apikey": api_key,
        "format": "JSON",
    }
    try:
        r = requests.get("https://api.twelvedata.com/time_series", params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        if data.get("status") == "error":
            raise ValueError(data.get("message", "Twelve Data error"))
        values = data.get("values", [])
        bars = []
        for v in reversed(values):
            dt = datetime.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S" if " " in v["datetime"] else "%Y-%m-%d")
            bars.append({
                "time": int(dt.replace(tzinfo=timezone.utc).timestamp()),
                "open":  float(v["open"]),
                "high":  float(v["high"]),
                "low":   float(v["low"]),
                "close": float(v["close"]),
                "volume": int(float(v.get("volume") or 0)),
            })
        return bars[-limit:]
    except Exception as e:
        raise


# ── Stubs for future brokers ──────────────────────────────────────────────────

def _alpaca_fetch(symbol, interval, limit=200):
    raise NotImplementedError("Configure ALPACA_API_KEY/SECRET and implement.")

def _binance_fetch(symbol, interval, limit=200):
    raise NotImplementedError("Implement with python-binance or REST.")

def _zerodha_fetch(symbol, interval, limit=200):
    raise NotImplementedError("Implement with kiteconnect.")

def _polygon_fetch(symbol, interval, limit=200):
    raise NotImplementedError("Configure POLYGON_API_KEY and implement.")

# ── Registry ──────────────────────────────────────────────────────────────────

DATA_SOURCES = {
    "hyperliquid": _hl_fetch,
    "yfinance":    _yf_fetch,
    "tradingview": _tv_fetch,
    "twelvedata":  _td_fetch,
    "alpaca":      _alpaca_fetch,
    "binance":     _binance_fetch,
    "zerodha":     _zerodha_fetch,
    "polygon":     _polygon_fetch,
}

# ── Symbol lists ──────────────────────────────────────────────────────────────

def _build_symbol_lists():
    hl_coins = _hl_all_coins()

    return {
        "hyperliquid": {
            "Crypto Perps": hl_coins,
        },
        "tradingview": {
            "Forex – Metals": [
                "XAUUSD:FX_IDC","XAGUSD:FX_IDC","XPTUSD:FX_IDC","XPDUSD:FX_IDC",
                "XAUEUR:FX_IDC","XAUGBP:FX_IDC","XAUJPY:FX_IDC","XAUINR:FX_IDC",
            ],
            "Forex – Majors": [
                "EURUSD:FX_IDC","GBPUSD:FX_IDC","USDJPY:FX_IDC","AUDUSD:FX_IDC",
                "USDCAD:FX_IDC","USDCHF:FX_IDC","NZDUSD:FX_IDC","USDINR:FX_IDC",
            ],
            "Forex – Crosses": [
                "EURGBP:FX_IDC","EURJPY:FX_IDC","GBPJPY:FX_IDC","EURAUD:FX_IDC",
                "GBPAUD:FX_IDC","AUDJPY:FX_IDC","CADJPY:FX_IDC","CHFJPY:FX_IDC",
            ],
            "Indices": [
                "SPX500USD:OANDA","NAS100USD:OANDA","US30USD:OANDA",
                "GER40EUR:OANDA","UK100GBP:OANDA","JP225USD:OANDA",
            ],
            "Crypto": [
                "BTCUSD:BINANCE","ETHUSD:BINANCE","SOLUSD:BINANCE",
                "BNBUSD:BINANCE","XRPUSD:BINANCE","DOGEUSD:BINANCE",
            ],
        },
        "yfinance": {
            # ── Forex ──────────────────────────────────────────────────────
            "Forex – Majors": [
                "EURUSD=X","GBPUSD=X","USDJPY=X","AUDUSD=X",
                "USDCAD=X","USDCHF=X","NZDUSD=X",
            ],
            "Forex – EUR Crosses": [
                "EURGBP=X","EURJPY=X","EURCAD=X","EURAUD=X",
                "EURNZD=X","EURCHF=X","EURSGD=X","EURHKD=X",
            ],
            "Forex – GBP Crosses": [
                "GBPJPY=X","GBPCAD=X","GBPAUD=X","GBPNZD=X",
                "GBPCHF=X","GBPSGD=X",
            ],
            "Forex – AUD Crosses": [
                "AUDJPY=X","AUDCAD=X","AUDNZD=X","AUDCHF=X","AUDSGD=X",
            ],
            "Forex – Other Crosses": [
                "CADJPY=X","CADCHF=X","NZDJPY=X","NZDCAD=X",
                "NZDCHF=X","CHFJPY=X","SGDJPY=X","NZDSGD=X",
            ],
            "Forex – USD Emerging": [
                "USDINR=X","USDCNH=X","USDCNY=X","USDKRW=X","USDSGD=X",
                "USDHKD=X","USDTWD=X","USDTHB=X","USDMYR=X","USDPHP=X",
                "USDMXN=X","USDBRL=X","USDZAR=X","USDTRY=X","USDNOK=X",
                "USDSEK=X","USDDKK=X","USDPLN=X","USDCZK=X","USDHUF=X",
                "USDILS=X","USDSAR=X","USDAED=X","USDRUB=X","USDNGN=X",
                "USDEGP=X","USDPKR=X","USDBDT=X","USDVND=X","USDKWD=X",
            ],
            # ── Crypto Spot ────────────────────────────────────────────────
            "Crypto Spot – Large Cap": [
                "BTC-USD","ETH-USD","BNB-USD","SOL-USD","XRP-USD",
                "ADA-USD","AVAX-USD","DOGE-USD","DOT-USD","MATIC-USD",
                "SHIB-USD","LTC-USD","BCH-USD","LINK-USD","UNI-USD",
                "ATOM-USD","XLM-USD","ALGO-USD","VET-USD","FIL-USD",
            ],
            "Crypto Spot – Mid Cap": [
                "HBAR-USD","NEAR-USD","FTM-USD","SAND-USD","MANA-USD",
                "AXS-USD","THETA-USD","ETC-USD","GRT-USD","AAVE-USD",
                "CRV-USD","SNX-USD","COMP-USD","MKR-USD","SUSHI-USD",
                "YFI-USD","1INCH-USD","ZRX-USD","BAT-USD","ENJ-USD",
                "CHZ-USD","APE-USD","GALA-USD","IMX-USD","OP-USD",
                "ARB11841-USD","SUI20947-USD","APT21794-USD","PEPE24478-USD",
                "WIF-USD","BONK-USD",
            ],
            "Crypto Spot – INR": [
                "BTC-INR","ETH-INR","BNB-INR","SOL-INR","XRP-INR",
                "DOGE-INR","MATIC-INR","ADA-INR","DOT-INR","LINK-INR",
            ],
            # ── Commodities ────────────────────────────────────────────────
            "Commodities – Metals": [
                "GC=F","SI=F","PL=F","PA=F","HG=F","ALI=F",
            ],
            "Commodities – Energy": [
                "CL=F","BZ=F","NG=F","RB=F","HO=F",
            ],
            "Commodities – Agriculture": [
                "ZC=F","ZW=F","ZS=F","ZM=F","ZL=F",
                "KC=F","CT=F","SB=F","OJ=F","CC=F",
                "LE=F","GF=F","HE=F",
            ],
            # ── Global Indices ─────────────────────────────────────────────
            "Indices – India": [
                "^NSEI","^BSESN","^NSEBANK","^CNXIT","^NSMIDCP50",
            ],
            "Indices – USA": [
                "^GSPC","^DJI","^IXIC","^RUT","^VIX","^NDX","DX-Y.NYB",
            ],
            "Indices – Europe": [
                "^FTSE","^GDAXI","^FCHI","^STOXX50E",
                "^AEX","^IBEX","^SSMI","^FTMIB","^BFX",
            ],
            "Indices – Asia-Pacific": [
                "^N225","^HSI","^STI","^AXJO","^KS11","^TWII","^KLSE","^SET.BK",
            ],
            "Indices – Bonds/Rates": [
                "^TNX","^TYX","^IRX","^FVX",
            ],
            # ── Indian Stocks (NSE) ────────────────────────────────────────
            "India – Nifty 50": [
                "RELIANCE.NS","TCS.NS","HDFCBANK.NS","ICICIBANK.NS","INFY.NS",
                "SBIN.NS","HINDUNILVR.NS","BAJFINANCE.NS","LT.NS","KOTAKBANK.NS",
                "AXISBANK.NS","ASIANPAINT.NS","MARUTI.NS","TITAN.NS","WIPRO.NS",
                "HCLTECH.NS","SUNPHARMA.NS","ULTRACEMCO.NS","ADANIENT.NS","ADANIPORTS.NS",
                "NESTLEIND.NS","BAJAJFINSV.NS","TECHM.NS","POWERGRID.NS","ONGC.NS",
                "TATAMOTORS.NS","TATASTEEL.NS","NTPC.NS","JSWSTEEL.NS","COALINDIA.NS",
                "BPCL.NS","GRASIM.NS","DRREDDY.NS","DIVISLAB.NS","CIPLA.NS",
                "EICHERMOT.NS","HEROMOTOCO.NS","M&M.NS","BAJAJ-AUTO.NS","INDUSINDBK.NS",
                "UPL.NS","BRITANNIA.NS","HINDALCO.NS","APOLLOHOSP.NS","TATACONSUM.NS",
                "BHARTIARTL.NS","ITC.NS","SHREECEM.NS","HDFCLIFE.NS","SBILIFE.NS",
            ],
            "India – Midcap": [
                "DABUR.NS","PIDILITIND.NS","BERGEPAINT.NS","GODREJCP.NS","MARICO.NS",
                "COLPAL.NS","SIEMENS.NS","ABB.NS","HAVELLS.NS","IRCTC.NS",
                "NAUKRI.NS","ZOMATO.NS","TRENT.NS","DMART.NS","TATAPOWER.NS",
                "BANKBARODA.NS","PNB.NS","CANBK.NS","IDFCFIRSTB.NS","FEDERALBNK.NS",
                "AUBANK.NS","MANAPPURAM.NS","CHOLAFIN.NS","MUTHOOTFIN.NS","SHRIRAMFIN.NS",
                "RECLTD.NS","PFC.NS","IRFC.NS","HUDCO.NS","NHPC.NS","SJVN.NS",
                "ADANIGREEN.NS","ADANIPOWER.NS","TORNTPOWER.NS","CESC.NS","JSWENERGY.NS",
                "MPHASIS.NS","COFORGE.NS","PERSISTENT.NS","LTIM.NS","HAPPSTMNDS.NS",
                "INFOEDGE.NS","INDIAMART.NS","JUSTDIAL.NS","POLICYBAZAAR.NS","PAYTM.NS",
                "DELHIVERY.NS","BIKAJI.NS","NAZARA.NS","VEDANTA.NS","RBLBANK.NS","YESBANK.NS",
            ],
            "India – PSU/Banks": [
                "SBIN.NS","BANKBARODA.NS","PNB.NS","CANBK.NS","UNIONBANK.NS",
                "INDIANB.NS","BANKINDIA.NS","CENTRALBK.NS","MAHABANK.NS","IOB.NS",
                "RECLTD.NS","PFC.NS","IRFC.NS","HUDCO.NS","RITES.NS","IRCON.NS",
                "ONGC.NS","OIL.NS","BPCL.NS","IOC.NS","HINDPETRO.NS","MRPL.NS",
                "COALINDIA.NS","NMDC.NS","MOIL.NS","SAIL.NS","NALCO.NS","HINDZINC.NS",
            ],
            # ── US Stocks ──────────────────────────────────────────────────
            "US – Mega Cap": [
                "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","BRK-B",
                "UNH","JPM","V","PG","MA","HD","ABBV","MRK","CVX","PEP",
                "COST","AVGO","KO","LLY","WMT","TMO","BAC","ACN","MCD",
                "ABT","CSCO","DHR","NEE","ADBE","TXN","CRM","CMCSA","NFLX",
            ],
            "US – Tech": [
                "AMD","INTC","QCOM","MU","AMAT","LRCX","KLAC","ASML","TSM",
                "ORCL","SAP","INTU","PANW","FTNT","CRWD","ZS","OKTA","NET",
                "SNOW","DDOG","MDB","PLTR","AI","PATH","U","RBLX","COIN",
                "MSTR","HOOD","SOFI","UPST","AFRM",
            ],
            "US – Finance": [
                "GS","MS","AXP","SCHW","BLK","SPGI","ICE","CME","MCO",
                "V","MA","PYPL","SQ","SOFI","LC","NU","ALLY","HOOD",
            ],
            "US – Energy/Commodities": [
                "XOM","CVX","COP","EOG","PXD","DVN","HAL","SLB","BKR",
                "FCX","NEM","GOLD","AA","CLF","X","NUE","STLD",
            ],
            "US – Healthcare": [
                "JNJ","UNH","PFE","ABT","MRK","ABBV","BMY","AMGN","GILD",
                "REGN","VRTX","BIIB","ILMN","IDXX","TMO","DHR","IQV","ZBH",
            ],
            # ── ETFs ───────────────────────────────────────────────────────
            "ETFs – Broad Market": [
                "SPY","QQQ","IWM","DIA","VTI","VOO","VEA","VWO","EEM","IEFA",
            ],
            "ETFs – Sector": [
                "XLK","XLF","XLE","XLV","XLI","XLU","XLY","XLP","XLRE","XLB","XLC",
                "SOXX","ARKK","ARKW","ARKG","ARKF","BOTZ","JETS","VNQ","MSOS",
            ],
            "ETFs – Commodities/Bonds": [
                "GLD","SLV","IAU","USO","UNG","TLT","IEF","SHY","HYG","LQD",
                "PDBC","DJP","BCI","WOOD","MOO","WEAT",
            ],
            "ETFs – Leveraged": [
                "SPXL","TQQQ","SQQQ","SDS","UVXY","SVXY","SPXS","LABD","SOXL","SOXS",
                "NRGU","NRGD","TECL","TECS","FAS","FAZ","TNA","TZA",
            ],
        },
    }

# Build at import time (fetches HL symbols)
SYMBOL_LISTS = _build_symbol_lists()
INTERVALS = ["1m","5m","15m","30m","1h","4h","1d","1w"]


def fetch_ohlcv(source: str, symbol: str, interval: str, limit: int = 200) -> list[dict]:
    fn = DATA_SOURCES.get(source)
    if fn is None:
        raise ValueError(f"Unknown source {source!r}. Available: {list(DATA_SOURCES)}")
    return fn(symbol, interval, limit)
