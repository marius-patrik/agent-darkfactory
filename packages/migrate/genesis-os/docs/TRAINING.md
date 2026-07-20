# Training Guide

## 1. Development sequence

Do not start with the largest configuration. Validate the lifecycle in this order:

```text
1. genesis demo
2. tiny Birth on target machine
3. real neural Wake and tool traces
4. one Sleep promotion and one intentional rejection
5. personal-data dry inspection
6. reasoning-scale Birth
7. long-running Wake/Sleep schedule
8. harness evolution experiments
```

A successful large training run is less valuable than a small run whose datasets, exact events, model hashes, and evaluation decisions are reproducible.

## 2. Configurations

### `configs/tiny.yaml`

CPU lifecycle validation. It deliberately disables generation viability samples and uses permissive loss gates.

### `configs/developmental-smoke.yaml`

CPU-scale exercise of every built-in curriculum generator, including textbook and verified procedural stages. Use it after `genesis demo` and before a GPU run.

### `configs/reasoning.yaml`

A 256-dimensional, 8-layer from-scratch developmental run with textbook and verified procedural stages. This is the recommended first GPU experiment.

### `configs/reasoning-teacher.yaml`

Same direction with an OpenAI-compatible Birth teacher. Set the endpoint, model, and key environment variable before use.

### `configs/base.yaml`

A larger 512-dimensional, 12-layer base. Dataset scale and step count still need adjustment for the available compute budget.

### `configs/personal.yaml`

Universal developmental stages plus private user/session data.

### `configs/sleep.yaml`

Conservative continual-learning update with replay and regression gates.

## 3. Curriculum semantics

A stage has:

```yaml
- name: procedural_reasoning
  generator: procedural_distillation
  examples: 100000
  prerequisites: [textbook_foundations]
  weight: 1.5
  parameters:
    teacher_required: false
```

`examples` is the requested number of emitted training examples. A procedural task emits a planning and execution example, so the compiler creates enough tasks and truncates to the requested output count.

Available generators:

- `textbook`
- `procedural_distillation`
- `language_foundations`
- `arithmetic`
- `symbolic_logic`
- `algorithms`
- `causal_worlds`
- `tool_use`
- `memory_recall`

## 4. Executable textbooks

Textbook files are YAML, JSON, or JSONL. YAML format:

```yaml
lessons:
  - concept: implication
    title: Implication
    prerequisites: [proposition]
    explanation: "A -> B licenses B when A is established."
    examples:
      - "A -> B, A, therefore B."
    counterexamples:
      - "A -> B, B, therefore A."
    exercises:
      - question: "From R -> S and R, what follows?"
        answer: "S"
        rationale: "Modus ponens"
        verifier: exact
```

Concept IDs must be unique, all prerequisites must exist in the loaded textbook set, and cycles fail compilation.

The current textbook compiler turns lessons into action-supervised explanations, examples, counterexamples, and exercises. The `verifier` field is retained in provenance; custom training/evaluation code can execute numeric, formal, theorem, or simulator verifiers.

## 5. Teacher isolation

A teacher may improve procedural descriptions, but it is not trusted as an oracle.

```yaml
curriculum:
  teacher:
    base_url: http://127.0.0.1:8000/v1
    model: teacher-model
    api_key_env: TEACHER_API_KEY
    required: true
```

Rules:

- teacher calls happen during curriculum compilation only;
- requests are cached by hash;
- API keys are read from the environment and not written into datasets;
- final answers are accepted only after executable verification;
- failure falls back to deterministic strategies unless required;
- real-world factual questions are excluded from procedural distillation.

## 6. Personal data

The ingestor recognizes:

- ChatGPT `conversations.json` exports;
- generic JSONL with `content`, `text`, or `message` fields;
- UTF-8 documents and logs;
- image/audio/binary files as content-addressed artifacts.

Binary media is preserved with metadata. It is not automatically transformed into training tensors by the current personal compiler. Add a modality-specific data program for image/audio learning.

Before Birth, inspect the JSONL manifest produced by `genesis ingest`. A quarantined record should not be manually unquarantined until its secret status has been reviewed.

## 7. Objective functions

The initial trainer combines:

```text
L = L_language
  + lambda_world * L_world_nll
  + lambda_value * L_value
  + lambda_uncertainty * L_uncertainty
```

- language loss applies only to the action target bytes;
- world loss predicts the encoded next context as a Gaussian latent distribution;
- value loss predicts explicit example outcomes;
- uncertainty loss estimates detached value error magnitude.

Future high-value objectives include:

- contrastive shared/private modality alignment;
- explicit self-state and user-state supervision;
- retrieval ranking and source attribution;
- counterfactual action ranking;
- temporal-difference value learning;
- model-based rollout consistency;
- process-verifier rewards;
- calibration proper scoring rules.

## 8. Reproducibility

Genesis applies:

- seeded Python, NumPy, and PyTorch RNGs;
- deterministic-algorithm requests with warnings;
- seeding before random parameter initialization;
- deterministic DataLoader generators;
- content-derived example IDs;
- canonical sorted JSONL serialization;
- content hashes for datasets, models, genomes, and raw artifacts.

GPU kernels, driver versions, hardware, and distributed reductions can still prevent bit-identical replication. Preserve the complete software/hardware environment for serious comparisons.

## 9. Scaling

Approximate parameter count is driven by `d_model`, layers, feed-forward multiplier, and modality/world heads. Memory pressure also depends strongly on sequence length and optimizer state.

Practical scaling order:

1. increase curriculum quality and verifier coverage;
2. increase token diversity and delayed-transfer tests;
3. increase model width/depth;
4. increase context and recurrent memory;
5. add aligned modalities;
6. distribute training;
7. evolve architecture and objectives.

Increasing parameter count before the curriculum and evaluations distinguish reasoning from memorization is unlikely to answer the core research question.

## 10. Sleep scheduling

A Sleep can be triggered manually, by service API, or requested by the organism. The request itself never writes weights.

Useful scheduling policies:

- event threshold;
- elapsed-time threshold;
- accumulated high-importance memories;
- measured novelty or prediction error;
- repeated task failure;
- explicit user approval;
- available compute window.

Production deployments should execute Sleep in an isolated training worker while the active release remains immutable. Promotion should cause a controlled runtime reload.

## 11. Promotion gates

Current gates compare:

- new-experience loss regression/improvement;
- foundation relative loss regression;
- tool-name accuracy drop;
- ledger integrity.

Add domain-specific held-out suites before any autonomous deployment. Never allow a candidate to generate or edit the only tests deciding its promotion.

## 12. Experiment records

Every serious experiment should retain:

- Birth/Sleep/Evolution spec;
- source commit;
- environment lock or container digest;
- GPU/CPU model and driver versions;
- dataset hashes;
- teacher request cache hashes;
- parent and candidate hashes;
- optimizer settings;
- full metric vectors;
- promotion decision and reasons;
- qualitative failure traces.
