#!/usr/bin/env python3
"""Fetch the numbers dashboard.html shows and write out/market.json.

Runs in GitHub Actions (see .github/workflows/dashboard-data.yml). Standard library only.
A source that fails never aborts the run: the item keeps its last good value, flagged stale.
"""
import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "*/*",
}


def get(url, timeout=20, tries=2):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - any network/HTTP failure just means "try again / next source"
            last = e
            time.sleep(1.5)
    raise last


def quote(price, prev, t=None):
    price = float(price)
    out = {"p": round(price, 4), "t": t}
    if prev not in (None, 0):
        prev = float(prev)
        out["c"] = round(price - prev, 4)
        out["pc"] = round((price - prev) / prev * 100, 3)
    return out


def q_yahoo(sym):
    err = None
    for host in ("query1", "query2"):
        try:
            url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range=1d&interval=1d"
            meta = json.loads(get(url, tries=1))["chart"]["result"][0]["meta"]
            prev = meta.get("chartPreviousClose") or meta.get("previousClose")
            t = meta.get("regularMarketTime")
            return quote(meta["regularMarketPrice"], prev, t * 1000 if t else None)
        except Exception as e:  # noqa: BLE001
            err = e
    raise err


def q_cboe(sym):
    d = json.loads(get(f"https://cdn.cboe.com/api/global/delayed_quotes/quotes/{sym}.json"))["data"]
    price = d["current_price"]
    prev = d.get("prev_day_close")
    if prev in (None, 0) and d.get("price_change") is not None:
        prev = float(price) - float(d["price_change"])
    if float(price) == 0:
        raise ValueError("zero price")
    return quote(price, prev, None)


def q_fred(series):
    rows = list(csv.reader(io.StringIO(get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"))))[1:]
    vals = [(r[0], float(r[1])) for r in rows if len(r) > 1 and r[1] not in ("", ".")]
    (d1, v1), (_, v0) = vals[-1], vals[-2]
    t = int(datetime.strptime(d1, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
    return quote(v1, v0, t)


SOURCES = {"yahoo": q_yahoo, "cboe": q_cboe, "fred": q_fred}

# (label shown on the dashboard, kind, [(source, symbol), ...] tried in order)
ITEMS = [
    ("VIX", "idx", [("cboe", "_VIX"), ("yahoo", "^VIX")]),
    ("VIXEQ", "idx", [("cboe", "_VIXEQ"), ("yahoo", "^VIXEQ")]),
    ("DXY", "idx", [("yahoo", "DX-Y.NYB")]),
    ("USD02Y", "yield", [("fred", "DGS2")]),
    ("USD10Y", "yield", [("yahoo", "^TNX"), ("fred", "DGS10")]),
    ("USD20Y", "yield", [("fred", "DGS20")]),
    ("USD30Y", "yield", [("yahoo", "^TYX"), ("fred", "DGS30")]),
    ("ZB1!", "fut", [("yahoo", "ZB=F")]),
    ("NQ1!", "fut", [("yahoo", "NQ=F")]),
    ("ES1!", "fut", [("yahoo", "ES=F")]),
    ("CL1!", "fut", [("yahoo", "CL=F")]),
    ("GC1!", "fut", [("yahoo", "GC=F")]),
    ("YM1!", "fut", [("yahoo", "YM=F")]),
    ("RTY1!", "fut", [("yahoo", "RTY=F")]),
]


def fix_yield(q):
    # Some feeds quote yields x10 (e.g. 42.5 for 4.25%).
    if q["p"] > 25:
        for k in ("p", "c"):
            if k in q:
                q[k] = round(q[k] / 10, 4)
    q.pop("pc", None)  # % change of a yield is not meaningful; the dashboard shows the point change
    return q


def fear_greed():
    d = json.loads(get("https://production.dataviz.cnn.io/index/fearandgreed/graphdata"))
    f = d["fear_and_greed"]

    def num(v):
        return None if v is None else round(float(v), 1)

    return {
        "score": num(f["score"]),
        "prev": num(f.get("previous_close")),
        "week": num(f.get("previous_1_week")),
        "month": num(f.get("previous_1_month")),
        "year": num(f.get("previous_1_year")),
        "t": f.get("timestamp"),
    }


def load_previous():
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        return {}
    try:
        return json.loads(get(f"https://raw.githubusercontent.com/{repo}/data/market.json", tries=1))
    except Exception:  # noqa: BLE001 - first run: there is no previous file
        return {}


def build(prev):
    prev_items = {i["label"]: i for i in prev.get("items", [])}
    items, fresh, log = [], 0, []
    for label, kind, chain in ITEMS:
        got, used = None, None
        for src, sym in chain:
            try:
                got = SOURCES[src](sym)
                if kind == "yield":
                    got = fix_yield(got)
                used = f"{src}:{sym}"
                break
            except Exception as e:  # noqa: BLE001
                log.append(f"  {label:7} {src}:{sym} failed: {type(e).__name__}: {e}")
        if got:
            fresh += 1
            items.append({"label": label, "kind": kind, "src": used, **got})
        elif label in prev_items:
            old = dict(prev_items[label])
            old["stale"] = True
            items.append(old)
        else:
            items.append({"label": label, "kind": kind, "p": None})

    fng, fng_ok = None, False
    try:
        fng, fng_ok = fear_greed(), True
    except Exception as e:  # noqa: BLE001
        log.append(f"  fear&greed failed: {type(e).__name__}: {e}")
        fng = prev.get("fng")

    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "items": items, "fng": fng}
    return out, fresh, fng_ok, log


def main():
    out, fresh, fng_ok, log = build(load_previous())
    for it in out["items"]:
        state = "stale" if it.get("stale") else ("ok" if it.get("p") is not None else "MISSING")
        print(f"{it['label']:7} {state:8} {it.get('p')}  {it.get('src', '')}")
    print(f"fear&greed {'ok' if fng_ok else 'FAILED'}: {out['fng']}")
    if log:
        print("failures:")
        print("\n".join(log))
    if fresh == 0 and not fng_ok:
        print("nothing fetched, leaving the published file untouched")
        sys.exit(1)
    os.makedirs("out", exist_ok=True)
    with open("out/market.json", "w") as fh:
        json.dump(out, fh, separators=(",", ":"))


if __name__ == "__main__":
    main()
