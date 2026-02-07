import os
import unittest

from chunkhound.core.config.llm_config import (
    DEFAULT_OPENROUTER_MODEL,
    OPENROUTER_BASE_URL,
    LLMConfig,
)


class LLMConfigOpenRouterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {
            "OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY"),
            "CHUNKHOUND_LLM_MODEL": os.environ.get("CHUNKHOUND_LLM_MODEL"),
            "CHUNKHOUND_LLM_PROVIDER": os.environ.get("CHUNKHOUND_LLM_PROVIDER"),
            "CHUNKHOUND_LLM_UTILITY_MODEL": os.environ.get(
                "CHUNKHOUND_LLM_UTILITY_MODEL"
            ),
        }

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_openrouter_defaults(self) -> None:
        os.environ.pop("OPENROUTER_API_KEY", None)
        os.environ.pop("CHUNKHOUND_LLM_MODEL", None)

        cfg = LLMConfig()
        utility_config, synthesis_config = cfg.get_provider_configs()

        self.assertEqual(cfg.provider, "openrouter")
        self.assertEqual(cfg.model, DEFAULT_OPENROUTER_MODEL)
        self.assertEqual(cfg.base_url, OPENROUTER_BASE_URL)
        self.assertEqual(utility_config["provider"], "openrouter")
        self.assertEqual(synthesis_config["provider"], "openrouter")
        self.assertEqual(utility_config["model"], DEFAULT_OPENROUTER_MODEL)
        self.assertEqual(synthesis_config["model"], DEFAULT_OPENROUTER_MODEL)
        self.assertFalse(cfg.is_provider_configured())

    def test_openrouter_env_model_and_key(self) -> None:
        os.environ["OPENROUTER_API_KEY"] = "sk-or-test"
        os.environ["CHUNKHOUND_LLM_MODEL"] = "anthropic/claude-sonnet-4-5"

        cfg = LLMConfig()
        utility_config, synthesis_config = cfg.get_provider_configs()

        self.assertEqual(cfg.model, "anthropic/claude-sonnet-4-5")
        self.assertTrue(cfg.is_provider_configured())
        self.assertEqual(utility_config["api_key"], "sk-or-test")
        self.assertEqual(synthesis_config["api_key"], "sk-or-test")

    def test_base_url_must_be_openrouter(self) -> None:
        with self.assertRaises(ValueError):
            LLMConfig(base_url="https://api.openai.com/v1")

    def test_load_from_env_reads_only_openrouter_contract(self) -> None:
        os.environ["OPENROUTER_API_KEY"] = "sk-or-test"
        os.environ["CHUNKHOUND_LLM_MODEL"] = "openai/gpt-5-mini"
        os.environ["CHUNKHOUND_LLM_PROVIDER"] = "gemini"
        os.environ["CHUNKHOUND_LLM_UTILITY_MODEL"] = "ignored"

        loaded = LLMConfig.load_from_env()

        self.assertEqual(loaded["api_key"], "sk-or-test")
        self.assertEqual(loaded["model"], "openai/gpt-5-mini")
        self.assertNotIn("provider", loaded)
        self.assertNotIn("utility_model", loaded)


if __name__ == "__main__":
    unittest.main()

