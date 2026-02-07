"""OpenRouter-only LLM configuration for ChunkHound deep research."""

import argparse
import os
from typing import Any

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash"


class LLMConfig(BaseSettings):
    """LLM configuration for deep research.

    Deep research is OpenRouter-only:
    - Auth: OPENROUTER_API_KEY
    - Endpoint: https://openrouter.ai/api/v1 (fixed)
    - Model: CHUNKHOUND_LLM_MODEL (single model for utility+synthesis)
    """

    model_config = SettingsConfigDict(
        env_prefix="CHUNKHOUND_LLM_",
        env_nested_delimiter="__",
        case_sensitive=False,
        validate_default=True,
        extra="ignore",
    )

    model: str = Field(
        default=DEFAULT_OPENROUTER_MODEL,
        description=(
            "OpenRouter model identifier used for both utility and synthesis "
            "operations (for example: google/gemini-2.5-flash)."
        ),
    )

    api_key: SecretStr | None = Field(
        default=None,
        description="OpenRouter API key (reads OPENROUTER_API_KEY)",
        validation_alias="OPENROUTER_API_KEY",
    )

    base_url: str = Field(
        default=OPENROUTER_BASE_URL,
        description="OpenRouter base URL (fixed)",
    )

    timeout: int = Field(default=60, description="Internal timeout for LLM calls")
    max_retries: int = Field(default=3, description="Internal max retries")

    @property
    def provider(self) -> str:
        """Human-readable provider label for metadata/logs."""
        return "openrouter"

    @property
    def utility_model(self) -> str:
        """Compatibility alias: utility stage uses the same model."""
        return self.model

    @property
    def synthesis_model(self) -> str:
        """Compatibility alias: synthesis stage uses the same model."""
        return self.model

    @field_validator("base_url")
    def validate_base_url(cls, value: str) -> str:  # noqa: N805
        """Validate and normalize OpenRouter base URL."""
        normalized = value.strip().rstrip("/")
        if normalized != OPENROUTER_BASE_URL:
            raise ValueError(
                f"base_url is fixed to {OPENROUTER_BASE_URL}; received {value!r}"
            )
        return normalized

    def get_provider_configs(self) -> tuple[dict[str, Any], dict[str, Any]]:
        """Return utility/synthesis provider configs.

        Both roles intentionally share the same OpenRouter provider/model.
        """
        base_config: dict[str, Any] = {
            "provider": "openrouter",
            "model": self.model,
            "base_url": OPENROUTER_BASE_URL,
            "timeout": self.timeout,
            "max_retries": self.max_retries,
        }
        if self.api_key:
            base_config["api_key"] = self.api_key.get_secret_value()

        utility_config = base_config.copy()
        synthesis_config = base_config.copy()
        return utility_config, synthesis_config

    def is_provider_configured(self) -> bool:
        """Return True when required OpenRouter auth is available."""
        return self.api_key is not None

    def get_missing_config(self) -> list[str]:
        """List missing required OpenRouter configuration keys."""
        if self.api_key:
            return []
        return ["api_key (set OPENROUTER_API_KEY)"]

    @classmethod
    def add_cli_arguments(cls, parser: argparse.ArgumentParser) -> None:
        """Add LLM-related CLI arguments."""
        parser.add_argument(
            "--llm-model",
            help=(
                "OpenRouter model for deep research (single model for utility and "
                "synthesis)."
            ),
        )

    @classmethod
    def load_from_env(cls) -> dict[str, Any]:
        """Load LLM config from environment variables."""
        config: dict[str, Any] = {}

        if api_key := os.getenv("OPENROUTER_API_KEY"):
            config["api_key"] = api_key
        if model := os.getenv("CHUNKHOUND_LLM_MODEL"):
            config["model"] = model

        return config

    @classmethod
    def extract_cli_overrides(cls, args: Any) -> dict[str, Any]:
        """Extract LLM config overrides from CLI arguments."""
        overrides: dict[str, Any] = {}

        if hasattr(args, "llm_model") and args.llm_model:
            overrides["model"] = args.llm_model

        return overrides

    def __repr__(self) -> str:
        """String representation hiding sensitive information."""
        api_key_display = "***" if self.api_key else None
        return (
            f"LLMConfig("
            f"provider={self.provider}, "
            f"model={self.model}, "
            f"api_key={api_key_display}, "
            f"base_url={self.base_url})"
        )
