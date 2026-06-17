"""
Flask backend for the trading dashboard.

Routes
------
GET  /                     → serve index.html
GET  /api/symbols          → {source: {group: [symbols]}}
GET  /api/candles          → ?source=&symbol=&interval=&limit=
GET  /api/quote            → ?source=&symbol=   (latest price only)
WS   /ws/hyperliquid       → proxy Hyperliquid live trade stream
"""

from flask import Flask, jsonify, request, render_template
from flask_sock import Sock
import json, threading, websocket as ws_client
from data_source import fetch_ohlcv, SYMBOL_LISTS, INTERVALS, _hl_all_coins

app = Flask(__name__)
sock = Sock(app)

# ── REST ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/symbols")
def api_symbols():
    return jsonify({"symbols": SYMBOL_LISTS, "intervals": INTERVALS})


@app.route("/api/hl-symbols")
def api_hl_symbols():
    """Live-fetch all Hyperliquid perp coins (bypasses startup cache)."""
    return jsonify({"coins": _hl_all_coins()})


@app.route("/api/candles")
def api_candles():
    source   = request.args.get("source", "hyperliquid")
    symbol   = request.args.get("symbol", "BTC")
    interval = request.args.get("interval", "1h")
    limit    = int(request.args.get("limit", 200))
    try:
        bars = fetch_ohlcv(source, symbol, interval, limit)
        return jsonify({"bars": bars})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/quote")
def api_quote():
    source = request.args.get("source", "hyperliquid")
    symbol = request.args.get("symbol", "BTC")
    try:
        bars = fetch_ohlcv(source, symbol, "1m", 1)
        if bars:
            return jsonify({"price": bars[-1]["close"], "time": bars[-1]["time"]})
        return jsonify({"error": "no data"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── WebSocket proxy: Hyperliquid live trades ──────────────────────────────────

_hl_subscribers: list = []
_hl_lock = threading.Lock()
_hl_thread = None


def _hl_on_message(wsapp, message):
    data = json.loads(message)
    with _hl_lock:
        dead = []
        for client in _hl_subscribers:
            try:
                client.send(message)
            except Exception:
                dead.append(client)
        for d in dead:
            _hl_subscribers.remove(d)


def _hl_connect():
    """Keep a persistent upstream connection to Hyperliquid."""
    HL_WS = "wss://api.hyperliquid.xyz/ws"
    while True:
        try:
            app_ws = ws_client.WebSocketApp(
                HL_WS,
                on_message=_hl_on_message,
            )
            # Subscribe to all mid prices once connected
            def on_open(wsapp):
                wsapp.send(json.dumps({"method": "subscribe", "subscription": {"type": "allMids"}}))
            app_ws.on_open = on_open
            app_ws.run_forever(ping_interval=20)
        except Exception:
            import time; time.sleep(3)


@sock.route("/ws/hyperliquid")
def ws_hyperliquid(ws):
    global _hl_thread
    if _hl_thread is None or not _hl_thread.is_alive():
        _hl_thread = threading.Thread(target=_hl_connect, daemon=True)
        _hl_thread.start()

    with _hl_lock:
        _hl_subscribers.append(ws)
    try:
        # Keep alive: block until client disconnects
        while True:
            ws.receive()   # will raise when client closes
    except Exception:
        pass
    finally:
        with _hl_lock:
            if ws in _hl_subscribers:
                _hl_subscribers.remove(ws)


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
