# Architecture

## 1. System boundary

Genesis OS distinguishes four layers:

```text
Species   architecture, curriculum, objectives, Birth, reproduction, evolution
Life      Wake, experience, exact memory, Sleep, promotion
Organism  neural model, recurrent state, world model, self/user representations
Body      typed tools connecting the organism to environments
```

The stable substrate is deliberately small: artifact hashing, event-ledger integrity, capability checks, lineage manifests, evaluation inputs, atomic promotion, and rollback. Model architecture and training policy can evolve above that layer.

## 2. Lifecycle state machine

```text
UNBORN
  |
  | BirthSpec + curriculum + initialization
  v
BIRTHING --viability failure--> FAILED_BIRTH
  |
  | root release
  v
AWAKE <-------------------------------+
  |                                   |
  | exact experience                  | promoted descendant
  v                                   |
SLEEPING -> CANDIDATE -> EVALUATING --+
                        |
                        +-> REJECTED_BRANCH
```

Wake and Sleep are mutually exclusive for a lineage in the service process. The FastAPI runtime serializes observations and Sleep with a runtime lock; a production deployment should additionally use a distributed lineage lease when multiple processes share storage.

## 3. Neural organism

`GenesisNetwork` is an integrated but inspectable initial substrate.

### 3.1 Language/action backbone

A byte-level vocabulary avoids an externally fixed tokenizer and can represent arbitrary UTF-8 text and serialized tool calls. Transformer blocks use causal attention, RMS normalization, and SwiGLU feed-forward layers. The decoder emits only action envelopes at the operational boundary.

### 3.2 Persistent recurrent state

Each session has recurrent memory slots and a world-state vector stored separately from canonical weights. These survive inference calls and are loaded by lineage/session identifier. Wake may update this state because it is working memory, not a durable model release.

### 3.3 Multimodal representation

Image patches, audio frames, and structured features are encoded into shared and modality-private representations. Shared/private projection avoids forcing every modality-specific detail into one undifferentiated semantic vector.

Current training data loaders focus on textual/event examples. The tensor interfaces and forward path are implemented; a multimodal training program must supply aligned tensors and appropriate cross-modal losses.

### 3.4 World transition

The pooled cognitive state and prior world state parameterize a Gaussian latent transition. Training can align its mean and variance with the encoded next context. The `reality.simulate` tool recursively samples this transition under textual interventions.

### 3.5 Auxiliary heads

- value predicts observed outcome;
- uncertainty learns an error-magnitude proxy;
- self state projects an internal representation of the acting system;
- user state projects a representation intended for user-model objectives.

The initial trainer does not yet impose a dedicated contrastive loss on self/user heads. They are architectural extension points and become meaningful only when the curriculum supplies those targets.

## 4. Tool-native operating system

The neural policy selects an intention. No intention has an environmental effect until represented as a `ToolCall` and accepted by the Tool Kernel.

```text
policy output
   |
SchemaActionDecoder
   |
ToolCall(name, arguments)
   |
ledger TOOL_CALL event
   |
registry lookup -> capability policy -> JSON Schema validation
   |
execution -> output schema validation
   |
ledger TOOL_RESULT event
```

The tool catalog is generated from the live registry on every step, so newly installed tools are immediately discoverable. Tool names are selected through a byte trie; required argument structure is generated under schema constraints.

The initial constrained grammar intentionally emits required fields and omits optional fields unless represented by a tool-specific required schema. Semantic tool selection and useful argument values remain learned behavior.

## 5. Memory hierarchy

### 5.1 Working state

Recurrent memory slots, transient cognition notes, current tool result, active session, and world state.

### 5.2 Exact episodic memory

SQLite events are append-only and chained by SHA-256. Database triggers reject updates and deletes. Every event stores actor, timestamp, source, session, causation/correlation identifiers, importance, previous hash, and event hash.

### 5.3 Retrieval

The initial implementation uses SQLite FTS for exact/lexical autobiographical retrieval and explicit event/timeline tools. Learned associative retrieval is a planned model-side extension; exact source events remain authoritative even when a learned index is added.

### 5.4 Parametric consolidation

Sleep converts selected events into training examples. The ledger is not deleted when information is consolidated; weights encode semantic/procedural regularities while events retain exact chronology and provenance.

## 6. Birth

`BirthSpec` contains a `ModelGenome`, initialization policy, developmental curriculum, training configuration, viability suite, and metadata.

Curriculum stages form a dependency graph at the stage level. Textbook files contain a second prerequisite DAG at the concept level. A Birth fails early on unknown generators, missing sources, prerequisite violations, cyclic textbook dependencies, empty train/validation splits, or failed viability.

Initialization modes:

- `random`: seed parameters before construction;
- `inherit`: load a checkpoint and optionally require exact genome identity.

The inheritance mode is intended for descendants or externally initialized generation-zero models. It is not required for from-scratch Birth.

## 7. Procedural distillation

The procedural distiller generates temporary formal worlds with randomized symbols and values. Current task families include ordering, state transitions, implication-chain deduction, parity state machines, and local variable binding.

For each task:

1. create a task whose final answer can be exactly checked;
2. obtain a deterministic domain-general strategy;
3. optionally ask a teacher for a better strategy and answer;
4. reject teacher output unless the answer passes the executable verifier;
5. train a `cognition.record` planning action;
6. train a separate verified execution action.

This minimizes direct factual transfer. It does not mathematically guarantee that no teacher-specific representation is transferred.

## 8. Personal imprinting

The ingestor content-addresses all source files, preserves conversation roles and timestamps, and quarantines likely secrets. The compiler generates:

- exact user-statement recall with source events;
- user versus assistant attribution;
- conversation chronology;
- explicit user preference/requirement/identity/decision/goal memory writes;
- conservative personal-document preservation;
- optional, low-weight historical assistant imitation.

Assistant statements are not classified as user truth. Corrections and supersession remain event-level operations during Wake.

## 9. Sleep

Sleep establishes an immutable parent release and an event cursor. It then:

- verifies the entire ledger hash chain;
- compiles successful action selections;
- excludes failed calls from positive imitation;
- builds exact memory, event-ID, and timestamp questions;
- mixes prior datasets for replay;
- trains a separate candidate;
- evaluates parent and candidate on the same new-experience set;
- evaluates foundation retention;
- stores the candidate regardless of decision;
- atomically promotes only when the gate passes.

The cursor advances only after a promoted Sleep transaction. Rejected experience remains available for a later improved Sleep program.

## 10. Harness evolution

Evolution mutates inheritable machinery rather than the active organism directly. Candidate harnesses receive isolated workspaces and run real Birth and optional Sleep trials. The initial mutator changes dimensions, layer count, memory slots, latent size, curriculum weights, and optimization settings.

A production research program should replace the simple scalar score with multi-objective Pareto selection over capability, retention, calibration, efficiency, robustness, and safety.

## 11. Content and authority boundaries

Checkpoint writes require an unforgeable in-process authority token issued for Birth, Sleep, or Evolution. Runtime code receives no issuer. This is an architectural guard against accidental writes, not a security boundary against arbitrary code execution in the same Python process.

The stronger deployment boundary is process/container separation: run Wake with read-only release mounts and run Sleep in a separate worker with write access to candidate directories and atomic promotion metadata.
