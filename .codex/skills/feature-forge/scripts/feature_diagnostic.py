#!/usr/bin/env python3
"""Feature diagnostic script for feature-forge workflow.

Usage:
    uv run python .codex/skills/feature-forge/scripts/feature_diagnostic.py <feature_name>
    uv run python .codex/skills/feature-forge/scripts/feature_diagnostic.py <feat1> <feat2> <feat3>
    uv run python .codex/skills/feature-forge/scripts/feature_diagnostic.py pivot_strength
    uv run python .codex/skills/feature-forge/scripts/feature_diagnostic.py funding_rate open_interest basis
    uv run python .codex/skills/feature-forge/scripts/feature_diagnostic.py obv --source experiment
    uv run python .codex/skills/feature-forge/scripts/feature_diagnostic.py perf-scan
    uv run python .codex/skills/feature-forge/scripts/feature_diagnostic.py clean-workshop
    uv run python .codex/skills/feature-forge/scripts/feature_diagnostic.py --clean-workshop

Defaults:
    --start 2023-06-25
    --end (default: Jan 1 of current year, UTC)
    --horizon 24 (auto horizon sensitivity checks at 12/24/36/48)
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import math
import os
import sys
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from textwrap import dedent

import numpy as np
import polars as pl
from scipy import stats

from aegis.infrastructure.utils.correlation import (
    chatterjee_xi,
    dcor_pvalue as dcor_pvalue_metric,
    pearson_ic,
    rank_distance_correlation,
    rdc,
    rolling_rdc,
    rolling_spearman,
    spearman_ic,
)

# IC: Spearman for signed predictive power (feature → returns)
_ic = spearman_ic

# Correlation: Pearson for feature-feature redundancy checks
_corr = pearson_ic


DEFAULT_INTERACTIONS: dict[str, tuple[str, ...]] = {
    "funding_oi_product": ("funding_rate", "open_interest_change"),
    "crowding_intensity": ("funding_rate", "open_interest"),
    "unwind_indicator": ("funding_rate", "open_interest_change"),
    "sentiment_alignment": ("funding_rate", "basis"),
}

CLEAN_WORKSHOP_TEMPLATE = dedent(
    '''\
"""Feature workshop for feature-forge experiments.

Define experimental feature functions here and register them in FEATURES.
The diagnostic script can run them with --source experiment or --source auto.
Run the diagnostic script with the clean-workshop subcommand (or --clean-workshop) to reset this file.
"""

from __future__ import annotations

from typing import Callable

import polars as pl


def example_feature(df: pl.DataFrame) -> pl.Series:
    """Example feature stub (returns neutral 0.5)."""
    return pl.Series([0.5] * df.height)


# Register features after definitions to avoid forward refs.
FEATURES: dict[str, Callable[..., pl.Series]] = {
    # "example_feature": example_feature,
}
'''
)


def _build_interaction_map(specs: list[str], map_path: str | None) -> dict[str, list[str]]:
    mapping = {name: list(parents) for name, parents in DEFAULT_INTERACTIONS.items()}

    if map_path:
        path = Path(map_path)
        if not path.exists():
            raise FileNotFoundError(f"Interaction map not found: {map_path}")
        raw = json.loads(path.read_text())
        if not isinstance(raw, dict):
            raise ValueError("Interaction map JSON must be a dict of feature -> parents")
        for name, parents in raw.items():
            if isinstance(parents, str):
                parsed = [p.strip() for p in parents.split(",") if p.strip()]
            elif isinstance(parents, (list, tuple)):
                parsed = [str(p).strip() for p in parents if str(p).strip()]
            else:
                continue
            if len(parsed) >= 2 and name:
                mapping[str(name)] = parsed

    for spec in specs:
        if ":" not in spec:
            raise ValueError("Interaction spec must be feature:parent1,parent2")
        name, parents_str = spec.split(":", 1)
        parents = [p.strip() for p in parents_str.split(",") if p.strip()]
        if len(parents) < 2:
            raise ValueError("Interaction spec requires at least 2 parents")
        mapping[name.strip()] = parents

    return mapping


@dataclass(frozen=True)
class DiagConfig:
    horizon: int
    min_samples: int
    split: float
    rolling_window: int
    regime_window: int
    null_block: int
    null_samples: int
    null_p_thresh: float
    leak_lead_thresh: float
    flag_min_ratio: float
    position_mode: str
    quantile: float
    cost_bps: float
    neutralize: bool
    seed: int
    perf_bars: int
    perf_sluggish_ms: float
    perf_warn_ms: float
    wf_train: int | None
    wf_test: int | None
    wf_embargo: int | None
    wf_step: int | None
    wf_min_folds: int
    stream_check: bool
    stream_samples: int
    stream_warmup: int
    stream_thresh: float
    per_fold_recompute: bool
    interaction_checks: bool
    interaction_corr_max: float
    interaction_resid_min: float
    interaction_uplift_min: float
    interaction_quad_min: float
    interaction_parent_margin: float
    interaction_min_group: int
    interaction_auto: int
    interaction_auto_min_corr: float
    interaction_auto_max_pool: int
    interaction_auto_only: bool
    interaction_include_disabled: bool
    interaction_edge_uplift_min: float


def load_data(symbol: str, start: str = "2023-06-25", end: str = "") -> pl.DataFrame:
    """Load OHLCV data from parquet as Polars DataFrame."""
    if not end:
        end = f"{datetime.now(tz=UTC).year}-01-01"
    paths = [
        Path(f"data/historical/{symbol}_1h.parquet"),
        Path.home() / f"data/historical/{symbol}_1h.parquet",
    ]
    for path in paths:
        if path.exists():
            df = pl.read_parquet(path)
            # Normalize timestamp column to UTC
            if "timestamp" in df.columns:
                ts_dtype = df.schema["timestamp"]
                if isinstance(ts_dtype, pl.Datetime):
                    if ts_dtype.time_zone is None:
                        df = df.with_columns(pl.col("timestamp").dt.replace_time_zone("UTC"))
                    elif ts_dtype.time_zone != "UTC":
                        df = df.with_columns(pl.col("timestamp").dt.convert_time_zone("UTC"))
                else:
                    # Parse string timestamps
                    df = df.with_columns(
                        pl.col("timestamp").cast(pl.Datetime).dt.replace_time_zone("UTC")
                    )
            else:
                raise ValueError(f"Data file missing timestamp column: {path}")

            df = df.sort("timestamp")
            # Filter by date range - cast to same precision as data
            ts_dtype = df.schema["timestamp"]
            start_dt = pl.lit(start).str.to_datetime().cast(ts_dtype)
            end_dt = pl.lit(end).str.to_datetime().cast(ts_dtype)
            df = df.filter((pl.col("timestamp") >= start_dt) & (pl.col("timestamp") < end_dt))
            return df
    raise FileNotFoundError(f"No data found for {symbol}")


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent
    return Path(__file__).resolve().parents[4]


def _workshop_path() -> Path:
    return _repo_root() / "experiments" / "feature_forge" / "feature_workshop.py"


def _default_symbols() -> list[str]:
    data_dir = _repo_root() / "data" / "historical"
    if data_dir.exists():
        symbols = sorted({p.name.split("_", 1)[0] for p in data_dir.glob("*_1h.parquet")})
        if symbols:
            return symbols
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT"]


@lru_cache(maxsize=1)
def _load_disabled_features() -> set[str]:
    config_path = _repo_root() / "config" / "features.json"
    if not config_path.exists():
        return set()
    try:
        data = json.loads(config_path.read_text())
    except json.JSONDecodeError:
        return set()
    disabled = data.get("disabled_features", [])
    if isinstance(disabled, list):
        return {str(name) for name in disabled}
    return set()


@lru_cache(maxsize=1)
def _get_trading_constants():
    """Cached TradingConstants to avoid repeated Pydantic validation."""
    from aegis.infrastructure.config.trading_constants import TradingConstants

    return TradingConstants()


def _filter_disabled(pool: dict[str, pl.Series], include_disabled: bool) -> dict[str, pl.Series]:
    if include_disabled:
        return pool
    disabled = _load_disabled_features()
    if not disabled:
        return pool
    return {name: series for name, series in pool.items() if name not in disabled}


def _load_experiment_registry() -> dict[str, Callable[[pl.DataFrame], pl.Series]]:
    workshop_path = _workshop_path()
    if not workshop_path.exists():
        return {}

    spec = importlib.util.spec_from_file_location("feature_forge_workshop", workshop_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load feature workshop: {workshop_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    features = getattr(module, "FEATURES", {})
    if not isinstance(features, dict):
        raise TypeError("Experiment FEATURES must be a dict[str, Callable]")
    return features


def _clean_workshop(backup: bool) -> Path:
    workshop_path = _workshop_path()
    workshop_path.parent.mkdir(parents=True, exist_ok=True)
    template = CLEAN_WORKSHOP_TEMPLATE.strip() + "\n"
    if workshop_path.exists():
        current = workshop_path.read_text()
        if current.strip() == template.strip():
            print(f"Workshop already clean: {workshop_path}")
            return workshop_path
        if backup:
            timestamp = datetime.now(tz=UTC).strftime("%Y%m%d_%H%M%S")
            backups_dir = workshop_path.parent / "backups"
            backups_dir.mkdir(parents=True, exist_ok=True)
            backup_path = backups_dir / f"{workshop_path.stem}.bak.{timestamp}.py"
            backup_path.write_text(current)
            print(f"Workshop backup written: {backup_path}")
    workshop_path.write_text(template)
    print(f"Workshop reset to clean template: {workshop_path}")
    return workshop_path


def _handle_clean_subcommand(argv: list[str]) -> bool:
    if len(argv) < 2:
        return False
    if argv[1] != "clean-workshop":
        return False

    parser = argparse.ArgumentParser(
        description="Reset experiments/feature_forge/feature_workshop.py to a clean board."
    )
    parser.add_argument("command", choices=["clean-workshop"])
    parser.add_argument(
        "--no-backup",
        dest="clean_backup",
        action="store_false",
        default=True,
        help="Skip backup when cleaning the workshop",
    )
    parser.add_argument(
        "--no-clean-backup",
        dest="clean_backup",
        action="store_false",
        help="Alias for --no-backup",
    )
    args = parser.parse_args(argv[1:])
    _clean_workshop(backup=args.clean_backup)
    return True


def _list_feature_names_for_source(source: str, include_disabled: bool) -> list[str]:
    names: set[str] = set()

    if source in {"experiment", "auto"}:
        names.update(_load_experiment_registry().keys())

    if source in {"engine", "auto"}:
        constants = _get_trading_constants()
        names.update(_get_feature_engine_index(constants).keys())

    if not include_disabled:
        disabled = _load_disabled_features()
        names = {name for name in names if name not in disabled}

    return sorted(names)


def _handle_perf_scan_subcommand(argv: list[str]) -> bool:
    if len(argv) < 2:
        return False
    if argv[1] != "perf-scan":
        return False

    parser = argparse.ArgumentParser(
        description="Scan feature compute performance (ms per N bars) without running full diagnostics."
    )
    parser.add_argument("command", choices=["perf-scan"])
    parser.add_argument(
        "--source",
        choices=["engine", "experiment", "auto"],
        default="engine",
        help="Feature source to scan.",
    )
    parser.add_argument("--symbols", nargs="+", default=_default_symbols())
    parser.add_argument("--start", default="2023-06-25", help="Start date (YYYY-MM-DD)")
    parser.add_argument(
        "--end",
        default="",
        help="End date (YYYY-MM-DD, default: Jan 1 of current year, UTC)",
    )
    parser.add_argument(
        "--perf-bars",
        type=int,
        default=8000,
        help="Normalize compute time to this many bars.",
    )
    parser.add_argument(
        "--include-disabled",
        action="store_true",
        help="Include disabled features from config/features.json.",
    )
    parser.add_argument(
        "--metric",
        choices=["median", "mean", "max"],
        default="median",
        help="Per-feature aggregation metric across symbols (used for ranking).",
    )
    parser.add_argument("--top", type=int, default=15, help="Show N slowest features.")
    parser.add_argument(
        "--json-out",
        default="",
        help="Write raw results to a JSON file for offline analysis.",
    )
    args = parser.parse_args(argv[1:])

    features = _list_feature_names_for_source(args.source, include_disabled=args.include_disabled)
    if not features:
        raise ValueError(f"No features found for source={args.source!r}")

    # Load data + market states once per symbol (timing excludes this setup).
    df_cache: dict[str, pl.DataFrame] = {}
    states_cache: dict[str, list] = {}
    for symbol in args.symbols:
        try:
            df = load_data(symbol, start=args.start, end=args.end)
        except Exception as e:
            print(f"Skipping {symbol}: {e}")
            continue
        df_cache[symbol] = df
        try:
            states_cache[symbol] = _build_market_states(df, symbol)
        except Exception:
            # Some features may not require states; allow fallback inside compute_feature_with_perf.
            states_cache[symbol] = None

    symbols = sorted(df_cache.keys())
    if not symbols:
        raise ValueError("No symbols could be loaded for perf-scan")

    per_feature: list[dict] = []
    for feature_name in features:
        per_symbol: dict[str, float] = {}
        for symbol in symbols:
            df = df_cache[symbol]
            try:
                _, compute_ms = compute_feature_with_perf(
                    df, feature_name, symbol, args.source, states=states_cache.get(symbol)
                )
            except Exception:
                continue
            ms_per_n = compute_ms * args.perf_bars / max(len(df), 1)
            per_symbol[symbol] = float(ms_per_n)

        if not per_symbol:
            continue

        values = np.asarray(list(per_symbol.values()), dtype=float)
        row = {
            "feature": feature_name,
            "n_symbols": len(per_symbol),
            "median_ms": float(np.nanmedian(values)),
            "mean_ms": float(np.nanmean(values)),
            "max_ms": float(np.nanmax(values)),
            "per_symbol_ms": per_symbol,
        }
        per_feature.append(row)

    if not per_feature:
        raise ValueError("Perf-scan produced no results (no feature/symbol computations succeeded)")

    metric_key = {"median": "median_ms", "mean": "mean_ms", "max": "max_ms"}[args.metric]
    per_feature.sort(key=lambda r: float(r.get(metric_key, np.nan)), reverse=True)

    metric_values = np.asarray([r[metric_key] for r in per_feature], dtype=float)

    def _q(p: float) -> float:
        return float(np.nanquantile(metric_values, p)) if metric_values.size else np.nan

    print("=" * 70)
    print("PERF SCAN (ms per normalized bars)")
    print("=" * 70)
    print(
        f"Source: {args.source} | Symbols: {len(symbols)} | Features: {len(per_feature)} | "
        f"Normalized bars: {args.perf_bars} | Metric: {args.metric}"
    )
    print(
        "Quantiles (ms): "
        f"p50={_q(0.50):.2f}, p75={_q(0.75):.2f}, p90={_q(0.90):.2f}, "
        f"p95={_q(0.95):.2f}, p99={_q(0.99):.2f}"
    )
    print(f"Suggested --perf-warn-ms: p90={_q(0.90):.2f} | p95={_q(0.95):.2f}")
    print(f"Suggested --perf-sluggish-ms: p75={_q(0.75):.2f} | p80={_q(0.80):.2f}")
    print()
    print("Slowest features:")
    for r in per_feature[: max(0, args.top)]:
        print(
            f"  {r['feature']}: {r[metric_key]:.2f} ms "
            f"(median={r['median_ms']:.2f}, mean={r['mean_ms']:.2f}, max={r['max_ms']:.2f}, "
            f"n={r['n_symbols']}/{len(symbols)})"
        )

    if args.json_out:
        path = Path(args.json_out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "source": args.source,
                    "symbols": symbols,
                    "perf_bars": args.perf_bars,
                    "metric": args.metric,
                    "per_feature": per_feature,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        print()
        print(f"Wrote JSON: {path}")

    return True


def _call_experiment_feature(
    func: Callable[..., pl.Series], df: pl.DataFrame, symbol: str
) -> pl.Series:
    params = inspect.signature(func).parameters
    if len(params) >= 2:
        return func(df, symbol)
    return func(df)


def _build_market_states(df: pl.DataFrame, symbol: str) -> list:
    from aegis.domain.entities.market_state import MarketState
    from aegis.domain.enums.asset_type import AssetType

    # Pre-extract columns as numpy arrays for fast access
    n = df.height
    timestamps = df["timestamp"].to_numpy()
    opens = df["open"].to_numpy()
    highs = df["high"].to_numpy()
    lows = df["low"].to_numpy()
    closes = df["close"].to_numpy()
    volumes = df["volume"].to_numpy()

    # Pre-extract metadata columns with validity masks
    metadata_cols = [
        "funding_rate",
        "open_interest",
        "basis",
        "long_liquidations",
        "short_liquidations",
        "long_ratio",
    ]
    metadata_data = {}  # {col: (values_array, valid_mask)}
    for col in metadata_cols:
        if col in df.columns:
            arr = df[col].to_numpy().astype(np.float64)
            valid = ~np.isnan(arr)
            metadata_data[col] = (arr, valid)

    asset_type = AssetType.CRYPTO_PERP
    states = [None] * n  # Pre-allocate list

    for i in range(n):
        ts = timestamps[i]
        # Convert numpy datetime64 to Python datetime
        if hasattr(ts, "astype"):
            ts = ts.astype("datetime64[us]").astype(datetime)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)

        metadata = {}
        for col, (arr, valid) in metadata_data.items():
            if valid[i]:
                metadata[col] = arr[i]
        if "basis" in metadata:
            metadata["basis_raw"] = metadata.pop("basis")

        states[i] = MarketState(
            symbol=symbol,
            asset_type=asset_type,
            timestamp=ts,
            open=float(opens[i]),
            high=float(highs[i]),
            low=float(lows[i]),
            close=float(closes[i]),
            volume=float(volumes[i]),
            metadata=metadata,
        )
    return states


def _build_engines(constants) -> list:
    engines = []

    try:
        from aegis.infrastructure.adapters.feature_engines.price_engine import (
            PriceFeatureEngine,
        )

        engines.append(PriceFeatureEngine())
    except ImportError:
        pass

    try:
        from aegis.infrastructure.adapters.feature_engines.pattern_engine import (
            PatternFeatureEngine,
        )

        engines.append(PatternFeatureEngine(constants.indicators, constants.support_resistance))
    except ImportError:
        pass

    try:
        from aegis.infrastructure.adapters.feature_engines.momentum_engine import (
            MomentumFeatureEngine,
        )

        engines.append(MomentumFeatureEngine(constants.indicators))
    except ImportError:
        pass

    try:
        from aegis.infrastructure.adapters.feature_engines.regime_engine import RegimeFeatureEngine

        engines.append(
            RegimeFeatureEngine(constants.indicators, constants.regime, constants.volatility)
        )
    except ImportError:
        pass

    try:
        from aegis.infrastructure.adapters.feature_engines.volatility_engine import (
            VolatilityFeatureEngine,
        )

        engines.append(VolatilityFeatureEngine(constants.indicators))
    except ImportError:
        pass

    try:
        from aegis.infrastructure.adapters.feature_engines.volume_engine import VolumeFeatureEngine

        engines.append(VolumeFeatureEngine(constants.volume))
    except ImportError:
        pass

    try:
        from aegis.infrastructure.adapters.feature_engines.crypto_ta import CryptoTAEngine

        engines.append(CryptoTAEngine(constants.crypto))
    except ImportError:
        pass

    try:
        from aegis.infrastructure.adapters.feature_engines.mtf_engine import MTFTrendEngine

        engines.append(MTFTrendEngine(mtf_settings=constants.mtf))
    except ImportError:
        pass

    return engines


# Cache: feature_name -> engine instance
_FEATURE_ENGINE_INDEX: dict[str, object] | None = None


def _get_feature_engine_index(constants) -> dict[str, object]:
    """Build feature->engine index dynamically from available engines."""
    global _FEATURE_ENGINE_INDEX
    if _FEATURE_ENGINE_INDEX is not None:
        return _FEATURE_ENGINE_INDEX

    index: dict[str, object] = {}
    for engine in _build_engines(constants):
        if hasattr(engine, "FEATURES"):
            for feat in engine.FEATURES:
                index[feat.name] = engine
    _FEATURE_ENGINE_INDEX = index
    return index


def _compute_feature_pool(
    df: pl.DataFrame,
    symbol: str,
    source: str,
    include_disabled: bool,
    states: list | None = None,
) -> dict[str, pl.Series]:
    pool: dict[str, pl.Series] = {}
    disabled = set() if include_disabled else _load_disabled_features()

    if source in {"engine", "auto"}:
        constants = _get_trading_constants()
        if states is None:
            states = _build_market_states(df, symbol)
        for engine in _build_engines(constants):
            # Get only enabled features for this engine
            if hasattr(engine, "FEATURES"):
                enabled = [f.name for f in engine.FEATURES if f.name not in disabled]
                if not enabled:
                    continue  # Skip engine entirely if all features disabled
            else:
                enabled = None  # Compute all if no FEATURES defined
            try:
                output = engine.compute_vectorized(df, states, features=enabled)
            except Exception:
                continue
            for name, series in output.items():
                pool[name] = series

    if source in {"experiment", "auto"}:
        experiments = _load_experiment_registry()
        for name, func in experiments.items():
            if name in disabled:
                continue  # Skip disabled experiment features
            try:
                pool[name] = _call_experiment_feature(func, df, symbol)
            except Exception:
                continue

    return pool


def compute_feature(
    df: pl.DataFrame,
    feature_name: str,
    symbol: str,
    source: str,
    states: list | None = None,
) -> pl.Series:
    """Compute a feature using the appropriate engine (with direct lookup).

    Args:
        df: OHLCV DataFrame
        feature_name: Name of feature to compute
        symbol: Trading symbol
        source: Feature source ("engine", "experiment", "auto")
        states: Optional pre-built market states (for caching/reuse)
    """
    if source in {"experiment", "auto"}:
        experiments = _load_experiment_registry()
        if feature_name in experiments:
            series = _call_experiment_feature(experiments[feature_name], df, symbol)
            return series
        if source == "experiment":
            raise ValueError(f"Experiment feature '{feature_name}' not found in registry")

    constants = _get_trading_constants()
    index = _get_feature_engine_index(constants)

    # Direct lookup - O(1) instead of O(n_engines)
    if feature_name in index:
        engine = index[feature_name]
        if states is None:
            states = _build_market_states(df, symbol)
        output = engine.compute_vectorized(df, states, features=[feature_name])
        if feature_name in output:
            return output[feature_name]

    raise ValueError(f"Feature '{feature_name}' not found in any engine")


def compute_feature_with_perf(
    df: pl.DataFrame,
    feature_name: str,
    symbol: str,
    source: str,
    states: list | None = None,
) -> tuple[pl.Series, float]:
    """Compute a feature and return an estimated per-feature compute time (ms)."""
    if source in {"experiment", "auto"}:
        experiments = _load_experiment_registry()
        if feature_name in experiments:
            t0 = time.perf_counter()
            series = _call_experiment_feature(experiments[feature_name], df, symbol)
            compute_ms = (time.perf_counter() - t0) * 1000.0
            return series, compute_ms
        if source == "experiment":
            raise ValueError(f"Experiment feature '{feature_name}' not found in registry")

    constants = _get_trading_constants()
    index = _get_feature_engine_index(constants)

    # Direct lookup - O(1) instead of O(n_engines)
    if feature_name in index:
        engine = index[feature_name]
        if states is None:
            states = _build_market_states(df, symbol)
        t0 = time.perf_counter()
        output = engine.compute_vectorized(df, states, features=[feature_name])
        compute_ms = (time.perf_counter() - t0) * 1000.0
        if feature_name in output:
            return output[feature_name], compute_ms

    raise ValueError(f"Feature '{feature_name}' not found in any engine")


def _cache_key(source: str, feature_name: str) -> str:
    return f"{source}:{feature_name}"


def _get_feature_cached(
    cache: dict[str, dict[str, pl.Series]],
    feature_name: str,
    df: pl.DataFrame,
    symbol: str,
    source: str,
    states: list | None = None,
) -> pl.Series:
    key = _cache_key(source, feature_name)
    if key in cache.get(symbol, {}):
        return cache[symbol][key]
    series = compute_feature(df, feature_name, symbol, source, states=states)
    cache.setdefault(symbol, {})[key] = series
    return series


def _to_numpy(arr: pl.Series | np.ndarray) -> np.ndarray:
    """Safely convert Polars Series or numpy array to numpy."""
    return arr.to_numpy() if isinstance(arr, pl.Series) else np.asarray(arr)


def _rolling_pearson_fast(x: np.ndarray, y: np.ndarray, window: int) -> np.ndarray:
    """O(n) rolling Pearson correlation using cumsum trick.

    For continuous financial data, Pearson ≈ Spearman (correlation ~0.98).
    This is 300-400x faster than computing rolling Spearman via loop.
    """
    n = len(x)
    if n < window:
        return np.array([np.nan])

    # Cumulative sums for O(n) rolling computation
    cx = np.cumsum(np.concatenate([[0], x]))
    cy = np.cumsum(np.concatenate([[0], y]))
    cx2 = np.cumsum(np.concatenate([[0], x * x]))
    cy2 = np.cumsum(np.concatenate([[0], y * y]))
    cxy = np.cumsum(np.concatenate([[0], x * y]))

    # Rolling sums via difference
    sum_x = cx[window:] - cx[:-window]
    sum_y = cy[window:] - cy[:-window]
    sum_x2 = cx2[window:] - cx2[:-window]
    sum_y2 = cy2[window:] - cy2[:-window]
    sum_xy = cxy[window:] - cxy[:-window]

    # Pearson correlation formula
    w = window
    num = w * sum_xy - sum_x * sum_y
    denom = np.sqrt((w * sum_x2 - sum_x**2) * (w * sum_y2 - sum_y**2))

    result = np.full_like(num, np.nan, dtype=np.float64)
    valid = denom > 1e-10
    np.divide(num, denom, out=result, where=valid)
    return result


def _positions(feature: pl.Series, mode: str, quantile: float) -> np.ndarray:
    values = feature.to_numpy()
    if mode == "sign":
        return np.sign(values)
    low = np.nanquantile(values, quantile)
    high = np.nanquantile(values, 1.0 - quantile)
    return np.where(values >= high, 1.0, np.where(values <= low, -1.0, 0.0))


def _block_shuffle(values: np.ndarray, block: int, rng: np.random.Generator) -> np.ndarray:
    if block <= 1 or len(values) <= block:
        shuffled = values.copy()
        rng.shuffle(shuffled)
        return shuffled
    blocks = [values[i : i + block] for i in range(0, len(values), block)]
    rng.shuffle(blocks)
    return np.concatenate(blocks)


def _autocorr(arr: np.ndarray, lag: int) -> float:
    """Compute autocorrelation at given lag."""
    if len(arr) <= lag:
        return np.nan
    x, y = arr[:-lag], arr[lag:]
    if np.std(x) < 1e-10 or np.std(y) < 1e-10:
        return np.nan
    return float(np.corrcoef(x, y)[0, 1])


def _decorrelation_lag(series: pl.Series, max_lag: int, threshold: float = 0.1) -> int:
    clean = series.drop_nulls().to_numpy()
    if len(clean) < 50:
        return max(5, min(max_lag, len(clean) // 4)) if len(clean) > 0 else 5
    for lag in range(1, max_lag + 1):
        if abs(_autocorr(clean, lag)) < threshold:
            return lag
    return max_lag


def _null_ic_distribution(
    feature: pl.Series,
    returns: pl.Series,
    rng: np.random.Generator,
    block: int,
    samples: int,
) -> tuple[list[float], float]:
    """Compute null IC distribution using vectorized Pearson.

    Returns (null_ics, actual_pearson_ic) for consistent comparison.
    Vectorized Pearson is ~50x faster than looped Spearman.
    """
    feat_arr = _to_numpy(feature)
    ret_arr = returns.to_numpy()

    # Filter valid indices once
    mask = np.isfinite(feat_arr) & np.isfinite(ret_arr)
    if mask.sum() < 3:
        return [], np.nan
    feat_clean = feat_arr[mask]
    ret_clean = ret_arr[mask]

    # Pre-center feature (constant across permutations)
    feat_c = feat_clean - feat_clean.mean()
    feat_ss = np.dot(feat_c, feat_c)
    if feat_ss < 1e-10:
        return [], np.nan

    # Compute actual Pearson IC (for consistent comparison with null)
    ret_c_actual = ret_clean - ret_clean.mean()
    ret_ss_actual = np.dot(ret_c_actual, ret_c_actual)
    if ret_ss_actual < 1e-10:
        actual_ic = np.nan
    else:
        actual_ic = float(np.dot(feat_c, ret_c_actual) / np.sqrt(feat_ss * ret_ss_actual))

    # Generate all shuffled arrays at once (matrix: samples x n)
    if block <= 1:
        # Simple shuffle: generate permutation indices
        shuffled_matrix = np.array([rng.permutation(ret_clean) for _ in range(samples)])
    else:
        shuffled_matrix = np.array([_block_shuffle(ret_clean, block, rng) for _ in range(samples)])

    # Vectorized Pearson: center each row, compute correlations
    ret_means = shuffled_matrix.mean(axis=1, keepdims=True)
    ret_c = shuffled_matrix - ret_means
    ret_ss = np.sum(ret_c * ret_c, axis=1)

    # Dot product of each shuffled row with feature
    numerators = ret_c @ feat_c
    denominators = np.sqrt(ret_ss * feat_ss)

    valid = denominators > 1e-10
    ics = np.where(valid, numerators / denominators, np.nan)
    return [float(ic) for ic in ics if np.isfinite(ic)], actual_ic


def _default_horizon_checks(base: int) -> list[int]:
    if base <= 0:
        return []
    multipliers = [0.5, 1.0, 1.5, 2.0]
    horizons: list[int] = []
    for mult in multipliers:
        h = int(round(base * mult))
        if h < 1:
            continue
        if h not in horizons:
            horizons.append(h)
    return horizons


def _neutralize(feature: pl.Series, factors: pl.DataFrame) -> pl.Series:
    # Build mask: rows where feature and all factors are not null
    feat_arr = feature.to_numpy()
    fact_arr = factors.to_numpy()
    mask = ~np.isnan(feat_arr) & ~np.any(np.isnan(fact_arr), axis=1)
    if mask.sum() < 20:
        return feature
    y = feat_arr[mask]
    x = fact_arr[mask]
    x = np.column_stack([np.ones(len(x)), x])
    beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ beta
    # Build output array with NaN where mask is False
    out = np.full(len(feature), np.nan)
    out[mask] = resid
    return pl.Series(out)


def _robust_outlier_ratio(series: pl.Series) -> float:
    values = series.to_numpy()
    median = np.median(values)
    mad = np.median(np.abs(values - median))
    if mad <= 0:
        return np.nan
    robust_z = 0.6745 * (values - median) / mad
    return float(np.mean(np.abs(robust_z) > 3.5))


def _walk_forward_splits(cfg: DiagConfig, n: int) -> list[tuple[int, int, int, int]]:
    if n < 50:
        return []

    train_window = cfg.wf_train or int(n * 0.6)
    test_window = cfg.wf_test or max(cfg.horizon * 5, int(n * 0.1))
    embargo = cfg.wf_embargo if cfg.wf_embargo is not None else cfg.horizon
    step = cfg.wf_step or test_window

    splits: list[tuple[int, int, int, int]] = []
    start = 0
    while start + train_window + embargo + test_window <= n:
        train_start = start
        train_end = train_start + train_window
        test_start = train_end + embargo
        test_end = test_start + test_window
        splits.append((train_start, train_end, test_start, test_end))
        start += step
    return splits


def _walk_forward_ic(
    f: pl.Series, r: pl.Series, cfg: DiagConfig
) -> tuple[float, float, float, int]:
    n = len(f)
    train_ics: list[float] = []
    test_ics: list[float] = []
    splits = _walk_forward_splits(cfg, n)
    if not splits:
        return np.nan, np.nan, np.nan, 0

    for train_start, train_end, test_start, test_end in splits:
        train_ic = _ic(f[train_start:train_end], r[train_start:train_end])
        test_ic = _ic(f[test_start:test_end], r[test_start:test_end])

        if np.isfinite(train_ic):
            train_ics.append(train_ic)
        if np.isfinite(test_ic):
            test_ics.append(test_ic)

    if not test_ics:
        return np.nan, np.nan, np.nan, 0

    ic_train = float(np.mean(train_ics)) if train_ics else np.nan
    ic_test = float(np.mean(test_ics))
    ic_decay = (
        (ic_train - ic_test) / abs(ic_train) if np.isfinite(ic_train) and ic_train != 0 else np.nan
    )
    return ic_train, ic_test, ic_decay, len(test_ics)


def _horizon_oos_ic(feature: pl.Series, fwd_ret: pl.Series, cfg: DiagConfig) -> float:
    f = feature
    r = fwd_ret
    mask = _mask_valid_rows(f, r)
    if mask.sum() < cfg.min_samples:
        return np.nan
    # Convert to numpy for masking (Polars doesn't support boolean indexing)
    f_arr, r_arr = f.to_numpy()[mask], r.to_numpy()[mask]
    _, ic_test, _, _ = _walk_forward_ic(pl.Series(f_arr), pl.Series(r_arr), cfg)
    return ic_test


def _mask_valid_rows(*arrays: pl.Series | np.ndarray) -> np.ndarray:
    if not arrays:
        return np.array([], dtype=bool)
    length = len(arrays[0])
    mask = np.ones(length, dtype=bool)
    for arr in arrays:
        values = np.asarray(arr)
        if values.ndim == 1:
            mask &= np.isfinite(values)
        else:
            mask &= np.isfinite(values).all(axis=1)
    return mask


def _fit_ridge(x: np.ndarray, y: np.ndarray, alpha: float = 1e-6) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    if x.ndim == 1:
        x = x.reshape(-1, 1)
    x = np.column_stack([np.ones(len(x)), x])
    xtx = x.T @ x
    if alpha > 0:
        xtx[1:, 1:] += alpha * np.eye(x.shape[1] - 1)
    try:
        beta = np.linalg.solve(xtx, x.T @ y)
    except np.linalg.LinAlgError:
        beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    return beta


def _predict_linear(x: np.ndarray, beta: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        x = x.reshape(-1, 1)
    x = np.column_stack([np.ones(len(x)), x])
    return x @ beta


def _net_edge_from_signal(signal: np.ndarray, returns: np.ndarray, cfg: DiagConfig) -> float:
    signal_series = pl.Series(signal)
    ret_series = pl.Series(returns)
    positions = _positions(signal_series, cfg.position_mode, cfg.quantile)
    turnover = float(np.mean(np.abs(np.diff(positions)))) if len(positions) > 1 else 0.0
    cost_per_bar = turnover * cfg.cost_bps / 1e4
    gross_edge = float(np.mean(positions * ret_series.to_numpy()))
    return gross_edge - cost_per_bar


def _walk_forward_residual_ic(
    f: pl.Series | np.ndarray,
    parents: list[pl.Series | np.ndarray],
    r: pl.Series | np.ndarray,
    cfg: DiagConfig,
) -> tuple[float, float, float, int]:
    # Convert to numpy upfront for consistent indexing
    f_arr = _to_numpy(f)
    r_arr = _to_numpy(r)
    parents_arr = [_to_numpy(p) for p in parents]

    splits = _walk_forward_splits(cfg, len(f_arr))
    if not splits:
        return np.nan, np.nan, np.nan, 0

    train_ics: list[float] = []
    test_ics: list[float] = []
    min_test = max(30, cfg.min_samples // 2)

    for train_start, train_end, test_start, test_end in splits:
        f_train = f_arr[train_start:train_end]
        r_train = r_arr[train_start:train_end]
        p_train = np.column_stack([p[train_start:train_end] for p in parents_arr])

        mask_train = _mask_valid_rows(f_train, r_train, p_train)
        if mask_train.sum() < cfg.min_samples:
            continue

        beta = _fit_ridge(p_train[mask_train], f_train[mask_train])
        resid_train = f_train[mask_train] - _predict_linear(p_train[mask_train], beta)
        train_ic = _ic(resid_train, r_train[mask_train])

        f_test = f_arr[test_start:test_end]
        r_test = r_arr[test_start:test_end]
        p_test = np.column_stack([p[test_start:test_end] for p in parents_arr])
        mask_test = _mask_valid_rows(f_test, r_test, p_test)
        if mask_test.sum() < min_test:
            continue

        resid_test = f_test[mask_test] - _predict_linear(p_test[mask_test], beta)
        test_ic = _ic(resid_test, r_test[mask_test])

        if np.isfinite(train_ic):
            train_ics.append(train_ic)
        if np.isfinite(test_ic):
            test_ics.append(test_ic)

    if not test_ics:
        return np.nan, np.nan, np.nan, 0

    ic_train = float(np.mean(train_ics)) if train_ics else np.nan
    ic_test = float(np.mean(test_ics))
    ic_decay = (
        (ic_train - ic_test) / abs(ic_train) if np.isfinite(ic_train) and ic_train != 0 else np.nan
    )
    return ic_train, ic_test, ic_decay, len(test_ics)


def _walk_forward_return_residual_ic(
    f: pl.Series | np.ndarray,
    parents: list[pl.Series | np.ndarray],
    r: pl.Series | np.ndarray,
    cfg: DiagConfig,
) -> tuple[float, float, float, int]:
    # Convert to numpy upfront for consistent indexing
    f_arr = _to_numpy(f)
    r_arr = _to_numpy(r)
    parents_arr = [_to_numpy(p) for p in parents]

    splits = _walk_forward_splits(cfg, len(f_arr))
    if not splits:
        return np.nan, np.nan, np.nan, 0

    train_ics: list[float] = []
    test_ics: list[float] = []
    min_test = max(30, cfg.min_samples // 2)

    for train_start, train_end, test_start, test_end in splits:
        f_train = f_arr[train_start:train_end]
        f_test = f_arr[test_start:test_end]
        r_train = r_arr[train_start:train_end]
        r_test = r_arr[test_start:test_end]
        p_train = np.column_stack([p[train_start:train_end] for p in parents_arr])
        p_test = np.column_stack([p[test_start:test_end] for p in parents_arr])

        mask_train = _mask_valid_rows(f_train, r_train, p_train)
        mask_test = _mask_valid_rows(f_test, r_test, p_test)
        if mask_train.sum() < cfg.min_samples or mask_test.sum() < min_test:
            continue

        beta_parent = _fit_ridge(p_train[mask_train], r_train[mask_train])
        resid_train = r_train[mask_train] - _predict_linear(p_train[mask_train], beta_parent)
        resid_test = r_test[mask_test] - _predict_linear(p_test[mask_test], beta_parent)

        train_ic = _ic(resid_train, f_train[mask_train])
        test_ic = _ic(resid_test, f_test[mask_test])

        if np.isfinite(train_ic):
            train_ics.append(train_ic)
        if np.isfinite(test_ic):
            test_ics.append(test_ic)

    if not test_ics:
        return np.nan, np.nan, np.nan, 0

    ic_train = float(np.mean(train_ics)) if train_ics else np.nan
    ic_test = float(np.mean(test_ics))
    ic_decay = (
        (ic_train - ic_test) / abs(ic_train) if np.isfinite(ic_train) and ic_train != 0 else np.nan
    )
    return ic_train, ic_test, ic_decay, len(test_ics)


def _walk_forward_uplift_ic(
    f: pl.Series | np.ndarray,
    parents: list[pl.Series | np.ndarray],
    r: pl.Series | np.ndarray,
    cfg: DiagConfig,
) -> tuple[float, float, float, float, int]:
    # Convert to numpy upfront for consistent indexing
    f_arr = _to_numpy(f)
    r_arr = _to_numpy(r)
    parents_arr = [_to_numpy(p) for p in parents]

    splits = _walk_forward_splits(cfg, len(f_arr))
    if not splits:
        return np.nan, np.nan, np.nan, np.nan, 0

    parent_ics: list[float] = []
    full_ics: list[float] = []
    uplifts: list[float] = []
    wins = 0
    min_test = max(30, cfg.min_samples // 2)

    for train_start, train_end, test_start, test_end in splits:
        f_train = f_arr[train_start:train_end]
        r_train = r_arr[train_start:train_end]
        p_train = np.column_stack([p[train_start:train_end] for p in parents_arr])
        mask_train = _mask_valid_rows(f_train, r_train, p_train)
        if mask_train.sum() < cfg.min_samples:
            continue

        f_test = f_arr[test_start:test_end]
        r_test = r_arr[test_start:test_end]
        p_test = np.column_stack([p[test_start:test_end] for p in parents_arr])
        mask_test = _mask_valid_rows(f_test, r_test, p_test)
        if mask_test.sum() < min_test:
            continue

        beta_parent = _fit_ridge(p_train[mask_train], r_train[mask_train])
        pred_parent = _predict_linear(p_test[mask_test], beta_parent)

        full_train = np.column_stack([p_train[mask_train], f_train[mask_train]])
        full_test = np.column_stack([p_test[mask_test], f_test[mask_test]])
        beta_full = _fit_ridge(full_train, r_train[mask_train])
        pred_full = _predict_linear(full_test, beta_full)

        ic_parent = _ic(pred_parent, r_test[mask_test])
        ic_full = _ic(pred_full, r_test[mask_test])

        if np.isfinite(ic_parent) and np.isfinite(ic_full):
            parent_ics.append(ic_parent)
            full_ics.append(ic_full)
            uplifts.append(ic_full - ic_parent)
            if ic_full > ic_parent:
                wins += 1

    if not full_ics:
        return np.nan, np.nan, np.nan, np.nan, 0

    mean_parent = float(np.mean(parent_ics)) if parent_ics else np.nan
    mean_full = float(np.mean(full_ics))
    mean_uplift = float(np.mean(uplifts)) if uplifts else np.nan
    win_rate = float(wins / len(full_ics)) if full_ics else np.nan
    return mean_parent, mean_full, mean_uplift, win_rate, len(full_ics)


def _walk_forward_edge_uplift(
    f: pl.Series | np.ndarray,
    parents: list[pl.Series | np.ndarray],
    r: pl.Series | np.ndarray,
    cfg: DiagConfig,
) -> tuple[float, float, float, float, int]:
    # Convert to numpy upfront for consistent indexing
    f_arr = _to_numpy(f)
    r_arr = _to_numpy(r)
    parents_arr = [_to_numpy(p) for p in parents]

    splits = _walk_forward_splits(cfg, len(f_arr))
    if not splits:
        return np.nan, np.nan, np.nan, np.nan, 0

    parent_edges: list[float] = []
    full_edges: list[float] = []
    uplifts: list[float] = []
    wins = 0
    min_test = max(30, cfg.min_samples // 2)

    for train_start, train_end, test_start, test_end in splits:
        f_train = f_arr[train_start:train_end]
        r_train = r_arr[train_start:train_end]
        p_train = np.column_stack([p[train_start:train_end] for p in parents_arr])
        mask_train = _mask_valid_rows(f_train, r_train, p_train)
        if mask_train.sum() < cfg.min_samples:
            continue

        f_test = f_arr[test_start:test_end]
        r_test = r_arr[test_start:test_end]
        p_test = np.column_stack([p[test_start:test_end] for p in parents_arr])
        mask_test = _mask_valid_rows(f_test, r_test, p_test)
        if mask_test.sum() < min_test:
            continue

        beta_parent = _fit_ridge(p_train[mask_train], r_train[mask_train])
        pred_parent = _predict_linear(p_test[mask_test], beta_parent)

        full_train = np.column_stack([p_train[mask_train], f_train[mask_train]])
        full_test = np.column_stack([p_test[mask_test], f_test[mask_test]])
        beta_full = _fit_ridge(full_train, r_train[mask_train])
        pred_full = _predict_linear(full_test, beta_full)

        edge_parent = _net_edge_from_signal(pred_parent, r_test[mask_test], cfg)
        edge_full = _net_edge_from_signal(pred_full, r_test[mask_test], cfg)

        parent_edges.append(edge_parent)
        full_edges.append(edge_full)
        uplifts.append(edge_full - edge_parent)
        if edge_full > edge_parent:
            wins += 1

    if not full_edges:
        return np.nan, np.nan, np.nan, np.nan, 0

    mean_parent = float(np.mean(parent_edges))
    mean_full = float(np.mean(full_edges))
    mean_uplift = float(np.mean(uplifts)) if uplifts else np.nan
    win_rate = float(wins / len(full_edges)) if full_edges else np.nan
    return mean_parent, mean_full, mean_uplift, win_rate, len(full_edges)


def _quadrant_threshold(series: pl.Series | np.ndarray) -> float:
    arr = _to_numpy(series)
    clean = arr[np.isfinite(arr)]
    if len(clean) == 0:
        return np.nan
    if clean.min() >= 0.0 and clean.max() <= 1.0:
        return 0.5
    return float(np.median(clean))


def _quadrant_consistency(
    f: pl.Series, parent_a: pl.Series, parent_b: pl.Series, r: pl.Series, cfg: DiagConfig
) -> tuple[float, int, int]:
    mask = _mask_valid_rows(f, parent_a, parent_b, r)
    if mask.sum() < cfg.min_samples:
        return np.nan, 0, 0

    # Convert to numpy for masking
    f = f.to_numpy()[mask]
    parent_a = parent_a.to_numpy()[mask]
    parent_b = parent_b.to_numpy()[mask]
    r = r.to_numpy()[mask]

    overall_ic = _ic(f, r)
    if not np.isfinite(overall_ic) or abs(overall_ic) < 1e-6:
        return np.nan, 0, 0

    thr_a = _quadrant_threshold(parent_a)
    thr_b = _quadrant_threshold(parent_b)
    if not np.isfinite(thr_a) or not np.isfinite(thr_b):
        return np.nan, 0, 0

    overall_sign = 1 if overall_ic > 0 else -1
    groups = 0
    matches = 0
    flips = 0

    for hi_a in (0, 1):
        for hi_b in (0, 1):
            mask_group = (parent_a >= thr_a) if hi_a else (parent_a < thr_a)
            mask_group &= (parent_b >= thr_b) if hi_b else (parent_b < thr_b)
            if mask_group.sum() < cfg.interaction_min_group:
                continue
            ic_group = _ic(f[mask_group], r[mask_group])
            if not np.isfinite(ic_group):
                continue
            groups += 1
            if np.sign(ic_group) == overall_sign:
                matches += 1
            else:
                flips += 1

    if groups < 2:
        return np.nan, groups, flips

    return matches / groups, groups, flips


def _interaction_metrics_pf(
    feature_name: str,
    parents: list[str],
    df: pl.DataFrame,
    symbol: str,
    feature_source: str,
    parent_source: str,
    fwd_ret: pl.Series,
    cfg: DiagConfig,
) -> dict:
    if not cfg.per_fold_recompute:
        return {}

    splits = _walk_forward_splits(cfg, len(df))
    if not splits:
        return {}

    resid_train_ics: list[float] = []
    resid_test_ics: list[float] = []
    return_resid_ics: list[float] = []
    uplift_parent_ics: list[float] = []
    uplift_full_ics: list[float] = []
    uplift_deltas: list[float] = []
    uplift_wins = 0
    edge_parent_vals: list[float] = []
    edge_full_vals: list[float] = []
    edge_uplifts: list[float] = []
    edge_wins = 0
    min_test = max(30, cfg.min_samples // 2)

    for train_start, train_end, test_start, test_end in splits:
        df_train = df[train_start:train_end]
        df_test = df[train_start:test_end]

        try:
            feature_train_raw = compute_feature(df_train, feature_name, symbol, feature_source)
            feature_test_raw = compute_feature(df_test, feature_name, symbol, feature_source)
            feature_train = feature_train_raw
            feature_test_full = feature_test_raw
            feature_test = feature_test_full[test_start - train_start : test_end - train_start]

            parents_train = [compute_feature(df_train, p, symbol, parent_source) for p in parents]
            parents_test_full = [
                compute_feature(df_test, p, symbol, parent_source) for p in parents
            ]
            parents_test = [
                p[test_start - train_start : test_end - train_start] for p in parents_test_full
            ]
        except Exception:
            continue

        r_train = fwd_ret[train_start:train_end]
        r_test = fwd_ret[test_start:test_end]

        p_train = np.column_stack(parents_train)
        p_test = np.column_stack(parents_test)
        mask_train = _mask_valid_rows(feature_train, r_train, p_train)
        mask_test = _mask_valid_rows(feature_test, r_test, p_test)

        if mask_train.sum() < cfg.min_samples or mask_test.sum() < min_test:
            continue

        beta = _fit_ridge(p_train[mask_train], np.asarray(feature_train)[mask_train])
        resid_train = np.asarray(feature_train)[mask_train] - _predict_linear(
            p_train[mask_train], beta
        )
        resid_test = np.asarray(feature_test)[mask_test] - _predict_linear(p_test[mask_test], beta)

        resid_train_ic = _ic(pl.Series(resid_train), pl.Series(np.asarray(r_train)[mask_train]))
        resid_test_ic = _ic(pl.Series(resid_test), pl.Series(np.asarray(r_test)[mask_test]))
        if np.isfinite(resid_train_ic):
            resid_train_ics.append(resid_train_ic)
        if np.isfinite(resid_test_ic):
            resid_test_ics.append(resid_test_ic)

        beta_parent = _fit_ridge(p_train[mask_train], np.asarray(r_train)[mask_train])
        pred_parent = _predict_linear(p_test[mask_test], beta_parent)
        ret_resid = np.asarray(r_test)[mask_test] - pred_parent
        ret_resid_ic = _ic(pl.Series(np.asarray(feature_test)[mask_test]), pl.Series(ret_resid))
        if np.isfinite(ret_resid_ic):
            return_resid_ics.append(ret_resid_ic)
        full_train = np.column_stack([p_train[mask_train], np.asarray(feature_train)[mask_train]])
        full_test = np.column_stack([p_test[mask_test], np.asarray(feature_test)[mask_test]])
        beta_full = _fit_ridge(full_train, np.asarray(r_train)[mask_train])
        pred_full = _predict_linear(full_test, beta_full)

        ic_parent = _ic(pl.Series(pred_parent), pl.Series(np.asarray(r_test)[mask_test]))
        ic_full = _ic(pl.Series(pred_full), pl.Series(np.asarray(r_test)[mask_test]))
        if np.isfinite(ic_parent) and np.isfinite(ic_full):
            uplift_parent_ics.append(ic_parent)
            uplift_full_ics.append(ic_full)
            uplift_deltas.append(ic_full - ic_parent)
            if ic_full > ic_parent:
                uplift_wins += 1

        edge_parent = _net_edge_from_signal(pred_parent, np.asarray(r_test)[mask_test], cfg)
        edge_full = _net_edge_from_signal(pred_full, np.asarray(r_test)[mask_test], cfg)
        edge_parent_vals.append(edge_parent)
        edge_full_vals.append(edge_full)
        edge_uplifts.append(edge_full - edge_parent)
        if edge_full > edge_parent:
            edge_wins += 1

    if not resid_test_ics and not uplift_full_ics:
        return {}

    return {
        "resid_ic_train_pf": float(np.mean(resid_train_ics)) if resid_train_ics else np.nan,
        "resid_ic_test_pf": float(np.mean(resid_test_ics)) if resid_test_ics else np.nan,
        "resid_ic_decay_pf": (
            (float(np.mean(resid_train_ics)) - float(np.mean(resid_test_ics)))
            / abs(float(np.mean(resid_train_ics)))
            if resid_train_ics
            and resid_test_ics
            and np.isfinite(np.mean(resid_train_ics))
            and np.mean(resid_train_ics) != 0
            else np.nan
        ),
        "resid_folds_pf": len(resid_test_ics),
        "uplift_parent_ic_pf": float(np.mean(uplift_parent_ics)) if uplift_parent_ics else np.nan,
        "uplift_full_ic_pf": float(np.mean(uplift_full_ics)) if uplift_full_ics else np.nan,
        "uplift_delta_pf": float(np.mean(uplift_deltas)) if uplift_deltas else np.nan,
        "uplift_win_rate_pf": float(uplift_wins / len(uplift_full_ics))
        if uplift_full_ics
        else np.nan,
        "uplift_folds_pf": len(uplift_full_ics),
        "return_resid_ic_pf": float(np.mean(return_resid_ics)) if return_resid_ics else np.nan,
        "edge_parent_pf": float(np.mean(edge_parent_vals)) if edge_parent_vals else np.nan,
        "edge_full_pf": float(np.mean(edge_full_vals)) if edge_full_vals else np.nan,
        "edge_uplift_pf": float(np.mean(edge_uplifts)) if edge_uplifts else np.nan,
        "edge_uplift_win_pf": float(edge_wins / len(edge_full_vals)) if edge_full_vals else np.nan,
    }


def _residualize_feature(
    feature: pl.Series, parents: list[pl.Series], cfg: DiagConfig
) -> pl.Series:
    mask = _mask_valid_rows(feature, *parents)
    if mask.sum() < cfg.min_samples:
        return feature
    x = np.column_stack([p.to_numpy() for p in parents])
    feat_arr = feature.to_numpy()
    beta = _fit_ridge(x[mask], feat_arr[mask])
    out = np.full(len(feature), np.nan)
    out[mask] = feat_arr[mask] - _predict_linear(x[mask], beta)
    return pl.Series(out)


def _batch_correlations(
    target: np.ndarray,
    candidates: list[tuple[str, np.ndarray]],
    min_samples: int,
) -> list[tuple[str, float]]:
    """Compute correlations between target and all candidates in batch.

    Uses vectorized operations where possible.
    Returns list of (name, abs_correlation) sorted by correlation descending.
    """
    results = []
    for name, arr in candidates:
        mask = np.isfinite(target) & np.isfinite(arr)
        n = mask.sum()
        if n < min_samples:
            continue
        corr = abs(_ic(target[mask], arr[mask]))
        if np.isfinite(corr):
            results.append((name, corr))
    results.sort(key=lambda x: x[1], reverse=True)
    return results


# Cache for correlation results: (feature_a_id, feature_b_id) -> correlation
_correlation_cache: dict[tuple[int, int], float] = {}


def _cached_ic(arr_a: np.ndarray, arr_b: np.ndarray) -> float:
    """Cached version of _ic using array id for cache key."""
    key = (id(arr_a), id(arr_b))
    if key in _correlation_cache:
        return _correlation_cache[key]
    result = _ic(arr_a, arr_b)
    _correlation_cache[key] = result
    return result


def _auto_select_parents(
    feature_name: str,
    feature: pl.Series,
    pool: dict[str, pl.Series],
    cfg: DiagConfig,
) -> list[str]:
    if cfg.interaction_auto < 2:
        return []

    feat_arr = feature.to_numpy()

    # Pre-compute candidate arrays once (avoid repeated .to_numpy())
    candidates: list[tuple[str, np.ndarray]] = []
    for name, series in pool.items():
        if name == feature_name:
            continue
        arr = series.to_numpy()
        if float(np.nanstd(arr)) < 1e-12:
            continue
        mask = np.isfinite(feat_arr) & np.isfinite(arr)
        if mask.sum() < cfg.min_samples:
            continue
        candidates.append((name, arr))

    if not candidates:
        return []

    # If pool is too large, score and keep top N
    if cfg.interaction_auto_max_pool > 0 and len(candidates) > cfg.interaction_auto_max_pool:
        scored = _batch_correlations(feat_arr, candidates, cfg.min_samples)
        keep_names = {name for name, _ in scored[: cfg.interaction_auto_max_pool]}
        candidates = [(name, arr) for name, arr in candidates if name in keep_names]

    selected: list[str] = []
    residual = feat_arr.copy()
    remaining = candidates

    while len(selected) < cfg.interaction_auto and remaining:
        # Find best correlated candidate with current residual
        best_name = None
        best_corr = 0.0
        best_idx = -1

        for i, (name, arr) in enumerate(remaining):
            mask = np.isfinite(residual) & np.isfinite(arr)
            if mask.sum() < cfg.min_samples:
                continue
            corr = abs(_ic(residual[mask], arr[mask]))
            if np.isfinite(corr) and corr > best_corr:
                best_corr = corr
                best_name = name
                best_idx = i

        if best_name is None or best_corr < cfg.interaction_auto_min_corr:
            break

        selected.append(best_name)
        remaining = [c for j, c in enumerate(remaining) if j != best_idx]
        parent_series = [pool[name] for name in selected]
        residual = _residualize_feature(feature, parent_series, cfg).to_numpy()

    return selected


def _interaction_candidate_pool(
    df: pl.DataFrame,
    symbol: str,
    source: str,
    cfg: DiagConfig,
    cache: dict[str, dict[str, pl.Series]],
    pool_cache: dict[str, dict[str, pl.Series]],
    pool_names: list[str] | None,
    states: list | None = None,
) -> dict[str, pl.Series]:
    # Always use engine features for interaction parents (stable baselines)
    # Experiment features should compare against production features, not other experiments
    pool_source = "engine"

    if pool_names:
        pool: dict[str, pl.Series] = {}
        for name in pool_names:
            try:
                pool[name] = _get_feature_cached(
                    cache, name, df, symbol, pool_source, states=states
                )
            except Exception:
                continue
        pool_cache[symbol] = pool
        return pool

    if symbol not in pool_cache:
        pool = _compute_feature_pool(
            df,
            symbol,
            pool_source,
            cfg.interaction_include_disabled,
            states=states,
        )
        cache_for_symbol = cache.setdefault(symbol, {})
        for name, series in pool.items():
            cache_for_symbol[_cache_key(pool_source, name)] = series
        pool_cache[symbol] = pool

    return pool_cache[symbol]


def analyze_interaction(
    feature_name: str,
    feature: pl.Series,
    parent_names: list[str],
    df: pl.DataFrame,
    symbol: str,
    source: str,
    fwd_ret: pl.Series,
    cfg: DiagConfig,
    cache: dict[str, dict[str, pl.Series]],
    states: list | None = None,
) -> dict:
    info: dict[str, float | int | str] = {
        "interaction_parents": ", ".join(parent_names),
        "interaction_parent_count": len(parent_names),
    }

    parent_source = "engine"
    parents: list[pl.Series] = []
    for parent in parent_names:
        try:
            parent_series = _get_feature_cached(
                cache, parent, df, symbol, parent_source, states=states
            )
        except Exception:
            info["interaction_error"] = f"missing_parent:{parent}"
            return info
        parents.append(parent_series)

    feature = feature
    r = fwd_ret

    mask = _mask_valid_rows(feature, r, *parents)
    if mask.sum() < cfg.min_samples:
        info["interaction_error"] = "insufficient_overlap"
        return info

    # Convert to numpy for masking (Polars doesn't support boolean indexing)
    f = feature.to_numpy()[mask]
    r_arr = r.to_numpy()[mask]
    parents_arr = [p.to_numpy()[mask] for p in parents]

    parent_corrs = []
    parent_ics = []
    parent_oos = []
    for parent in parents_arr:
        parent_corrs.append(_ic(f, parent))
        parent_ics.append(_ic(parent, r_arr))
        parent_oos.append(_walk_forward_ic(pl.Series(parent), pl.Series(r_arr), cfg)[1])

    corr_abs = [abs(c) for c in parent_corrs if np.isfinite(c)]
    ic_abs = [abs(c) for c in parent_ics if np.isfinite(c)]
    oos_abs = [abs(c) for c in parent_oos if np.isfinite(c)]

    info["parent_corr_max"] = max(corr_abs) if corr_abs else np.nan
    info["parent_ic_max"] = max(ic_abs) if ic_abs else np.nan
    info["parent_oos_max"] = max(oos_abs) if oos_abs else np.nan

    # Walk-forward functions expect full-length arrays (they do their own train/test splits)
    # Pass the original unmasked Polars Series
    resid_train, resid_test, resid_decay, resid_folds = _walk_forward_residual_ic(
        feature, parents, fwd_ret, cfg
    )
    info["resid_ic_train"] = resid_train
    info["resid_ic_test"] = resid_test
    info["resid_ic_decay"] = resid_decay
    info["resid_folds"] = resid_folds

    ret_resid_train, ret_resid_test, ret_resid_decay, ret_resid_folds = (
        _walk_forward_return_residual_ic(feature, parents, fwd_ret, cfg)
    )
    info["return_resid_ic_train"] = ret_resid_train
    info["return_resid_ic_test"] = ret_resid_test
    info["return_resid_ic_decay"] = ret_resid_decay
    info["return_resid_folds"] = ret_resid_folds

    uplift_parent, uplift_full, uplift_delta, uplift_win, uplift_folds = _walk_forward_uplift_ic(
        feature, parents, fwd_ret, cfg
    )
    info["uplift_parent_ic"] = uplift_parent
    info["uplift_full_ic"] = uplift_full
    info["uplift_delta"] = uplift_delta
    info["uplift_win_rate"] = uplift_win
    info["uplift_folds"] = uplift_folds

    edge_parent, edge_full, edge_uplift, edge_win, edge_folds = _walk_forward_edge_uplift(
        feature, parents, fwd_ret, cfg
    )
    info["edge_parent"] = edge_parent
    info["edge_full"] = edge_full
    info["edge_uplift"] = edge_uplift
    info["edge_uplift_win"] = edge_win
    info["edge_folds"] = edge_folds

    if len(parents) == 2:
        quad_consistency, quad_groups, quad_flips = _quadrant_consistency(
            feature, parents[0], parents[1], fwd_ret, cfg
        )
        info["quad_consistency"] = quad_consistency
        info["quad_groups"] = quad_groups
        info["quad_flips"] = quad_flips

    info.update(
        _interaction_metrics_pf(
            feature_name,
            parent_names,
            df,
            symbol,
            source,
            parent_source,
            fwd_ret,
            cfg,
        )
    )
    return info


def _streaming_equivalence(
    feature_name: str,
    df: pl.DataFrame,
    symbol: str,
    source: str,
    vector_feature: pl.Series,
    cfg: DiagConfig,
    states: list | None = None,
) -> tuple[float, float, float]:
    if not cfg.stream_check:
        return np.nan, np.nan, np.nan

    n = len(df)
    warmup = min(max(cfg.stream_warmup, cfg.horizon * 2 + 5), n - 2) if n > 2 else 0
    if n <= warmup + 2:
        return np.nan, np.nan, np.nan

    sample_count = min(cfg.stream_samples, n - warmup)
    if sample_count <= 0:
        return np.nan, np.nan, np.nan

    # Use provided states or build once for full df
    full_states = states if states is not None else _build_market_states(df, symbol)

    idxs = np.linspace(warmup, n - 1, num=sample_count, dtype=int)
    diffs: list[float] = []
    for idx in idxs:
        sub_df = df[: idx + 1]
        sub_states = full_states[: idx + 1]
        try:
            stream_series = compute_feature(sub_df, feature_name, symbol, source, states=sub_states)
            stream_val = float(stream_series[-1])
            vec_val = float(vector_feature[idx])
        except Exception:
            continue

        if np.isfinite(stream_val) and np.isfinite(vec_val):
            diffs.append(abs(stream_val - vec_val))

    if not diffs:
        return np.nan, np.nan, np.nan

    arr = np.asarray(diffs, dtype=float)
    mae = float(arr.mean())
    max_diff = float(arr.max())
    bad_ratio = float(np.mean(arr > cfg.stream_thresh))
    return mae, max_diff, bad_ratio


def _walk_forward_ic_recompute(
    feature_name: str,
    df: pl.DataFrame,
    symbol: str,
    source: str,
    fwd_ret: pl.Series,
    cfg: DiagConfig,
) -> tuple[float, float, float, int]:
    if not cfg.per_fold_recompute:
        return np.nan, np.nan, np.nan, 0

    train_ics: list[float] = []
    test_ics: list[float] = []
    splits = _walk_forward_splits(cfg, len(df))
    if not splits:
        return np.nan, np.nan, np.nan, 0

    for train_start, train_end, test_start, test_end in splits:
        df_train = df[train_start:train_end]
        df_test = df[train_start:test_end]

        try:
            feature_train = compute_feature(df_train, feature_name, symbol, source)
            feature_test = compute_feature(df_test, feature_name, symbol, source)[
                test_start - train_start : test_end - train_start
            ]
        except Exception:
            start += step
            continue

        r_train = fwd_ret[train_start:train_end]
        r_test = fwd_ret[test_start:test_end]

        train_ic = _ic(feature_train, r_train)
        test_ic = _ic(feature_test, r_test)

        if np.isfinite(train_ic):
            train_ics.append(train_ic)
        if np.isfinite(test_ic):
            test_ics.append(test_ic)

    if not test_ics:
        return np.nan, np.nan, np.nan, 0

    ic_train = float(np.mean(train_ics)) if train_ics else np.nan
    ic_test = float(np.mean(test_ics))
    ic_decay = (
        (ic_train - ic_test) / abs(ic_train) if np.isfinite(ic_train) and ic_train != 0 else np.nan
    )
    return ic_train, ic_test, ic_decay, len(test_ics)


def analyze_feature(
    feature: pl.Series,
    fwd_ret: pl.Series,
    spot_ret: pl.Series,
    volume: pl.Series,
    cfg: DiagConfig,
    rng: np.random.Generator,
    feature_name: str,
    df: pl.DataFrame,
    symbol: str,
    source: str,
) -> dict:
    """Compute diagnostic metrics for a feature."""
    feature = feature
    fwd_ret = fwd_ret
    spot_ret = spot_ret
    volume = volume

    valid = ~(feature.is_null() | fwd_ret.is_null())
    coverage = float(valid.mean())
    missing_ratio = float(feature.is_null().mean())
    f = feature.filter(valid)
    r = fwd_ret.filter(valid)

    if len(f) < cfg.min_samples:
        return {"error": "Insufficient data", "coverage": coverage, "missing_ratio": missing_ratio}

    if float(f.std()) < 1e-12:
        return {"error": "Constant feature", "coverage": coverage, "missing_ratio": missing_ratio}

    # Basic stats
    ic = _ic(f, r)
    xi_ic = chatterjee_xi(f, r)
    rank_dcor = rank_distance_correlation(f, r)
    dcor_p = dcor_pvalue_metric(f, r)
    nonlinear_uplift = (
        rank_dcor - abs(ic) if np.isfinite(rank_dcor) and np.isfinite(ic) else np.nan
    )
    rdc_value = rdc(f, r, seed=cfg.seed)
    unique_ratio = f.n_unique() / len(f)
    f_np = f.to_numpy()
    zero_ratio = float(np.mean(f_np == 0.0))
    stale_ratio = float(np.mean(np.isclose(np.diff(f_np), 0.0))) if len(f) > 1 else 1.0
    autocorr1 = _autocorr(f_np, 1) if len(f) > 2 else np.nan

    # Distribution
    p05 = float(f.quantile(0.05))
    p95 = float(f.quantile(0.95))
    outlier_ratio = _robust_outlier_ratio(f)
    skew = float(stats.skew(f.to_numpy(), bias=False))
    kurt = float(stats.kurtosis(f.to_numpy(), bias=False))

    # Rolling Spearman / RDC stability
    f_arr, r_arr = f.to_numpy(), r.to_numpy()
    rolling_spear = rolling_spearman(f_arr, r_arr, cfg.rolling_window)
    spearman_ic_mean = float(np.nanmean(rolling_spear))
    spearman_ic_std = float(np.nanstd(rolling_spear))
    spearman_ic_ir = abs(spearman_ic_mean) / (spearman_ic_std + 1e-12)
    rolling_rdc_vals = rolling_rdc(f_arr, r_arr, cfg.rolling_window, seed=cfg.seed)
    rdc_mean = float(np.nanmean(rolling_rdc_vals))
    rdc_std = float(np.nanstd(rolling_rdc_vals))
    rdc_ir = abs(rdc_mean) / (rdc_std + 1e-12)

    # Quintile analysis
    try:
        f_clean = f_arr[~np.isnan(f_arr)]
        r_clean = r_arr[~np.isnan(f_arr)]
        quintiles = (
            np.digitize(f_clean, np.nanquantile(f_clean, [0.2, 0.4, 0.6, 0.8]))
            if len(f_clean) > 5
            else None
        )
        if quintiles is not None:
            q_means = [
                np.nanmean(r_clean[quintiles == q]) if (quintiles == q).sum() > 0 else np.nan
                for q in range(5)
            ]
            monotonicity = _corr(np.arange(5), np.array(q_means)) if len(q_means) == 5 else np.nan
            q_spread = float(q_means[-1] - q_means[0]) if len(q_means) >= 2 else np.nan
        else:
            monotonicity, q_spread = np.nan, np.nan
    except Exception:
        monotonicity = np.nan
        q_spread = np.nan

    # Walk-forward OOS with embargo (purged)
    ic_train, ic_test, ic_decay, wf_folds = _walk_forward_ic(f, r, cfg)

    # Per-fold recompute OOS (strict backward-only)
    ic_train_pf, ic_test_pf, ic_decay_pf, wf_folds_pf = _walk_forward_ic_recompute(
        feature_name, df, symbol, source, fwd_ret, cfg
    )
    if wf_folds < cfg.wf_min_folds:
        # Fallback to single split if insufficient folds
        split_idx = int(len(f) * cfg.split)
        ic_train = _ic(f[:split_idx], r[:split_idx]) if split_idx > 2 else np.nan
        ic_test = _ic(f[split_idx:], r[split_idx:]) if split_idx > 2 else np.nan
        ic_decay = (
            (ic_train - ic_test) / abs(ic_train)
            if np.isfinite(ic_train) and ic_train != 0
            else np.nan
        )

    # Turnover proxy + naive PnL
    positions = _positions(f, cfg.position_mode, cfg.quantile)
    r_np = r.to_numpy()
    turnover = float(np.mean(np.abs(np.diff(positions)))) if len(positions) > 1 else 0.0
    cost_per_bar = turnover * cfg.cost_bps / 1e4
    gross_edge = float(np.mean(positions * r_np))
    net_edge = gross_edge - cost_per_bar
    active = positions != 0
    hit_rate = float(np.mean((positions[active] * r_np[active]) > 0)) if active.any() else np.nan

    # Null tests
    past_ret = fwd_ret.shift(cfg.horizon)
    past_mask = ~(feature.is_null() | past_ret.is_null())
    ic_past = rank_distance_correlation(feature.filter(past_mask), past_ret.filter(past_mask))

    lead_offsets = [1, max(1, cfg.horizon // 2), cfg.horizon]
    lead_ics: list[float] = []
    for offset in lead_offsets:
        lead_ret = fwd_ret.shift(-offset)
        lead_mask = ~(feature.is_null() | lead_ret.is_null())
        lead_ics.append(_ic(feature.filter(lead_mask), lead_ret.filter(lead_mask)))
    ic_lead = np.nan
    if lead_ics:
        idx = int(np.nanargmax(np.abs(lead_ics))) if np.any(np.isfinite(lead_ics)) else 0
        ic_lead = lead_ics[idx]

    max_lag = max(cfg.null_block * 2, 50)
    block = max(cfg.null_block, _decorrelation_lag(spot_ret, max_lag=max_lag))
    null_ics, null_actual_ic = _null_ic_distribution(
        f, r, rng, block=block, samples=cfg.null_samples
    )
    ic_shuffle = float(np.mean(null_ics)) if null_ics else np.nan
    # Compare Pearson IC against Pearson null distribution (consistent comparison)
    ic_shuffle_p = (
        float(np.mean(np.abs(null_ics) >= abs(null_actual_ic)))
        if null_ics and np.isfinite(null_actual_ic)
        else np.nan
    )

    # Regime stability
    vol = spot_ret.rolling_std(window_size=cfg.regime_window)
    trend_mean = spot_ret.rolling_mean(window_size=cfg.regime_window).abs()
    trend = trend_mean / (vol + 1e-12)
    vol_q30, vol_q70 = vol.quantile(0.3), vol.quantile(0.7)
    trend_q30, trend_q70 = trend.quantile(0.3), trend.quantile(0.7)
    vol_low = vol <= vol_q30
    vol_high = vol >= vol_q70
    trend_low = trend <= trend_q30
    trend_high = trend >= trend_q70

    def ic_mask(mask: pl.Series) -> float:
        # Fill nulls with False before converting to numpy
        mask_filled = mask.fill_null(False) if isinstance(mask, pl.Series) else mask
        mask_arr = mask_filled.to_numpy() if isinstance(mask_filled, pl.Series) else mask_filled
        feat_arr, ret_arr = feature.to_numpy(), fwd_ret.to_numpy()
        m = ~np.isnan(feat_arr) & ~np.isnan(ret_arr) & mask_arr
        if m.sum() <= 10:
            return np.nan
        return _ic(feat_arr[m], ret_arr[m])

    ic_vol_low = ic_mask(vol_low)
    ic_vol_high = ic_mask(vol_high)
    ic_trend_low = ic_mask(trend_low)
    ic_trend_high = ic_mask(trend_high)

    # Neutralization (optional)
    ic_neutral = np.nan
    if cfg.neutralize:
        factors = pl.DataFrame({
            "ret": spot_ret,
            "vol": vol,
            "volume": volume,
        })
        neutral = _neutralize(feature, factors)
        mask = ~(neutral.is_null() | fwd_ret.is_null())
        ic_neutral = _ic(neutral.filter(mask), fwd_ret.filter(mask))

    return {
        "ic": ic,
        "xi_ic": xi_ic,
        "rank_dcor": rank_dcor,
        "dcor_pvalue": dcor_p,
        "nonlinear_uplift": nonlinear_uplift,
        "rdc": rdc_value,
        "ic_mean": spearman_ic_mean,
        "ic_std": spearman_ic_std,
        "ic_ir": spearman_ic_ir,
        "spearman_ic_mean": spearman_ic_mean,
        "spearman_ic_std": spearman_ic_std,
        "spearman_ic_ir": spearman_ic_ir,
        "rdc_mean": rdc_mean,
        "rdc_std": rdc_std,
        "rdc_ir": rdc_ir,
        "ic_train": ic_train,
        "ic_test": ic_test,
        "ic_decay": ic_decay,
        "ic_train_pf": ic_train_pf,
        "ic_test_pf": ic_test_pf,
        "ic_decay_pf": ic_decay_pf,
        "wf_folds_pf": wf_folds_pf,
        "ic_past": ic_past,
        "ic_lead": ic_lead,
        "ic_shuffle": ic_shuffle,
        "ic_shuffle_p": ic_shuffle_p,
        "ic_vol_low": ic_vol_low,
        "ic_vol_high": ic_vol_high,
        "ic_trend_low": ic_trend_low,
        "ic_trend_high": ic_trend_high,
        "ic_neutral": ic_neutral,
        "unique_ratio": unique_ratio,
        "coverage": coverage,
        "missing_ratio": missing_ratio,
        "zero_ratio": zero_ratio,
        "stale_ratio": stale_ratio,
        "autocorr1": autocorr1,
        "monotonicity": monotonicity,
        "q_spread": q_spread,
        "turnover": turnover,
        "cost_per_bar": cost_per_bar,
        "gross_edge": gross_edge,
        "net_edge": net_edge,
        "hit_rate": hit_rate,
        "outlier_ratio": outlier_ratio,
        "p05": p05,
        "p95": p95,
        "skew": skew,
        "kurtosis": kurt,
        "mean": float(f.mean()),
        "std": float(f.std()),
        "min": float(f.min()),
        "max": float(f.max()),
        "n_samples": len(f),
    }


def _mean_metric(results: list[dict], key: str) -> float:
    values = [r[key] for r in results if key in r and r[key] is not None and not np.isnan(r[key])]
    return float(np.mean(values)) if values else np.nan


def _score(
    avg_oos: float, avg_ir: float, avg_decay: float, sign_consistent: bool, avg_turn: float
) -> float:
    if np.isnan(avg_oos) or np.isnan(avg_ir) or np.isnan(avg_turn):
        return np.nan
    stability = 1.0 - min(1.0, abs(avg_decay)) if np.isfinite(avg_decay) else 0.0
    turnover_norm = min(1.0, avg_turn / 0.5) if avg_turn >= 0 else 1.0
    cross_asset = 1.0 if sign_consistent else 0.0
    return (
        0.4 * abs(avg_oos)
        + 0.2 * avg_ir
        + 0.2 * stability
        + 0.1 * cross_asset
        + 0.1 * (1 - turnover_norm)
    )


def main() -> None:
    if _handle_clean_subcommand(sys.argv):
        return
    if _handle_perf_scan_subcommand(sys.argv):
        return

    parser = argparse.ArgumentParser(description="Feature diagnostic for feature-forge workflow")
    parser.add_argument("features", nargs="*", help="Feature name(s) to analyze")
    parser.add_argument("--symbols", nargs="+", default=_default_symbols())
    parser.add_argument("--start", default="2023-06-25", help="Start date (YYYY-MM-DD)")
    parser.add_argument(
        "--end",
        default="",
        help="End date (YYYY-MM-DD, default: Jan 1 of current year, UTC)",
    )
    parser.add_argument("--horizon", type=int, default=24, help="Forward return horizon")
    parser.add_argument(
        "--horizon-check",
        nargs="+",
        type=int,
        default=None,
        help="Extra horizons to evaluate for HORIZON_SENSITIVE flag (e.g., 12 24 48).",
    )
    parser.add_argument(
        "--no-horizon-check",
        dest="horizon_check_disable",
        action="store_true",
        default=False,
        help="Disable automatic horizon sensitivity checks.",
    )
    parser.add_argument(
        "--horizon-drop-thresh",
        type=float,
        default=0.6,
        help="Relative OOS IC drop threshold for HORIZON_SENSITIVE.",
    )
    parser.add_argument(
        "--horizon-min-ic",
        type=float,
        default=0.03,
        help="Minimum abs OOS IC to evaluate horizon sensitivity.",
    )
    parser.add_argument(
        "--suppress-flag",
        action="append",
        default=[],
        help="Hide specific flags in report output (repeatable).",
    )
    parser.add_argument("--min-samples", type=int, default=200)
    parser.add_argument("--split", type=float, default=0.7)
    parser.add_argument("--rolling-window", type=int, default=500)
    parser.add_argument("--regime-window", type=int, default=120)
    parser.add_argument(
        "--regime-min-abs-ic",
        type=float,
        default=0.02,
        help="Minimum abs(IC) within a regime slice to consider for REGIME_* flags.",
    )
    parser.add_argument(
        "--regime-drop-thresh",
        type=float,
        default=0.6,
        help=(
            "Relative abs(IC) drop threshold between regime slices for REGIME_UNSTABLE "
            "(1 - min(abs(ic_low), abs(ic_high)) / max(abs(ic_low), abs(ic_high)))."
        ),
    )
    parser.add_argument("--null-block", type=int, default=50)
    parser.add_argument("--null-samples", type=int, default=100)
    parser.add_argument("--null-p-thresh", type=float, default=0.01)
    parser.add_argument("--leak-lead-thresh", type=float, default=0.02)
    parser.add_argument(
        "--flag-min-ratio",
        type=float,
        default=0.9,
        help="Minimum fraction of symbols that must pass before a flag is raised (floor).",
    )
    parser.add_argument("--position", choices=["quantile", "sign"], default="quantile")
    parser.add_argument("--quantile", type=float, default=0.2)
    parser.add_argument("--cost-bps", type=float, default=3.0)
    parser.add_argument(
        "--source",
        choices=["engine", "experiment", "auto"],
        default="engine",
        help=(
            "Feature source (engine = production, experiment = "
            "experiments/feature_forge/feature_workshop.py)"
        ),
    )
    parser.add_argument("--neutralize", action="store_true")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--perf-bars", type=int, default=8000)
    parser.add_argument(
        "--perf-sluggish-ms",
        type=float,
        default=30.0,
        help="Mild performance warning threshold (ms per 8000 bars) for SLUGGISH.",
    )
    parser.add_argument("--perf-warn-ms", type=float, default=50.0)
    parser.add_argument("--wf-train", type=int, default=None)
    parser.add_argument("--wf-test", type=int, default=None)
    parser.add_argument("--wf-embargo", type=int, default=None)
    parser.add_argument("--wf-step", type=int, default=None)
    parser.add_argument("--wf-min-folds", type=int, default=3)
    parser.add_argument(
        "--no-stream-check", dest="stream_check", action="store_false", default=True
    )
    parser.add_argument("--stream-samples", type=int, default=25)
    parser.add_argument("--stream-warmup", type=int, default=200)
    parser.add_argument("--stream-thresh", type=float, default=0.01)
    parser.add_argument(
        "--per-fold-recompute",
        action="store_true",
        default=False,
        help="Recompute features per fold (strict backward-only)",
    )
    parser.add_argument(
        "--interaction",
        action="append",
        default=[],
        help="Interaction mapping: feature:parent1,parent2 (repeatable)",
    )
    parser.add_argument(
        "--interaction-map",
        default=None,
        help="JSON file mapping interaction feature -> parent list",
    )
    parser.add_argument(
        "--no-interaction-checks",
        dest="interaction_checks",
        action="store_false",
        default=True,
        help="Disable interaction diagnostics",
    )
    parser.add_argument("--interaction-corr-max", type=float, default=0.8)
    parser.add_argument("--interaction-resid-min", type=float, default=0.01)
    parser.add_argument("--interaction-uplift-min", type=float, default=0.003)
    parser.add_argument("--interaction-quad-min", type=float, default=0.6)
    parser.add_argument("--interaction-parent-margin", type=float, default=0.005)
    parser.add_argument("--interaction-min-group", type=int, default=50)
    parser.add_argument(
        "--interaction-auto",
        type=int,
        default=2,
        help="Auto-select N parents (>=2 enables)",
    )
    parser.add_argument("--interaction-auto-min-corr", type=float, default=0.05)
    parser.add_argument(
        "--interaction-auto-pool",
        nargs="+",
        default=None,
        help="Candidate pool for auto parents (default: all features from source)",
    )
    parser.add_argument(
        "--interaction-include-disabled",
        action="store_true",
        help="Include disabled features from config/features.json in auto-parent pool",
    )
    parser.add_argument(
        "--interaction-auto-max-pool",
        type=int,
        default=0,
        help="Limit auto-parent candidate pool size (0 = no limit)",
    )
    parser.add_argument(
        "--interaction-edge-uplift-min",
        type=float,
        default=0.0,
        help="Minimum edge uplift required for interaction (net edge per bar)",
    )
    parser.add_argument(
        "--interaction-auto-only",
        dest="interaction_auto_only",
        action="store_true",
        default=True,
        help="Ignore explicit/default interaction mappings; only use auto parents (default)",
    )
    parser.add_argument(
        "--interaction-use-explicit",
        dest="interaction_auto_only",
        action="store_false",
        help="Use explicit/default interaction mappings when available",
    )
    parser.add_argument(
        "--clean-workshop",
        action="store_true",
        help=(
            "Reset experiments/feature_forge/feature_workshop.py to a clean board and exit "
            "(legacy; prefer the 'clean' subcommand)"
        ),
    )
    parser.add_argument(
        "--no-clean-backup",
        dest="clean_backup",
        action="store_false",
        default=True,
        help="Skip backup when cleaning the workshop",
    )
    args = parser.parse_args()
    if args.perf_sluggish_ms >= args.perf_warn_ms:
        parser.error("--perf-sluggish-ms must be < --perf-warn-ms")
    suppress_flags = {flag.strip().upper() for flag in args.suppress_flag if flag.strip()}
    if args.horizon_check is not None:
        horizon_checks = sorted({h for h in args.horizon_check if h > 0})
    elif args.horizon_check_disable:
        horizon_checks = []
    else:
        horizon_checks = _default_horizon_checks(args.horizon)

    if args.clean_workshop:
        _clean_workshop(backup=args.clean_backup)
        return

    if not args.features:
        if args.source == "engine":
            # Auto-populate with all active engine features
            args.features = _list_feature_names_for_source("engine", include_disabled=False)
            if not args.features:
                parser.error("No active features found in engine")
            print(
                f"Auto-selecting all {len(args.features)} active features: {', '.join(args.features)}"
            )
            print()
        else:
            parser.error(
                "features are required unless --source engine (auto-selects all active) "
                "or --clean-workshop is provided"
            )

    cfg = DiagConfig(
        horizon=args.horizon,
        min_samples=args.min_samples,
        split=args.split,
        rolling_window=args.rolling_window,
        regime_window=args.regime_window,
        null_block=args.null_block,
        null_samples=args.null_samples,
        null_p_thresh=args.null_p_thresh,
        leak_lead_thresh=args.leak_lead_thresh,
        flag_min_ratio=args.flag_min_ratio,
        position_mode=args.position,
        quantile=args.quantile,
        cost_bps=args.cost_bps,
        neutralize=args.neutralize,
        seed=args.seed,
        perf_bars=args.perf_bars,
        perf_sluggish_ms=args.perf_sluggish_ms,
        perf_warn_ms=args.perf_warn_ms,
        wf_train=args.wf_train,
        wf_test=args.wf_test,
        wf_embargo=args.wf_embargo,
        wf_step=args.wf_step,
        wf_min_folds=args.wf_min_folds,
        stream_check=args.stream_check,
        stream_samples=args.stream_samples,
        stream_warmup=args.stream_warmup,
        stream_thresh=args.stream_thresh,
        per_fold_recompute=args.per_fold_recompute,
        interaction_checks=args.interaction_checks,
        interaction_corr_max=args.interaction_corr_max,
        interaction_resid_min=args.interaction_resid_min,
        interaction_uplift_min=args.interaction_uplift_min,
        interaction_quad_min=args.interaction_quad_min,
        interaction_parent_margin=args.interaction_parent_margin,
        interaction_min_group=args.interaction_min_group,
        interaction_auto=args.interaction_auto,
        interaction_auto_min_corr=args.interaction_auto_min_corr,
        interaction_auto_max_pool=args.interaction_auto_max_pool,
        interaction_auto_only=args.interaction_auto_only,
        interaction_include_disabled=args.interaction_include_disabled,
        interaction_edge_uplift_min=args.interaction_edge_uplift_min,
    )

    rng = np.random.default_rng(cfg.seed)
    if cfg.interaction_auto_only and cfg.interaction_auto < 2:
        raise ValueError("--interaction-auto-only requires --interaction-auto >= 2")

    interaction_map = (
        _build_interaction_map(args.interaction, args.interaction_map)
        if cfg.interaction_checks and not cfg.interaction_auto_only
        else {}
    )

    features_str = ", ".join(args.features)
    print("=" * 70)
    print(f"FEATURE DIAGNOSTIC: {features_str}")
    print("=" * 70)
    print()

    all_results: dict[str, list[dict]] = {}
    feature_cache: dict[str, dict[str, pl.Series]] = {}
    perf_cache: dict[str, dict[str, float]] = {}
    states_cache: dict[str, list] = {}  # Cache market states per symbol
    df_cache: dict[str, pl.DataFrame] = {}  # Cache loaded dataframes
    pool_cache: dict[str, dict[str, pl.Series]] = {}

    for feature_name in args.features:
        print(f"\n--- {feature_name} ---")
        results = []

        for symbol in args.symbols:
            print(f"  Analyzing {symbol}...")
            try:
                # Cache df and states per symbol
                if symbol not in df_cache:
                    df_cache[symbol] = load_data(symbol, args.start, args.end)
                df = df_cache[symbol]

                if symbol not in states_cache:
                    states_cache[symbol] = _build_market_states(df, symbol)
                states = states_cache[symbol]

                feat_key = _cache_key(args.source, feature_name)
                if feat_key in feature_cache.get(symbol, {}):
                    feature = feature_cache[symbol][feat_key]
                    compute_ms = perf_cache.get(symbol, {}).get(feat_key)
                    if compute_ms is None:
                        _, compute_ms = compute_feature_with_perf(
                            df, feature_name, symbol, args.source, states=states
                        )
                        perf_cache.setdefault(symbol, {})[feat_key] = compute_ms
                else:
                    feature, compute_ms = compute_feature_with_perf(
                        df, feature_name, symbol, args.source, states=states
                    )
                    feature_cache.setdefault(symbol, {})[feat_key] = feature
                    perf_cache.setdefault(symbol, {})[feat_key] = compute_ms
                ms_per_8000 = compute_ms * cfg.perf_bars / max(len(df), 1)

                stream_mae, stream_max, stream_bad = _streaming_equivalence(
                    feature_name, df, symbol, args.source, feature, cfg, states=states
                )

                fwd_ret = df["close"].pct_change(args.horizon).shift(-args.horizon)
                spot_ret = df["close"].pct_change()
                volume = df["volume"]

                t1 = time.perf_counter()
                metrics = analyze_feature(
                    feature,
                    fwd_ret,
                    spot_ret,
                    volume,
                    cfg,
                    rng,
                    feature_name,
                    df,
                    symbol,
                    args.source,
                )
                metrics["stream_mae"] = stream_mae
                metrics["stream_max"] = stream_max
                metrics["stream_bad"] = stream_bad
                metrics["analysis_ms"] = (time.perf_counter() - t1) * 1000.0
                metrics["compute_ms"] = compute_ms
                metrics["ms_per_8000"] = ms_per_8000
                metrics["symbol"] = symbol
                if horizon_checks:
                    horizon_oos: dict[int, float] = {}
                    for h in horizon_checks:
                        if h == cfg.horizon:
                            horizon_oos[h] = metrics.get("ic_test", np.nan)
                            continue
                        fwd_ret_h = df["close"].pct_change(h).shift(-h)
                        cfg_h = replace(cfg, horizon=h)
                        horizon_oos[h] = _horizon_oos_ic(feature, fwd_ret_h, cfg_h)
                    metrics["horizon_oos"] = horizon_oos

                if cfg.interaction_checks:
                    parent_names = interaction_map.get(feature_name)
                    parent_source = "explicit" if parent_names else None

                    if not parent_names and cfg.interaction_auto >= 2:
                        pool = _interaction_candidate_pool(
                            df,
                            symbol,
                            args.source,
                            cfg,
                            feature_cache,
                            pool_cache,
                            args.interaction_auto_pool,
                            states=states,
                        )
                        parent_names = _auto_select_parents(
                            feature_name,
                            feature,
                            pool,
                            cfg,
                        )
                        parent_source = "auto" if parent_names else None

                    if parent_names:
                        interaction_metrics = analyze_interaction(
                            feature_name,
                            feature,
                            parent_names,
                            df,
                            symbol,
                            args.source,
                            fwd_ret,
                            cfg,
                            feature_cache,
                            states=states,
                        )
                        interaction_metrics["interaction_parent_source"] = parent_source
                        metrics.update(interaction_metrics)
                    elif cfg.interaction_auto >= 2 and feature_name not in interaction_map:
                        metrics["interaction_error"] = "auto_parent_not_found"
                results.append(metrics)
            except Exception as e:
                print(f"    Error: {e}")
                continue

        all_results[feature_name] = results

    if not all_results:
        print("No results to display")
        return

    # Summary for each feature
    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)

    # Build per-symbol dependency view from ALL active features (not just the batch)
    # so "Used as parent by" reflects the full active feature set per symbol.
    # Only available when interaction_auto >= 2 and pool was cached.
    # Structure: parent_children_per_sym[symbol][parent] = set(children)
    parent_children_per_sym: dict[str, dict[str, set[str]]] = {}
    if cfg.interaction_auto >= 2 and pool_cache:
        # Get all active feature names from the cached pool
        all_active_features: set[str] = set()
        for pool in pool_cache.values():
            all_active_features.update(pool.keys())

        # For features in the batch, use their computed parents (per-symbol)
        for child_feature, child_results in all_results.items():
            for r in child_results:
                symbol = r.get("symbol")
                parents_str = r.get("interaction_parents")
                if not symbol or not parents_str:
                    continue
                for parent in parents_str.split(","):
                    parent = parent.strip()
                    if not parent or parent == child_feature:
                        continue
                    parent_children_per_sym.setdefault(symbol, {}).setdefault(parent, set()).add(
                        child_feature
                    )

        # For active features NOT in the batch, compute their parents per-symbol
        # Uses parallel processing across symbols for faster computation
        non_batch_features = all_active_features - set(all_results.keys())
        if non_batch_features:

            def _compute_parents_for_symbol(
                symbol: str, pool: dict[str, pl.Series]
            ) -> dict[str, set[str]]:
                """Compute parent-child relationships for one symbol."""
                result: dict[str, set[str]] = {}
                for child_feature in non_batch_features:
                    if child_feature not in pool:
                        continue
                    child_series = pool[child_feature]
                    parents = _auto_select_parents(child_feature, child_series, pool, cfg)
                    for parent in parents:
                        if parent and parent != child_feature:
                            result.setdefault(parent, set()).add(child_feature)
                return result

            # Parallel execution across symbols
            max_workers = min(len(pool_cache), os.cpu_count() or 4)
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(_compute_parents_for_symbol, symbol, pool): symbol
                    for symbol, pool in pool_cache.items()
                }
                for future in futures:
                    symbol = futures[future]
                    try:
                        sym_result = future.result()
                        for parent, children in sym_result.items():
                            parent_children_per_sym.setdefault(symbol, {}).setdefault(
                                parent, set()
                            ).update(children)
                    except Exception:
                        pass  # Skip failed symbols

    for feature_name, results in all_results.items():
        if not results:
            continue

        print(f"\n{feature_name}:")

        avg_ic = _mean_metric(results, "ic")
        avg_rank_dcor = _mean_metric(results, "rank_dcor")
        avg_dcor_p = _mean_metric(results, "dcor_pvalue")
        avg_rdc = _mean_metric(results, "rdc")
        avg_nonlinear_uplift = _mean_metric(results, "nonlinear_uplift")
        avg_oos = _mean_metric(results, "ic_test")
        avg_oos_pf = _mean_metric(results, "ic_test_pf")
        avg_decay = _mean_metric(results, "ic_decay")
        avg_decay_pf = _mean_metric(results, "ic_decay_pf")
        avg_unique = _mean_metric(results, "unique_ratio")
        avg_ic_ir = _mean_metric(results, "ic_ir")
        avg_turnover = _mean_metric(results, "turnover")
        avg_cov = _mean_metric(results, "coverage")
        avg_past = _mean_metric(results, "ic_past")
        avg_lead = _mean_metric(results, "ic_lead")
        avg_shuffle = _mean_metric(results, "ic_shuffle")
        avg_shuffle_p = _mean_metric(results, "ic_shuffle_p")
        avg_stale = _mean_metric(results, "stale_ratio")
        avg_mono = _mean_metric(results, "monotonicity")
        avg_outlier = _mean_metric(results, "outlier_ratio")
        avg_perf = _mean_metric(results, "ms_per_8000")
        avg_net = _mean_metric(results, "net_edge")
        avg_q_spread = _mean_metric(results, "q_spread")
        avg_stream_mae = _mean_metric(results, "stream_mae")
        avg_stream_bad = _mean_metric(results, "stream_bad")

        interaction_parents = next(
            (r.get("interaction_parents") for r in results if r.get("interaction_parents")), None
        )
        interaction_source = next(
            (
                r.get("interaction_parent_source")
                for r in results
                if r.get("interaction_parent_source") is not None
            ),
            None,
        )
        interaction_errors = {
            r.get("interaction_error") for r in results if r.get("interaction_error") is not None
        }

        avg_parent_corr = _mean_metric(results, "parent_corr_max")
        avg_parent_oos = _mean_metric(results, "parent_oos_max")
        avg_resid_oos = _mean_metric(results, "resid_ic_test")
        avg_resid_pf = _mean_metric(results, "resid_ic_test_pf")
        avg_ret_resid = _mean_metric(results, "return_resid_ic_test")
        avg_ret_resid_pf = _mean_metric(results, "return_resid_ic_pf")
        avg_uplift = _mean_metric(results, "uplift_delta")
        avg_uplift_pf = _mean_metric(results, "uplift_delta_pf")
        avg_uplift_win = _mean_metric(results, "uplift_win_rate")
        avg_uplift_folds = _mean_metric(results, "uplift_folds")
        avg_edge_uplift = _mean_metric(results, "edge_uplift")
        avg_edge_uplift_pf = _mean_metric(results, "edge_uplift_pf")
        avg_edge_win = _mean_metric(results, "edge_uplift_win")
        avg_edge_folds = _mean_metric(results, "edge_folds")
        avg_quad = _mean_metric(results, "quad_consistency")

        ics = [r["ic"] for r in results if "ic" in r and not np.isnan(r["ic"])]
        sign_consistent = bool(ics) and (all(ic > 0 for ic in ics) or all(ic < 0 for ic in ics))

        total_symbols = len(results)
        ratio = min(max(cfg.flag_min_ratio, 0.0), 1.0)
        required_pass = (
            min(total_symbols, max(1, int(math.floor(ratio * total_symbols))))
            if total_symbols
            else 0
        )
        allowed_fail = max(0, total_symbols - required_pass)

        def _ordered_unique(values: list[str]) -> list[str]:
            seen: set[str] = set()
            ordered: list[str] = []
            for value in values:
                if value not in seen:
                    ordered.append(value)
                    seen.add(value)
            return ordered

        def _flag_symbols(symbols: list[str]) -> bool:
            return bool(symbols) and len(symbols) > allowed_fail

        def _fmt_flag(name: str, symbols: list[str]) -> str:
            if symbols:
                return f"{name}({', '.join(symbols)})"
            return name

        def _add_flag(name: str, symbols: list[str]) -> None:
            if name in suppress_flags:
                return
            if _flag_symbols(symbols):
                flags.append(_fmt_flag(name, _ordered_unique(symbols)))

        def _sym_vals(key: str) -> list[tuple[str, float]]:
            return [(r["symbol"], r.get(key, np.nan)) for r in results]

        flags: list[str] = []

        low_ic_syms = [sym for sym, val in _sym_vals("ic") if np.isfinite(val) and abs(val) < 0.015]
        _add_flag("LOW_IC", low_ic_syms)

        low_oos_syms = [
            sym for sym, val in _sym_vals("ic_test") if np.isfinite(val) and abs(val) < 0.015
        ]
        _add_flag("LOW_OOS", low_oos_syms)

        low_oos_pf_syms = [
            sym for sym, val in _sym_vals("ic_test_pf") if np.isfinite(val) and abs(val) < 0.015
        ]
        _add_flag("LOW_OOS_PF", low_oos_pf_syms)

        low_card_syms = [
            sym for sym, val in _sym_vals("unique_ratio") if np.isfinite(val) and val < 0.05
        ]
        _add_flag("LOW_CARDINALITY", low_card_syms)

        unstable_syms = [sym for sym, val in _sym_vals("ic_ir") if np.isfinite(val) and val < 0.15]
        _add_flag("UNSTABLE", unstable_syms)

        low_cov_syms = [sym for sym, val in _sym_vals("coverage") if np.isfinite(val) and val < 0.9]
        _add_flag("LOW_COVERAGE", low_cov_syms)

        high_decay_syms = [
            sym for sym, val in _sym_vals("ic_decay") if np.isfinite(val) and val > 0.5
        ]
        _add_flag("HIGH_DECAY", high_decay_syms)

        past_proxy_syms = [
            sym for sym, val in _sym_vals("ic_past") if np.isfinite(val) and val > 0.08
        ]
        _add_flag("PAST_RET_PROXY", past_proxy_syms)

        leak_syms = []
        for r in results:
            lead = r.get("ic_lead", np.nan)
            oos = r.get("ic_test", np.nan)
            if (
                np.isfinite(lead)
                and np.isfinite(oos)
                and abs(lead) > max(cfg.leak_lead_thresh, abs(oos))
            ):
                leak_syms.append(r["symbol"])
        _add_flag("LEAKAGE_RISK", leak_syms)

        stream_bad_syms = [
            sym for sym, val in _sym_vals("stream_bad") if np.isfinite(val) and val > 0.1
        ]
        stream_mae_syms = [
            sym
            for sym, val in _sym_vals("stream_mae")
            if np.isfinite(val) and val > cfg.stream_thresh
        ]
        stream_syms = _ordered_unique(stream_bad_syms + stream_mae_syms)
        _add_flag("LEAKAGE_STREAM", stream_syms)

        null_syms = [
            sym for sym, val in _sym_vals("dcor_pvalue") if np.isfinite(val) and val > cfg.null_p_thresh
        ]
        _add_flag("NULL_FAIL", null_syms)

        nonlinear_signal_syms = [
            r["symbol"]
            for r in results
            if np.isfinite(r.get("nonlinear_uplift", np.nan))
            and np.isfinite(r.get("dcor_pvalue", np.nan))
            and float(r["nonlinear_uplift"]) > 0.02
            and float(r["dcor_pvalue"]) < 0.01
        ]
        _add_flag("NONLINEAR_SIGNAL", nonlinear_signal_syms)

        pos_syms = [sym for sym, val in _sym_vals("ic") if np.isfinite(val) and val > 0]
        neg_syms = [sym for sym, val in _sym_vals("ic") if np.isfinite(val) and val < 0]
        zero_syms = [sym for sym, val in _sym_vals("ic") if np.isfinite(val) and val == 0]
        sign_flip_syms: list[str] = []
        if pos_syms and neg_syms:
            sign_flip_syms = (
                neg_syms + zero_syms if len(pos_syms) >= len(neg_syms) else pos_syms + zero_syms
            )
        elif (zero_syms and (pos_syms or neg_syms)) or (zero_syms and not (pos_syms or neg_syms)):
            sign_flip_syms = zero_syms
        _add_flag("SIGN_FLIP", sign_flip_syms)

        horizon_sensitive_syms: list[str] = []
        if horizon_checks:
            for r in results:
                base = r.get("ic_test", np.nan)
                if not np.isfinite(base) or abs(base) < args.horizon_min_ic:
                    continue
                horizon_oos = r.get("horizon_oos") or {}
                for h, alt in horizon_oos.items():
                    if h == cfg.horizon or not np.isfinite(alt):
                        continue
                    rel_drop = 1.0 - (abs(alt) / abs(base)) if abs(base) > 0 else 0.0
                    if rel_drop >= args.horizon_drop_thresh:
                        horizon_sensitive_syms.append(r["symbol"])
                        break
                    if abs(alt) >= args.horizon_min_ic and np.sign(base) != np.sign(alt):
                        horizon_sensitive_syms.append(r["symbol"])
                        break
        _add_flag("HORIZON_SENSITIVE", horizon_sensitive_syms)

        regime_sign_flip_syms: list[str] = []
        regime_unstable_syms: list[str] = []

        def _regime_sign_flip(low: float, high: float) -> bool:
            if not np.isfinite(low) or not np.isfinite(high):
                return False
            if abs(low) < args.regime_min_abs_ic or abs(high) < args.regime_min_abs_ic:
                return False
            return np.sign(low) != np.sign(high)

        def _regime_unstable(low: float, high: float) -> bool:
            if not np.isfinite(low) or not np.isfinite(high):
                return False
            max_abs = max(abs(low), abs(high))
            if max_abs < args.regime_min_abs_ic:
                return False
            rel_drop = 1.0 - (min(abs(low), abs(high)) / max_abs) if max_abs > 0 else 0.0
            return rel_drop >= args.regime_drop_thresh

        for r in results:
            vol_low = r.get("ic_vol_low", np.nan)
            vol_high = r.get("ic_vol_high", np.nan)
            trend_low = r.get("ic_trend_low", np.nan)
            trend_high = r.get("ic_trend_high", np.nan)

            vol_flip = _regime_sign_flip(vol_low, vol_high)
            trend_flip = _regime_sign_flip(trend_low, trend_high)
            if vol_flip or trend_flip:
                regime_sign_flip_syms.append(r["symbol"])

            vol_unstable = vol_flip or _regime_unstable(vol_low, vol_high)
            trend_unstable = trend_flip or _regime_unstable(trend_low, trend_high)
            if vol_unstable or trend_unstable:
                regime_unstable_syms.append(r["symbol"])

        _add_flag("REGIME_SIGN_FLIP", regime_sign_flip_syms)
        _add_flag("REGIME_UNSTABLE", regime_unstable_syms)

        stale_syms = [
            sym for sym, val in _sym_vals("stale_ratio") if np.isfinite(val) and val > 0.5
        ]
        _add_flag("STALE", stale_syms)

        slow_syms = [
            sym
            for sym, val in _sym_vals("ms_per_8000")
            if np.isfinite(val) and val > cfg.perf_warn_ms
        ]
        _add_flag("SLOW", slow_syms)

        sluggish_syms = [
            sym
            for sym, val in _sym_vals("ms_per_8000")
            if np.isfinite(val) and cfg.perf_sluggish_ms <= val <= cfg.perf_warn_ms
        ]
        _add_flag("SLUGGISH", sluggish_syms)

        mono_syms = [
            sym for sym, val in _sym_vals("monotonicity") if np.isfinite(val) and abs(val) < 0.2
        ]
        _add_flag("NON_MONO", mono_syms)

        tail_syms = [
            sym for sym, val in _sym_vals("outlier_ratio") if np.isfinite(val) and val > 0.05
        ]
        _add_flag("HEAVY_TAIL", tail_syms)

        edge_syms = [sym for sym, val in _sym_vals("net_edge") if np.isfinite(val) and val <= 0]
        _add_flag("LOW_EDGE", edge_syms)

        if interaction_parents:
            # Helper: check if feature is leaf (not used as parent) on a specific symbol
            def _is_leaf_on_symbol(sym: str) -> bool:
                if len(args.features) <= 1:
                    return True  # Single feature analysis, treat as leaf
                sym_parents = parent_children_per_sym.get(sym, {})
                return feature_name not in sym_parents

            redundant_syms = [
                sym
                for sym, val in _sym_vals("parent_corr_max")
                if np.isfinite(val) and val > cfg.interaction_corr_max
            ]
            # Filter to only symbols where feature is leaf
            redundant_syms = [s for s in redundant_syms if _is_leaf_on_symbol(s)]
            _add_flag("INTERACTION_REDUNDANT", redundant_syms)

            resid_syms = [
                sym
                for sym, val in _sym_vals("resid_ic_test")
                if np.isfinite(val) and abs(val) < cfg.interaction_resid_min
            ]
            resid_syms = [s for s in resid_syms if _is_leaf_on_symbol(s)]
            _add_flag("INTERACTION_NO_RESID", resid_syms)

            ret_resid_syms = [
                sym
                for sym, val in _sym_vals("return_resid_ic_test")
                if np.isfinite(val) and abs(val) < cfg.interaction_resid_min
            ]
            ret_resid_syms = [s for s in ret_resid_syms if _is_leaf_on_symbol(s)]
            _add_flag("INTERACTION_NO_RET_RESID", ret_resid_syms)

            uplift_syms = [
                r["symbol"]
                for r in results
                if int(r.get("uplift_folds", 0) or 0) >= cfg.wf_min_folds
                and np.isfinite(r.get("uplift_delta", np.nan))
                and float(r["uplift_delta"]) < cfg.interaction_uplift_min
            ]
            uplift_syms = [s for s in uplift_syms if _is_leaf_on_symbol(s)]
            _add_flag("INTERACTION_NO_UPLIFT", uplift_syms)

            edge_uplift_syms = [
                r["symbol"]
                for r in results
                if int(r.get("edge_folds", 0) or 0) >= cfg.wf_min_folds
                and np.isfinite(r.get("edge_uplift", np.nan))
                and float(r["edge_uplift"]) < cfg.interaction_edge_uplift_min
            ]
            edge_uplift_syms = [s for s in edge_uplift_syms if _is_leaf_on_symbol(s)]
            _add_flag("INTERACTION_NO_EDGE_UPLIFT", edge_uplift_syms)

            quad_syms = [
                sym
                for sym, val in _sym_vals("quad_consistency")
                if np.isfinite(val) and val < cfg.interaction_quad_min
            ]
            _add_flag("INTERACTION_SIGN_UNSTABLE", quad_syms)

            parent_dom_syms = []
            for r in results:
                parent_oos = r.get("parent_oos_max", np.nan)
                oos = r.get("ic_test", np.nan)
                uplift = r.get("uplift_delta", np.nan)
                if (
                    np.isfinite(parent_oos)
                    and np.isfinite(oos)
                    and int(r.get("uplift_folds", 0) or 0) >= cfg.wf_min_folds
                    and abs(oos) + cfg.interaction_parent_margin <= abs(parent_oos)
                    and np.isfinite(uplift)
                    and uplift < cfg.interaction_uplift_min
                ):
                    parent_dom_syms.append(r["symbol"])
            parent_dom_syms = [s for s in parent_dom_syms if _is_leaf_on_symbol(s)]
            _add_flag("INTERACTION_PARENT_DOMINATES", parent_dom_syms)

        score = _score(avg_oos, avg_ic_ir, avg_decay, sign_consistent, avg_turnover)

        flag_str = ", ".join(flags) if flags else "OK"
        print(
            "  "
            f"Mean Spearman: {avg_ic:+.4f}, "
            f"OOS IC: {avg_oos:+.4f}, "
            f"OOS PF: {avg_oos_pf:+.4f}, "
            f"Decay: {avg_decay * 100:+.1f}%, "
            f"Decay PF: {avg_decay_pf * 100:+.1f}%, "
            f"Spear IR: {avg_ic_ir:.3f}, "
            f"dCor: {avg_rank_dcor:+.4f}, "
            f"dCor p: {avg_dcor_p:.3f}, "
            f"RDC: {avg_rdc:+.4f}, "
            f"NL uplift: {avg_nonlinear_uplift:+.4f}, "
            f"Turnover: {avg_turnover:.3f}, "
            f"Coverage: {avg_cov * 100:.1f}%, "
            f"Score: {score:.3f}, "
            f"Flags: {flag_str}"
        )
        print(
            "  "
            f"Net edge: {avg_net:+.5f}, "
            f"Q-spread: {avg_q_spread:+.5f}, "
            f"Past-ret IC: {avg_past:+.4f}, "
            f"Lead IC: {avg_lead:+.4f}, "
            f"Null IC mean: {avg_shuffle:+.4f}, "
            f"Null p: {avg_shuffle_p:.3f}, "
            f"Stream MAE: {avg_stream_mae:.4f}, "
            f"Stream bad%: {avg_stream_bad * 100:.1f}%, "
            f"Perf ms/8k: {avg_perf:.1f}"
        )

        # Aggregate children across all symbols (union)
        all_children: set[str] = set()
        core_symbols: list[str] = []
        leaf_symbols: list[str] = []
        for sym in args.symbols:
            sym_children = parent_children_per_sym.get(sym, {}).get(feature_name, set())
            if sym_children:
                all_children.update(sym_children)
                core_symbols.append(sym)
            else:
                leaf_symbols.append(sym)
        if parent_children_per_sym:
            if all_children:
                if leaf_symbols:
                    print(
                        f"  Used as parent by: {len(all_children)} feature(s), LEAF on: {', '.join(leaf_symbols)}"
                    )
                else:
                    print(f"  Used as parent by: {len(all_children)} feature(s)")
            else:
                print("  Used as parent by: 0 feature(s) (LEAF)")

        if interaction_parents:
            print(
                "  "
                f"Interaction parents: {interaction_parents}, "
                f"Parent source: {interaction_source or 'explicit'}, "
                f"Parent corr max: {avg_parent_corr:.3f}, "
                f"Parent OOS max: {avg_parent_oos:.4f}, "
                f"Residual OOS: {avg_resid_oos:+.4f}, "
                f"Return-resid OOS: {avg_ret_resid:+.4f}, "
                f"Uplift: {avg_uplift:+.4f}, "
                f"Edge uplift: {avg_edge_uplift:+.5f}, "
                f"Uplift win%: {avg_uplift_win * 100:.1f}%, "
                f"Uplift folds: {avg_uplift_folds:.1f}, "
                f"Edge win%: {avg_edge_win * 100:.1f}%, "
                f"Edge folds: {avg_edge_folds:.1f}, "
                f"Quad consistency: {avg_quad:.2f}"
            )
            if np.isfinite(avg_resid_pf) or np.isfinite(avg_uplift_pf):
                print(
                    "  "
                    f"Interaction PF Residual OOS: {avg_resid_pf:+.4f}, "
                    f"Interaction PF Return-resid OOS: {avg_ret_resid_pf:+.4f}, "
                    f"Interaction PF Uplift: {avg_uplift_pf:+.4f}, "
                    f"Interaction PF Edge uplift: {avg_edge_uplift_pf:+.5f}"
                )
            if interaction_errors:
                print(f"  Interaction warnings: {', '.join(sorted(interaction_errors))}")

        # Regime summary
        avg_vol_low = _mean_metric(results, "ic_vol_low")
        avg_vol_high = _mean_metric(results, "ic_vol_high")
        avg_trend_low = _mean_metric(results, "ic_trend_low")
        avg_trend_high = _mean_metric(results, "ic_trend_high")
        print(
            "  "
            f"Regime IC vol low/high: {avg_vol_low:+.4f}/{avg_vol_high:+.4f}, "
            f"trend low/high: {avg_trend_low:+.4f}/{avg_trend_high:+.4f}"
        )

        if cfg.neutralize:
            avg_neutral = _mean_metric(results, "ic_neutral")
            print(f"  Neutralized IC: {avg_neutral:+.4f}")

    # Pairwise correlations if multiple features
    if len(args.features) > 1:
        print()
        print("=" * 70)
        print("PAIRWISE FEATURE CORRELATION (PEARSON)")
        print("=" * 70)
        for symbol, cached in feature_cache.items():
            series_by_name: dict[str, pl.Series] = {}
            for name in args.features:
                key = _cache_key(args.source, name)
                if key in cached:
                    series_by_name[name] = cached[key]
            names = list(series_by_name.keys())
            if len(names) < 2:
                continue
            print(f"\n{symbol}:")
            for i in range(len(names)):
                for j in range(i + 1, len(names)):
                    f1 = series_by_name[names[i]]
                    f2 = series_by_name[names[j]]
                    mask = ~(f1.is_null() | f2.is_null())
                    rho = _corr(f1.filter(mask), f2.filter(mask)) if mask.sum() > 10 else np.nan
                    print(f"  {names[i]} vs {names[j]}: {rho:+.4f}")

    # Combination recommendation if multiple features
    if len(args.features) > 1:
        print()
        print("=" * 70)
        print("COMBINATION POTENTIAL")
        print("=" * 70)
        print()
        print("Consider combining these features only if they:")
        print("  1. Share a clear economic story")
        print("  2. Have low pairwise correlation (< 0.4)")
        print("  3. Add residual IC after regression")
        print()
        print("Test combinations like:")
        print(
            f"  combo = ({args.features[0]} - {args.features[1] if len(args.features) > 1 else '0.5'})"
        )
        if len(args.features) > 2:
            print(f"  combo = ({args.features[0]} - {args.features[1]}) * {args.features[2]}")


if __name__ == "__main__":
    main()
