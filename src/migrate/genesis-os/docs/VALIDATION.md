# Release Validation

Validation was performed from clean workspaces on July 19, 2026.

## Environment

- Python 3.13.5
- PyTorch 2.10.0 CPU
- FastAPI 0.128.2
- Pydantic 2.13.4
- Node.js 22.16.0
- TypeScript 5.8-compatible SDK
- Ruff 0.15.22

## Quality gates

```text
ruff check src tests                         PASS
pytest -q                                    PASS (15 tests)
python -m compileall -q src tests            PASS
npm --prefix sdk/typescript run typecheck    PASS
npm --prefix sdk/typescript run build        PASS
python -m pip wheel . --no-deps              PASS
```

The tests cover model/cache/multimodal shapes, measurable training-loss reduction, immutable ledger behavior, dynamic workflows, gated Python tools, curriculum compilation, procedural verification, personal-data provenance and secret quarantine, Birth/Wake/Sleep lineage behavior, tamper-resistant promotion, and the authenticated API/tool trace.

## Lifecycle demonstration

Command:

```bash
genesis demo --workspace /tmp/genesis-demo --reset
```

Observed result:

```text
Sleep examples:              135
new-experience loss:         2.5974609 -> 2.0953127
foundation loss:             2.7401712 -> 2.2724963
candidate promoted:          yes
ledger integrity:            15 events, valid hash chain
```

This proves the lifecycle and promotion transaction; it is not a broad-capability benchmark.

## Full developmental smoke Birth

Command:

```bash
genesis birth \
  --workspace /tmp/genesis-developmental-smoke \
  --config configs/developmental-smoke.yaml
```

Observed result:

```text
compiled examples:           324
training steps:              20
training loss:               4.9768206
validation loss:             4.6762183
birth promoted:              yes
```

The run exercised textbook, procedural distillation, language, arithmetic, symbolic logic, algorithms, causal worlds, tool use, and memory recall.

## Deterministic repeat

Two independent developmental smoke workspaces produced equal:

- curriculum hash;
- train dataset hash;
- validation dataset hash;
- final model hash (`3751236aa692f9615fc85c51f98a64700b06e73a2e4f915a363c902deea75df8`).

Bit-identical reproduction on other GPU/driver/platform combinations is not implied; preserve the complete environment for serious comparisons.
