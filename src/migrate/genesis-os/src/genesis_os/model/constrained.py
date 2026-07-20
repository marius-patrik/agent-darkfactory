from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import torch
from jsonschema import Draft202012Validator
from torch import Tensor

from genesis_os.model.network import GenesisNetwork
from genesis_os.model.tokenizer import ByteTokenizer


@dataclass(slots=True)
class DecoderState:
    cache: list[tuple[Tensor, Tensor]]
    logits: Tensor
    pooled: Tensor
    world_mean: Tensor
    generated: list[int]


class IncrementalByteDecoder:
    """KV-cached byte decoder used by the JSON-schema action grammar."""

    def __init__(
        self,
        *,
        model: GenesisNetwork,
        tokenizer: ByteTokenizer,
        prompt: str,
        memory: Tensor,
        world_state: Tensor,
        max_new_tokens: int,
        device: torch.device,
    ) -> None:
        self.model = model
        self.tokenizer = tokenizer
        self.memory = memory
        self.world_state = world_state
        self.device = device
        self.max_new_tokens = max_new_tokens
        prompt_budget = max(1, model.genome.max_sequence_length - max_new_tokens)
        prompt_ids = tokenizer.encode(prompt, bos=True)[-prompt_budget:]
        input_ids = torch.tensor([prompt_ids], dtype=torch.long, device=device)
        output = model(
            input_ids,
            memory_state=memory,
            world_state=world_state,
            use_cache=True,
        )
        if output.past_key_values is None:
            raise RuntimeError("Model did not return a KV cache")
        self.state = DecoderState(
            cache=output.past_key_values,
            logits=output.logits[:, -1],
            pooled=output.pooled,
            world_mean=output.world_mean,
            generated=[],
        )

    @property
    def remaining(self) -> int:
        return self.max_new_tokens - len(self.state.generated)

    def emit_byte(self, value: int) -> None:
        if self.remaining <= 0:
            raise RuntimeError("Constrained action exceeded generation budget")
        token_id = self.tokenizer.BYTE_OFFSET + value
        token = torch.tensor([[token_id]], dtype=torch.long, device=self.device)
        output = self.model(
            token,
            memory_state=self.memory,
            world_state=self.world_state,
            past_key_values=self.state.cache,
            use_cache=True,
        )
        if output.past_key_values is None:
            raise RuntimeError("Model did not return a KV cache")
        self.state.cache = output.past_key_values
        self.state.logits = output.logits[:, -1]
        self.state.pooled = output.pooled
        self.state.world_mean = output.world_mean
        self.state.generated.append(token_id)

    def emit_text(self, value: str) -> None:
        for byte in value.encode("utf-8"):
            self.emit_byte(byte)

    def choose_byte(self, allowed: set[int]) -> int:
        if not allowed:
            raise ValueError("Grammar supplied no allowed bytes")
        token_ids = torch.tensor(
            [self.tokenizer.BYTE_OFFSET + value for value in sorted(allowed)],
            dtype=torch.long,
            device=self.device,
        )
        scores = self.state.logits[0].index_select(0, token_ids)
        selected = int(torch.argmax(scores).item())
        value = sorted(allowed)[selected]
        self.emit_byte(value)
        return value

    def emit_trie_choice(self, values: list[bytes]) -> bytes:
        if not values:
            raise ValueError("Cannot choose from an empty value set")
        active = list(dict.fromkeys(values))
        prefix = b""
        while True:
            complete = [value for value in active if len(value) == len(prefix)]
            if complete:
                return prefix
            allowed = {value[len(prefix)] for value in active if len(value) > len(prefix)}
            selected = self.choose_byte(allowed)
            prefix += bytes([selected])
            active = [value for value in active if value.startswith(prefix)]
            if not active:
                raise RuntimeError("Trie decoder entered an impossible state")

    def text(self) -> str:
        return self.tokenizer.decode(self.state.generated)


class SchemaActionDecoder:
    """Guarantees a syntactically valid, schema-validated tool call from byte logits.

    The grammar deterministically emits JSON structure and lets the model choose tool names and
    leaf values. Required schema fields are emitted; optional fields can be learned later through
    richer schema policies without weakening the execution invariant.
    """

    def __init__(self, decoder: IncrementalByteDecoder) -> None:
        self.decoder = decoder

    def decode(self, tool_specs: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
        if not tool_specs:
            raise ValueError("No tools are installed")
        by_name = {str(spec["name"]): spec for spec in tool_specs}
        self.decoder.emit_text('{"tool":"')
        # Appending the quote handles a dynamically installed name that is a prefix of another.
        selected_bytes = self.decoder.emit_trie_choice(
            [(name + '"').encode("utf-8") for name in sorted(by_name)]
        )
        selected_name = selected_bytes[:-1].decode("utf-8")
        self.decoder.emit_text(',"arguments":')
        schema = dict(by_name[selected_name].get("input_schema") or {"type": "object"})
        self._value(schema, depth=0)
        self.decoder.emit_text("}")
        raw = self.decoder.text()
        parsed = json.loads(raw)
        arguments = parsed["arguments"]
        Draft202012Validator(schema).validate(arguments)
        return selected_name, arguments

    def _value(self, schema: dict[str, Any], *, depth: int) -> None:
        if depth > 12:
            raise ValueError("Tool input schema exceeds maximum nesting depth")
        if "const" in schema:
            self.decoder.emit_text(json.dumps(schema["const"], separators=(",", ":")))
            return
        if schema.get("enum"):
            candidates = [
                json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
                for value in schema["enum"]
            ]
            # Enum values in tool schemas are normally disjoint at the first differing byte.
            self.decoder.emit_trie_choice(candidates)
            return
        for keyword in ("oneOf", "anyOf"):
            alternatives = schema.get(keyword)
            if isinstance(alternatives, list) and alternatives:
                self._value(dict(alternatives[0]), depth=depth + 1)
                return
        value_type = schema.get("type")
        if isinstance(value_type, list):
            non_null = [value for value in value_type if value != "null"]
            value_type = non_null[0] if non_null else "null"
        if value_type == "object" or (value_type is None and "properties" in schema):
            self._object(schema, depth=depth)
        elif value_type == "array":
            self._array(schema, depth=depth)
        elif value_type == "string":
            self._string(schema)
        elif value_type == "integer":
            self._integer(schema)
        elif value_type == "number":
            self._number(schema)
        elif value_type == "boolean":
            self.decoder.emit_trie_choice([b"true", b"false"])
        elif value_type == "null":
            self.decoder.emit_text("null")
        else:
            # An unconstrained JSON object is the safest schema-valid neutral value.
            self.decoder.emit_text("{}")

    def _object(self, schema: dict[str, Any], *, depth: int) -> None:
        properties = dict(schema.get("properties") or {})
        required = [str(value) for value in schema.get("required", [])]
        self.decoder.emit_text("{")
        for index, name in enumerate(required):
            if index:
                self.decoder.emit_text(",")
            self.decoder.emit_text(json.dumps(name, ensure_ascii=True))
            self.decoder.emit_text(":")
            self._value(dict(properties.get(name) or {}), depth=depth + 1)
        self.decoder.emit_text("}")

    def _array(self, schema: dict[str, Any], *, depth: int) -> None:
        minimum = int(schema.get("minItems", 0))
        maximum = int(schema.get("maxItems", max(minimum, 4)))
        count = min(minimum, maximum, 16)
        item_schema = dict(schema.get("items") or {})
        self.decoder.emit_text("[")
        for index in range(count):
            if index:
                self.decoder.emit_text(",")
            self._value(item_schema, depth=depth + 1)
        self.decoder.emit_text("]")

    def _string(self, schema: dict[str, Any]) -> None:
        minimum = int(schema.get("minLength", 0))
        configured_maximum = int(schema.get("maxLength", 256))
        maximum = max(minimum, min(configured_maximum, 256, max(0, self.decoder.remaining - 8)))
        self.decoder.emit_text('"')
        # Printable ASCII excluding quote and backslash keeps the emitted JSON valid without escapes.
        printable = set(range(32, 127)) - {34, 92}
        for index in range(maximum):
            allowed = set(printable)
            if index >= minimum:
                allowed.add(34)
            selected = self.decoder.choose_byte(allowed)
            if selected == 34:
                return
        self.decoder.emit_text('"')

    def _integer(self, schema: dict[str, Any]) -> None:
        minimum = int(schema.get("minimum", -10))
        maximum = int(schema.get("maximum", 10))
        candidates = sorted({minimum, maximum, 0, 1, -1, (minimum + maximum) // 2})
        candidates = [value for value in candidates if minimum <= value <= maximum]
        if not candidates:
            candidates = [minimum]
        selected = self._score_fixed([str(value) for value in candidates])
        self.decoder.emit_text(selected)

    def _number(self, schema: dict[str, Any]) -> None:
        minimum = float(schema.get("minimum", 0.0))
        maximum = float(schema.get("maximum", 1.0))
        midpoint = (minimum + maximum) / 2.0
        candidates = [minimum, maximum, midpoint, 0.0, 1.0]
        normalized = sorted(
            {
                value
                for value in candidates
                if minimum <= value <= maximum and value == value and abs(value) != float("inf")
            }
        )
        selected = self._score_fixed([format(value, ".6g") for value in normalized or [minimum]])
        self.decoder.emit_text(selected)

    def _score_fixed(self, values: list[str]) -> str:
        # Lightweight local choice: select the candidate whose first byte has the highest next-token score.
        # Fixed candidates remain schema-valid; later evolution can replace this with full-sequence scoring.
        best = values[0]
        best_score = float("-inf")
        for value in values:
            first = value.encode("utf-8")[0]
            score = float(
                self.decoder.state.logits[0, self.decoder.tokenizer.BYTE_OFFSET + first].item()
            )
            if score > best_score:
                best = value
                best_score = score
        return best
