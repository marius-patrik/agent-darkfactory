# Tool-Native AI Operating System

## 1. Principle

The model may internally predict, attend, and update recurrent state, but any operation with a durable or externally observable effect is a tool. This makes agency typed, discoverable, auditable, trainable, and replaceable.

The model never receives a hidden Python object giving unrestricted environment access. It receives a serialized catalog of tools that are currently installed and permitted.

## 2. Tool manifest

Every tool defines:

- qualified name and semantic version;
- description;
- JSON Schema input and output;
- required capabilities;
- kind: built-in, workflow, or Python;
- timeout;
- deterministic flag;
- tags.

## 3. Built-in primitives

Built-ins are the minimal kernel calls from which richer behavior can be composed:

- `communication.respond`
- `runtime.yield`
- `memory.append`, `memory.search`, `memory.get`, `memory.timeline`
- `sleep.request`
- `tool.list`, `tool.describe`, `tool.refresh`
- `tool.create_workflow`, `tool.create_python`, `tool.remove`
- `workspace.read`, `workspace.write`, `workspace.list`
- `process.run`
- `cognition.record`, `cognition.inspect`
- `reality.simulate`
- `evolution.propose`

Built-ins are fixed substrate primitives. The organism is expected to create task-level dynamic tools from them rather than repeatedly constructing long low-level action sequences.

## 4. Workflow tools

Workflow manifests define a directed sequence of nested calls. Inputs and prior outputs can be projected into later arguments. The registry computes effective capabilities from nested tools, rejects self-recursion, and reloads installed manifests at runtime.

Workflow creation is the preferred default because it is declarative and easier to audit than generated source code.

## 5. Python tools

Python tools are appropriate when a declarative workflow cannot express the operation. Installation requires the `code_execute` and `tool_install` capabilities and an explicitly enabled runtime policy.

The validator rejects dangerous syntax/imports not covered by requested capabilities, then executes declared test vectors in a temporary workspace. Runtime invocation uses a separate process, bounded resources, timeout, JSON input/output, and no shell interpolation.

This does not replace a container, VM, seccomp profile, namespace isolation, or a dedicated unprivileged account.

## 6. Capability policy

Runtime settings deny high-impact categories by default:

```text
Python-generated code: denied
arbitrary subprocesses: denied
network-capable tools: denied
```

Workspace reads/writes, exact memory, communication, and safe workflow composition remain available under their own capabilities. Deployment policy can further deny individual tools or capability classes.

## 7. Audit trail

For each operation, the ledger records:

```text
STATE(action_selection)
  prompt
  raw generated action
  parsed call
  active release

TOOL_CALL
  call id
  tool
  arguments

TOOL_RESULT
  success/error
  output
  duration
  causal/correlation IDs
```

Sleep uses successful action selections as positive behavioral examples. Failed calls stay in the autobiography and can be converted into contrastive or correction data by future compilers.

## 8. Dynamic tool learning loop

```text
novel task
  -> decompose with cognition.record
  -> inspect available tools
  -> compose or implement a new tool
  -> run declared tests
  -> install
  -> refresh catalog
  -> use tool
  -> observe outcome
  -> Sleep consolidates successful selection/use
```

This is the practical bridge from “LLM with a fixed tool list” to a computational organism that expands its own action vocabulary while remaining inside an auditable operating system.
