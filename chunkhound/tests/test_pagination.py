"""Tests for pagination logic across the search system."""

import json
import pytest

from chunkhound.mcp_server.tools import (
    PaginationInfo,
    SearchResponse,
    estimate_tokens,
    limit_response_size,
)


class TestEstimateTokens:
    """Tests for token estimation."""

    def test_empty_string(self):
        assert estimate_tokens("") == 0

    def test_short_string(self):
        # 9 chars / 3 = 3 tokens
        assert estimate_tokens("123456789") == 3

    def test_longer_string(self):
        # 300 chars / 3 = 100 tokens
        assert estimate_tokens("x" * 300) == 100


class TestPaginationCalculation:
    """Tests for pagination metadata calculation logic."""

    def _calc_pagination(
        self, offset: int, page_size: int, total: int
    ) -> PaginationInfo:
        """Helper to calculate pagination like the providers do."""
        return {
            "offset": offset,
            "page_size": page_size,
            "has_more": offset + page_size < total,
            "next_offset": offset + page_size if offset + page_size < total else None,
            "total": total,
        }

    def test_first_page_with_more(self):
        pag = self._calc_pagination(offset=0, page_size=10, total=25)
        assert pag["has_more"] is True
        assert pag["next_offset"] == 10

    def test_middle_page(self):
        pag = self._calc_pagination(offset=10, page_size=10, total=25)
        assert pag["has_more"] is True
        assert pag["next_offset"] == 20

    def test_last_page_partial(self):
        pag = self._calc_pagination(offset=20, page_size=10, total=25)
        assert pag["has_more"] is False
        assert pag["next_offset"] is None

    def test_exactly_one_page(self):
        pag = self._calc_pagination(offset=0, page_size=10, total=10)
        assert pag["has_more"] is False
        assert pag["next_offset"] is None

    def test_less_than_page_size(self):
        pag = self._calc_pagination(offset=0, page_size=10, total=5)
        assert pag["has_more"] is False
        assert pag["next_offset"] is None

    def test_no_results(self):
        pag = self._calc_pagination(offset=0, page_size=10, total=0)
        assert pag["has_more"] is False
        assert pag["next_offset"] is None

    def test_exact_boundary(self):
        # offset + page_size == total, so no more results
        pag = self._calc_pagination(offset=90, page_size=10, total=100)
        assert pag["has_more"] is False
        assert pag["next_offset"] is None

    def test_large_offset(self):
        pag = self._calc_pagination(offset=1000, page_size=10, total=500)
        assert pag["has_more"] is False
        assert pag["next_offset"] is None


class TestLimitResponseSize:
    """Tests for response size limiting with pagination updates."""

    def test_empty_results_unchanged(self):
        response: SearchResponse = {
            "results": [],
            "pagination": {
                "offset": 0,
                "page_size": 0,
                "has_more": False,
            },
        }
        result = limit_response_size(response)
        assert result["results"] == []
        assert result["pagination"]["has_more"] is False

    def test_small_response_unchanged(self):
        response: SearchResponse = {
            "results": [{"content": "small result"}],
            "pagination": {
                "offset": 0,
                "page_size": 1,
                "has_more": False,
            },
        }
        result = limit_response_size(response)
        assert len(result["results"]) == 1
        assert result["pagination"]["page_size"] == 1

    def test_response_within_limit(self):
        response: SearchResponse = {
            "results": [{"content": f"result {i}"} for i in range(10)],
            "pagination": {
                "offset": 0,
                "page_size": 10,
                "has_more": True,
                "next_offset": 10,
                "total": 25,
            },
        }
        result = limit_response_size(response, max_tokens=20000)
        assert len(result["results"]) == 10
        assert result["pagination"]["has_more"] is True

    def test_truncation_updates_has_more(self):
        # Large results that need truncation
        large_results = [{"content": "x" * 1000} for _ in range(100)]
        response: SearchResponse = {
            "results": large_results,
            "pagination": {
                "offset": 0,
                "page_size": 100,
                "has_more": False,  # Originally no more
                "total": 100,
            },
        }
        # Force truncation with low token limit
        result = limit_response_size(response, max_tokens=5000)

        assert len(result["results"]) < 100
        # has_more should now be True since we truncated
        assert result["pagination"]["has_more"] is True

    def test_truncation_updates_next_offset(self):
        large_results = [{"content": "x" * 500} for _ in range(50)]
        response: SearchResponse = {
            "results": large_results,
            "pagination": {
                "offset": 10,
                "page_size": 50,
                "has_more": False,
                "next_offset": None,
                "total": 60,
            },
        }
        result = limit_response_size(response, max_tokens=3000)

        if len(result["results"]) < 50:
            # next_offset should be offset + actual count
            expected_next = 10 + len(result["results"])
            assert result["pagination"]["next_offset"] == expected_next

    def test_truncation_updates_page_size(self):
        large_results = [{"content": "x" * 1000} for _ in range(100)]
        response: SearchResponse = {
            "results": large_results,
            "pagination": {
                "offset": 0,
                "page_size": 100,
                "has_more": False,
                "total": 100,
            },
        }
        result = limit_response_size(response, max_tokens=5000)

        # page_size should reflect actual returned count
        assert result["pagination"]["page_size"] == len(result["results"])

    def test_preserves_original_has_more_when_not_truncated(self):
        response: SearchResponse = {
            "results": [{"content": "small"}],
            "pagination": {
                "offset": 0,
                "page_size": 1,
                "has_more": True,  # More results exist
                "next_offset": 1,
            },
        }
        result = limit_response_size(response)
        assert result["pagination"]["has_more"] is True
        assert result["pagination"]["next_offset"] == 1


class TestParameterValidation:
    """Tests for search parameter validation."""

    def _validate_params(self, page_size: int, offset: int) -> tuple[int, int]:
        """Simulate the validation logic from tools.py."""
        page_size = max(1, min(page_size, 100))
        offset = max(0, offset)
        return page_size, offset

    def test_normal_values(self):
        ps, off = self._validate_params(10, 0)
        assert ps == 10
        assert off == 0

    def test_page_size_zero_becomes_one(self):
        ps, _ = self._validate_params(0, 0)
        assert ps == 1

    def test_negative_page_size_becomes_one(self):
        ps, _ = self._validate_params(-5, 0)
        assert ps == 1

    def test_page_size_over_100_capped(self):
        ps, _ = self._validate_params(150, 0)
        assert ps == 100

    def test_page_size_at_max(self):
        ps, _ = self._validate_params(100, 0)
        assert ps == 100

    def test_page_size_at_min(self):
        ps, _ = self._validate_params(1, 0)
        assert ps == 1

    def test_negative_offset_becomes_zero(self):
        _, off = self._validate_params(10, -10)
        assert off == 0

    def test_large_offset_allowed(self):
        _, off = self._validate_params(10, 10000)
        assert off == 10000


class TestMultiHopPagination:
    """Tests for multi-hop strategy pagination slicing."""

    def _apply_pagination(
        self, all_results: list, offset: int, page_size: int
    ) -> tuple[list, dict]:
        """Simulate multi-hop pagination logic."""
        total_results = len(all_results)
        paginated_results = all_results[offset : offset + page_size]

        pagination = {
            "offset": offset,
            "page_size": page_size,
            "has_more": offset + page_size < total_results,
            "next_offset": offset + page_size
            if offset + page_size < total_results
            else None,
            "total": total_results,
        }

        return paginated_results, pagination

    def test_first_page(self):
        results = [{"id": i} for i in range(100)]
        paginated, pag = self._apply_pagination(results, offset=0, page_size=10)

        assert len(paginated) == 10
        assert paginated[0]["id"] == 0
        assert pag["has_more"] is True
        assert pag["next_offset"] == 10
        assert pag["total"] == 100

    def test_middle_page(self):
        results = [{"id": i} for i in range(100)]
        paginated, pag = self._apply_pagination(results, offset=50, page_size=10)

        assert len(paginated) == 10
        assert paginated[0]["id"] == 50
        assert pag["has_more"] is True
        assert pag["next_offset"] == 60

    def test_last_page_partial(self):
        results = [{"id": i} for i in range(100)]
        paginated, pag = self._apply_pagination(results, offset=95, page_size=10)

        assert len(paginated) == 5
        assert paginated[0]["id"] == 95
        assert pag["has_more"] is False
        assert pag["next_offset"] is None

    def test_exact_boundary(self):
        results = [{"id": i} for i in range(100)]
        paginated, pag = self._apply_pagination(results, offset=90, page_size=10)

        assert len(paginated) == 10
        assert pag["has_more"] is False
        assert pag["next_offset"] is None

    def test_offset_beyond_results(self):
        results = [{"id": i} for i in range(100)]
        paginated, pag = self._apply_pagination(results, offset=150, page_size=10)

        assert len(paginated) == 0
        assert pag["has_more"] is False
        assert pag["next_offset"] is None

    def test_empty_results(self):
        paginated, pag = self._apply_pagination([], offset=0, page_size=10)

        assert len(paginated) == 0
        assert pag["has_more"] is False
        assert pag["total"] == 0
