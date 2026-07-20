# Contributing

Use Python 3.11+, typed interfaces, deterministic tests, and immutable provenance. New operational behavior must be implemented as a tool and executed through the Tool Kernel. New durable weight writes must require Birth, Sleep, or Evolution authority.

Before committing:

```bash
ruff check src tests
pytest
npm --prefix sdk/typescript run typecheck
```

Changes to training objectives, curricula, promotion gates, tool capabilities, or ledger semantics require tests demonstrating the intended invariant and at least one failure case.
