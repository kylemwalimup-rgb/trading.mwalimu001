# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
# Install once
pip install -r requirements.txt

# Start the server (runs on http://localhost:5000)
python app.py
```

The app runs entirely locally — no deployment, no external services beyond the Hyperliquid WebSocket and yfinance HTTP calls.

## Architecture

```
app.py               Flask entry point + WebSocket proxy to Hyperliquid
data_source.py       All broker integrations — the only file that touches external APIs
templates/index.html Single-page shell, clones <template> for each chart pane
static/js/dashboard.js Full frontend logic (no build step, no framework)
static/css/style.css  Grid layout, ticker flash animations, dark theme
```

### Data flow

1. **Hyperliquid (crypto)**: Browser connects to `/ws/hyperliquid` → Flask (`flask-sock`) holds that socket and fans out messages from a single upstream `wss://api.hyperliquid.xyz/ws` connection maintained in a daemon thread (`_hl_connect`). The subscription message (`allMids`) is sent on upstream `on_open`.

2. **yfinance (Indian/US stocks)**: Purely REST. Frontend polls `/api/quote` every 15 s. Historical candles come from `/api/candles` which calls `fetch_ohlcv()` in `data_source.py`.

3. **Historical candles**: Both sources share the same `/api/candles?source=&symbol=&interval=&limit=` endpoint. `data_source.py:fetch_ohlcv()` dispatches to the correct function via `DATA_SOURCES` dict.

### Frontend (no build step)

- `buildGrid(n)` tears down all existing Lightweight Charts instances and recreates `n` pane DOM nodes from the `<template>` tag, then sets `data-count` on `#grid` — CSS grid columns/rows are driven entirely by that attribute.
- Each pane tracks state in a plain JS object (`panes[]`). Per-pane selections (source, symbol, timeframe) are persisted in `localStorage` keyed by pane index.
- `connectHyperliquid()` is called once; on close it reconnects after 3 s. All panes with `source === "hyperliquid"` receive updates from the single socket.
- `ResizeObserver` keeps each Lightweight Charts instance in sync with its container as the grid resizes.

## Adding a new broker

1. Implement `_mybroke_fetch(symbol, interval, limit) -> list[dict]` in `data_source.py`. Each dict: `{time, open, high, low, close, volume}` where `time` is Unix seconds.
2. Add it to `DATA_SOURCES` dict.
3. Add its symbols to `SYMBOL_LISTS` so the frontend dropdown picks them up.
4. If it has a push feed, add a new WS route in `app.py` mirroring `ws_hyperliquid`.

## Grid layouts

| chart count | CSS columns | CSS rows |
|-------------|-------------|----------|
| 1 | 1fr | 1fr |
| 2 | 1fr 1fr | 1fr |
| 4 | 1fr 1fr | 1fr 1fr |
| 6 | 1fr 1fr 1fr | 1fr 1fr |
| 8 | 1fr 1fr 1fr 1fr | 1fr 1fr |

Controlled by `#grid[data-count="N"]` selectors in `style.css`.
