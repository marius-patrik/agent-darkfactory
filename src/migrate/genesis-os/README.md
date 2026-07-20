# Genesis OS

Genesis OS is an executable research substrate for **persistent, tool-native learning organisms**. It implements the complete lifecycle needed to begin experiments now:

```text
Birth -> Wake -> Experience -> Sleep -> Promotion
  ^                                |
  |                                v
  +------ Reproduction <- Evolution
```

It is not a claim that a small model trained by this repository is already AGI. The repository establishes the code and provenance layer that an evolving model needs: developmental birth, persistent operation, immutable autobiography, dynamic tools, sleep-only consolidation, regression-gated lineage updates, multimodal/recurrent neural state, probabilistic world prediction, personal-data compilation, and harness evolution.

## Non-negotiable invariants

1. **Every operational act during Wake is a tool call.** Speech, memory access, file operations, processes, simulations, tool creation, sleep requests, and evolution proposals all pass through `ToolKernel.invoke()`.
2. **Wake cannot persistently mutate canonical weights.** It may change recurrent cognitive state, append events, and use disposable runtime state. Durable model changes require Birth, Sleep, or Evolution authority.
3. **Experience is lossless; consolidation is selective.** The ledger records exact events. Sleep compiles verified trajectories, memory tests, outcomes, and historical replay into candidate training data.
4. **A candidate never silently replaces the organism.** Sleep evaluates the candidate against new experience and retained foundation data, verifies ledger integrity, then atomically promotes or rejects it.
5. **Birth can create a genuinely new base model.** It supports random initialization, inherited checkpoints, executable textbook curricula, procedural reasoning distillation, personal-data imprinting, adaptive remediation, and viability gates.
6. **Dynamic tools do not create hidden side channels.** Safe workflows inherit the capabilities of their component tools. Python subprocess tools are separately gated, statically checked, tested in a disposable workspace, resource-limited, and audited.
7. **Lineage artifacts are content-verified.** Promotion checks the hashes of the model and genome before moving the canonical pointer.

## Architecture

```text
                           SPECIES LAYER
        ModelGenome · BirthSpec · Curriculum · Harness Evolution
                                   |
                                   v
                              BIRTH RUNNER
     random/inherited weights + textbooks + procedural worlds + personal data
                                   |
                         viable root checkpoint
                                   v
+----------------------------- WAKE RUNTIME ------------------------------+
|                                                                         |
| observation -> exact retrieval -> recurrent organism -> one tool call   |
|                                              |                          |
|                                              v                          |
|                                      audited Tool Kernel                |
|                         dynamic workflows / gated Python / primitives   |
|                                              |                          |
|                                              v                          |
|                              environment + immutable event ledger       |
+----------------------------------------------+--------------------------+
                                               |
                                               v
                                          SLEEP PROGRAM
                         experience compiler + replay + candidate training
                                               |
                    new-memory eval + foundation regression + hash checks
                                  |                         |
                                reject                    promote
                                  |                         |
                         retained branch             next canonical release
```

The model is a byte-level causal decoder with:

- persistent recurrent memory slots;
- custom cached causal attention and SwiGLU blocks;
- shared/private image, audio, and structured-state encoders;
- a probabilistic action-conditional world-transition head;
- value and calibrated-error proxy heads;
- self-state and user-state heads;
- schema-constrained action decoding against the live tool catalog.

The constrained decoder guarantees a syntactically valid, schema-shaped tool call. Choosing the correct tool remains a learned capability and improves through curriculum, Wake experience, and Sleep.

## Repository status

The current implementation contains working code for:

- append-only SQLite autobiography with a cryptographic hash chain and update/delete blocking triggers;
- full Birth, Wake, Sleep, promotion, rollback, and Evolution paths;
- deterministic curriculum compilation and seeded parameter initialization;
- executable textbook lessons with prerequisite DAG validation;
- knowledge-minimized procedural distillation in randomized formal worlds;
- optional cached OpenAI-compatible teacher use during Birth only;
- ChatGPT export, JSONL, document, image, audio, and binary personal-data ingestion;
- explicit user/assistant provenance and secret quarantine;
- dynamic workflow and Python tool installation without runtime restart;
- persistent cognitive state independent of the context window;
- probabilistic latent reality simulation exposed only through a tool;
- FastAPI, WebSocket event streaming, and a TypeScript Andromeda client;
- end-to-end tests and a compact lifecycle demonstration.

## Quick start

Python 3.11 or newer is required.

```bash
git clone <your-repository-url> genesis-os
cd genesis-os
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
pytest
```

Run the compact proof:

```bash
genesis demo --workspace .genesis/demo
```

Exercise every built-in developmental curriculum generator with a small CPU model:

```bash
genesis birth --workspace .genesis/developmental-smoke --config configs/developmental-smoke.yaml
```

The demonstration performs a real CPU-scale Birth, an audited Wake trajectory, Sleep training, parent/candidate evaluation, promotion gating, and final ledger verification. The controlled Wake policy used by this one demonstration exists to make the lifecycle proof deterministic; production Wake loads the promoted neural organism.

### Birth a small runnable organism

```bash
genesis birth \
  --workspace .genesis/tiny \
  --config configs/tiny.yaml

genesis lineage list --workspace .genesis/tiny
```

Copy the emitted lineage identifier, then run Wake:

```bash
genesis wake \
  --workspace .genesis/tiny \
  --lineage <LINEAGE_ID> \
  --interactive
```

After the organism has accumulated experience:

```bash
genesis sleep \
  --workspace .genesis/tiny \
  --lineage <LINEAGE_ID> \
  --config configs/sleep.yaml

genesis lineage releases \
  --workspace .genesis/tiny \
  --lineage <LINEAGE_ID>
```

A tiny randomly initialized model is useful for proving the loop, not for useful general intelligence. Use it to validate hardware, storage, tools, datasets, and promotion behavior before committing substantial compute.

## Start developmental reasoning training

`configs/reasoning.yaml` starts from random weights and combines:

1. prerequisite-ordered textbook foundations;
2. randomized procedural tasks with exact verifiers;
3. language foundations;
4. arithmetic, symbolic logic, algorithms, and causal micro-worlds;
5. tool-mediated action training;
6. exact autobiographical recall training.

```bash
genesis birth \
  --workspace .genesis/reasoning \
  --config configs/reasoning.yaml
```

`configs/base.yaml` is a larger 512-dimensional, 12-layer starting point. It is still a research-scale base, not a substitute for the token volume and compute used by frontier pretraining.

### Teacher-assisted procedural distillation

`configs/reasoning-teacher.yaml` accepts an OpenAI-compatible `/chat/completions` endpoint. The teacher is used only to propose compact, domain-general procedures for invented formal tasks. Its answer must pass the task's executable verifier before becoming training data.

```bash
export TEACHER_API_KEY='...'
genesis birth \
  --workspace .genesis/reasoning-teacher \
  --config configs/reasoning-teacher.yaml
```

Teacher output is cached by request hash. It is never called during Wake and never becomes a permanent runtime dependency. To avoid transferring ordinary factual knowledge, task symbols, rules, values, and surface forms are regenerated continuously.

## Personal birth from session history and private data

Export ChatGPT data so that `conversations.json` is available, place other sources under a private directory, and edit `configs/personal.yaml` paths as needed. Paths are resolved relative to the YAML file.

```text
personal-data/
├── chatgpt-export/
│   └── conversations.json
└── documents/
    ├── projects.md
    ├── preferences.txt
    └── ...
```

Inspect the ingestion manifest before training:

```bash
genesis ingest \
  --workspace .genesis/personal \
  personal-data/chatgpt-export/conversations.json \
  personal-data/documents
```

Then birth the personal lineage:

```bash
genesis birth \
  --workspace .genesis/personal \
  --config configs/personal.yaml
```

The compiler preserves roles and provenance. User statements train exact recall, source attribution, chronology, and explicit user-model memory actions. Historical assistant output is treated as assistant behavior rather than user truth and is not imitated unless `include_assistant_imitation` is deliberately enabled.

Likely credentials, private keys, API tokens, and password-like values are redacted and marked quarantined by default. Quarantined records remain represented in the ingestion manifest and content-addressed source archive but do not become training examples.

## Birth

A Birth is an executable developmental program, not merely “load weights and a dataset.” A `BirthSpec` defines:

- the model genome;
- random or inherited initialization;
- curriculum stages and prerequisites;
- textbook sources;
- optional teacher configuration;
- personal-data sources and privacy behavior;
- optimizer/training regimen;
- adaptive remediation;
- viability evaluation.

A successful Birth produces:

- a root checkpoint in safetensors format;
- a genome manifest;
- train and validation JSONL datasets;
- evaluation metrics;
- a content-hashed release manifest;
- an atomically promoted lineage pointer;
- a Birth certificate recorded in the autobiography.

Generated datasets use content-derived example identifiers and canonical JSON serialization. Random initialization is seeded before parameters are constructed.

## Wake and the AI operating system

The organism never directly “does” an operation. It selects one typed tool call from the live catalog:

```json
{"tool":"workspace.write","arguments":{"path":"notes/result.txt","content":"..."}}
```

The kernel then:

1. appends the requested call to the ledger;
2. resolves the current version of the tool;
3. checks capabilities against runtime policy;
4. validates arguments with JSON Schema;
5. executes with timeout and recursion controls;
6. validates the result schema;
7. records the outcome, error, duration, and causal link.

Built-in primitives include communication, yielding, exact memory, workspace I/O, process execution, cognition notes, learned reality simulation, Sleep requests, evolution proposals, and dynamic-tool management.

### Dynamic workflow tools

A workflow tool composes installed tools with argument templates and JSON-path-like references. It is stored as a manifest, loaded without restart, and remains fully audited. Its effective capabilities are the union of all nested tool capabilities.

### Dynamic Python tools

`tool.create_python` can install a Python subprocess tool when explicitly enabled:

```bash
genesis serve \
  --workspace .genesis/personal \
  --lineage <LINEAGE_ID> \
  --allow-python-tools \
  --allow-process-tools
```

Python source is AST-checked, written to a disposable package, run against declared tests in a temporary workspace, and then installed atomically. This is defense in depth, not a hardened hostile multitenant sandbox. Use OS/container isolation for untrusted code.

## Sleep

Sleep is the only within-life transaction allowed to write durable canonical model weights. Its phases are implemented as:

1. verify ledger integrity and establish the last promoted cursor;
2. compile successful Wake action selections and tool outcomes;
3. generate exact content, provenance, chronology, and user-observation recall tasks;
4. mix representative historical Birth/Sleep replay;
5. train a separate candidate release;
6. evaluate parent and candidate on new experience;
7. evaluate retention on foundation data;
8. apply configured loss and tool-accuracy gates;
9. save the candidate whether accepted or rejected;
10. atomically promote only when every gate passes.

This separates continuous experience from safe canonical evolution. A rejected model is retained for inspection rather than silently discarded or deployed.

## Reality model

The model contains a probabilistic latent transition head and exposes it through `reality.simulate`. The tool accepts a textual belief state, interventions, horizon, sample count, and seed, then returns distributions over latent trajectories.

This is an extensible world-model interface, not a claim of perfect simulation. Fidelity is domain- and data-dependent. Exact simulators, theorem provers, code execution, numerical solvers, and learned dynamics should be composed as tools whenever they outperform neural approximation.

The multimodal encoder currently accepts image tensors, raw audio tensors, and structured features and preserves shared plus modality-private representations. The default generated curricula in this repository are primarily text/event based; serious visual or audio capability requires adding aligned multimodal datasets and objectives rather than assuming the encoder alone creates grounding.

## Harness evolution

Harness evolution runs isolated candidate workspaces, mutates model/curriculum/Sleep parameters, performs fresh Births, optionally performs Sleep trials, scores candidates, and preserves all lineage evidence.

```bash
genesis evolve \
  --workspace .genesis/evolution \
  --birth-config configs/tiny.yaml \
  --sleep-config configs/sleep.yaml \
  --generations 2 \
  --population 4
```

The organism may propose evolution through `evolution.propose`, but proposals do not control their own held-out acceptance tests.

## Andromeda integration

Genesis runs standalone and exposes a narrow integration contract rather than assuming Andromeda internals.

Start the service:

```bash
export GENESIS_API_TOKEN='replace-me'
genesis serve \
  --workspace .genesis/personal \
  --lineage <LINEAGE_ID> \
  --host 127.0.0.1 \
  --port 8787
```

Use the TypeScript client:

```ts
import { GenesisClient } from "@genesis-os/andromeda-sdk";

const genesis = new GenesisClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.GENESIS_API_TOKEN,
});

const result = await genesis.sendAndromedaEvent({
  type: "chat.message",
  content: "Inspect the current project state.",
  sessionId: "andromeda-session-42",
  metadata: { projectId: "andromeda" },
});
```

The bridge returns emitted messages and the complete tool trace. Event history can be consumed by REST polling or WebSocket. See [`docs/ANDROMEDA.md`](docs/ANDROMEDA.md).

## API surface

- `GET /health`
- `GET /v1/tools`
- `POST /v1/tools/invoke`
- `POST /v1/observe`
- `POST /v1/andromeda/events`
- `GET /v1/events`
- `POST /v1/sleep`
- `WS /v1/events/ws`

Set `GENESIS_API_TOKEN` for bearer authentication and `GENESIS_CORS_ORIGINS` for explicit browser origins.

## Storage layout

```text
<workspace>/
├── genesis.sqlite3              immutable event ledger
├── artifacts/                   content-addressed raw artifacts
├── datasets/                    Birth and Sleep JSONL datasets
├── dynamic-tools/               installed workflow/Python tools
├── lineages/
│   └── <lineage>/
│       ├── current.json         atomic canonical pointer
│       ├── promotion_history.jsonl
│       └── releases/<release>/
│           ├── model.safetensors
│           ├── genome.json
│           ├── metadata.json
│           ├── release.json
│           └── birth_certificate.json (root releases)
├── state/                       recurrent Wake state and evolution proposals
├── logs/
└── workspace/                   organism-visible filesystem
```

## Verification and rollback

```bash
genesis ledger verify --workspace .genesis/personal

genesis lineage releases \
  --workspace .genesis/personal \
  --lineage <LINEAGE_ID>

genesis lineage promote \
  --workspace .genesis/personal \
  --lineage <LINEAGE_ID> \
  --release <PREVIOUS_RELEASE_ID> \
  --reason 'rollback after regression review'
```

Manual promotion verifies model and genome hashes before moving the pointer.

## Development

```bash
make install
make test
make lint
npm --prefix sdk/typescript run typecheck
```

Key modules:

```text
src/genesis_os/birth/       Birth specs, personal ingestion, textbooks, distillation
src/genesis_os/model/       neural genome, multimodal network, recurrent organism
src/genesis_os/runtime/     persistent Wake loop
src/genesis_os/tools/       audited Tool Kernel and dynamic tool system
src/genesis_os/storage/     immutable ledger, artifacts, lineages
src/genesis_os/sleep/       experience compiler, candidate training, promotion gate
src/genesis_os/reality/     probabilistic latent simulation
src/genesis_os/evolution/   harness mutation and isolated selection
src/genesis_os/server/      REST/WebSocket service
sdk/typescript/             Andromeda-facing client
```

## What remains research work

The substrate is complete enough to start training and accumulating evaluated experience. The following are not solved by repository structure alone:

- obtaining enough high-quality developmental curriculum and compute for broad intelligence;
- demonstrating robust reasoning transfer at scale rather than benchmark memorization;
- preventing all forms of continual-learning interference and synthetic-data drift;
- building high-fidelity multimodal world models across arbitrary domains;
- establishing any scientifically defensible claim about consciousness;
- hardening generated code execution for adversarial multi-user deployment;
- proving that self-improvement remains stable over long autonomous runs.

Those questions should be attacked experimentally through the existing Birth/Wake/Sleep/Evolution loop rather than hidden behind an external frontier model at runtime.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/TRAINING.md`](docs/TRAINING.md)
- [`docs/TOOL_OS.md`](docs/TOOL_OS.md)
- [`docs/ANDROMEDA.md`](docs/ANDROMEDA.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/VALIDATION.md`](docs/VALIDATION.md)

## License

Apache License 2.0.
