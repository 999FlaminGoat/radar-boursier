"""Mise à jour quotidienne du Radar Boursier (GitHub Actions, gratuit).

- Lit data/universe.json (liste des titres suivis + textes et scores fixes)
- Va chercher prix, historique, ratios, dividendes, fractionnements, états financiers
  et nouvelles sur Yahoo Finance (bibliothèque yfinance, sans clé)
- Écrit data/market.json (données publiques)
- Si le secret RADAR_PASSWORD est défini : déchiffre data/private.enc.json,
  applique dividendes réinvestis (DRIP) et fractionnements à tes positions,
  ajoute un point d'historique du portefeuille, puis rechiffre le fichier.
- Le lundi (ou si absent), relit les déclarations 13F des grands investisseurs à la SEC.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import math
import os
import re
import sys
import time
import traceback
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
TODAY = dt.date.today()
SINCE = "2026-11-03"  # positions importées de Wallet.xlsm à cette date

# ---------------------------------------------------------------- utilitaires

def jload(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def jdump(p: Path, obj, compact=True):
    p.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":") if compact else None, indent=None if compact else 1)
    p.write_text(txt, encoding="utf-8")


def num(x, nd=None):
    try:
        if x is None:
            return None
        f = float(x)
        if math.isnan(f) or math.isinf(f):
            return None
        return round(f, nd) if nd is not None else f
    except Exception:
        return None


ALIAS = {"GRA.V": "GRA.TO"}  # NanoXplore est passée de la Bourse de croissance au TSX


def ysym(t: str) -> str:
    t = ALIAS.get(t, t)
    return t.replace(".B", "-B") if t.endswith(".B") else t


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- chiffrement (compatible WebCrypto)
ITER = 250_000


def _key(password: str, salt: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(password.encode())


def decrypt(blob: dict, password: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, iv, ct = (base64.b64decode(blob[k]) for k in ("salt", "iv", "ct"))
    return json.loads(AESGCM(_key(password, salt)).decrypt(iv, ct, None).decode("utf-8"))


def encrypt(obj: dict, password: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, iv = os.urandom(16), os.urandom(12)
    ct = AESGCM(_key(password, salt)).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode("utf-8"), None)
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "cipher": "AES-256-GCM", "salt": b(salt), "iv": b(iv), "ct": b(ct)}


# ---------------------------------------------------------------- Yahoo Finance
SECTOR_FR = {
    "Technology": "Technologie", "Communication Services": "Technologie", "Consumer Cyclical": "Consommation",
    "Consumer Defensive": "Consommation", "Financial Services": "Finance & Assurance", "Healthcare": "Santé",
    "Industrials": "Industrie", "Energy": "Énergie", "Basic Materials": "Matériaux", "Real Estate": "Finance & Assurance",
    "Utilities": "Énergie",
}
RATING_FR = {"strong_buy": "Achat fort", "buy": "Achat", "hold": "Conserver", "underperform": "Sous-performance", "sell": "Vente", "strong_sell": "Vente forte", "none": None}
COUNTRY_FR = {"United States": "États-Unis", "Canada": "Canada", "Japan": "Japon", "China": "Chine", "Germany": "Allemagne", "Netherlands": "Pays-Bas",
              "United Kingdom": "Royaume-Uni", "Denmark": "Danemark", "Taiwan": "Taïwan", "Italy": "Italie", "Singapore": "Singapour", "India": "Inde",
              "Switzerland": "Suisse", "France": "France", "Uruguay": "Amérique latine", "Argentina": "Amérique latine", "Brazil": "Brésil",
              "Luxembourg": "Luxembourg", "Ireland": "Irlande", "Israel": "Israël", "South Korea": "Corée du Sud", "Hong Kong": "Hong Kong"}


def ds(d) -> str:
    return d.strftime("%Y-%m-%d")


def row(df, *names):
    """Première ligne trouvée parmi plusieurs libellés possibles d'un état financier."""
    if df is None or getattr(df, "empty", True):
        return None
    for n in names:
        if n in df.index:
            return df.loc[n]
    return None


def financials(y) -> tuple[dict | None, list | None]:
    inc = y.income_stmt
    cf = y.cashflow
    bs = y.balance_sheet
    if inc is None or inc.empty:
        return None, None
    rev, gross, ni = row(inc, "Total Revenue", "Operating Revenue"), row(inc, "Gross Profit"), row(inc, "Net Income", "Net Income Common Stockholders")
    fcf = row(cf, "Free Cash Flow")
    hist = []
    for col in sorted(inc.columns):
        r = num(rev.get(col)) if rev is not None else None
        if r is None:
            continue
        hist.append({"y": f"Ex. {col.year}", "rev": r, "ni": num(ni.get(col)) if ni is not None else None,
                     "fcf": num(fcf.get(col)) if fcf is not None and col in fcf.index else None})
    hist = hist[-5:]
    # 12 derniers mois si disponibles
    fin = None
    try:
        ti, tc = y.ttm_income_stmt, y.ttm_cashflow
        if ti is not None and not ti.empty:
            c0 = ti.columns[0]
            tr, tg, tn = row(ti, "Total Revenue", "Operating Revenue"), row(ti, "Gross Profit"), row(ti, "Net Income", "Net Income Common Stockholders")
            tf = row(tc, "Free Cash Flow") if tc is not None else None
            fin = {"period": f"12 derniers mois ({c0.strftime('%m/%Y')})", "rev": num(tr.get(c0)) if tr is not None else None,
                   "gross": num(tg.get(c0)) if tg is not None else None, "ni": num(tn.get(c0)) if tn is not None else None,
                   "fcf": num(tf.iloc[0]) if tf is not None and len(tf) else None}
            hist.append({"y": f"12 mois ({c0.strftime('%m/%y')})", "rev": fin["rev"], "ni": fin["ni"], "fcf": fin["fcf"]})
    except Exception:
        fin = None
    if not fin and hist:
        last = hist[-1]
        col = sorted(inc.columns)[-1]
        fin = {"period": f"Exercice {col.year}", "rev": last["rev"], "gross": num(gross.get(col)) if gross is not None else None, "ni": last["ni"], "fcf": last["fcf"]}
    if fin:
        if fin.get("rev") and fin.get("gross") is not None:
            fin["cogs"] = fin["rev"] - fin["gross"]
        if len(hist) >= 2 and hist[-2].get("rev"):
            prev = [h for h in hist if h["y"].startswith("Ex.")]
            if len(prev) >= 2 and prev[-2]["rev"]:
                fin["revGrowth"] = round(prev[-1]["rev"] / prev[-2]["rev"] - 1, 4)
        debt = row(bs, "Total Debt")
        if debt is not None and len(debt):
            fin["debt"] = num(debt.iloc[0])
    return fin, hist or None


def news_of(y) -> list:
    out = []
    try:
        for n in (y.news or [])[:6]:
            c = n.get("content", n)
            title = c.get("title")
            when = c.get("pubDate") or c.get("displayTime")
            if not when and n.get("providerPublishTime"):
                when = dt.datetime.fromtimestamp(n["providerPublishTime"], dt.timezone.utc).isoformat()
            if title:
                out.append({"d": (when or "")[:10], "t": title, "lang": "en"})
            if len(out) >= 3:
                break
    except Exception:
        pass
    return out


def fetch_one(t: str, prev: dict, want_fin: bool, ysym_override: str | None = None) -> dict | None:
    import pandas as pd
    import yfinance as yf

    y = yf.Ticker(ysym_override or ysym(t))
    h = y.history(period="5y", interval="1d", auto_adjust=False, actions=True)
    if h is None or h.empty:
        return None
    close = h["Close"].dropna()
    if len(close) < 2:
        return None
    out: dict = {}
    last, prevc = float(close.iloc[-1]), float(close.iloc[-2])
    out["price"] = round(last, 4)
    out["chg"] = round(last / prevc - 1, 6)
    out["chgDate"] = ds(close.index[-1])
    cut = close.index[-1] - pd.Timedelta(days=366)
    old = close[close.index < cut].resample("W-FRI").last().dropna()
    new = close[close.index >= cut]
    out["h"] = [[ds(d), round(float(v), 4)] for d, v in list(old.items()) + list(new.items())]
    yr = close[close.index >= cut]
    out["hi52"], out["lo52"] = round(float(yr.max()), 4), round(float(yr.min()), 4)
    # dividendes et fractionnements (dates ex-dividende / date d'effet)
    if "Dividends" in h:
        dv = h["Dividends"][h["Dividends"] > 0]
        out["divEvents"] = [[ds(d), round(float(v), 6)] for d, v in dv.items()][-12:]
        ttm = dv[dv.index >= close.index[-1] - pd.Timedelta(days=372)]
        out["divAnnual"] = round(float(ttm.sum()), 4) if len(ttm) else 0
        if len(dv):
            out["lastDiv"] = {"exDate": ds(dv.index[-1]), "amount": round(float(dv.iloc[-1]), 6)}
    if "Stock Splits" in h:
        sp = h["Stock Splits"][h["Stock Splits"] > 0]
        out["splitEvents"] = [[ds(d), float(v)] for d, v in sp.items() if d.year >= 2020]
    # profil et ratios
    try:
        info = y.get_info() or {}
    except Exception:
        info = {}
    if info:
        out["name"] = info.get("longName") or info.get("shortName")
        out["etf"] = info.get("quoteType") == "ETF"
        if info.get("sector"):
            out["sectorAuto"] = SECTOR_FR.get(info["sector"], info["sector"])
        if info.get("country"):
            out["regionAuto"] = COUNTRY_FR.get(info["country"], info["country"])
        if info.get("currency"):
            out["cur"] = info["currency"]
        out["pe"] = num(info.get("trailingPE"), 2)
        out["fpe"] = num(info.get("forwardPE"), 2)
        out["mcap"] = num(info.get("marketCap"))
        out["beta"] = num(info.get("beta"), 3)
        out["target"] = num(info.get("targetMeanPrice"), 2)
        rk = RATING_FR.get(info.get("recommendationKey") or "none")
        n_an = info.get("numberOfAnalystOpinions")
        out["rating"] = f"{rk} ({n_an} analystes)" if rk and n_an else rk
        if num(info.get("dividendRate")) is not None:
            out["divAnnual"] = num(info.get("dividendRate"), 4)
        if info.get("exDividendDate"):
            try:
                out.setdefault("lastDiv", {})["exDate"] = ds(dt.datetime.fromtimestamp(int(info["exDividendDate"]), dt.timezone.utc))
            except Exception:
                pass
        if info.get("longBusinessSummary"):
            out["about"] = info["longBusinessSummary"][:600]
    try:
        cal = y.calendar or {}
        ed = cal.get("Earnings Date") if isinstance(cal, dict) else None
        if ed:
            d0 = ed[0] if isinstance(ed, (list, tuple)) else ed
            out["nextEarnings"] = str(d0)[:10]
        if isinstance(cal, dict) and cal.get("Dividend Date"):
            out.setdefault("lastDiv", {})["payDate"] = str(cal["Dividend Date"])[:10]
    except Exception:
        pass
    if want_fin and not out.get("etf"):
        try:
            fin, fh = financials(y)
            fc, pc = info.get("financialCurrency"), info.get("currency")
            if fin and fc and pc and fc != pc:
                # états financiers publiés dans une autre devise (ex. Toyota en yens) : conversion au taux du jour
                rh = yf.Ticker(f"{fc}{pc}=X").history(period="5d")["Close"].dropna()
                rate = float(rh.iloc[-1]) if len(rh) else None
                if rate:
                    for k in ("rev", "gross", "cogs", "ni", "fcf", "debt"):
                        if fin.get(k) is not None:
                            fin[k] = fin[k] * rate
                    for hh in fh or []:
                        for k in ("rev", "ni", "fcf"):
                            if hh.get(k) is not None:
                                hh[k] = hh[k] * rate
                    fin["converted"] = f"{fc}→{pc}"
                else:
                    fin = fh = None
            if fin:
                out["fin"], out["finHist"], out["finAt"] = fin, fh, ds(TODAY)
        except Exception as e:
            log("  états financiers indisponibles:", t, e)
    n = news_of(y)
    if n:
        out["newsAuto"] = n
    return {k: v for k, v in out.items() if v is not None}


def fetch_quick(sym: str):
    import yfinance as yf
    h = yf.Ticker(sym).history(period="10d", interval="1d")
    c = h["Close"].dropna()
    if len(c) < 2:
        return None
    return {"v": round(float(c.iloc[-1]), 4), "chg": round(float(c.iloc[-1] / c.iloc[-2] - 1), 6), "d": ds(c.index[-1])}


# ---------------------------------------------------------------- SEC 13F (grands investisseurs)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
CIKS = {"berkshire": ("0001067983", "BERKSHIRE"), "pershing": ("0001336528", "PERSHING"), "duquesne": ("0001536411", "DUQUESNE"),
        "ark": ("0001697748", "ARK INVEST"), "appaloosa": ("0001656456", "APPALOOSA")}
NAME_MAP = {"APPLE": "AAPL", "ALPHABET": "GOOGL", "AMAZON COM": "AMZN", "MICROSOFT": "MSFT", "META PLATFORMS": "META", "NVIDIA": "NVDA",
            "AMERICAN EXPRESS": "AXP", "COCA COLA": "KO", "BANK AMER": "BAC", "BANK OF AMERICA": "BAC", "CHEVRON": "CVX", "OCCIDENTAL": "OXY",
            "CHUBB": "CB", "MOODYS": "MCO", "KRAFT HEINZ": "KHC", "DAVITA": "DVA", "KROGER": "KR", "VISA": "V", "MASTERCARD": "MA",
            "UBER": "UBER", "BROOKFIELD CORP": "BN", "RESTAURANT BRANDS": "QSR.TO", "HOWARD HUGHES": "HHH", "NETFLIX": "NFLX",
            "S&P GLOBAL": "SPGI", "INTERCONTINENTAL EXCHANGE": "ICE", "TAIWAN SEMICONDUCTOR": "TSM", "NATERA": "NTRA", "STMICROELECTRONICS": "STM",
            "TESLA": "TSLA", "ADVANCED MICRO": "AMD", "SHOPIFY": "SHOP", "PALANTIR": "PLTR", "ROBINHOOD": "HOOD", "COINBASE": "COIN",
            "ROBLOX": "RBLX", "MICRON": "MU", "BOEING": "BA", "DELTA AIR": "DAL", "NEW YORK TIMES": "NYT", "ALIBABA": "BABA",
            "BROADCOM": "AVGO", "SEA LTD": "SE", "UNITEDHEALTH": "UNH", "ORACLE": "ORCL", "CROWDSTRIKE": "CRWD", "CIRCLE INTERNET": "CRCL",
            "CRISPR": "CRSP", "TEMPUS AI": "TEM", "TERADYNE": "TER", "ROKU": "ROKU", "LENNAR": "LEN", "CAPITAL ONE": "COF", "NUCOR": "NUE"}


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def http_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def norm(s):
    return re.sub(r"[^A-Z0-9& ]", "", s.upper()).replace(" INC", "").replace(" CORP", "").replace(" CO ", " ").strip()


def to_ticker(name, universe):
    n = norm(name)
    for k, t in NAME_MAP.items():
        if n.startswith(k):
            return t
    for t, u in universe.items():
        un = norm(u.get("name", ""))
        if un and (un.startswith(n[:14]) or n.startswith(un[:14])):
            return t
    return ""


def holdings_13f(cik, acc):
    acc_nd = acc.replace("-", "")
    idx = http_json(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nd}/index.json")
    files = [f["name"] for f in idx["directory"]["item"] if f["name"].lower().endswith(".xml") and "primary_doc" not in f["name"].lower()]
    if not files:
        return None
    xml = http_text(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nd}/{files[0]}")
    xml = re.sub(r'\sxmlns(:\w+)?="[^"]+"', "", xml)
    xml = re.sub(r"<(/?)\w+:", r"<\1", xml)
    root = ET.fromstring(xml)
    agg, opts = {}, []
    for it in root.iter("infoTable"):
        name = (it.findtext("nameOfIssuer") or "").strip()
        val = float(it.findtext("value") or 0)
        sh = float(it.findtext("shrsOrPrnAmt/sshPrnamt") or 0)
        pc = (it.findtext("putCall") or "").strip().lower()
        if pc:
            opts.append({"n": name, "type": pc, "v": val})
            continue
        a = agg.setdefault(name, {"v": 0.0, "sh": 0.0})
        a["v"] += val
        a["sh"] += sh
    return agg, opts


def update_investors(universe):
    invs = jload(DATA / "investors.json", [])
    by_id = {i.get("id"): i for i in invs}
    for iid, (cik, must) in CIKS.items():
        try:
            sub = http_json(f"https://data.sec.gov/submissions/CIK{cik}.json")
            if must not in (sub.get("name") or "").upper():
                log("  13F: nom inattendu pour", iid, sub.get("name"))
                continue
            r = sub["filings"]["recent"]
            idxs = [k for k, f in enumerate(r["form"]) if f == "13F-HR"][:2]
            if not idxs:
                continue
            k0 = idxs[0]
            inv = by_id.get(iid)
            if inv and inv.get("filed") == r["filingDate"][k0]:
                continue  # déjà à jour
            cur = holdings_13f(cik, r["accessionNumber"][k0])
            prv = holdings_13f(cik, r["accessionNumber"][idxs[1]]) if len(idxs) > 1 else None
            if not cur:
                continue
            agg, opts = cur
            total = sum(a["v"] for a in agg.values()) or 1
            top = sorted(agg.items(), key=lambda kv: -kv[1]["v"])[:11]
            pagg = prv[0] if prv else {}
            hold, new, up, down = [], [], [], []
            for name, a in top:
                ch = None
                if pagg:
                    p = pagg.get(name)
                    if not p:
                        ch = "Nouveau"; new.append(name.title())
                    elif a["sh"] > p["sh"] * 1.05:
                        ch = "Augmenté"; up.append(name.title())
                    elif a["sh"] < p["sh"] * 0.95:
                        ch = "Réduit"; down.append(name.title())
                hold.append({"t": to_ticker(name, universe), "n": name.title()[:28], "w": round(a["v"] / total * 100, 2), "chg": ch})
            sold = [n.title() for n in pagg if n not in agg][:4] if pagg else []
            moves = []
            if new: moves.append("Nouvelles positions parmi les plus grosses : " + ", ".join(new[:4]))
            if up: moves.append("Augmentées : " + ", ".join(up[:4]))
            if down: moves.append("Réduites : " + ", ".join(down[:4]))
            if sold: moves.append("Vendues complètement : " + ", ".join(sold))
            rep = r.get("reportDate", [""] * len(r["form"]))[k0]
            upd = {"holdings": hold, "moves": moves or ["Peu de changements parmi les plus grosses positions."], "filed": r["filingDate"][k0],
                   "period": f"Trimestre terminé le {rep}" if rep else "Dernière déclaration", "aum": total, "positions": len(agg),
                   "options": [{"t": to_ticker(o["n"], universe) or o["n"].title()[:12], "type": o["type"], "v": o["v"]} for o in sorted(opts, key=lambda o: -o["v"])[:4]] or (inv or {}).get("options"),
                   "source": "Déclaration 13F, SEC EDGAR (mise à jour automatique)", "updatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
            if inv:
                inv.update(upd)
            log("  13F mis à jour:", iid, r["filingDate"][k0])
            time.sleep(0.5)
        except Exception as e:
            log("  13F indisponible pour", iid, ":", e)
    jdump(DATA / "investors.json", invs, compact=False)


# ---------------------------------------------------------------- portefeuille privé

def qty_at(p, t, account, date, txs):
    """Quantité détenue à une date (en retirant les achats et ventes faits après)."""
    q = p["qty"]
    for x in txs:
        if x.get("t") == t and x.get("account") == account and (x.get("date") or "") > date:
            q += -x["qty"] if x.get("type") in ("buy", "drip") else x["qty"]
    return max(q, 0.0)


def price_on_or_after(hist, d):
    for dd, v in hist:
        if dd >= d:
            return v
    return hist[-1][1] if hist else None


def apply_private(priv, market, fx):
    stocks = market["stocks"]
    pos = priv.setdefault("positions", [])
    txs = priv.get("transactions", [])
    done_div = {f"{x['t']}|{x['exDate']}|{x['account']}" for x in priv.setdefault("dividends", [])}
    done_sp = {f"{x['t']}|{x['date']}" for x in priv.setdefault("splits", [])}
    since = priv.get("since", SINCE)
    held = sorted({p["t"] for p in pos if p.get("qty", 0) > 1e-9})
    n_div = n_sp = 0
    for t in held:
        m = stocks.get(t) or {}
        # fractionnements
        for d, ratio in m.get("splitEvents", []):
            if d <= since or f"{t}|{d}" in done_sp or not ratio:
                continue
            ps = [p for p in pos if p["t"] == t]
            before = {"qty": sum(p["qty"] for p in ps), "avg": (sum(p["qty"] * p["avg"] for p in ps) / max(sum(p["qty"] for p in ps), 1e-12))}
            for p in ps:
                p["qty"] = round(p["qty"] * ratio, 6)
                p["avg"] = round(p["avg"] / ratio, 6)
            after = {"qty": sum(p["qty"] for p in ps), "avg": before["avg"] / ratio}
            rev = ratio < 1
            priv["splits"].append({"t": t, "date": d, "ratio": round(1 / ratio if rev else ratio, 4), "reverse": rev, "before": before, "after": after, "appliedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
            n_sp += 1
        # dividendes réinvestis : traités 14 jours après la date ex-dividende (date de versement estimée)
        for d, amt in m.get("divEvents", []):
            if d <= since:
                continue
            pay = (dt.date.fromisoformat(d) + dt.timedelta(days=14)).isoformat()
            lp = (m.get("lastDiv") or {}).get("payDate")
            if lp and (m.get("lastDiv") or {}).get("exDate") == d:
                pay = lp
            if pay > TODAY.isoformat():
                continue
            price = price_on_or_after(m.get("h", []), pay) or m.get("price")
            if not price:
                continue
            for p in [p for p in pos if p["t"] == t]:
                key = f"{t}|{d}|{p['account']}"
                if key in done_div:
                    continue
                q = qty_at(p, t, p["account"], d, txs)
                if q <= 0:
                    continue
                w = 0.15 if p.get("cur") == "USD" else 0.0
                gross = q * amt
                net = gross * (1 - w)
                sh = net / price
                newq = p["qty"] + sh
                p["avg"] = round((p["qty"] * p["avg"] + net) / newq, 6)
                p["qty"] = round(newq, 6)
                priv["dividends"].append({"t": t, "account": p["account"], "exDate": d, "payDate": pay, "amountPerShare": amt, "gross": round(gross, 4),
                                          "withholding": w, "net": round(net, 4), "cur": p.get("cur"), "price": price, "shares": round(sh, 6),
                                          "netCAD": round(net * (fx if p.get("cur") == "USD" else 1), 4), "estimated": True,
                                          "createdAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
                done_div.add(key)
                n_div += 1
    # point d'historique du portefeuille (valeur CAD)
    total = 0.0
    for p in pos:
        m = stocks.get(p["t"]) or {}
        pr = m.get("price") or p["avg"]
        total += p["qty"] * pr * (fx if p.get("cur") == "USD" else 1)
    hist = priv.setdefault("history", [])
    d = TODAY.isoformat()
    hist[:] = [h for h in hist if h.get("d") != d] + [{"d": d, "wallet": round(total, 2), "auto": True}]
    priv["lastRun"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # alertes de prix atteintes et résultats imminents (pour la notification, sans détails)
    n_alert = 0
    for t, a in (priv.get("alerts") or {}).items():
        pr = (stocks.get(t) or {}).get("price")
        if pr is None:
            continue
        if (a.get("below") and pr <= a["below"]) or (a.get("above") and pr >= a["above"]):
            n_alert += 1
    n_earn = 0
    for t in held:
        ne = (stocks.get(t) or {}).get("nextEarnings")
        try:
            if ne and 0 <= (dt.date.fromisoformat(ne[:10]) - TODAY).days <= 2:
                n_earn += 1
        except Exception:
            pass
    priv["_notify"] = {"alerts": n_alert, "earnings": n_earn, "dividends": n_div, "splits": n_sp}
    return n_div, n_sp, total


# ---------------------------------------------------------------- programme principal

def main():
    universe = jload(DATA / "universe.json", {})
    prev = jload(DATA / "market.json", {"stocks": {}})
    pstocks = prev.get("stocks", {})
    only = set(sys.argv[1:])  # option : symboles précis
    out = {}
    fails = []
    monday = TODAY.weekday() == 0
    for i, t in enumerate(sorted(universe)):
        if only and t not in only:
            out[t] = pstocks.get(t, {})
            continue
        old = pstocks.get(t, {})
        want_fin = monday or not old.get("fin") or not old.get("finAt")
        for attempt in range(3):
            try:
                m = fetch_one(t, old, want_fin)
                if m is None:
                    raise RuntimeError("aucune donnée")
                if not want_fin:
                    for k in ("fin", "finHist", "finAt"):
                        if k in old:
                            m[k] = old[k]
                m["updatedAt"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                out[t] = m
                break
            except Exception as e:
                if attempt == 2:
                    fails.append(t)
                    log("ÉCHEC", t, e)
                    if old:
                        out[t] = old
                else:
                    time.sleep(3 * (attempt + 1))
        if i % 10 == 9:
            log(f"{i + 1}/{len(universe)} titres")
        time.sleep(0.4)

    # scores automatiques, DCF, raisons bilingues, score radar
    import smart
    for t, m in out.items():
        try:
            if m:
                smart.enrich(t, m, universe.get(t, {}))
        except Exception as e:
            log("  enrichissement impossible", t, e)
    # historique des scores (pour les tendances et les changements de verdict)
    sh = jload(DATA / "scores.json", {})
    dkey = TODAY.isoformat()
    upgrades = []
    for t, m in out.items():
        sc = m.get("radarScore") if m else None
        if sc is None:
            continue
        serie = [x for x in sh.get(t, []) if x[0] != dkey]
        if serie and smart.verdict(serie[-1][1]) != smart.verdict(sc) and sc >= 66 > serie[-1][1]:
            upgrades.append(t)
        sh[t] = (serie + [[dkey, sc]])[-180:]
    for t in list(sh):
        if t not in universe:
            del sh[t]
    jdump(DATA / "scores.json", sh)
    # découvertes hebdomadaires
    disc_file = DATA / "discover.json"
    disc = jload(disc_file, {})
    new_disc = []
    if monday or not disc.get("items") or os.environ.get("FORCE_DISCOVER"):
        try:
            items = smart.discover(universe, fetch_one, SECTOR_FR)
            if items:
                old = {i["t"] for i in disc.get("items", [])}
                new_disc = [i["t"] for i in items if i["t"] not in old][:3]
                disc = {"generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "items": items}
                jdump(disc_file, disc, compact=False)
        except Exception:
            traceback.print_exc()

    fx = (fetch_quick("CAD=X") or {}).get("v") or prev.get("fx", {}).get("USDCAD") or 1.39
    indices = []
    for n, s in (("S&P 500", "^GSPC"), ("Nasdaq", "^IXIC"), ("TSX", "^GSPTSE")):
        try:
            q = fetch_quick(s)
            if q:
                indices.append({"n": n, "chg": q["chg"], "v": q["v"], "d": q["d"]})
        except Exception:
            pass
    day = max((m.get("chgDate", "") for m in out.values()), default="")
    pub_splits = []
    for t, m in out.items():
        for d, r in m.get("splitEvents", []):
            if d > SINCE:
                pub_splits.append({"t": t, "date": d, "ratio": round(1 / r if r < 1 else r, 4), "reverse": r < 1})
    market = {"generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "fx": {"USDCAD": round(fx, 5), "asOf": TODAY.isoformat()},
              "day": {"date": day, "indices": indices}, "splits": pub_splits, "fails": fails, "stocks": out}

    # données privées
    pw = os.environ.get("RADAR_PASSWORD")
    pfile = DATA / "private.enc.json"
    note = ""
    notify_priv = {}
    if pw and pfile.exists():
        try:
            priv = decrypt(jload(pfile, {}), pw)
            n_div, n_sp, total = apply_private(priv, market, fx)
            notify_priv = priv.pop("_notify", {})
            jdump(pfile, encrypt(priv, pw))
            note = f", {n_div} dividende(s) réinvesti(s), {n_sp} fractionnement(s) appliqué(s)"
            log(f"Portefeuille : {total:,.0f} $ CAD{note}")
        except Exception as e:
            log("Portefeuille privé non traité (mot de passe ou fichier) :", e)
            note = " — portefeuille privé non traité (vérifie le secret RADAR_PASSWORD)"
    else:
        log("RADAR_PASSWORD absent : dividendes et fractionnements non appliqués.")
    market["note"] = f"{len(out) - len(fails)} titres mis à jour{note}"
    market["upgrades"] = upgrades
    jdump(DATA / "market.json", market)

    # notification (texte volontairement vague : le dépôt est public)
    lines = []
    n = notify_priv
    if n.get("alerts"): lines.append(f"🔔 {n['alerts']} alerte(s) de prix atteinte(s)")
    if n.get("earnings"): lines.append(f"📣 {n['earnings']} de tes titres publient leurs résultats d'ici 2 jours")
    if n.get("dividends"): lines.append(f"💰 {n['dividends']} dividende(s) réinvesti(s)")
    if n.get("splits"): lines.append(f"✂️ {n['splits']} fractionnement(s) d'actions appliqué(s) à tes positions")
    if upgrades: lines.append("🚀 Passent à « Achat intéressant » : " + ", ".join(upgrades[:6]))
    if new_disc: lines.append("🆕 Nouvelles découvertes de la semaine : " + ", ".join(new_disc))
    note_file = ROOT / ".notify.md"
    if lines:
        note_file.write_text("\n".join(f"- {l}" for l in lines), encoding="utf-8")
    elif note_file.exists():
        note_file.unlink()

    if monday or not (DATA / "investors.json").exists() or os.environ.get("FORCE_13F"):
        try:
            update_investors(universe)
        except Exception:
            traceback.print_exc()
    log(market["note"], "| échecs :", ", ".join(fails) or "aucun")


if __name__ == "__main__":
    main()
