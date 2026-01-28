"""
Compare adaptive horizon methods: B (Min-Max) vs C (Percentile Rank)
"""

import numpy as np

# Simulate realistic volatility data (log-normal, like real markets)
np.random.seed(42)
n_bars = 5000
lookback = 500  # rolling window for history

# Log-normal volatility (typical for financial data)
sigma = np.random.lognormal(mean=-4, sigma=0.3, size=n_bars)

# Parameters
h_min, h_max = 12, 48


def horizon_b(sigma_t, sigma_history):
    """Option B: Min-Max with percentile bounds"""
    sigma_lo = np.percentile(sigma_history, 5)
    sigma_hi = np.percentile(sigma_history, 95)

    if sigma_hi == sigma_lo:
        return h_min

    ratio = (sigma_t - sigma_lo) / (sigma_hi - sigma_lo)
    ratio = np.clip(ratio, 0, 1)

    return h_min + int(ratio * (h_max - h_min))


def horizon_c(sigma_t, sigma_history):
    """Option C: Percentile Rank"""
    pct = np.mean(sigma_history < sigma_t)
    return h_min + int(pct * (h_max - h_min))


def horizon_original(sigma_t, sigma_history):
    """Original formula for comparison"""
    sigma_max = np.percentile(sigma_history, 95)
    ratio = sigma_t / sigma_max
    # Using (1 - ratio) as described in original problem
    return h_min + int((1 - ratio) * (h_max - h_min))


# Calculate horizons for each method
horizons_b = []
horizons_c = []
horizons_orig = []

for i in range(lookback, n_bars):
    sigma_t = sigma[i]
    sigma_history = sigma[i - lookback:i]

    horizons_b.append(horizon_b(sigma_t, sigma_history))
    horizons_c.append(horizon_c(sigma_t, sigma_history))
    horizons_orig.append(horizon_original(sigma_t, sigma_history))

horizons_b = np.array(horizons_b)
horizons_c = np.array(horizons_c)
horizons_orig = np.array(horizons_orig)


# Print statistics
def print_stats(name, h):
    print(f"\n{name}:")
    print(f"  Range used:    {h.min()} - {h.max()} (target: {h_min}-{h_max})")
    print(f"  Mean:          {h.mean():.1f}")
    print(f"  Std:           {h.std():.1f}")
    print(f"  Unique values: {len(np.unique(h))}")

    # Distribution across range
    q1 = np.sum(h <= 20) / len(h) * 100
    q2 = np.sum((h > 20) & (h <= 30)) / len(h) * 100
    q3 = np.sum((h > 30) & (h <= 40)) / len(h) * 100
    q4 = np.sum(h > 40) / len(h) * 100
    print(f"  Distribution:  12-20: {q1:5.1f}%  |  21-30: {q2:5.1f}%  |  31-40: {q3:5.1f}%  |  41-48: {q4:5.1f}%")

    # Visual histogram
    print(f"  Histogram:     ", end="")
    for bucket, pct in [("12-20", q1), ("21-30", q2), ("31-40", q3), ("41-48", q4)]:
        bar = "█" * int(pct / 5) + "░" * (20 - int(pct / 5))
        print(f"{bar[:20]} ", end="")
    print()


print("=" * 80)
print("COMPARISON: Adaptive Horizon Methods")
print("=" * 80)
print(f"\nSimulated data: {n_bars} bars of log-normal volatility (typical for financial data)")
print(f"Lookback window: {lookback} bars")
print(f"Target horizon range: [{h_min}, {h_max}] hours")

print_stats("ORIGINAL (your current formula)", horizons_orig)
print_stats("OPTION B (Min-Max w/ percentile bounds)", horizons_b)
print_stats("OPTION C (Percentile Rank)", horizons_c)

print("\n" + "=" * 80)
print("VERDICT:")
print("=" * 80)
range_orig = horizons_orig.max() - horizons_orig.min()
range_b = horizons_b.max() - horizons_b.min()
range_c = horizons_c.max() - horizons_c.min()

print(f"\n  Original uses {range_orig}/{h_max - h_min} of available range ({range_orig/(h_max-h_min)*100:.0f}%)")
print(f"  Option B uses {range_b}/{h_max - h_min} of available range ({range_b/(h_max-h_min)*100:.0f}%)")
print(f"  Option C uses {range_c}/{h_max - h_min} of available range ({range_c/(h_max-h_min)*100:.0f}%)")

std_orig = horizons_orig.std()
std_b = horizons_b.std()
std_c = horizons_c.std()
print(f"\n  Original std: {std_orig:.1f}  |  B std: {std_b:.1f}  |  C std: {std_c:.1f}")
print(f"\n  → C has {std_c/std_orig:.1f}x more variation than Original")
print(f"  → C has {std_c/std_b:.1f}x more variation than B")
