"""
Desktop launcher — opens the trading dashboard in a native window.
Run with:  python run.py
"""

import threading
import time
import webview
from app import app


def _start_flask():
    app.run(port=5000, threaded=True, use_reloader=False)


if __name__ == "__main__":
    t = threading.Thread(target=_start_flask, daemon=True)
    t.start()
    time.sleep(0.8)  # give Flask a moment to bind

    window = webview.create_window(
        "Trading Dashboard",
        "http://localhost:5000",
        width=1600,
        height=960,
        min_size=(800, 500),
        resizable=True,
    )
    webview.start()
