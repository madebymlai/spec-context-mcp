"""OpenRouter-only LLM manager for ChunkHound deep research."""

from typing import Any

from loguru import logger

from chunkhound.core.config.llm_config import OPENROUTER_BASE_URL
from chunkhound.interfaces.llm_provider import LLMProvider
from chunkhound.providers.llm.openai_llm_provider import OpenAILLMProvider


class LLMManager:
    """Manager for OpenRouter-backed providers.

    Utility and synthesis providers are both backed by the same OpenRouter
    integration path.
    """

    _providers: dict[str, type[LLMProvider] | Any] = {
        "openrouter": OpenAILLMProvider,
    }

    def __init__(
        self, utility_config: dict[str, Any], synthesis_config: dict[str, Any]
    ):
        self._utility_config = utility_config
        self._synthesis_config = synthesis_config
        self._utility_provider: LLMProvider | None = None
        self._synthesis_provider: LLMProvider | None = None

        self._initialize_utility_provider()
        self._initialize_synthesis_provider()

    def _create_provider(self, config: dict[str, Any]) -> LLMProvider:
        provider_name = str(config.get("provider", "openrouter")).strip().lower()
        if provider_name != "openrouter":
            raise ValueError(
                "Unsupported LLM provider. Deep research only supports OpenRouter; "
                f"received {provider_name!r}."
            )

        try:
            provider_kwargs = {
                "api_key": config.get("api_key"),
                "model": config.get("model", "google/gemini-2.5-flash"),
                "base_url": config.get("base_url", OPENROUTER_BASE_URL),
                "timeout": config.get("timeout", 60),
                "max_retries": config.get("max_retries", 3),
            }
            return OpenAILLMProvider(**provider_kwargs)
        except Exception as exc:
            logger.error(f"Failed to initialize OpenRouter LLM provider: {exc}")
            raise

    def create_provider_for_config(self, config: dict[str, Any]) -> LLMProvider:
        """Public factory for constructing a provider from a config dict."""
        return self._create_provider(config)

    def _initialize_utility_provider(self) -> None:
        self._utility_provider = self._create_provider(self._utility_config)
        logger.info(
            "Initialized utility LLM provider: openrouter "
            f"with model: {self._utility_provider.model}"
        )

    def _initialize_synthesis_provider(self) -> None:
        self._synthesis_provider = self._create_provider(self._synthesis_config)
        logger.info(
            "Initialized synthesis LLM provider: openrouter "
            f"with model: {self._synthesis_provider.model}"
        )

    def get_utility_provider(self) -> LLMProvider:
        if self._utility_provider is None:
            raise ValueError("Utility LLM provider not configured.")
        return self._utility_provider

    def get_synthesis_provider(self) -> LLMProvider:
        if self._synthesis_provider is None:
            raise ValueError("Synthesis LLM provider not configured.")
        return self._synthesis_provider

    def is_configured(self) -> bool:
        return (
            self._utility_provider is not None and self._synthesis_provider is not None
        )

    def list_providers(self) -> list[str]:
        return ["openrouter"]

    @classmethod
    def register_provider(cls, name: str, provider_class: type[LLMProvider]) -> None:
        del name, provider_class
        raise RuntimeError(
            "Custom LLM providers are disabled. ChunkHound deep research is OpenRouter-only."
        )

    async def health_check(self) -> dict[str, Any]:
        results: dict[str, Any] = {}

        if self._utility_provider:
            results["utility"] = await self._utility_provider.health_check()
        else:
            results["utility"] = {
                "status": "not_configured",
                "message": "Utility provider not configured",
            }

        if self._synthesis_provider:
            results["synthesis"] = await self._synthesis_provider.health_check()
        else:
            results["synthesis"] = {
                "status": "not_configured",
                "message": "Synthesis provider not configured",
            }

        return results

    def get_usage_stats(self) -> dict[str, Any]:
        stats: dict[str, Any] = {}

        if self._utility_provider:
            stats["utility"] = self._utility_provider.get_usage_stats()

        if self._synthesis_provider:
            stats["synthesis"] = self._synthesis_provider.get_usage_stats()

        return stats
