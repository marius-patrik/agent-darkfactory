from __future__ import annotations

from collections.abc import Iterable


class ByteTokenizer:
    """Deterministic UTF-8 byte tokenizer with no external vocabulary dependency."""

    PAD = 0
    BOS = 1
    EOS = 2
    SEP = 3
    BYTE_OFFSET = 4
    vocab_size = 260

    def encode(self, text: str, *, bos: bool = False, eos: bool = False) -> list[int]:
        values: list[int] = []
        if bos:
            values.append(self.BOS)
        values.extend(self.BYTE_OFFSET + byte for byte in text.encode("utf-8"))
        if eos:
            values.append(self.EOS)
        return values

    def decode(self, ids: Iterable[int], *, skip_special: bool = True) -> str:
        data = bytearray()
        for token_id in ids:
            if token_id >= self.BYTE_OFFSET:
                data.append(token_id - self.BYTE_OFFSET)
            elif not skip_special:
                data.extend(
                    {
                        self.PAD: b"<PAD>",
                        self.BOS: b"<BOS>",
                        self.EOS: b"<EOS>",
                        self.SEP: b"<SEP>",
                    }.get(token_id, b"<SPECIAL>")
                )
        return data.decode("utf-8", errors="replace")
