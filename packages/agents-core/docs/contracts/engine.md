# Engine Interface Contract — §03 I3

> **Design ref:** `.plans/design/03-inferctl.md` §I3 (line 29 — authoritative)  
> **Scope decisions:** `EXECUTION-STATE.md` D-028 (Dynamo RESERVED; KTransformers on-demand; vLLM/llama.cpp 4.0 core)  
> **Implementation:** `../inference-engine/python-agent/agent/engines/contract.py`

Every inference engine sits behind a single Python Protocol.  inferctl
(`inference-engine/services/inferctl`, Go) is the controller; the Python contract is the seam
that agent-side code — the gateway registry consumer, the autolearn adapter
flywheel, and any future tool that needs to call an engine — uses to talk to
whatever engine inferctl has brought up.

---

## The contract surface

The surface below is the **verbatim §03 I3 engine contract**
(`.plans/design/03-inferctl.md` line 29).  Any change to this surface must
first be ratified in §03 I3 and recorded as a new decision in
`EXECUTION-STATE.md`.

```
EngineAdapter (Protocol, runtime-checkable)
  .start(profile: str, model: str, nodes: list[NodePlacement]) → str
                                           # bring up engine; returns endpoint URL
  .health()    → bool                      # never raises; False triggers reconcile
  .stop()      → None                      # tear down; safe to call when already stopped
  .capabilities() → CapabilityFlags        # re-read after first health()==True and after model switch
```

Supporting types (`NodePlacement`, `ResourceBudget`, `CapabilityFlags`,
`EngineDescriptor`) live alongside the Protocol in the sibling
`../inference-engine/python-agent/agent/engines/contract.py` implementation and
provide the metadata that inferctl uses for placement decisions and gateway
registry publication.  They are NOT part of the `EngineAdapter` call surface.

`CapabilityFlags` includes `lora_adapters`, `max_context`, `embeddings`,
`reranking`, `multi_node_tp`, `kv_aware_routing`, `streaming`, and
`function_calling`.  inferctl reads these into the gateway registry after
the first `health() == True`.

All implementation types live in
`../inference-engine/python-agent/agent/engines/contract.py` and use Python >=
3.12 stdlib only (no third-party imports).

---

## Engine tier table

| Kind constant   | Engine            | Deployment profile         | When it lands | What it serves |
|-----------------|-------------------|---------------------------|---------------|----------------|
| `VLLM`          | vLLM (direct)     | `dynamo-gpu`\*            | **VS1 / 4.0 core** | GPU-tier dense models that fit in 24–48 GB VRAM (e.g. 32B AWQ coder). OpenAI-compatible HTTP. |
| `LLAMACPP`      | llama.cpp         | `llamacpp-gguf`           | **VS1 / 4.0 core** | GGUF fallback; CPU-only or GPU+CPU hybrid via `-ngl`. Also hosts the 1M-context conversation model served from RAM (§03 I4). |
| `KTRANSFORMERS` | KTransformers     | `ktransformers-ram-moe`   | **VS4b / 4.0 last** | 671B-class MoE (e.g. DeepSeek-R1/V3 Q4 ≈ 400 GiB) with expert offload to s002's 503 GiB RAM and attention / active-expert path on the 3090. The headline use of the 754 GiB cluster RAM. |
| `DYNAMO`        | NVIDIA Dynamo     | `dynamo-gpu` / `dynamo-tp-multinode` | **RESERVED post-4.0** | Disaggregated prefill/decode, KV-cache-aware routing, multi-node tensor-parallel across 2×3090. Gated on NIC upgrade (10 GbE / RDMA). |

\* In 4.0 the `dynamo-gpu` profile name is used for vLLM-direct runs on the
GPU tier.  When Dynamo lands it takes over the same profile name; the gateway
sees no change.

---

## RAM co-budgeting (D-028)

The 4.0 RAM consumers on s002 (503 GiB usable) are:

| Consumer | Peak RAM |
|---|---|
| KTransformers 671B-MoE weights + KV cache | ≈ 400 GiB |
| autolearn training-offload workspace | ≈ 40–80 GiB (only during a training run) |
| Brain workers + OS + llama.cpp warm pool | ≈ 20–40 GiB |

These peaks do **not** coincide: a training run is not triggered while a
KTransformers query is in flight; the brain workers are always active but
small.  inferctl co-budgets via `ResourceBudget.ram_co_budget_gb`:

- Each engine declares its peak share.
- `ResourceBudget.effective_co_budget()` resolves `None` → `ram_gb`
  (conservative fallback).
- Before starting a new engine, inferctl sums `effective_co_budget()` across
  all running engines on the node.  If `sum + new_engine_co_budget > node_ram_gb`
  the placement is deferred (queued, not rejected — §03 I4a oversubscription
  policy).

This is intentionally simple for 4.0.  A finer-grained policy (probabilistic
overlap, time-of-day profiles) is a post-4.0 optimisation.

---

## What a post-4.0 Dynamo adapter must implement

To drop in NVIDIA Dynamo behind this contract:

1. Create `../inference-engine/python-agent/agent/engines/dynamo.py`, `class DynamoAdapter`.
2. Implement the full `EngineAdapter` Protocol (`start`, `health`, `stop`,
   `capabilities`):
   - `start(profile, model, nodes)` — call Dynamo's deployment API / apply
     the Dynamo model CRD; poll until the model endpoint reports ready.  Do
     **not** manage a local process.  Return Dynamo's per-model routed OpenAI
     base URL; KV-aware routing is internal to Dynamo, so the URL is opaque
     to the caller.  Build and retain an `EngineDescriptor` internally with
     `kind=DYNAMO`, `profile="dynamo-gpu"` or `"dynamo-tp-multinode"`.
   - `health()` — aggregate health across all Dynamo workers for the loaded
     model; return `False` if any worker is unhealthy.
   - `stop()` — delete the Dynamo deployment for the model.
   - `capabilities()` — advertise `kv_aware_routing=True` always;
     `multi_node_tp=True` when cross-node TP is active (i.e. when running
     the `dynamo-tp-multinode` profile).  Set `lora_adapters` based on the
     Dynamo worker's actual support.
3. Uncomment (and fill in) the `EngineKind.dynamo` branch in
   `engine_adapter_factory()`.
4. No other caller changes are required — the gateway registry, the health
   reconcile loop, and the autolearn adapter consumer all depend only on the
   `EngineAdapter` Protocol.

---

## Deployment profile → kind mapping (§03 I3 re-statement)

| Profile name | Kind | Notes |
|---|---|---|
| `dynamo-gpu` | `VLLM` (4.0) / `DYNAMO` (post-4.0) | Per-node GPU; 1 GbE constraint makes cross-node the default-off path. |
| `ktransformers-ram-moe` | `KTRANSFORMERS` | s002 only; AVX2/AVX-512 sufficient (AMX is a speed bonus, not required — D-023). |
| `llamacpp-gguf` | `LLAMACPP` | Any node; GPU offload optional via `-ngl`. |
| `dynamo-tp-multinode` | `DYNAMO` | RESERVED; off until 10 GbE / RDMA upgrade. Profile swap from `dynamo-gpu` — no model config rewrite. |

---

## Upgrade path

```
4.0 GPU tier (per-node, 1 GbE):
  vLLM direct → profile "dynamo-gpu"

Post-4.0 (NIC upgrade done, Dynamo adapter wired):
  DynamoAdapter → same profile "dynamo-gpu"
  Multi-node TP: profile "dynamo-tp-multinode" (config toggle, no rewrite)
```

The contract surface is identical in both cases.  The gateway registry entry
changes only in `api_base` URL and `capabilities.multi_node_tp`.

---

*This document tracks `../inference-engine/python-agent/agent/engines/contract.py`.  It must be updated
whenever `EngineAdapter` (the §03 I3 surface), `EngineDescriptor`, or
`CapabilityFlags` gain new surface area — and any change to `EngineAdapter`
requires a prior ratifying update to `.plans/design/03-inferctl.md` §I3.*

