"""
Adaptive Horizon Calculation using Percentile Rank (Option C)

For ML labeling: high volatility → long horizon (avoid whipsaws)
"""

import numpy as np
from collections import deque


class AdaptiveHorizon:
    """
    Calculates adaptive horizon using percentile rank of volatility.

    Guarantees uniform distribution across [h_min, h_max] range.
    """

    def __init__(self, h_min: int = 12, h_max: int = 48, lookback: int = 500):
        """
        Args:
            h_min: Minimum horizon (hours)
            h_max: Maximum horizon (hours)
            lookback: Rolling window size for volatility history
        """
        self.h_min = h_min
        self.h_max = h_max
        self.lookback = lookback
        self.sigma_history = deque(maxlen=lookback)

    def update(self, sigma_t: float) -> int:
        """
        Update with new volatility and return adaptive horizon.

        Args:
            sigma_t: Current EWMA volatility

        Returns:
            Adaptive horizon in hours
        """
        if len(self.sigma_history) < 2:
            self.sigma_history.append(sigma_t)
            return (self.h_min + self.h_max) // 2  # Default to midpoint

        # Percentile rank: what fraction of history is below current?
        pct = np.mean(np.array(self.sigma_history) < sigma_t)

        # High vol → high percentile → long horizon
        horizon = self.h_min + int(pct * (self.h_max - self.h_min))

        # Update history
        self.sigma_history.append(sigma_t)

        return horizon

    def calculate(self, sigma_t: float, sigma_history: np.ndarray) -> int:
        """
        Stateless calculation (for batch processing).

        Args:
            sigma_t: Current EWMA volatility
            sigma_history: Array of past volatility values

        Returns:
            Adaptive horizon in hours
        """
        if len(sigma_history) < 2:
            return (self.h_min + self.h_max) // 2

        pct = np.mean(sigma_history < sigma_t)
        return self.h_min + int(pct * (self.h_max - self.h_min))


# Standalone function for simple usage
def adaptive_horizon(sigma_t: float, sigma_history: np.ndarray,
                     h_min: int = 12, h_max: int = 48) -> int:
    """
    Calculate adaptive horizon using percentile rank.

    Args:
        sigma_t: Current EWMA volatility
        sigma_history: Array of past volatility values
        h_min: Minimum horizon (hours)
        h_max: Maximum horizon (hours)

    Returns:
        Adaptive horizon in hours
    """
    if len(sigma_history) < 2:
        return (h_min + h_max) // 2

    pct = np.mean(sigma_history < sigma_t)
    return h_min + int(pct * (h_max - h_min))


if __name__ == "__main__":
    # Quick test
    np.random.seed(42)

    # Simulate log-normal volatility
    sigma = np.random.lognormal(mean=-4, sigma=0.3, size=1000)

    # Test stateful class
    ah = AdaptiveHorizon(h_min=12, h_max=48, lookback=200)
    horizons = [ah.update(s) for s in sigma]

    print("AdaptiveHorizon test:")
    print(f"  Range: {min(horizons)} - {max(horizons)}")
    print(f"  Mean:  {np.mean(horizons):.1f}")
    print(f"  Std:   {np.std(horizons):.1f}")

    # Distribution check
    h = np.array(horizons[200:])  # Skip warmup
    q1 = np.sum(h <= 20) / len(h) * 100
    q2 = np.sum((h > 20) & (h <= 30)) / len(h) * 100
    q3 = np.sum((h > 30) & (h <= 40)) / len(h) * 100
    q4 = np.sum(h > 40) / len(h) * 100
    print(f"  Distribution: 12-20: {q1:.0f}% | 21-30: {q2:.0f}% | 31-40: {q3:.0f}% | 41-48: {q4:.0f}%")
