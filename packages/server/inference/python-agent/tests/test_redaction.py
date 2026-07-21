"""Tests for persistence-boundary secret redaction."""

from __future__ import annotations

import logging
import time
from pathlib import Path

from agent.redaction import Redactor

KNOWN_VALUE = "known-materialized-secret-value"
SHORT_VALUE = "1234"
ANTHROPIC = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE"
OPENAI = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKE"
GITHUB = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE"
GITHUB_PAT = "github_pat_FAKEFAKEFAKEFAKEFAKEFAKE"
GOOGLE_API = "AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK"
GOOGLE_OAUTH = "ya29.FAKEFAKEFAKEFAKEFAKE"
AWS_ACCESS_KEY = "AKIAFAKEFAKEFAKEFAKE"
AWS_SECRET = "".join(("fakefakefakefakefake", "fakefakefakefake123+"))
AWS_SECRET_MIXED = "".join(("AbCdEfGhIjKlMnOpQrSt", "UvWxYz1234567890ABCD"))
AZURE_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGhIjKl=="
SLACK = "xoxb-FAKEFAKEFAKEFAKE"
JWT = "eyJFAKEFAKE.eyJFAKEFAKE.FAKEFAKE"
PRIVATE_KEY = """-----BEGIN PRIVATE KEY-----
FAKEFAKEFAKEFAKE
-----END PRIVATE KEY-----"""
BEARER_VALUE = "FAKEFAKEFAKEFAKEFAKE"
BEARER = f"Bearer {BEARER_VALUE}"
URL_PASSWORD = "urlpasswordFAKE"
URL_CREDENTIAL = f"postgres://user:{URL_PASSWORD}@localhost/db"
ASSIGNMENT_VALUE = "assignment-secret-value"
ASSIGNMENT = f'api_key="{ASSIGNMENT_VALUE}"'


def test_planted_secrets_redact_text_and_nested_object(tmp_path):
    secrets_root = tmp_path / ".agents" / "secrets"
    credentials = secrets_root / "credentials"
    credentials.mkdir(parents=True)
    (credentials / "known").write_text(KNOWN_VALUE, encoding="utf-8")
    redactor = Redactor.from_secrets_dir()
    planted = [
        KNOWN_VALUE,
        ANTHROPIC,
        OPENAI,
        GITHUB,
        GITHUB_PAT,
        GOOGLE_API,
        GOOGLE_OAUTH,
        AWS_ACCESS_KEY,
        AWS_SECRET,
        SLACK,
        JWT,
        PRIVATE_KEY,
        BEARER,
        URL_PASSWORD,
        ASSIGNMENT_VALUE,
    ]
    text = "\n".join(
        [
            f"known {KNOWN_VALUE}",
            f"anthropic {ANTHROPIC}",
            f"openai {OPENAI}",
            f"github {GITHUB}",
            f"github pat {GITHUB_PAT}",
            f"google api {GOOGLE_API}",
            f"google oauth {GOOGLE_OAUTH}",
            f"aws id {AWS_ACCESS_KEY}",
            f"secret = {AWS_SECRET}",
            f"slack {SLACK}",
            f"jwt {JWT}",
            PRIVATE_KEY,
            f"auth {BEARER}",
            URL_CREDENTIAL,
            ASSIGNMENT,
        ]
    )

    redacted = redactor.redact(text)

    for secret in planted:
        assert secret not in redacted
    assert "‹REDACTED:" in redacted
    assert "postgres://user:‹REDACTED:url-credential›@localhost/db" in redacted
    assert 'api_key="‹REDACTED:assignment›"' in redacted

    obj = {
        "secret-key": KNOWN_VALUE,
        "items": [ANTHROPIC, {"token": BEARER, GITHUB: "secret"}],
        "tuple": (URL_CREDENTIAL, ASSIGNMENT, 7, None),
    }
    redacted_obj = redactor.redact_obj(obj)
    assert set(redacted_obj.keys()) == {"secret-key", "items", "tuple"}
    assert len(redacted_obj["items"]) == 2
    assert redacted_obj["tuple"][2:] == (7, None)
    rendered = repr(redacted_obj)
    for secret in planted:
        assert secret not in rendered
    assert "‹REDACTED:" in rendered


def test_known_values_from_secrets_dir_and_min_length(tmp_path):
    credentials = tmp_path / ".agents" / "secrets" / "credentials"
    credentials.mkdir(parents=True)
    (credentials / "long").write_text(KNOWN_VALUE, encoding="utf-8")
    (credentials / "short").write_text(SHORT_VALUE, encoding="utf-8")

    redactor = Redactor.from_secrets_dir()

    redacted = redactor.redact(f"{KNOWN_VALUE} and {SHORT_VALUE}")
    assert KNOWN_VALUE not in redacted
    assert SHORT_VALUE not in redacted


def test_known_values_skip_blank_and_tiny_values():
    redactor = Redactor(secret_values=["", "   ", "abc", SHORT_VALUE], min_value_len=99)

    redacted = redactor.redact(f"abc {SHORT_VALUE}")

    assert redacted == "abc ‹REDACTED:known-value›"


def test_structured_redaction_preserves_shape_and_scalars():
    redactor = Redactor(secret_values=[KNOWN_VALUE])
    original = {
        "safe": ["plain", 3, None],
        "nested": {"token": GITHUB},
        ANTHROPIC: "key was secret-shaped",
    }

    redacted = redactor.redact_obj(original)

    assert redacted["safe"] == ["plain", 3, None]
    # "token" is a secret-named key, so the whole value is masked by key-context
    # (keyed-secret) rather than only the github-token span — and GITHUB never survives.
    assert redacted["nested"]["token"] == "‹REDACTED:keyed-secret›"
    assert GITHUB not in repr(redacted)
    assert "‹REDACTED:anthropic-key›" in redacted


def test_structured_redaction_handles_sets_and_bytes():
    redactor = Redactor(secret_values=[KNOWN_VALUE])
    original = {
        "set": {KNOWN_VALUE, "plain"},
        "frozenset": frozenset({ANTHROPIC, "safe"}),
        "bytes": f"before {KNOWN_VALUE} after".encode("latin-1"),
        "bytearray": bytearray(f"before {KNOWN_VALUE} after", "latin-1"),
        "nested": [{"inner": {f"token={KNOWN_VALUE}"}}],
    }

    redacted = redactor.redact_obj(original)

    assert isinstance(redacted["set"], set)
    assert isinstance(redacted["frozenset"], frozenset)
    assert isinstance(redacted["bytes"], bytes)
    assert isinstance(redacted["bytearray"], bytearray)
    rendered = repr(redacted)
    assert KNOWN_VALUE not in rendered
    assert ANTHROPIC not in rendered
    assert "‹REDACTED:" in rendered


def test_redact_obj_uses_key_context_for_unkeyed_values():
    # A dict value whose KEY names a secret must be redacted regardless of the value's
    # own shape — the structured-payload analogue of inline `key=value` text. Without
    # this, a bare token (e.g. an AWS secret) under "aws_secret_access_key" loses its
    # key context when redact_obj walks each leaf independently, and survives.
    redactor = Redactor()  # no known values: exercise pure key-context redaction
    obj = {
        "aws_secret_access_key": AWS_SECRET_MIXED,
        "AccountKey": AZURE_KEY,
        "password": "hunter2-long-enough-value",
        "api_token": "opaque-bare-token-value-1234",
        "creds": {"client_secret": b"bytes-secret-value-here"},
        # secret-named key whose value is a CONTAINER of bare tokens: secrecy must
        # propagate through the list/nested structure to every leaf.
        "api_keys": ["bare-list-token-aaaa", "bare-list-token-bbbb"],
        "secrets": {"deep": ["nested-bare-token-cccc"]},
        # benign keys must NOT be over-redacted
        "name": "Alice",
        "FOO": "SOME_IDENTIFIER",
        "count": 7,
    }
    red = redactor.redact_obj(obj)
    rendered = repr(red)
    for leaked in (
        AWS_SECRET_MIXED,
        AZURE_KEY,
        "hunter2-long-enough-value",
        "opaque-bare-token-value-1234",
        "bytes-secret-value-here",
        "bare-list-token-aaaa",
        "bare-list-token-bbbb",
        "nested-bare-token-cccc",
    ):
        assert leaked not in rendered, leaked
    assert "‹REDACTED:" in rendered
    assert red["name"] == "Alice"
    assert red["FOO"] == "SOME_IDENTIFIER"
    assert red["count"] == 7


def test_aws_and_azure_keys_redact_by_known_value_and_context(tmp_path):
    credentials = tmp_path / ".agents" / "secrets" / "credentials"
    credentials.mkdir(parents=True)
    (credentials / "aws").write_text(AWS_SECRET_MIXED, encoding="utf-8")
    (credentials / "azure").write_text(AZURE_KEY, encoding="utf-8")
    redactor = Redactor.from_secrets_dir()

    known_redacted = redactor.redact(f"{AWS_SECRET_MIXED} {AZURE_KEY}")
    assert AWS_SECRET_MIXED not in known_redacted
    assert AZURE_KEY not in known_redacted

    context_text = "\n".join(
        [
            f"aws_secret_access_key={AWS_SECRET_MIXED}",
            f'{{"aws_secret_access_key": "{AWS_SECRET_MIXED}"}}',
            f"AccountKey={AZURE_KEY};EndpointSuffix=core.windows.net",
            f"SharedAccessKey={AZURE_KEY}",
            "client_secret = abc.def.ghi",
            'private_key = "line one with spaces line two"',
        ]
    )
    context_redacted = Redactor().redact(context_text)
    assert AWS_SECRET_MIXED not in context_redacted
    assert AZURE_KEY not in context_redacted
    assert "abc.def.ghi" not in context_redacted
    assert "line one with spaces line two" not in context_redacted


def test_charset_gaps_for_url_bearer_and_assignments():
    redactor = Redactor()
    url = "postgres://user:p/a/s/s@localhost/db"
    bearer = "Bearer abcDEF123+/=abcDEF123+/="
    dotted_assignment = "token=abc.def.ghi"
    quoted_spaces = 'password="correct horse battery staple"'

    redacted = redactor.redact("\n".join([url, bearer, dotted_assignment, quoted_spaces]))

    assert "p/a/s/s" not in redacted
    assert "abcDEF123+/=abcDEF123+/=" not in redacted
    assert "abc.def.ghi" not in redacted
    assert "correct horse battery staple" not in redacted
    assert "postgres://user:‹REDACTED:url-credential›@localhost/db" in redacted


def test_truncated_and_lowercase_private_key_redact():
    truncated = "-----BEGIN RSA PRIVATE KEY-----" + ("A" * 1000)
    lowercase = "-----begin private key-----\nsecret-body\n-----end private key-----"

    redacted = Redactor().redact(f"{truncated}\n{lowercase}")

    assert "secret-body" not in redacted
    assert "A" * 100 not in redacted
    assert redacted.count("‹REDACTED:private-key›") == 1


def test_more_slack_token_prefixes_redact():
    redacted = Redactor().redact("xapp-FAKEFAKEFAKEFAKE xoxe-FAKEFAKEFAKEFAKE")

    assert "xapp-FAKE" not in redacted
    assert "xoxe-FAKE" not in redacted


def test_redaction_idempotent_clean_text_and_low_false_positive():
    redactor = Redactor(secret_values=[KNOWN_VALUE])
    secret_text = f"token={KNOWN_VALUE} {GITHUB}"
    clean_text = (
        "This ordinary prose mentions tokens as a concept. "
        "def configure(password: str | None = None) -> None: pass"
    )

    assert redactor.redact(redactor.redact(secret_text)) == redactor.redact(secret_text)
    assert redactor.redact(clean_text) == clean_text


def test_over_redaction_guards():
    redactor = Redactor()
    git_sha = "0123456789abcdef0123456789abcdef01234567"
    uuid = "123e4567-e89b-12d3-a456-426614174000"
    data_uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
    identifier_assignment = "FOO = SOME_IDENTIFIER"
    worker_source = Path("agent/loop/turn.py").read_text(encoding="utf-8")

    assert redactor.redact(git_sha) == git_sha
    assert redactor.redact(uuid) == uuid
    assert redactor.redact(data_uri) == data_uri
    assert redactor.redact(identifier_assignment) == identifier_assignment
    assert redactor.redact(worker_source) == worker_source


def test_redaction_perf_guards():
    redactor = Redactor()
    samples = [
        "-----BEGIN RSA PRIVATE KEY-----" + ("A" * 1_000_000),
        "x" * 200_000,
        "A" * (1024 * 1024),
    ]

    for sample in samples:
        started = time.perf_counter()
        redactor.redact(sample)
        elapsed = time.perf_counter() - started
        assert elapsed < 2.0


def test_missing_secrets_dir_never_raises_and_logs_no_values(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)

    redactor = Redactor.from_secrets_dir()
    redacted = redactor.redact(f"safe {ANTHROPIC}")

    assert ANTHROPIC not in redacted
    assert KNOWN_VALUE not in caplog.text


def test_findings_carry_type_and_count_only():
    redactor = Redactor(secret_values=[KNOWN_VALUE])

    found = redactor.findings(f"{KNOWN_VALUE} {GITHUB} {GITHUB}")

    assert {finding.type: finding.count for finding in found} == {
        "known-value": 1,
        "github-token": 2,
    }
    assert KNOWN_VALUE not in repr(found)
    assert GITHUB not in repr(found)
