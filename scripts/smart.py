"""Calculs « intelligents » du Radar : scores par style d'investisseur, valeur DCF,
raisons en français et en anglais, score radar public, découvertes S&P 500 / TSX 60."""
from __future__ import annotations

import io
import math
import time


def clamp(v, a=0.0, b=100.0):
    return max(a, min(b, v))


def avg(xs):
    xs = [x for x in xs if x is not None and not (isinstance(x, float) and math.isnan(x))]
    return sum(xs) / len(xs) if xs else None


def _f(m, *keys):
    cur = m
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    try:
        return None if cur is None else float(cur)
    except Exception:
        return None


# ------------------------------------------------------------------ indicateurs de base
def metrics(m: dict) -> dict:
    price = _f(m, "price")
    mcap = _f(m, "mcap")
    rev, ni, fcf, debt = _f(m, "fin", "rev"), _f(m, "fin", "ni"), _f(m, "fin", "fcf"), _f(m, "fin", "debt")
    shares = mcap / price if mcap and price else None
    hist = [h for h in (m.get("finHist") or []) if h.get("rev")]
    years = [h for h in hist if str(h.get("y", "")).startswith("Ex.")]
    cagr = None
    if len(years) >= 3 and years[0]["rev"] > 0 and years[-1]["rev"] > 0:
        cagr = (years[-1]["rev"] / years[0]["rev"]) ** (1 / (len(years) - 1)) - 1
    hi = _f(m, "hi52")
    return {
        "price": price, "mcap": mcap, "pe": _f(m, "pe"), "fpe": _f(m, "fpe"), "beta": _f(m, "beta"), "target": _f(m, "target"),
        "div": _f(m, "divAnnual"), "rev": rev, "ni": ni, "fcf": fcf, "debt": debt, "shares": shares,
        "margin": ni / rev if rev and ni is not None else None,
        "fcfYield": fcf / mcap if fcf is not None and mcap else None,
        "yield": (_f(m, "divAnnual") or 0) / price if price else None,
        "payout": ((_f(m, "divAnnual") or 0) * shares / ni) if shares and ni and ni > 0 else None,
        "debtRatio": debt / mcap if debt is not None and mcap else None,
        "growth": _f(m, "fin", "revGrowth") if _f(m, "fin", "revGrowth") is not None else cagr,
        "cagr": cagr,
        "epsGrowth": (_f(m, "pe") / _f(m, "fpe") - 1) if _f(m, "pe") and _f(m, "fpe") and _f(m, "fpe") > 0 else None,
        "disc": 1 - price / hi if price and hi else None,
        "upside": _f(m, "target") / price - 1 if _f(m, "target") and price else None,
    }


def pe_score(pe):
    if pe is None or pe <= 0:
        return 15
    return 90 if pe < 12 else 75 if pe < 18 else 55 if pe < 25 else 35 if pe < 40 else 15


# ------------------------------------------------------------------ 5 styles d'investisseurs (0-100)
def investor_scores(m: dict) -> dict | None:
    if m.get("etf"):
        return None
    x = metrics(m)
    if x["price"] is None:
        return None
    s = {}
    # Buffett : entreprise rentable, pas trop chère, peu endettée, qui génère du cash
    s["buffett"] = avg([
        clamp(x["margin"] * 300) if x["margin"] is not None else None,
        pe_score(x["pe"]),
        (80 if x["fcf"] > 0 else 15) if x["fcf"] is not None else None,
        clamp(100 - x["debtRatio"] * 150) if x["debtRatio"] is not None and m.get("_sector") not in FIN_SECT else None,
        clamp(40 + x["cagr"] * 250) if x["cagr"] is not None else None,
    ])
    # Burry : contrarien, titre délaissé mais bon marché sur ses flux de trésorerie
    s["burry"] = avg([
        clamp(x["disc"] * 160) if x["disc"] is not None else None,
        clamp(x["fcfYield"] * 900) if x["fcfYield"] is not None else None,
        pe_score(x["pe"]),
    ])
    # Duckett : dividende élevé et soutenable
    if x["yield"] is not None:
        y = x["yield"]
        ys = 0 if y == 0 else 30 if y < 0.01 else 55 if y < 0.02 else 75 if y < 0.04 else 85
        pay = None if x["payout"] is None else (85 if x["payout"] < 0.6 else 55 if x["payout"] < 0.85 else 25)
        s["duckett"] = avg([ys, pay if y > 0 else None])
    # Fink : long terme, stabilité, grande capitalisation, flux positifs
    s["fink"] = avg([
        clamp(100 - (x["beta"] or 1) * 40) if x["beta"] is not None else None,
        (85 if x["mcap"] > 2e11 else 70 if x["mcap"] > 5e10 else 55 if x["mcap"] > 1e10 else 35) if x["mcap"] else None,
        (75 if x["fcf"] > 0 else 25) if x["fcf"] is not None else None,
        clamp(50 + (x["growth"] or 0) * 150) if x["growth"] is not None else None,
    ])
    # Jensen : croissance des revenus et des profits, marge solide
    s["jensen"] = avg([
        clamp(40 + x["growth"] * 250) if x["growth"] is not None else None,
        clamp(50 + x["epsGrowth"] * 150) if x["epsGrowth"] is not None else None,
        clamp(x["margin"] * 250) if x["margin"] is not None else None,
        clamp(50 + x["upside"] * 150) if x["upside"] is not None else None,
    ])
    s = {k: round(v, 1) for k, v in s.items() if v is not None}
    return s or None


# ------------------------------------------------------------------ valeur DCF simplifiée
DCF = {"r": 0.085, "g_term": 0.03, "years": 10}
FIN_SECT = ("Finance & Assurance",)


def dcf_value(m: dict) -> dict | None:
    """Flux de trésorerie disponibles actualisés : croissance des 5 premières années = croissance
    des revenus (bornée entre 0 et 20 %), qui ralentit jusqu'à 2,5 % en 10 ans, actualisation à 9 %."""
    if m.get("etf") or m.get("_sector") in FIN_SECT:
        return None  # les flux de trésorerie des banques et assureurs ne se prêtent pas à ce modèle
    x = metrics(m)
    if not x["fcf"] or x["fcf"] <= 0 or not x["shares"]:
        return None
    g0 = clamp(x["growth"] if x["growth"] is not None else 0.04, 0.03, 0.20)
    r, gt, n = DCF["r"], DCF["g_term"], DCF["years"]
    cf, pv = x["fcf"], 0.0
    for yr in range(1, n + 1):
        g = g0 if yr <= 5 else g0 + (gt - g0) * (yr - 5) / 5
        cf *= 1 + g
        pv += cf / (1 + r) ** yr
    pv += cf * (1 + gt) / (r - gt) / (1 + r) ** n
    v = pv / x["shares"]
    if not math.isfinite(v) or v <= 0:
        return None
    return {"value": round(v, 2), "growth": round(g0, 4), "rate": r, "terminal": gt}


# ------------------------------------------------------------------ raisons bilingues
def pct(v, d=0):
    return f"{v * 100:.{d}f}".replace(".", ",") + " %"


def pct_en(v, d=0):
    return f"{v * 100:.{d}f}%"


def big(v):
    if v is None:
        return "–"
    a = abs(v)
    return (f"{v / 1e12:.1f} T$" if a >= 1e12 else f"{v / 1e9:.1f} G$" if a >= 1e9 else f"{v / 1e6:.0f} M$").replace(".", ",")


def big_en(v):
    if v is None:
        return "–"
    a = abs(v)
    return f"${v / 1e12:.1f}T" if a >= 1e12 else f"${v / 1e9:.1f}B" if a >= 1e9 else f"${v / 1e6:.0f}M"


def reasons(m: dict, fair: dict | None):
    x = metrics(m)
    pf, pe_, cf, ce = [], [], [], []
    if x["growth"] is not None:
        if x["growth"] > 0.10:
            pf.append(f"Revenus en forte hausse : +{pct(x['growth'])} sur un an")
            pe_.append(f"Strong revenue growth: +{pct_en(x['growth'])} year over year")
        elif x["growth"] < -0.03:
            cf.append(f"Revenus en baisse de {pct(-x['growth'])} sur un an")
            ce.append(f"Revenue down {pct_en(-x['growth'])} year over year")
    if x["margin"] is not None:
        if x["margin"] > 0.20:
            pf.append(f"Très rentable : garde {pct(x['margin'])} de ses revenus en profit")
            pe_.append(f"Highly profitable: {pct_en(x['margin'])} net margin")
        elif x["margin"] < 0:
            cf.append("Perd de l'argent sur les 12 derniers mois")
            ce.append("Lost money over the last 12 months")
    if x["fcf"] is not None:
        if x["fcf"] > 0 and x["fcfYield"] and x["fcfYield"] > 0.05:
            pf.append(f"Génère beaucoup de cash : {big(x['fcf'])} de flux libre ({pct(x['fcfYield'], 1)} de sa valeur)")
            pe_.append(f"Strong cash generation: {big_en(x['fcf'])} free cash flow ({pct_en(x['fcfYield'], 1)} yield)")
        elif x["fcf"] < 0:
            cf.append(f"Flux de trésorerie libre négatif ({big(x['fcf'])}) : dépense plus qu'elle n'encaisse")
            ce.append(f"Negative free cash flow ({big_en(x['fcf'])}): spending more cash than it brings in")
    if x["debtRatio"] is not None and x["debtRatio"] > 0.5 and m.get("_sector") not in FIN_SECT:
        cf.append(f"Dette élevée : {big(x['debt'])}, soit {pct(x['debtRatio'])} de sa valeur en Bourse")
        ce.append(f"High debt: {big_en(x['debt'])}, {pct_en(x['debtRatio'])} of market value")
    if x["epsGrowth"] is not None and x["epsGrowth"] > 0.15:
        pf.append(f"Les analystes prévoient des profits en hausse d'environ {pct(x['epsGrowth'])}")
        pe_.append(f"Analysts expect earnings to grow about {pct_en(x['epsGrowth'])}")
    if x["yield"] and x["yield"] >= 0.025:
        ok = x["payout"] is not None and x["payout"] < 0.8
        pf.append(f"Dividende de {pct(x['yield'], 1)} par année" + (", bien couvert par les profits" if ok else ""))
        pe_.append(f"{pct_en(x['yield'], 1)} dividend yield" + (", well covered by earnings" if ok else ""))
    if x["payout"] is not None and x["payout"] > 1 and x["yield"]:
        cf.append("Le dividende dépasse les profits : il pourrait être réduit")
        ce.append("Dividend exceeds earnings: it could be cut")
    if fair and x["price"]:
        d = fair["value"] / x["price"] - 1
        if d > 0.2:
            pf.append(f"Notre estimation DCF ({fair['value']:.2f} $) est {pct(d)} au-dessus du prix".replace(".", ",", 1))
            pe_.append(f"Our DCF estimate (${fair['value']:.2f}) is {pct_en(d)} above the price")
        elif d < -0.3:
            cf.append(f"Le prix dépasse de {pct(-d)} notre estimation DCF ({fair['value']:.2f} $)".replace(".", ","))
            ce.append(f"Price is {pct_en(-d)} above our DCF estimate (${fair['value']:.2f})")
    return {"fr": pf[:4], "en": pe_[:4]}, {"fr": cf[:4], "en": ce[:4]}


SECT_EN = {"Technologie": "technology", "Transport": "transportation", "Consommation": "consumer", "Industrie": "industrial",
           "Finance & Assurance": "financial", "Santé": "healthcare", "Énergie": "energy", "Matériaux": "materials"}


def auto_summary(name, sector, m):
    x = metrics(m)
    if m.get("etf"):
        return None
    fr = f"{name} : entreprise du secteur {sector or 'non classé'}"
    en = f"{name}: {SECT_EN.get(sector, 'listed')} company"
    if x["mcap"]:
        fr += f" valant {big(x['mcap'])} en Bourse"
        en += f" worth {big_en(x['mcap'])}"
    if x["rev"]:
        fr += f", avec {big(x['rev'])} de revenus annuels"
        en += f", with {big_en(x['rev'])} in annual revenue"
        if x["growth"] is not None:
            fr += f" ({'+' if x['growth'] >= 0 else ''}{pct(x['growth'])} sur un an)"
            en += f" ({'+' if x['growth'] >= 0 else ''}{pct_en(x['growth'])} YoY)"
    fr += "."
    en += "."
    if x["margin"] is not None:
        fr += f" Marge nette de {pct(x['margin'])}."
        en += f" Net margin {pct_en(x['margin'])}."
    return {"fr": fr, "en": en}


# ------------------------------------------------------------------ score radar public (sans ton portefeuille)
def radar_score(m: dict, consensus):
    x = metrics(m)
    pts = 50
    if m.get("etf"):
        pts += 10
    else:
        pe = x["fpe"] or x["pe"]
        if pe is None or pe <= 0:
            pts -= 12
        elif pe < 12:
            pts += 14
        elif pe < 18:
            pts += 8
        elif pe < 28:
            pass
        elif pe < 45:
            pts -= 8
        else:
            pts -= 16
        if x["mcap"] and x["mcap"] > 2e11:
            pts += 4
        elif x["mcap"] and x["mcap"] < 3e9:
            pts -= 6
    if x["disc"] is not None:
        if 0.15 <= x["disc"] <= 0.45:
            pts += 8
        elif x["disc"] > 0.45:
            pts -= 4
        elif x["disc"] < 0.04:
            pts -= 3
    if x["beta"] is not None:
        if x["beta"] > 1.6:
            pts -= 8
        elif 0 < x["beta"] < 0.8:
            pts += 4
    if x["upside"] is not None:
        pts += 10 if x["upside"] > 0.2 else 5 if x["upside"] > 0.08 else -8 if x["upside"] < 0 else 0
    rule = clamp(pts)
    return round(0.5 * consensus + 0.5 * rule) if consensus is not None else round(rule)


def verdict(sc):
    return "Achat intéressant" if sc >= 66 else "À considérer" if sc >= 57 else "À surveiller" if sc >= 46 else "Prudence" if sc >= 36 else "Éviter"


def enrich(t: str, m: dict, u: dict) -> dict:
    """Ajoute au titre : scores auto, DCF, raisons bilingues, résumé, score radar."""
    m["_sector"] = u.get("sector") if u.get("sector") not in (None, "Autre") else m.get("sectorAuto")
    sc = investor_scores(m)
    if sc:
        m["scoresAuto"] = sc
        m["consensusAuto"] = round(avg(list(sc.values())), 1)
    fair = dcf_value(m)
    if fair:
        m["fairValueAuto"] = fair
    p, c = reasons(m, fair)
    if p["fr"] or c["fr"]:
        m["autoPros"], m["autoCons"] = p, c
    s = auto_summary(m.get("name") or u.get("name") or t, u.get("sector") or m.get("sectorAuto"), m)
    if s:
        m["autoSummary"] = s
    cons = m.get("consensusAuto", u.get("consensus"))
    m["radarScore"] = radar_score(m, cons)
    m.pop("_sector", None)
    return m


# ------------------------------------------------------------------ découvertes S&P 500 / TSX 60
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def index_members():
    import pandas as pd
    import urllib.request

    def html(url):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8", "replace")

    out = {}
    try:
        for tb in pd.read_html(io.StringIO(html("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"))):
            if "Symbol" in tb.columns:
                for _, r in tb.iterrows():
                    out[str(r["Symbol"]).replace(".", "-")] = {"name": r.get("Security"), "idx": "S&P 500"}
                break
    except Exception as e:
        print("  S&P 500 indisponible:", e)
    try:
        for tb in pd.read_html(io.StringIO(html("https://en.wikipedia.org/wiki/S%26P/TSX_60"))):
            cols = [c for c in tb.columns if str(c).lower() in ("symbol", "ticker")]
            if cols:
                for _, r in tb.iterrows():
                    raw = str(r[cols[0]]).strip()
                    if not raw or raw.lower() == "nan":
                        continue
                    sym = raw.replace(".", "-") + ".TO"
                    out[sym] = {"name": r.get("Company") or r.get("Name"), "idx": "TSX 60"}
                break
    except Exception as e:
        print("  TSX 60 indisponible:", e)
    return out


_SYM = __import__("re").compile(r"[A-Z0-9][A-Z0-9.\-]{0,11}")


def to_radar_symbol(y: str) -> str:
    if y.endswith(".TO"):
        return y[:-3].replace("-", ".") + ".TO"
    return y.replace("-", ".")


def discover(universe: dict, fetch_one, sector_fr: dict, limit=12):
    import yfinance as yf

    members = {k: v for k, v in index_members().items() if _SYM.fullmatch(str(k))}
    known = {k.replace(".", "-") for k in universe} | set(universe)
    cands = [s for s in members if s not in known and to_radar_symbol(s) not in universe]
    if not cands:
        return []
    print(f"  Découvertes : {len(cands)} titres à balayer")
    data = yf.download(cands, period="1y", interval="1d", group_by="ticker", auto_adjust=False, threads=True, progress=False)
    pre = []
    for s in cands:
        try:
            c = data[s]["Close"].dropna()
            if len(c) < 120:
                continue
            last, hi = float(c.iloc[-1]), float(c.max())
            disc = 1 - last / hi
            mom6 = last / float(c.iloc[-126]) - 1 if len(c) > 126 else 0
            if 0.08 <= disc <= 0.5 and mom6 > -0.35:
                pre.append((disc - abs(mom6) * 0.2, s))
        except Exception:
            continue
    pre.sort(reverse=True)
    res = []
    for _, s in pre[:60]:
        try:
            m = fetch_one(to_radar_symbol(s), {}, True, ysym_override=s)
            if not m:
                continue
            u = {"name": m.get("name") or members[s].get("name"), "sector": m.get("sectorAuto")}
            enrich(s, m, u)
            res.append({"t": to_radar_symbol(s), "name": u["name"], "sector": u["sector"], "region": m.get("regionAuto"), "cur": m.get("cur"), "web": m.get("web"),
                        "index": members[s]["idx"], "price": m.get("price"), "chg": m.get("chg"), "pe": m.get("pe"), "target": m.get("target"),
                        "hi52": m.get("hi52"), "score": m.get("radarScore"), "verdict": verdict(m.get("radarScore", 0)),
                        "pros": m.get("autoPros"), "cons": m.get("autoCons"), "fair": (m.get("fairValueAuto") or {}).get("value")})
            time.sleep(0.3)
        except Exception as e:
            print("  découverte ignorée", s, e)
    res.sort(key=lambda r: -(r["score"] or 0))
    return res[:limit]


# ------------------------------------------------------------------ profil en 5 axes (30 critères)
def _med(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _q(xs, q):
    xs = sorted(x for x in xs if x is not None)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None


def _r(x, nd=4):
    return None if x is None else round(float(x), nd)


def _fiscal(m):
    return [h for h in (m.get("finHist") or []) if str(h.get("y", "")).startswith("Ex.")]


def _ni_growth(m):
    """(croissance du dernier exercice, croissance annuelle moyenne, nb d'années) du profit net."""
    fh = [h for h in _fiscal(m) if h.get("ni") is not None]
    last = cagr = None
    if len(fh) >= 2 and fh[-2]["ni"] > 0:
        last = fh[-1]["ni"] / fh[-2]["ni"] - 1
    if len(fh) >= 3 and fh[0]["ni"] > 0 and fh[-1]["ni"] > 0:
        cagr = (fh[-1]["ni"] / fh[0]["ni"]) ** (1 / (len(fh) - 1)) - 1
    return last, cagr, len(fh) - 1


def _fwd(m):
    est, rx = m.get("est") or {}, m.get("rx") or {}
    g = est.get("eg") if est.get("eg") is not None else rx.get("eg")
    r = est.get("rg") if est.get("rg") is not None else rx.get("rg")
    return g, r, ("f" if est.get("eg") is not None else "r"), ("f" if est.get("rg") is not None else "r")


def snowflake_all(stocks: dict, universe: dict):
    """Calcule pour chaque titre 30 critères (6 par axe) inspirés des profils « flocon ».
    Chaque critère : [id, réussi (1/0/None si non applicable), valeur a, valeur b]."""
    def sector(t, m):
        s = (universe.get(t) or {}).get("sector")
        return s if s not in (None, "Autre") else m.get("sectorAuto")

    live = {t: m for t, m in stocks.items() if m and not m.get("etf") and m.get("price")}
    pe = {t: m["pe"] for t, m in live.items() if m.get("pe") and 0 < m["pe"] < 400}
    g1 = {t: _fwd(m)[0] for t, m in live.items()}
    r1 = {t: _fwd(m)[1] for t, m in live.items()}
    last = {t: _ni_growth(m)[0] for t, m in live.items()}
    yld = [m["divAnnual"] / m["price"] for m in live.values() if m.get("divAnnual")]
    mk = {"pe": _med(pe.values()), "g": _med(g1.values()), "r": _med(r1.values()), "y25": _q(yld, .25), "y75": _q(yld, .75)}
    bysec = {}
    for t, m in live.items():
        bysec.setdefault(sector(t, m), []).append(t)
    sec_pe = {s: _med([pe.get(t) for t in ts]) for s, ts in bysec.items()}
    sec_last = {s: _med([last.get(t) for t in ts]) for s, ts in bysec.items()}

    for t, m in stocks.items():
        if not m or t not in live:
            if m:
                m.pop("snow", None)
            continue
        sec = sector(t, m)
        u = universe.get(t) or {}
        m["snow"] = snow_one(m, u, mk, sec_pe.get(sec), sec_last.get(sec), sec)
    return mk


def snow_one(m, u, mk, spe, slast, sec):
    price = m["price"]
    rx, fin, bs = m.get("rx") or {}, m.get("fin") or {}, m.get("bsx") or {}
    fv = u.get("fairValue") or (m.get("fairValueAuto") or {}).get("value")
    pe = m.get("pe") if m.get("pe") and m["pe"] > 0 else None
    B = lambda c: None if c is None else (1 if c else 0)
    fin_sector = sec == "Finance & Assurance"

    # 1. VALEUR
    g, r, gs, rs = _fwd(m)
    peg = pe / (g * 100) if pe and g and g > 0 else None
    tgt = m.get("target")
    value = [
        ["v1", B(price < fv) if fv else None, _r(price, 2), _r(fv, 2)],
        ["v2", B(price < fv * 0.8) if fv else None, _r(1 - price / fv, 4) if fv else None, None],
        ["v3", (B(pe < spe) if pe else 0) if spe else None, _r(pe, 1), _r(spe, 1)],
        ["v4", (B(pe < mk["pe"]) if pe else 0) if mk["pe"] else None, _r(pe, 1), _r(mk["pe"], 1)],
        ["v5", B(0 < peg < 1.5) if peg else (0 if pe is None or (g is not None and g <= 0) else None), _r(peg, 2), _r(g, 4)],
        ["v6", B(tgt >= price * 1.2) if tgt else None, _r(tgt / price - 1, 4) if tgt else None, _r(tgt, 2)],
    ]
    # 2. FUTUR
    feps, teps = rx.get("feps"), rx.get("teps")
    future = [
        ["f1", B(g > 0.03) if g is not None else None, _r(g), gs],
        ["f2", B(g > mk["g"]) if g is not None and mk["g"] is not None else None, _r(g), _r(mk["g"])],
        ["f3", B(g > 0.20) if g is not None else None, _r(g), gs],
        ["f4", B(r > mk["r"]) if r is not None and mk["r"] is not None else None, _r(r), _r(mk["r"])],
        ["f5", B(r > 0.20) if r is not None else None, _r(r), rs],
        ["f6", B(feps > teps * 1.1 if teps > 0 else feps > 0) if feps is not None and teps is not None else None, _r(feps, 2), _r(teps, 2)],
    ]
    # 3. PASSÉ
    ni, fcf, rev = fin.get("ni"), fin.get("fcf"), fin.get("rev")
    fh = _fiscal(m)
    mg_now = ni / rev if ni is not None and rev else None
    prevf = fh[-2] if fin.get("period", "").startswith("Exercice") and len(fh) >= 2 else (fh[-1] if fh else None)
    mg_prev = prevf["ni"] / prevf["rev"] if prevf and prevf.get("ni") is not None and prevf.get("rev") else None
    if mg_now is not None and mg_prev is not None and abs(mg_now - mg_prev) < 5e-4 and len(fh) >= 2:
        # les 12 derniers mois = dernier exercice : on compare avec l'exercice précédent
        p2_ = fh[-2]
        mg_prev = p2_["ni"] / p2_["rev"] if p2_.get("ni") is not None and p2_.get("rev") else None
    lastg, cagr, yrs = _ni_growth(m)
    roe = rx.get("roe")
    past = [
        ["p1", (B(fcf >= 0.5 * ni) if ni > 0 else 0) if ni is not None and fcf is not None and not fin_sector else None, _r(fcf / ni, 2) if ni and fcf is not None else None, None],
        ["p2", B(mg_now > mg_prev) if mg_now is not None and mg_prev is not None else None, _r(mg_now), _r(mg_prev)],
        ["p3", B(cagr > 0) if cagr is not None else (0 if fh and fh[-1].get("ni") is not None and fh[-1]["ni"] <= 0 else (1 if fh and fh[-1].get("ni") is not None and fh[-1]["ni"] > 0 and any((h.get("ni") or 0) <= 0 for h in fh) else None)), _r(cagr), yrs if cagr is not None else "turn"],
        ["p4", B(lastg > cagr) if lastg is not None and cagr is not None else None, _r(lastg), _r(cagr)],
        ["p5", B(lastg > slast) if lastg is not None and slast is not None else None, _r(lastg), _r(slast)],
        ["p6", B(roe > 0.20) if roe is not None else None, _r(roe), None],
    ]
    # 4. SANTÉ (les règles d'endettement ne s'appliquent pas aux banques et assureurs)
    ca, cl, ltl = bs.get("ca"), bs.get("cl"), bs.get("ltl")
    debt = bs.get("debt", rx.get("debt"))
    cash = bs.get("cash", rx.get("cash"))
    eq = bs.get("eq")
    de = rx.get("de") / 100 if rx.get("de") is not None else (debt / eq if debt is not None and eq else None)
    nde = (debt - (cash or 0)) / eq if debt is not None and eq and eq > 0 else None
    ocf = rx.get("ocf")
    ebit, it = bs.get("ebit"), bs.get("int")
    if fin_sector:
        health = [[k, None, None, "fin"] for k in ("h1", "h2", "h3", "h4", "h5", "h6")]
    else:
        health = [
            ["h1", B(ca > cl) if ca is not None and cl else (B(rx["cr"] > 1) if rx.get("cr") is not None else None), _r(ca), _r(cl)],
            ["h2", B(ca > ltl) if ca is not None and ltl is not None else None, _r(ca), _r(ltl)],
            ["h3", B(nde < 0.4) if nde is not None else (0 if eq is not None and eq <= 0 else None), _r(nde), None],
            ["h4", B(de < bs["de0"]) if de is not None and bs.get("de0") is not None else None, _r(de), _r(bs.get("de0"))],
            ["h5", (1 if not debt else B(ocf > 0.2 * debt)) if ocf is not None and debt is not None else None, _r(ocf / debt, 3) if ocf is not None and debt else None, None],
            ["h6", (1 if not it else B(ebit > 3 * it)) if ebit is not None else None, _r(ebit / it, 1) if ebit is not None and it else None, None],
        ]
    # 5. DIVIDENDE
    da = m.get("divAnnual") or 0
    y = da / price if price else 0
    dy = [v for _, v in (m.get("divYears") or [])]
    if not da:
        dividend = [[k, 0, None, "none"] for k in ("d1", "d2", "d3", "d4", "d5", "d6")]
    else:
        cuts = sum(1 for a, b in zip(dy, dy[1:]) if b < a * 0.9)
        po = rx.get("payout")
        sh, fcf2 = rx.get("shares"), rx.get("fcf", fcf)
        cpo = da * sh / fcf2 if sh and fcf2 and fcf2 > 0 else None
        dividend = [
            ["d1", B(y > mk["y25"]) if mk["y25"] else None, _r(y), _r(mk["y25"])],
            ["d2", B(y > mk["y75"]) if mk["y75"] else None, _r(y), _r(mk["y75"])],
            ["d3", B(cuts == 0 and len(dy) >= 4) if dy else None, cuts, len(dy)],
            ["d4", B(dy[-1] > dy[0]) if len(dy) >= 3 else None, _r(dy[-1] / dy[0] - 1) if len(dy) >= 3 and dy[0] else None, len(dy)],
            ["d5", B(0 < po < 0.9) if po is not None else None, _r(po), None],
            ["d6", B(cpo < 0.9) if cpo is not None else (0 if fcf2 is not None and fcf2 <= 0 else None), _r(cpo), None],
        ]

    def axis(checks):
        app = [c for c in checks if c[1] is not None]
        ok = sum(c[1] for c in app)
        s = round(6 * ok / len(app)) if len(app) >= 3 else None
        return {"s": s, "ok": ok, "n": len(app), "c": checks}
    return {"value": axis(value), "future": axis(future), "past": axis(past), "health": axis(health), "dividend": axis(dividend)}
