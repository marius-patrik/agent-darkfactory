"""Persistence-boundary secret redaction.

This module centralizes the write-boundary filter used before content is
persisted to session logs, memory, dreams, or handoffs.  The filter combines
known materialized secret values with conservative patterns for common secret
shapes.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable, Iterable, Match, Pattern

from agent.state import redaction_secrets_dir

logger = logging.getLogger(__name__)

_REDACTED_PREFIX = "‹REDACTED:"
_REDACTED_SUFFIX = "›"
_KNOWN_VALUE_MIN_LEN = 4
_MAX_DIRECT_TEXT_LEN = 2 * 1024 * 1024
_MAX_REGEX_CHUNK_LEN = 64 * 1024
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_KEY_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-'\"")
_VALUE_STOP_CHARS = set(" \t\r\n;&|`<>")
_SECRET_KEYWORD_RE = re.compile(
    r"(?:api[_-]?key|aws[_-]?secret[_-]?access[_-]?key|accountkey|sharedaccesskey|"
    r"client[_-]?secret|private[_-]?key|access[_-]?key|secret|token|password|passwd|pwd)",
    re.IGNORECASE,
)
_PRIVATE_KEY_BEGIN_RE = re.compile(r"-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----", re.IGNORECASE)
_PRIVATE_KEY_END_RE = re.compile(r"-----END [A-Z0-9 ]{0,64}PRIVATE KEY-----", re.IGNORECASE)


@dataclass(frozen=True)
class Finding:
    """A redaction finding summary.

    Attributes:
        type: The secret type label.
        count: Number of occurrences found for that type.
    """

    type: str
    count: int


@dataclass(frozen=True)
class _PatternRule:
    """Compiled redaction rule."""

    type: str
    pattern: Pattern[str]
    replacement: Callable[[Match[str], str], str] | None = None


def _placeholder(secret_type: str) -> str:
    return f"{_REDACTED_PREFIX}{secret_type}{_REDACTED_SUFFIX}"


def _whole_match(match: Match[str], secret_type: str) -> str:
    return _placeholder(secret_type)


def _url_credential(match: Match[str], secret_type: str) -> str:
    return f"{match.group('prefix')}{_placeholder(secret_type)}{match.group('suffix')}"


def _redact_private_key_blocks(text: str) -> str:
    """Redact complete or truncated private-key PEM blocks in linear time."""
    start = _PRIVATE_KEY_BEGIN_RE.search(text)
    if start is None:
        return text

    pieces: list[str] = []
    cursor = 0
    while start is not None:
        pieces.append(text[cursor : start.start()])
        end = _PRIVATE_KEY_END_RE.search(text, start.end())
        pieces.append(_placeholder("private-key"))
        if end is None:
            cursor = len(text)
            break
        cursor = end.end()
        start = _PRIVATE_KEY_BEGIN_RE.search(text, cursor)
    pieces.append(text[cursor:])
    return "".join(pieces)


def _is_secret_key(key: str) -> bool:
    normalized = key.strip().strip("'\"")
    return bool(_SECRET_KEYWORD_RE.search(normalized))


def _is_mixed_secret_literal(value: str) -> bool:
    return (
        len(value) >= 16
        and any(char.islower() for char in value)
        and any(char.isupper() for char in value)
        and any(char.isdigit() for char in value)
    )


def _redact_assignment_line(line: str) -> str:
    chars = list(line)
    index = 0
    while index < len(chars):
        if chars[index] not in ":=":
            index += 1
            continue

        key_end = index
        while key_end > 0 and chars[key_end - 1].isspace():
            key_end -= 1
        key_start = key_end
        while key_start > 0 and chars[key_start - 1] in _KEY_CHARS:
            key_start -= 1
        key = "".join(chars[key_start:key_end])
        if not _is_secret_key(key):
            index += 1
            continue

        value_start = index + 1
        while value_start < len(chars) and chars[value_start] in " \t":
            value_start += 1
        if value_start >= len(chars) or "".join(chars[value_start:]).startswith(_REDACTED_PREFIX):
            index += 1
            continue

        quote = chars[value_start] if chars[value_start] in "'\"" else ""
        if quote:
            secret_start = value_start + 1
            value_end = secret_start
            limit = min(len(chars), secret_start + 4096)
            while value_end < limit and chars[value_end] != quote and chars[value_end] not in "\r\n":
                value_end += 1
            if value_end >= len(chars) or chars[value_end] != quote or value_end - secret_start < 4:
                index += 1
                continue
            chars[secret_start:value_end] = list(_placeholder("assignment"))
            index = secret_start + len(_placeholder("assignment")) + 1
            continue

        value_end = value_start
        limit = min(len(chars), value_start + 4096)
        while value_end < limit and chars[value_end] not in _VALUE_STOP_CHARS:
            value_end += 1
        value = "".join(chars[value_start:value_end])
        if len(value) >= 4 and (
            not _IDENTIFIER_RE.fullmatch(value) or _is_mixed_secret_literal(value)
        ):
            chars[value_start:value_end] = list(_placeholder("assignment"))
            index = value_start + len(_placeholder("assignment"))
            continue
        index += 1
    return "".join(chars)


def _redact_assignments(text: str) -> str:
    return "".join(_redact_assignment_line(line) for line in text.splitlines(keepends=True))


_DEFAULT_PATTERN_SPECS: tuple[tuple[str, str, int, Callable[[Match[str], str], str] | None], ...] = (
    ("anthropic-key", r"sk-ant-[A-Za-z0-9_-]{16,}", 0, None),
    ("openai-key", r"sk-(proj-)?[A-Za-z0-9_-]{16,}", 0, None),
    ("github-token", r"gh[pousr]_[A-Za-z0-9]{36}", 0, None),
    ("github-token", r"github_pat_[A-Za-z0-9_]{22,}", 0, None),
    ("google-api-key", r"AIza[0-9A-Za-z_-]{35}", 0, None),
    ("google-oauth-token", r"ya29\.[0-9A-Za-z_-]+", 0, None),
    ("aws-access-key-id", r"AKIA[0-9A-Z]{16}", 0, None),
    ("slack-token", r"(?:xox[baprs]|xapp|xoxe)-[0-9A-Za-z-]{10,}", 0, None),
    ("jwt", r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", 0, None),
    (
        "private-key",
        r"-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z0-9 ]{0,64}PRIVATE KEY-----",
        re.IGNORECASE,
        None,
    ),
    ("bearer-token", r"[Bb]earer\s+[A-Za-z0-9._+/=-]{16,}", 0, None),
    (
        "url-credential",
        r"(?P<prefix>[A-Za-z][A-Za-z0-9+.-]{0,63}://[^/\s:@]{1,255}:)"
        r"(?P<password>[^@\s]{1,1024})(?P<suffix>@(?=[^@\s/:]{1,255}(?::\d{1,5})?(?:[/?#\s]|$)))",
        0,
        _url_credential,
    ),
)


class Redactor:
    """Redact secrets from text and JSON-like structures.

    Exact known values are the primary defense and are scrubbed before shape
    patterns regardless of ``min_value_len``.  Only blank values and values
    shorter than four characters are skipped to avoid pathological single-
    character or token-wide redaction.
    """

    def __init__(
        self,
        secret_values: Iterable[str] | None = None,
        *,
        min_value_len: int = 8,
        extra_patterns: list[tuple[str, str]] | None = None,
    ) -> None:
        """Initialize the redactor.

        Args:
            secret_values: Exact secret values to redact before pattern rules.
            min_value_len: Retained constructor parameter; exact-value
                redaction uses the fixed four-character floor documented above.
            extra_patterns: Additional ``(type, regex)`` whole-match rules.
        """
        self._min_value_len = min_value_len
        values = secret_values or ()
        self._secret_values = tuple(
            sorted(
                {
                    value
                    for value in values
                    if value.strip() and len(value) >= _KNOWN_VALUE_MIN_LEN
                },
                key=len,
                reverse=True,
            )
        )
        self._rules = self._compile_rules(extra_patterns or [])

    @classmethod
    def from_secrets_dir(cls, **kw: Any) -> "Redactor":
        """Create a redactor from materialized secret files.

        Args:
            **kw: Additional ``Redactor`` initializer arguments.

        Returns:
            A redactor populated with every readable regular file's stripped
            contents. Missing or unreadable directories produce an empty
            known-value set while pattern redaction remains active.
        """
        path = redaction_secrets_dir()
        values: list[str] = []
        try:
            candidates = path.rglob("*")
        except OSError:
            logger.debug("Unable to inspect materialized secrets directory.")
            return cls(values, **kw)

        try:
            for candidate in candidates:
                try:
                    if candidate.is_file():
                        value = candidate.read_text(encoding="utf-8").strip()
                        if value:
                            values.append(value)
                except OSError:
                    logger.debug("Unable to read one materialized secret file.")
        except OSError:
            logger.debug("Unable to enumerate materialized secrets directory.")
        return cls(values, **kw)

    def redact(self, text: str) -> str:
        """Redact secrets from text.

        Args:
            text: Input text.

        Returns:
            Text with known values and recognized secret patterns replaced.
        """
        redacted = text
        for value in self._secret_values:
            redacted = redacted.replace(value, _placeholder("known-value"))
        redacted = _redact_private_key_blocks(redacted)
        redacted = _redact_assignments(redacted)
        if len(redacted) > _MAX_DIRECT_TEXT_LEN:
            return "".join(
                self._redact_patterns(redacted[index : index + _MAX_REGEX_CHUNK_LEN])
                for index in range(0, len(redacted), _MAX_REGEX_CHUNK_LEN)
            )
        return self._redact_patterns(redacted)

    def _redact_patterns(self, text: str) -> str:
        redacted = text
        for rule in self._rules:
            replacement = rule.replacement or _whole_match
            def replace_match(match: re.Match[str]) -> str:
                return replacement(match, rule.type)

            redacted = rule.pattern.sub(replace_match, redacted)
        return redacted

    def redact_obj(self, obj: Any, *, _force: bool = False) -> Any:
        """Recursively redact strings in a JSON-like object.

        A value under a secret-named dict key (e.g. "aws_secret_access_key",
        "password", "token") is masked regardless of its shape — a bare token in a
        structured payload has no inline ``key=value`` text for the assignment rule to
        catch. Secrecy propagates through nested containers (so a list/dict of bare
        tokens under a secret key is fully masked). Known materialized values are always
        scrubbed by value; truly bare unknown secrets in unkeyed prose rely on
        known-value scrubbing — a documented residual.

        Args:
            obj: A string, bytes, bytearray, dict, list, tuple, set, frozenset, or scalar.
            _force: Internal. When True, every string/bytes leaf is masked wholesale —
                used to propagate secrecy from a secret-named dict key into its value,
                however deeply nested.

        Returns:
            A structure with the same shape and redacted string leaves. Dict keys that
            are strings are also redacted.
        """
        if isinstance(obj, str):
            if _force:
                return _placeholder("keyed-secret") if obj else obj
            return self.redact(obj)
        if isinstance(obj, bytes):
            if _force:
                return _placeholder("keyed-secret").encode("utf-8") if obj else obj
            return self.redact(obj.decode("latin-1")).encode("utf-8")
        if isinstance(obj, bytearray):
            if _force:
                return bytearray(_placeholder("keyed-secret").encode("utf-8")) if obj else obj
            return bytearray(self.redact(bytes(obj).decode("latin-1")).encode("utf-8"))
        if isinstance(obj, dict):
            result: dict[Any, Any] = {}
            for key, value in obj.items():
                red_key = self.redact(key) if isinstance(key, str) else key
                child_force = _force or (isinstance(key, str) and _is_secret_key(key))
                result[red_key] = self.redact_obj(value, _force=child_force)
            return result
        if isinstance(obj, list):
            return [self.redact_obj(value, _force=_force) for value in obj]
        if isinstance(obj, tuple):
            return tuple(self.redact_obj(value, _force=_force) for value in obj)
        if isinstance(obj, set):
            return {self.redact_obj(value, _force=_force) for value in obj}
        if isinstance(obj, frozenset):
            return frozenset(self.redact_obj(value, _force=_force) for value in obj)
        return obj

    def findings(self, text: str) -> list[Finding]:
        """Find secret occurrences without exposing values.

        Args:
            text: Input text.

        Returns:
            Finding summaries containing only type labels and counts.
        """
        counts: dict[str, int] = {}
        scan_text = text
        for value in self._secret_values:
            count = scan_text.count(value)
            if count:
                counts["known-value"] = counts.get("known-value", 0) + count
                scan_text = scan_text.replace(value, _placeholder("known-value"))
        scan_text = _redact_private_key_blocks(scan_text)
        for rule in self._rules:
            matches = list(rule.pattern.finditer(scan_text))
            if matches:
                counts[rule.type] = counts.get(rule.type, 0) + len(matches)
                replacement = rule.replacement or _whole_match
                def replace_match(match: re.Match[str]) -> str:
                    return replacement(match, rule.type)

                scan_text = rule.pattern.sub(replace_match, scan_text)
        return [Finding(type=secret_type, count=count) for secret_type, count in counts.items()]

    def _compile_rules(self, extra_patterns: list[tuple[str, str]]) -> tuple[_PatternRule, ...]:
        rules = [
            _PatternRule(
                type=secret_type,
                pattern=re.compile(pattern, flags),
                replacement=replacement,
            )
            for secret_type, pattern, flags, replacement in _DEFAULT_PATTERN_SPECS
        ]
        rules.extend(
            _PatternRule(type=secret_type, pattern=re.compile(pattern), replacement=None)
            for secret_type, pattern in extra_patterns
        )
        return tuple(rules)


@lru_cache(maxsize=1)
def default_redactor() -> Redactor:
    """Return the process-wide default redactor.

    Returns:
        A lazily-created redactor loaded from the default secrets directory.
    """
    return Redactor.from_secrets_dir()


def redact(text: str) -> str:
    """Redact text using the default redactor."""
    return default_redactor().redact(text)


def redact_obj(obj: Any) -> Any:
    """Redact a JSON-like object using the default redactor."""
    return default_redactor().redact_obj(obj)


def findings(text: str) -> list[Finding]:
    """Return default-redactor findings for text."""
    return default_redactor().findings(text)
