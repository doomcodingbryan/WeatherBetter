#!/usr/bin/env python3
import os
import json
import sys

def verify_calibration():
    path = "data/calibration-data.json"
    if not os.path.exists(path):
        print(f"Error: {path} does not exist yet.", file=sys.stderr)
        sys.exit(1)
        
    try:
        with open(path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"Error: {path} is not valid JSON ({e}).", file=sys.stderr)
        sys.exit(1)
        
    print("=== Verification of calibration-data.json ===")
    
    # 1. Check top-level keys
    required_keys = ["generatedAt", "calibratedBias", "calibratedSigmas", "errorDistributionByLead", "calibrationCurve", "accuracyScores"]
    for k in required_keys:
        if k not in data:
            print(f"FAIL: Missing key '{k}'", file=sys.stderr)
            sys.exit(1)
            
    print("OK: All top-level keys present.")
    
    # 2. Validate bias
    bias = data["calibratedBias"]
    if not isinstance(bias, (int, float)):
        print(f"FAIL: calibratedBias must be numeric, got {type(bias).__name__}", file=sys.stderr)
        sys.exit(1)
    if not (-10.0 <= bias <= 10.0):
        print(f"FAIL: calibratedBias is unusually large: {bias}°F", file=sys.stderr)
        sys.exit(1)
    print(f"OK: calibratedBias is reasonable: {bias}°F")

    # 3. Validate monthlyBias (optional field)
    if "monthlyBias" in data:
        mb = data["monthlyBias"]
        if not isinstance(mb, dict):
            print(f"FAIL: monthlyBias must be a JSON object, got {type(mb).__name__}", file=sys.stderr)
            sys.exit(1)
        for month_key, month_val in mb.items():
            if not month_key.isdigit() or not (1 <= int(month_key) <= 12):
                print(f"FAIL: monthlyBias key must be a month number 1-12, got '{month_key}'", file=sys.stderr)
                sys.exit(1)
            if not isinstance(month_val, (int, float)) or not (-10.0 <= month_val <= 10.0):
                print(f"FAIL: monthlyBias[{month_key}] out of bounds: {month_val}", file=sys.stderr)
                sys.exit(1)
        print(f"OK: monthlyBias present for {len(mb)} months: {sorted(int(k) for k in mb.keys())}")
    else:
        print("OK: monthlyBias not present (optional — will use global calibratedBias).")

    # 4. Validate tailNu (optional field — degrees of freedom for t-distribution tail model)
    if "tailNu" in data:
        nu = data["tailNu"]
        if not isinstance(nu, (int, float)):
            print(f"FAIL: tailNu must be numeric, got {type(nu).__name__}", file=sys.stderr)
            sys.exit(1)
        if not (3.0 <= nu <= 100.0):
            print(f"FAIL: tailNu out of expected range [3, 100]: {nu}", file=sys.stderr)
            sys.exit(1)
        print(f"OK: tailNu={nu} (t-distribution degrees of freedom for tail correction).")
    else:
        print("OK: tailNu not present (optional — will use Normal distribution).")

    # 5. Validate sigmas
    sigmas = data["calibratedSigmas"]
    if not isinstance(sigmas, dict):
        print(f"FAIL: calibratedSigmas must be a JSON object, got {type(sigmas).__name__}", file=sys.stderr)
        sys.exit(1)
        
    for lead, sig in sigmas.items():
        if not lead.isdigit():
            print(f"FAIL: Lead key must be string representation of int, got '{lead}'", file=sys.stderr)
            sys.exit(1)
        if not isinstance(sig, (int, float)) or sig <= 0:
            print(f"FAIL: Sigma for lead {lead} must be positive, got {sig}", file=sys.stderr)
            sys.exit(1)
        if not (0.5 <= sig <= 15.0):
            print(f"FAIL: Sigma for lead {lead} is out of expected bounds [0.5, 15]: {sig}", file=sys.stderr)
            sys.exit(1)
            
    print(f"OK: calibratedSigmas are positive and reasonable for {len(sigmas)} lead days.")
    
    # 6. Validate accuracyScores
    scores = data["accuracyScores"]
    if not isinstance(scores, dict):
        print(f"FAIL: accuracyScores must be a JSON object, got {type(scores).__name__}", file=sys.stderr)
        sys.exit(1)
        
    for k in ["kalshiBrier", "modelBrier", "tripletsCount"]:
        if k not in scores:
            print(f"FAIL: Missing accuracy key '{k}'", file=sys.stderr)
            sys.exit(1)
            
    k_brier = scores["kalshiBrier"]
    m_brier = scores["modelBrier"]
    count = scores["tripletsCount"]
    
    if k_brier is not None and not (0.0 <= k_brier <= 1.0):
        print(f"FAIL: kalshiBrier must be between 0 and 1, got {k_brier}", file=sys.stderr)
        sys.exit(1)
    if m_brier is not None and not (0.0 <= m_brier <= 1.0):
        print(f"FAIL: modelBrier must be between 0 and 1, got {m_brier}", file=sys.stderr)
        sys.exit(1)
        
    print(f"OK: Accuracy scores are valid. Triplets analyzed: {count}")
    print(f"    Kalshi Brier Score: {k_brier}")
    print(f"    Model Brier Score: {m_brier}")
    
    print("ALL CHECKS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    verify_calibration()
