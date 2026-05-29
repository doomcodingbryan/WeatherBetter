#!/usr/bin/env python3
import os
import re
import sys
import json
import time
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError
from concurrent.futures import ThreadPoolExecutor, as_completed

# Configuration
DB_PATH = "data/backtest.db"
OUTPUT_JSON_PATH = "data/calibration-data.json"
START_DATE = "2026-01-01"
END_DATE = "2026-05-28"

# Standard headers for requests
HEADERS = {"Accept": "application/json", "User-Agent": "WeatherBetterBacktest/1.0"}

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    
    # NWS Forecasts table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS nws_forecasts (
            issue_time TEXT,
            target_date TEXT,
            lead_days INTEGER,
            forecast_high REAL,
            period_name TEXT,
            description TEXT,
            PRIMARY KEY (issue_time, target_date)
        )
    """)
    
    # Kalshi Markets table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kalshi_markets (
            ticker TEXT PRIMARY KEY,
            event_ticker TEXT,
            target_date TEXT,
            strike_type TEXT,
            floor_strike REAL,
            cap_strike REAL,
            expiration_value REAL,
            result TEXT,
            open_time TEXT,
            close_time TEXT
        )
    """)
    
    # Kalshi Prices table (cached hourly candles)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kalshi_prices (
            ticker TEXT,
            timestamp INTEGER,
            yes_ask REAL,
            yes_bid REAL,
            price REAL,
            PRIMARY KEY (ticker, timestamp)
        )
    """)
    
    conn.commit()
    conn.close()

def http_get(url, headers=None, retries=4):
    req_headers = HEADERS.copy()
    if headers:
        req_headers.update(headers)
    
    req = Request(url, headers=req_headers)
    last_err = None
    for attempt in range(retries):
        try:
            with urlopen(req, timeout=30) as resp:
                return resp.read()
        except HTTPError as e:
            if e.code == 429:
                sleep_time = (attempt + 1) * 3
                log(f"HTTP 429 (Rate Limited) on {url}. Sleeping {sleep_time}s and retrying...")
                time.sleep(sleep_time)
                last_err = "HTTP 429"
                continue
            if e.code < 500:
                raise e
            last_err = f"HTTP {e.code}"
        except URLError as e:
            last_err = str(e.reason)
        time.sleep(2)
    raise Exception(f"Failed to fetch {url} after {retries} retries: {last_err}")

# --- KALSHI DATA FETCHING ---

def parse_ticker_date(ticker):
    # E.g., KXHIGHNY-26MAR28-T47 or KXHIGHNY-26MAR28
    match = re.search(r'KXHIGHNY-(\d{2})([A-Z]{3})(\d{2})', ticker)
    if not match:
        return None
    yr, mon, day = match.groups()
    try:
        dt = datetime.strptime(f"20{yr}-{mon}-{day}", "%Y-%b-%d")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return None

def fetch_kalshi_markets():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    
    log("Fetching Kalshi historical markets...")
    base_url = "https://api.elections.kalshi.com/trade-api/v2/historical/markets?series_ticker=KXHIGHNY&limit=200"
    cursor = None
    new_markets = 0
    total_markets = 0
    
    while True:
        url = base_url + (f"&cursor={cursor}" if cursor else "")
        try:
            res = http_get(url)
            data = json.loads(res.decode('utf-8'))
        except Exception as e:
            log(f"Error fetching markets: {e}")
            break
            
        markets = data.get("markets", [])
        if not markets:
            break
            
        should_stop = False
        for m in markets:
            ticker = m.get("ticker")
            status = m.get("status")
            if status != "finalized":
                continue
                
            target_date = parse_ticker_date(ticker)
            if not target_date:
                continue
                
            if target_date < START_DATE:
                dt_target = datetime.strptime(target_date, "%Y-%m-%d")
                dt_start = datetime.strptime(START_DATE, "%Y-%m-%d")
                if (dt_start - dt_target).days > 7:
                    log(f"Encountered target date {target_date} older than START_DATE {START_DATE} by > 7 days. Stopping market fetch.")
                    should_stop = True
                    break
                continue
                
            if target_date > END_DATE:
                continue
                
            # Parse expiration_value (observed high temp)
            exp_val_str = m.get("expiration_value")
            try:
                expiration_value = float(exp_val_str) if exp_val_str else None
            except ValueError:
                expiration_value = None
                
            cur.execute("""
                INSERT OR IGNORE INTO kalshi_markets 
                (ticker, event_ticker, target_date, strike_type, floor_strike, cap_strike, expiration_value, result, open_time, close_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                ticker,
                m.get("event_ticker"),
                target_date,
                m.get("strike_type"),
                m.get("floor_strike"),
                m.get("cap_strike"),
                expiration_value,
                m.get("result"),
                m.get("open_time"),
                m.get("close_time")
            ))
            if cur.rowcount > 0:
                new_markets += 1
            total_markets += 1
            
        if should_stop:
            break
        cursor = data.get("cursor")
        if not cursor:
            break
        time.sleep(0.5)
        
    conn.commit()
    conn.close()
    log(f"Processed {total_markets} markets. Inserted {new_markets} new finalized markets.")

def fetch_kalshi_prices():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    
    # Find all markets that do not have price candles in our database
    cur.execute("""
        SELECT ticker, open_time, close_time FROM kalshi_markets
        WHERE target_date >= ? AND target_date <= ? AND ticker NOT IN (SELECT DISTINCT ticker FROM kalshi_prices)
    """, (START_DATE, END_DATE))
    missing_markets = cur.fetchall()
    
    if not missing_markets:
        log("No missing price candles for markets.")
        conn.close()
        return
        
    log(f"Fetching historical price candles for {len(missing_markets)} markets sequentially...")
    fetched_count = 0
    
    for ticker, open_time, close_time in missing_markets:
        try:
            ot_dt = datetime.fromisoformat(open_time.replace("Z", "+00:00"))
            ct_dt = datetime.fromisoformat(close_time.replace("Z", "+00:00"))
            start_ts = int(ot_dt.timestamp())
            end_ts = int(ct_dt.timestamp())
        except Exception:
            continue
            
        url = f"https://api.elections.kalshi.com/trade-api/v2/historical/markets/{ticker}/candlesticks?start_ts={start_ts}&end_ts={end_ts}&period_interval=60"
        
        try:
            res = http_get(url)
            data = json.loads(res.decode('utf-8'))
            candles = data.get("candlesticks", [])
            
            for c in candles:
                ts = c.get("end_period_ts")
                yes_ask = c.get("yes_ask", {}).get("close")
                yes_bid = c.get("yes_bid", {}).get("close")
                price = c.get("price", {}).get("close")
                
                yes_ask = float(yes_ask) if yes_ask is not None else None
                yes_bid = float(yes_bid) if yes_bid is not None else None
                price = float(price) if price is not None else None
                
                cur.execute("""
                    INSERT OR IGNORE INTO kalshi_prices (ticker, timestamp, yes_ask, yes_bid, price)
                    VALUES (?, ?, ?, ?, ?)
                """, (ticker, ts, yes_ask, yes_bid, price))
                
            if not candles:
                cur.execute("INSERT OR IGNORE INTO kalshi_prices (ticker, timestamp, yes_ask, yes_bid, price) VALUES (?, ?, ?, ?, ?)", (ticker, 0, None, None, None))
                
        except HTTPError as e:
            if e.code == 404:
                # 404 is fine, insert dummy to avoid re-querying
                cur.execute("INSERT OR IGNORE INTO kalshi_prices (ticker, timestamp, yes_ask, yes_bid, price) VALUES (?, ?, ?, ?, ?)", (ticker, 0, None, None, None))
                continue
            log(f"HTTP error for {ticker}: {e}")
            break
        except Exception as e:
            log(f"Error fetching candlesticks for {ticker}: {e}")
            break
            
        fetched_count += 1
        if fetched_count % 50 == 0:
            conn.commit()
            log(f"Fetched price data for {fetched_count}/{len(missing_markets)} markets...")
            
        time.sleep(0.15) # rate limit delay
        
    conn.commit()
    conn.close()
    log(f"Completed pricing fetch. Processed {fetched_count} markets.")

# --- NWS DATA FETCHING & PARSING ---

def extract_high_temp(text):
    # Regex 1: "Highs in the mid 60s" or "Highs around 80"
    m = re.search(r'(?:highs|temperature\s+near|temperature\s+in\s+the|temperatures\s+near|temperatures\s+in\s+the|highs\s+near|highs\s+in\s+the|highs\s+around|highs\s+ranging\s+from)\s+(?:in\s+the\s+)?(mid|upper|lower)?\s*(\d+)(?:s)?(?:\s+to\s+(\d+))?', text, re.IGNORECASE)
    if m:
        qual, val, to_val = m.groups()
        if to_val:
            return (int(val) + int(to_val)) / 2.0
        base = int(val)
        if qual:
            qual = qual.lower()
            if qual == 'mid': return base + 5
            if qual == 'upper': return base + 8
            if qual == 'lower': return base + 2
        return base
    
    # Fallback 1: match "mid 60s", "upper 50s", etc.
    m = re.search(r'(mid|upper|lower)\s+(\d+)s', text, re.IGNORECASE)
    if m:
        qual, base = m.groups()
        base = int(base)
        qual = qual.lower()
        if qual == 'mid': return base + 5
        if qual == 'upper': return base + 8
        if qual == 'lower': return base + 2
        
    # Fallback 2: "highs of 85" or "high 85"
    m = re.search(r'(?:highs|high|highs\s+around|highs\s+of)\s+(\d+)', text, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return None

def parse_issue_date(section_text):
    # Try multiple NWS date formats
    # E.g. "232 PM EDT Fri May 22 2026"
    match = re.search(r'(\d{1,2}):?(\d{2})?\s*([AP]M)\s+([A-Z]{3,4})\s+[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})', section_text)
    if not match:
        match = re.search(r'(\d{1,2}):?(\d{2})?\s*([AP]M)\s+([A-Z]{3,4})\s+[A-Za-z]+\s+([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})', section_text)
        
    if match:
        hour_str, minute_str, ampm, tz, month_str, day_str, year_str = match.groups()
        minute = minute_str if minute_str else "00"
        
        # Parse month abbreviation
        dt_str = f"{year_str}-{month_str[:3]}-{day_str.zfill(2)}"
        try:
            dt = datetime.strptime(dt_str, "%Y-%b-%d")
            # Convert to UTC or keep as local YYYY-MM-DD HH:MM:SS
            # Since Kalshi and NWS are East Coast, let's represent issue time as YYYY-MM-DD HH:MM:SS in local ET
            hour = int(hour_str)
            if ampm.upper() == "PM" and hour < 12:
                hour += 12
            elif ampm.upper() == "AM" and hour == 12:
                hour = 0
            
            issue_time_str = f"{dt.strftime('%Y-%m-%d')} {str(hour).zfill(2)}:{minute}:00"
            return issue_time_str, dt.strftime("%Y-%m-%d")
        except ValueError:
            return None
    return None

def parse_zfpokx_products(raw_text):
    # Split the raw text of concatenated products by the WMO header/PIL
    # Usually products start with CDUS or FPUS
    # E.g. FPUS51 KOKX or CDUS41 KOKX
    products = re.split(r'(?=FPUS51 KOKX|CDUS41 KOKX)', raw_text)
    parsed_forecasts = []
    
    for prod in products:
        if "ZFPOKX" not in prod:
            continue
            
        # Find Manhattan zone NYZ072 section
        # NYZ072 section starts with NYZ072 and ends with $$ or the next zone NYZ073...
        ny_match = re.search(r'(NYZ072-.*?)(?=\$\$|\nNYZ\d{3})', prod, re.DOTALL)
        if not ny_match:
            continue
            
        section = ny_match.group(1)
        date_info = parse_issue_date(section)
        if not date_info:
            continue
            
        issue_time_str, issue_date_str = date_info
        issue_date = datetime.strptime(issue_date_str, "%Y-%m-%d")
        
        # Find all periods e.g. .TODAY... or .SUNDAY...
        raw_periods = re.findall(r'^\.([A-Z0-9\s]+)\.\.\.(.*?)(?=\n\.[A-Z0-9\s]+\.\.\.|\n\n|\n\$\$)', section, re.MULTILINE | re.DOTALL)
        
        current_date = issue_date
        is_first = True
        
        for name, desc in raw_periods:
            name = name.strip().upper()
            is_night = "NIGHT" in name or name == "TONIGHT"
            
            if not is_night:
                if is_first:
                    current_date = issue_date
                    is_first = False
                else:
                    current_date += timedelta(days=1)
            else:
                if is_first:
                    current_date = issue_date
                    is_first = False
                    
            if not is_night:
                high = extract_high_temp(desc)
                if high is not None:
                    target_date_str = current_date.strftime("%Y-%m-%d")
                    lead = (current_date - issue_date).days
                    parsed_forecasts.append({
                        "issue_time": issue_time_str,
                        "target_date": target_date_str,
                        "lead_days": lead,
                        "forecast_high": high,
                        "period_name": name,
                        "description": desc.strip().replace('\n', ' ')
                    })
                    
    return parsed_forecasts

def fetch_nws_forecasts():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    
    # We query the IEM monthly to avoid massive request lists
    start_dt = datetime.strptime(START_DATE, "%Y-%m-%d")
    end_dt = datetime.strptime(END_DATE, "%Y-%m-%d")
    
    # Iterate month by month
    curr_dt = start_dt
    while curr_dt < end_dt:
        month_start = curr_dt.strftime("%Y-%m-%d")
        # Go to next month
        next_month_start = (curr_dt.replace(day=28) + timedelta(days=4)).replace(day=1)
        month_end = min(next_month_start, end_dt + timedelta(days=1)).strftime("%Y-%m-%d")
        
        # Check if we already have forecasts for this month (rough check)
        cur.execute("""
            SELECT COUNT(*) FROM nws_forecasts 
            WHERE issue_time >= ? AND issue_time < ?
        """, (month_start + " 00:00:00", month_end + " 00:00:00"))
        if cur.fetchone()[0] > 10: # If we have more than 10 products, assume we cached it
            log(f"NWS forecasts for {curr_dt.strftime('%B %Y')} already cached.")
            curr_dt = next_month_start
            continue
            
        log(f"Fetching NWS forecasts for {curr_dt.strftime('%B %Y')}...")
        url = f"https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=ZFPOKX&fmt=text&sdate={month_start}&edate={month_end}&limit=9999"
        
        try:
            res = http_get(url)
            raw_text = res.decode('utf-8', errors='ignore')
            forecasts = parse_zfpokx_products(raw_text)
            
            new_forecasts = 0
            for f in forecasts:
                cur.execute("""
                    INSERT OR IGNORE INTO nws_forecasts 
                    (issue_time, target_date, lead_days, forecast_high, period_name, description)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    f["issue_time"],
                    f["target_date"],
                    f["lead_days"],
                    f["forecast_high"],
                    f["period_name"],
                    f["description"]
                ))
                if cur.rowcount > 0:
                    new_forecasts += 1
            
            conn.commit()
            log(f"Parsed {len(forecasts)} forecasts for {curr_dt.strftime('%B %Y')}. Inserted {new_forecasts} new.")
        except Exception as e:
            log(f"Error fetching/parsing NWS forecasts for {month_start}: {e}")
            
        curr_dt = next_month_start
        time.sleep(1.0) # Rate limit friendly
        
    conn.close()

# --- BACKTEST ANALYSIS AND CALIBRATION ---

def run_calibration_analysis():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    
    # 1. Calculate NWS Forecast Error Statistics by Lead Day
    # We join nws_forecasts with the actual observed max temp.
    # The actual observed max temp is stored in kalshi_markets.expiration_value for that target_date.
    # Because there are multiple markets per target_date, they all have the same expiration_value.
    # Let's get the distinct target_date observations.
    cur.execute("""
        SELECT DISTINCT target_date, expiration_value 
        FROM kalshi_markets 
        WHERE expiration_value IS NOT NULL
    """)
    observations = dict(cur.fetchall())
    
    log(f"Total target dates with ground-truth observations: {len(observations)}")
    
    # Now query the forecasts
    cur.execute("""
        SELECT issue_time, target_date, lead_days, forecast_high 
        FROM nws_forecasts
    """)
    forecasts = cur.fetchall()
    
    lead_errors = {}
    for issue_time, target_date, lead, mu in forecasts:
        if target_date not in observations:
            continue
        actual = observations[target_date]
        error = actual - mu
        
        if lead not in lead_errors:
            lead_errors[lead] = []
        lead_errors[lead].append(error)
        
    log("Computing forecast error statistics by lead day...")
    error_stats = []
    calibrated_sigmas = {}
    calibrated_bias = 0.0
    all_errors = []
    
    # Standard priors from probability.js
    priors_sigma = {0: 2.0, 1: 2.5, 2: 3.5, 3: 3.5, 4: 3.5, 5: 3.5, 6: 3.5, 7: 3.5}
    
    for lead in sorted(lead_errors.keys()):
        if lead > 7:
            continue
        errors = lead_errors[lead]
        count = len(errors)
        if count < 10:
            continue
            
        mean_err = sum(errors) / count
        # Variance / standard deviation
        var_err = sum((e - mean_err)**2 for e in errors) / (count - 1)
        sigma = var_err**0.5
        
        # Accumulate for overall bias
        all_errors.extend(errors)
        
        error_stats.append({
            "lead": lead,
            "bias": round(mean_err, 3),
            "priorSigma": priors_sigma.get(lead, 3.5),
            "calibratedSigma": round(sigma, 3),
            "count": count
        })
        calibrated_sigmas[str(lead)] = round(sigma, 2)
        
    if all_errors:
        calibrated_bias = round(sum(all_errors) / len(all_errors), 2)
    else:
        calibrated_bias = 0.0
        
    log(f"Overall settlement bias: {calibrated_bias}°F")
    
    # 2. Calibration of Kalshi Implied Probabilities
    # For this, we join:
    # - kalshi_markets
    # - nws_forecasts (closest issue time before the target date)
    # - kalshi_prices (at the NWS forecast issue time)
    # Let's map forecast issue times to Kalshi price candles.
    # NWS forecasts are typically issued around 04:30 AM/PM EST (08:30 / 20:30 UTC or 09:30 / 21:30 UTC).
    # Kalshi price candles have timestamp (unix epoch).
    # For each forecast issue time, we convert it to unix timestamp and look for candles within a 2-hour window.
    
    # Let's extract matched triplets: (market_ticker, target_date, strike_rules, Kalshi yes_ask, NWS_forecast_high, actual_high, settled_result)
    # We query all settled markets
    cur.execute("""
        SELECT ticker, strike_type, floor_strike, cap_strike, expiration_value, result, target_date, open_time, close_time
        FROM kalshi_markets
    """)
    markets = cur.fetchall()
    
    matched_data = []
    
    for ticker, strike_type, floor_strike, cap_strike, actual, result, target_date, open_time, close_time in markets:
        if actual is None:
            continue
            
        # Get NWS forecasts for this target_date
        cur.execute("""
            SELECT issue_time, lead_days, forecast_high 
            FROM nws_forecasts 
            WHERE target_date = ? AND lead_days <= 5 AND lead_days >= 0
        """, (target_date,))
        m_forecasts = cur.fetchall()
        
        for issue_time, lead, mu in m_forecasts:
            # issue_time looks like "2026-05-22 14:32:00" in local time
            # Convert issue_time to local timestamp
            try:
                # NWS issues in ET. Let's parse as ET
                # Standard format: YYYY-MM-DD HH:MM:SS
                # To find unix timestamp:
                dt_local = datetime.strptime(issue_time, "%Y-%m-%d %H:%M:%S")
                # Approximate UTC timestamp (assume Eastern is UTC-4 or UTC-5)
                # Let's assume -4 for DST (May-Oct) and -5 for standard time (Nov-Apr)
                is_dst = 3 <= dt_local.month <= 10 # rough DST filter (Mar-Nov)
                offset = 4 if is_dst else 5
                dt_utc = dt_local + timedelta(hours=offset)
                issue_ts = int(dt_utc.replace(tzinfo=timezone.utc).timestamp())
            except Exception:
                continue
                
            # Find the closest Kalshi price candle within 2 hours of this NWS issue time
            cur.execute("""
                SELECT yes_ask, yes_bid, price, timestamp FROM kalshi_prices
                WHERE ticker = ? AND timestamp >= ? AND timestamp <= ?
                ORDER BY ABS(timestamp - ?) ASC LIMIT 1
            """, (ticker, issue_ts - 7200, issue_ts + 7200, issue_ts))
            price_row = cur.fetchone()
            
            if not price_row or price_row[0] is None:
                continue
                
            yes_ask, yes_bid, price, candle_ts = price_row
            
            # Kalshi YES ask represents the cost in dollars (e.g. 0.30 = 30 cents = 30% implied prob).
            # Convert yes_ask to cents
            kalshi_ask_cents = round(yes_ask * 100)
            
            # Calculate standard Model P(YES)
            # Normal(mu, sigma) with target strike rules
            lead_sigma = priors_sigma.get(lead, 3.5)
            # Use normal distribution PDF/CDF math to calculate model P(YES)
            model_prob = calculate_model_prob(strike_type, floor_strike, cap_strike, mu, lead_sigma)
            
            if model_prob is not None:
                matched_data.append({
                    "ticker": ticker,
                    "target_date": target_date,
                    "lead": lead,
                    "nws_forecast": mu,
                    "actual": actual,
                    "strike_type": strike_type,
                    "floor": floor_strike,
                    "cap": cap_strike,
                    "kalshi_price": kalshi_ask_cents, # in cents (0-100)
                    "model_p": round(model_prob * 100), # in % (0-100)
                    "result": 1 if result.lower() == "yes" else 0
                })
                
    log(f"Matched {len(matched_data)} forecast-price-settlement triplets.")
    
    # 3. Bin prices and calculate win rates to build a Calibration Curve
    # Bin sizes: 10% wide (0-10, 10-20, ... 90-100)
    bins = [i * 10 for i in range(11)]
    kalshi_bins = {b: {"yes_count": 0, "total": 0} for b in bins[:-1]}
    model_bins = {b: {"yes_count": 0, "total": 0} for b in bins[:-1]}
    
    for d in matched_data:
        k_price = d["kalshi_price"]
        m_prob = d["model_p"]
        res = d["result"]
        
        # Find which bin
        k_bin = min(90, (k_price // 10) * 10)
        m_bin = min(90, (m_prob // 10) * 10)
        
        # Guard in bounds
        k_bin = max(0, k_bin)
        m_bin = max(0, m_bin)
        
        kalshi_bins[k_bin]["total"] += 1
        model_bins[m_bin]["total"] += 1
        if res == 1:
            kalshi_bins[k_bin]["yes_count"] += 1
            model_bins[m_bin]["yes_count"] += 1
            
    calibration_curve = []
    for b in bins[:-1]:
        k_total = kalshi_bins[b]["total"]
        m_total = model_bins[b]["total"]
        
        calibration_curve.append({
            "bucket": f"{b}-{b+10}%",
            "midpoint": b + 5,
            "kalshiWinRate": round(kalshi_bins[b]["yes_count"] / k_total, 3) if k_total > 0 else None,
            "kalshiCount": k_total,
            "modelWinRate": round(model_bins[b]["yes_count"] / m_total, 3) if m_total > 0 else None,
            "modelCount": m_total
        })
        
    # 4. Calculate Brier Scores (Mean Squared Error of probabilities)
    # Brier Score = 1/N * sum((p - y)^2)
    # Lower is better!
    k_sq_errors = []
    m_sq_errors = []
    
    for d in matched_data:
        res = d["result"]
        # Convert Kalshi price to prob
        k_prob = d["kalshi_price"] / 100.0
        m_prob = d["model_p"] / 100.0
        
        k_sq_errors.append((k_prob - res) ** 2)
        m_sq_errors.append((m_prob - res) ** 2)
        
    k_brier = sum(k_sq_errors) / len(k_sq_errors) if k_sq_errors else None
    m_brier = sum(m_sq_errors) / len(m_sq_errors) if m_sq_errors else None
    
    log(f"Kalshi Brier Score: {k_brier:.4f}" if k_brier else "Kalshi Brier Score: N/A")
    log(f"Model Brier Score: {m_brier:.4f}" if m_brier else "Model Brier Score: N/A")
    
    # Export all stats
    out_data = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "calibratedBias": calibrated_bias,
        "calibratedSigmas": calibrated_sigmas,
        "errorDistributionByLead": error_stats,
        "calibrationCurve": calibration_curve,
        "accuracyScores": {
            "kalshiBrier": round(k_brier, 4) if k_brier else None,
            "modelBrier": round(m_brier, 4) if m_brier else None,
            "tripletsCount": len(matched_data)
        }
    }
    
    with open(OUTPUT_JSON_PATH, "w") as f:
        json.dump(out_data, f, indent=2)
        
    log(f"Wrote calibration dataset to {OUTPUT_JSON_PATH}")
    conn.close()

# --- PROBABILITY MATH ---

def normal_cdf(x):
    # Abramowitz & Stegun erf approximation
    t = 1.0 / (1.0 + 0.2316419 * abs(x))
    d = 0.3989423 * (2.7182818 ** (-x * x / 2.0))
    p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
    return 1.0 - p if x >= 0 else p

def calculate_model_prob(strike_type, floor, cap, mu, sigma):
    if sigma <= 0:
        return None
        
    # We use the same continuity corrections as probability.js
    if strike_type == "greater" and floor is not None:
        z = (floor + 0.5 - mu) / sigma
        return 1.0 - normal_cdf(z)
        
    if strike_type == "less" and cap is not None:
        z = (cap - 0.5 - mu) / sigma
        return normal_cdf(z)
        
    if strike_type == "between" and floor is not None and cap is not None:
        z_hi = (cap + 0.5 - mu) / sigma
        z_lo = (floor - 0.5 - mu) / sigma
        return normal_cdf(z_hi) - normal_cdf(z_lo)
        
    return None

if __name__ == "__main__":
    init_db()
    
    # Step 1: Fetch Kalshi settled markets metadata
    fetch_kalshi_markets()
    
    # Step 2: Fetch prices for those markets
    fetch_kalshi_prices()
    
    # Step 3: Fetch NWS forecast archives
    fetch_nws_forecasts()
    
    # Step 4: Run analysis & save to JSON
    run_calibration_analysis()
    
    log("Calibration database build finished successfully!")
