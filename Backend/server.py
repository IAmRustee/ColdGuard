# ColdGuard backend: Flask + CSV (no database) + Random Forest
#
# One process does both jobs:
#   1. DATA LOGGER (formerly logger.py): the ESP32 POSTs a temperature over WiFi,
#      we compute the rolling features and append a row to readings.csv.
#   2. CLASSIFIER: the Random Forest scores the features of that logged row
#      (normal / warning / excursion) and the label + confidence are saved
#      in the same row. The mobile app reads the results back via GET /readings.
#
# readings.csv is the source of truth. On startup the server rebuilds its
# in-memory history from it, so a restart doesn't reset the rolling features.
# If the file is in the old logger.py format (6 columns, no "confidence"),
# it is upgraded automatically (a backup is kept as readings.csv.bak).
#
# Install: pip install flask flask-cors pandas joblib numpy scikit-learn==1.8.0
#          (use the same scikit-learn version you trained with)
# Run:     python server.py        (single process only)
#
# ESP32 -> POST http://<server-ip>:5000/reading   {"temp_c": 4.5}
#          (/readings and the key "temperature" are accepted too, so the
#           firmware for either old script keeps working)
import csv
import math
import os
import random
import shutil
import threading
import time
from collections import deque
from datetime import datetime
import requests

import joblib
import numpy as np
import pandas as pd
from flask import Flask, request, jsonify
from flask_cors import CORS

NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "coldguard-x7k2q9")
NOTIFY_COOLDOWN_S = {"warning": 10, "excursion": 10}   # seconds, per status
last_notified = {"warning": 0.0, "excursion": 0.0}

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "RandomForest.joblib")  # saved at the end of the notebook
CSV_PATH = os.path.join(BASE_DIR, "readings.csv")

# CSV columns. The first 6 are exactly the logger.py / validation.csv columns,
# so this file can be appended to the training data to retrain later.
FIELDS = [
    "timestamp", "temp_c", "rolling_mean_5m", "rolling_std_5m",
    "rate_of_change_1m", "excursion_phase", "confidence",
]
FEATURES = FIELDS[1:5]  # exact column order used in training
LABELS = {0: "normal", 1: "warning", 2: "excursion"}  # notebook: 0/1/2

LOW, HIGH = 2.0, 8.0  
STATS_WINDOW_S = 300   
ROC_LAG_S = 60        
ROC_TOLERANCE_S = 15   
HISTORY_S = 3600       
TEMP_MIN, TEMP_MAX = -50.0, 100.0

model = joblib.load(MODEL_PATH)
lock = threading.Lock()  # one writer at a time (run a single server process)
history = deque()        # in-memory copy of the last hour of the CSV, oldest first


def new_csv():
    with open(CSV_PATH, "w", newline="") as f:
        csv.writer(f).writerow(FIELDS)


def load_history():
    """Rebuild `history` from readings.csv (creating / upgrading it if needed)."""
    if not os.path.exists(CSV_PATH) or os.path.getsize(CSV_PATH) == 0:
        new_csv()
        return

    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        old_fields = reader.fieldnames or []
        rows = list(reader)

    if "timestamp" not in old_fields or "temp_c" not in old_fields:
        raise RuntimeError(f"{CSV_PATH} doesn't look like a ColdGuard log "
                           f"(columns found: {old_fields})")

    if old_fields != FIELDS:  # e.g. written by the old logger.py: add "confidence"
        shutil.copy(CSV_PATH, CSV_PATH + ".bak")
        with open(CSV_PATH, "w", newline="") as f:
            w = csv.DictWriter(f, FIELDS, restval="", extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)
        print(f"Upgraded {CSV_PATH} to the new columns (backup: {CSV_PATH}.bak)")

    cutoff = time.time() - HISTORY_S
    for r in rows:
        try:
            ts = datetime.fromisoformat(r["timestamp"]).timestamp()
            if ts < cutoff:
                continue
            history.append({
                "ts": ts,
                "temperature": float(r["temp_c"]),
                "status": r["excursion_phase"],
                "confidence": float(r["confidence"]) if r.get("confidence") else None,
            })
        except (KeyError, ValueError):
            continue  # skip a damaged row instead of refusing to start


load_history()

def send_notification(title, message, priority="high", tags="warning"):
    try:
        requests.post(
            f"https://ntfy.sh/{NTFY_TOPIC}",
            data=message.encode("utf-8"),
            headers={"Title": title, "Priority": priority, "Tags": tags},
            timeout=5,
        )
    except requests.RequestException as e:
        print(f"Notification failed: {e}")

def build_features(temp, ts):
    """Same definitions as the training data / logger.py (30 s sampling):
    - rolling_mean_5m / rolling_std_5m: all readings in the last 5 minutes,
      including the current one. std is population std (ddof=0).
    - rate_of_change_1m: current temp minus the temp ~1 minute ago, 0 if
      there is no reading from then (e.g. right after startup).
    """
    window = [temp]
    prev = None
    best = None
    for h in reversed(history):
        age = ts - h["ts"]
        if age >= STATS_WINDOW_S:
            break
        if age > 0:
            window.append(h["temperature"])
            diff = abs(age - ROC_LAG_S)
            if diff <= ROC_TOLERANCE_S and (best is None or diff < best):
                best, prev = diff, h["temperature"]
    return {
        "temp_c": temp,
        "rolling_mean_5m": round(float(np.mean(window)), 3),
        "rolling_std_5m": round(float(np.std(window)), 3),
        "rate_of_change_1m": round(temp - prev, 3) if prev is not None else 0.0,
    }


def classify(feats):
    t = feats["temp_c"]
    # Safety net: outside the hard limits is always an excursion.
    # Delete these two lines if you want the model alone to decide.
    X = pd.DataFrame([feats])[FEATURES]
    proba = model.predict_proba(X)[0]
    i = int(proba.argmax())
    return LABELS[int(model.classes_[i])], float(proba[i])


def save(temp, ts=None):
    """Log one reading: features -> CSV row -> model label stored on that row."""
    live = ts is None          # seed() passes fake timestamps, so it never notifies
    ts = ts or time.time()
    notify = False
    with lock:
        prev_status = history[-1]["status"] if history else None
        feats = build_features(temp, ts)
        status, conf = classify(feats)
        row = {
            "timestamp": datetime.fromtimestamp(ts).isoformat(timespec="seconds"),
            **feats,
            "excursion_phase": status,
            "confidence": round(conf, 4),
        }
        with open(CSV_PATH, "a", newline="") as f:
            csv.DictWriter(f, FIELDS).writerow(row)
        history.append(
            {"ts": ts, "temperature": temp, "status": status, "confidence": conf}
        )
        while history and ts - history[0]["ts"] > HISTORY_S:
            history.popleft()

        if (status == "warning" or status == "excursion"):
            if status == "excursion":
                args = ("COLDGUARD EXCURSION",
                f"Fridge at {temp:.1f}°C is OUTSIDE the 2-8°C range "
                f"(model confidence {conf:.0%}). Check it now.",
                "urgent", "rotating_light")
            else:
                args = ("ColdGuard warning",
                f"Fridge at {temp:.1f}°C is close to the 2-8°C limit "
                f"(model confidence {conf:.0%}). Check the fridge.",
                "high", "warning")
            threading.Thread(target=send_notification, args=args, daemon=True).start()
    return status, conf

def parse_temp(data):
    """Accept {"temp_c": 4.5} (logger.py) or {"temperature": 4.5} (old server.py)."""
    if not isinstance(data, dict):
        return None
    for key in ("temp_c", "temperature"):
        if key in data:
            try:
                t = float(data[key])
            except (TypeError, ValueError):
                return None
            return t if math.isfinite(t) and TEMP_MIN <= t <= TEMP_MAX else None
    return None


# ESP32 sends: {"temp_c": 4.5}
@app.post("/reading")
@app.post("/readings")
def add_reading():
    temp = parse_temp(request.get_json(force=True, silent=True))
    if temp is None:
        return jsonify(error='bad payload, expected {"temp_c": <number>}'), 400
    status, conf = save(temp)
    print(f"{temp:.2f} C  {status} ({conf:.2f})")
    return jsonify({"ok": True, "status": status, "confidence": conf})


# App reads the past hour
@app.get("/readings")
def get_readings():
    since = time.time() - HISTORY_S
    with lock:
        rows = [
            {
                "temperature": h["temperature"],
                "status": h["status"],
                "confidence": h["confidence"],
                "created_at": int(h["ts"]),
            }
            for h in history
            if h["ts"] >= since
        ]
    return jsonify(rows)


# DEMO ONLY: fake data para makita agad ang chart (open /seed?confirm=yes sa browser)
# WARNING: this replaces readings.csv, so real ESP32 readings are removed from it.
# A copy is saved first as readings.csv.bak-<unix time>.
@app.get("/seed")
def seed():
    if request.args.get("confirm") != "yes":
        return jsonify(error="This replaces readings.csv with fake data. "
                             "Open /seed?confirm=yes to continue."), 400
    with lock:
        if os.path.exists(CSV_PATH) and os.path.getsize(CSV_PATH) > 0:
            shutil.copy(CSV_PATH, f"{CSV_PATH}.bak-{int(time.time())}")
        history.clear()
        new_csv()
    now = time.time()
    for i in range(120):  # 120 readings x 30 sec = 1 hour
        temp = random.uniform(3.5, 5.5)
        if i > 100:  # simulate excursion sa dulo
            temp = 5.5 + (i - 100) * 0.25
        save(round(temp, 2), now - (120 - i) * 30)
    return jsonify({"seeded": 120})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
