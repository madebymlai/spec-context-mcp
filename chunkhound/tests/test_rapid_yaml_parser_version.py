from chunkhound.parsers.rapid_yaml_parser import _parse_semver


def test_parse_semver_none() -> None:
    assert _parse_semver(None) is None


def test_parse_semver_basic() -> None:
    assert _parse_semver("0.10.0") == (0, 10, 0)


def test_parse_semver_leading_v() -> None:
    assert _parse_semver("v0.10.0") == (0, 10, 0)


def test_parse_semver_pep440_suffix() -> None:
    assert _parse_semver("0.1.0.post60") == (0, 1, 0)


def test_parse_semver_garbage() -> None:
    assert _parse_semver("not-a-version") is None
