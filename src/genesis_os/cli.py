from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Annotated, Any

import typer
import uvicorn
import yaml
from rich.console import Console
from rich.table import Table

from genesis_os.birth import BirthRunner, BirthSpec
from genesis_os.birth.ingest import PersonalDataIngestor
from genesis_os.birth.spec import CurriculumSpec, CurriculumStageSpec, ViabilitySpec
from genesis_os.config import RuntimeSettings, WorkspacePaths
from genesis_os.evolution import EvolutionEngine, EvolutionSpec, HarnessGenome
from genesis_os.model.genome import ModelGenome
from genesis_os.runtime.factory import load_runtime
from genesis_os.runtime.wake import WakeRuntime
from genesis_os.server import create_app
from genesis_os.sleep import SleepProgram, SleepSpec
from genesis_os.sleep.spec import PromotionGateSpec
from genesis_os.storage import ArtifactStore, ExperienceLedger, LineageStore
from genesis_os.tools.builtins import register_builtin_tools
from genesis_os.tools.registry import ToolRegistry
from genesis_os.training.trainer import TrainingConfig
from genesis_os.types import Observation, ToolCall

app = typer.Typer(no_args_is_help=True, help="Genesis OS lifecycle and runtime CLI.")
ledger_app = typer.Typer(no_args_is_help=True, help="Inspect and verify autobiographical history.")
tool_app = typer.Typer(no_args_is_help=True, help="Inspect and invoke AI OS tools.")
lineage_app = typer.Typer(no_args_is_help=True, help="Inspect and move model lineage pointers.")
app.add_typer(ledger_app, name="ledger")
app.add_typer(tool_app, name="tools")
app.add_typer(lineage_app, name="lineage")
console = Console()


def _yaml(path: Path) -> dict[str, Any]:
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise typer.BadParameter(f"Configuration must be a YAML object: {path}")
    return value


def _tiny_birth_spec() -> BirthSpec:
    return BirthSpec(
        name="genesis-tiny",
        genome=ModelGenome(
            d_model=64,
            n_layers=2,
            n_heads=4,
            ff_multiplier=3.0,
            max_sequence_length=384,
            memory_slots=4,
            world_latent_dim=32,
            max_modality_tokens=32,
            structured_feature_dim=16,
            image_patch_size=8,
            audio_kernel_size=64,
            audio_stride=32,
        ),
        curriculum=CurriculumSpec(
            validation_fraction=0.1,
            stages=(
                CurriculumStageSpec(name="arithmetic", generator="arithmetic", examples=64),
                CurriculumStageSpec(name="tools", generator="tool_use", examples=128, weight=1.5),
                CurriculumStageSpec(
                    name="memory", generator="memory_recall", examples=64, weight=1.4
                ),
            ),
            remediation_rounds=0,
        ),
        training=TrainingConfig(
            seed=42,
            epochs=10,
            max_steps=100,
            batch_size=8,
            learning_rate=1e-3,
            warmup_steps=10,
            world_loss_weight=0.1,
            device="auto",
            log_every=10,
        ),
        viability=ViabilitySpec(
            max_validation_loss=20.0,
            min_tool_name_accuracy=0.0,
            generation_samples=0,
            max_generation_tokens=128,
        ),
    )


def _resolve_config_paths(spec: BirthSpec, config_path: Path) -> BirthSpec:
    """Resolve all file-bearing Birth inputs relative to the owning YAML file."""
    personal = spec.curriculum.personal
    resolved = tuple(
        source if source.is_absolute() else (config_path.parent / source).resolve()
        for source in personal.sources
    )
    stages = []
    for stage in spec.curriculum.stages:
        parameters = dict(stage.parameters)
        raw_paths = parameters.get("paths") if stage.generator == "textbook" else None
        if isinstance(raw_paths, (list, tuple)):
            parameters["paths"] = [
                str(
                    Path(str(raw)).expanduser()
                    if Path(str(raw)).expanduser().is_absolute()
                    else (config_path.parent / str(raw)).expanduser().resolve()
                )
                for raw in raw_paths
            ]
        stages.append(stage.model_copy(update={"parameters": parameters}))
    curriculum = spec.curriculum.model_copy(
        update={
            "personal": personal.model_copy(update={"sources": resolved}),
            "stages": tuple(stages),
        }
    )
    return spec.model_copy(update={"curriculum": curriculum})


def _resolve_workspace(workspace: Path | None = None) -> Path:
    if workspace is not None:
        return workspace.resolve()

    env_workspace = os.getenv("GENESIS_WORKSPACE")
    if env_workspace:
        return Path(env_workspace).expanduser().resolve()

    cwd = Path.cwd().resolve()
    genesis_dir = cwd / ".genesis"
    if genesis_dir.exists():
        first_ai = genesis_dir / "first_ai"
        if first_ai.exists():
            return first_ai
        subdirs = [d for d in genesis_dir.iterdir() if d.is_dir() and d.name not in {"scratch", "logs"}]
        if subdirs:
            return sorted(subdirs)[0]
        return genesis_dir

    home_genesis = Path.home() / ".genesis"
    if home_genesis.exists():
        first_ai = home_genesis / "first_ai"
        if first_ai.exists():
            return first_ai
        subdirs = [d for d in home_genesis.iterdir() if d.is_dir() and d.name not in {"scratch", "logs"}]
        if subdirs:
            return sorted(subdirs)[0]

    return (cwd / ".genesis" / "default").resolve()


@app.command()
def init(
    workspace: Annotated[
        Path | None, typer.Argument(help="Workspace directory (auto-resolved if omitted)")
    ] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    paths = WorkspacePaths.from_root(target_workspace)
    paths.ensure()
    ExperienceLedger(paths.database)
    console.print(f"Initialized Genesis workspace: [bold]{paths.root}[/bold]")


def _resolve_lineage(workspace: Path | None, lineage: str | None) -> str:
    target_workspace = _resolve_workspace(workspace)
    store = LineageStore(WorkspacePaths.from_root(target_workspace).lineages)
    lineages = store.list_lineages()
    promoted = [info for info in lineages if info.get("current_release_id")]

    if lineage is not None:
        try:
            store.current(lineage)
            return lineage
        except FileNotFoundError:
            if promoted:
                available = ", ".join(info["lineage_id"] for info in promoted)
                raise typer.BadParameter(
                    f"Lineage '{lineage}' has no promoted release in workspace '{target_workspace}'. "
                    f"Available promoted lineages: {available}"
                ) from None
            elif lineages:
                available = ", ".join(info["lineage_id"] for info in lineages)
                raise typer.BadParameter(
                    f"Lineage '{lineage}' has no promoted release in workspace '{target_workspace}'. "
                    f"Unpromoted lineages: {available}. Use 'genesis lineage promote' to promote a release."
                ) from None
            else:
                raise typer.BadParameter(
                    f"Workspace '{target_workspace}' contains no lineages. Run 'genesis birth' first."
                ) from None

    if promoted:
        sorted_promoted = sorted(
            promoted, key=lambda info: info.get("promoted_at") or "", reverse=True
        )
        selected = str(sorted_promoted[0]["lineage_id"])
        console.print(f"[dim]Auto-selected active lineage: [bold]{selected}[/bold][/dim]")
        return selected

    if lineages:
        available = ", ".join(info["lineage_id"] for info in lineages)
        raise typer.BadParameter(
            f"No lineage in workspace '{target_workspace}' has a promoted release yet. "
            f"Unpromoted lineages: {available}. Use 'genesis lineage promote' to promote a release."
        )

    raise typer.BadParameter(
        f"No lineages found in workspace '{target_workspace}'. Run 'genesis birth' first."
    )


@app.command()
def birth(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
    config: Annotated[Path | None, typer.Option("--config", "-c")] = None,
    tiny: Annotated[
        bool, typer.Option("--tiny", help="Use a CPU-scale developmental birth")
    ] = False,
    lineage: Annotated[
        str | None,
        typer.Option("--lineage", "-l", help="Target lineage ID (auto-created if omitted)"),
    ] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    if config is None and not tiny:
        raise typer.BadParameter("Provide --config or --tiny")
    if config is not None and tiny:
        raise typer.BadParameter("Choose either --config or --tiny")
    if tiny:
        spec = _tiny_birth_spec()
    else:
        assert config is not None
        spec = BirthSpec.model_validate(_yaml(config))
        spec = _resolve_config_paths(spec, config.resolve())
    if lineage is not None:
        spec = spec.model_copy(update={"lineage_id": lineage})
    console.print(
        f"Birthing [bold]{spec.name}[/bold] from {spec.initialization.mode.value} weights "
        f"with {sum(stage.examples for stage in spec.curriculum.stages):,} generated lessons."
    )
    certificate = BirthRunner(target_workspace).run(spec)
    console.print_json(certificate.model_dump_json(indent=2))
    console.print(
        f"[green]Birth complete.[/green] To wake this organism, run:\n"
        f"  [bold]genesis wake --lineage {certificate.lineage_id}[/bold]"
    )


@app.command()
def wake(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
    lineage: Annotated[
        str | None,
        typer.Option("--lineage", "-l", help="Lineage ID (auto-selected if omitted)"),
    ] = None,
    message: Annotated[str | None, typer.Option("--message", "-m")] = None,
    session: Annotated[str | None, typer.Option("--session")] = None,
    device: Annotated[str, typer.Option("--device")] = "auto",
    interactive: Annotated[bool, typer.Option("--interactive", "-i")] = False,
    max_tool_steps: Annotated[int, typer.Option("--max-tool-steps")] = 8,
    temperature: Annotated[float, typer.Option("--temperature")] = 0.0,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    target_lineage = _resolve_lineage(target_workspace, lineage)
    runtime = load_runtime(
        target_workspace,
        lineage_id=target_lineage,
        device=device,
        settings=RuntimeSettings(
            max_tool_steps=max_tool_steps,
            temperature=temperature,
        ),
    )

    async def run_once(content: str, session_id: str | None) -> str:
        result = await runtime.observe(
            Observation(source="user", content=content), session_id=session_id
        )
        for output in result.messages:
            console.print(output)
        if not result.messages:
            console.print(
                f"[dim]No communication.respond output. Tools: "
                f"{[value.tool for value in result.tool_results]}[/dim]"
            )
        return result.session_id

    if interactive:
        active_session = session
        console.print("Interactive Wake session. Enter /exit to stop.")
        while True:
            content = console.input("[bold]you>[/bold] ")
            if content.strip() in {"/exit", "/quit"}:
                break
            active_session = asyncio.run(run_once(content, active_session))
    elif message is not None:
        asyncio.run(run_once(message, session))
    else:
        raise typer.BadParameter("Provide --message or --interactive")


@app.command()
def sleep(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
    lineage: Annotated[
        str | None,
        typer.Option("--lineage", "-l", help="Lineage ID (auto-selected if omitted)"),
    ] = None,
    config: Annotated[Path | None, typer.Option("--config", "-c")] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    target_lineage = _resolve_lineage(target_workspace, lineage)
    spec = SleepSpec.model_validate(_yaml(config)) if config else SleepSpec()
    result = SleepProgram(target_workspace).run(target_lineage, spec)
    console.print_json(result.model_dump_json(indent=2))


@app.command()
def serve(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
    lineage: Annotated[
        str | None,
        typer.Option("--lineage", "-l", help="Lineage ID (auto-selected if omitted)"),
    ] = None,
    host: Annotated[str, typer.Option("--host")] = "127.0.0.1",
    port: Annotated[int, typer.Option("--port")] = 8787,
    device: Annotated[str, typer.Option("--device")] = "auto",
    allow_python_tools: Annotated[bool, typer.Option("--allow-python-tools")] = False,
    allow_process_tools: Annotated[bool, typer.Option("--allow-process-tools")] = False,
    allow_network_tools: Annotated[bool, typer.Option("--allow-network-tools")] = False,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    target_lineage = _resolve_lineage(target_workspace, lineage)
    settings = RuntimeSettings(
        allow_python_tools=allow_python_tools,
        allow_process_tools=allow_process_tools,
        allow_network_tools=allow_network_tools,
    )
    uvicorn.run(
        create_app(
            workspace=target_workspace,
            lineage_id=target_lineage,
            device=device,
            settings=settings,
        ),
        host=host,
        port=port,
    )


@app.command()
def ingest(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
    sources: Annotated[list[Path], typer.Argument(help="Files or directories to ingest")] = None,
    output: Annotated[Path | None, typer.Option("--output", "-o")] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    paths = WorkspacePaths.from_root(target_workspace)
    paths.ensure()
    records = PersonalDataIngestor(
        artifacts=ArtifactStore(paths.artifacts), redact_secrets=True
    ).ingest(sources or [])
    target = output or (paths.datasets / "personal-manifest.jsonl")
    target.parent.mkdir(parents=True, exist_ok=True)
    from dataclasses import asdict

    with target.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(asdict(record), ensure_ascii=False, sort_keys=True) + "\n")
    quarantined = sum(record.quarantined for record in records)
    console.print(
        f"Compiled {len(records):,} personal records to {target}; "
        f"{quarantined:,} were secret-quarantined."
    )


@app.command()
def evolve(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
    birth_config: Annotated[Path, typer.Option("--birth-config")] = None,
    sleep_config: Annotated[Path | None, typer.Option("--sleep-config")] = None,
    generations: Annotated[int, typer.Option("--generations")] = 1,
    population: Annotated[int, typer.Option("--population")] = 3,
    no_sleep_trial: Annotated[bool, typer.Option("--no-sleep-trial")] = False,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    birth_spec = BirthSpec.model_validate(_yaml(birth_config))
    birth_spec = _resolve_config_paths(birth_spec, birth_config.resolve())
    sleep_spec = SleepSpec.model_validate(_yaml(sleep_config)) if sleep_config else SleepSpec()
    result = EvolutionEngine(target_workspace).run(
        HarnessGenome(birth=birth_spec, sleep=sleep_spec),
        EvolutionSpec(
            generations=generations,
            population=population,
            run_sleep_trial=not no_sleep_trial,
        ),
    )
    console.print_json(result.model_dump_json(indent=2))


@ledger_app.command("verify")
def ledger_verify(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    ledger = ExperienceLedger(WorkspacePaths.from_root(target_workspace).database)
    valid, errors = ledger.verify()
    if valid:
        console.print(f"Ledger verified: {ledger.latest_sequence():,} immutable events.")
    else:
        for error in errors:
            console.print(f"[red]{error}[/red]")
        raise typer.Exit(1)


@ledger_app.command("export")
def ledger_export(
    output: Annotated[Path, typer.Option("--output", "-o")],
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    target = ExperienceLedger(WorkspacePaths.from_root(target_workspace).database).export_jsonl(output)
    console.print(f"Exported ledger to {target}")


@lineage_app.command("list")
def lineage_list(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    store = LineageStore(WorkspacePaths.from_root(target_workspace).lineages)
    table = Table("Lineage", "Current release", "Created", "Name")
    for value in store.list_lineages():
        metadata = value.get("metadata", {})
        table.add_row(
            str(value["lineage_id"]),
            str(value.get("current_release_id") or "—"),
            str(value.get("created_at") or "—"),
            str(metadata.get("name") or "—") if isinstance(metadata, dict) else "—",
        )
    console.print(table)


@lineage_app.command("releases")
def lineage_releases(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
    lineage: Annotated[
        str | None,
        typer.Option("--lineage", "-l", help="Lineage ID (auto-selected if omitted)"),
    ] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    lineage_id = _resolve_lineage(target_workspace, lineage)
    store = LineageStore(WorkspacePaths.from_root(target_workspace).lineages)
    try:
        current_ref = store.current(lineage_id)
        current_release_id = current_ref.release_id
    except FileNotFoundError:
        current_release_id = None
    table = Table("Release", "Current", "Parent", "Created", "Validation loss")
    for value in store.list_releases(lineage_id):
        metrics = value.get("metrics", {})
        table.add_row(
            str(value["release_id"]),
            "yes" if value["release_id"] == current_release_id else "",
            str(value.get("parent_release_id") or "—"),
            str(value.get("created_at") or "—"),
            str(metrics.get("validation_loss", "—")) if isinstance(metrics, dict) else "—",
        )
    console.print(table)


@lineage_app.command("promote")
def lineage_promote(
    lineage: Annotated[str, typer.Option("--lineage", "-l")],
    release: Annotated[str, typer.Option("--release", "-r")],
    reason: Annotated[str, typer.Option("--reason")],
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    store = LineageStore(WorkspacePaths.from_root(target_workspace).lineages)
    reference = store.promote_release(
        lineage,
        release,
        reason={"manual": True, "reason": reason},
    )
    console.print(
        f"Promoted verified release [bold]{reference.release_id}[/bold] "
        f"for lineage [bold]{lineage}[/bold]."
    )


@tool_app.command("list")
def tools_list(
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    paths = WorkspacePaths.from_root(target_workspace)
    paths.ensure()
    registry = ToolRegistry(paths.dynamic_tools)
    register_builtin_tools(registry)
    registry.refresh_dynamic()
    table = Table("Name", "Kind", "Capabilities", "Description")
    for tool in registry.list():
        table.add_row(
            tool.spec.name,
            tool.spec.kind.value,
            ", ".join(sorted(value.value for value in tool.spec.capabilities)) or "—",
            tool.spec.description,
        )
    console.print(table)


class _UnusedPolicy:
    def __init__(self) -> None:
        self.self_state: dict[str, object] = {"mode": "direct-tool-cli"}

    def generate_tool_call(self, *_: Any, **__: Any) -> tuple[ToolCall, str]:
        raise RuntimeError("Direct tool CLI does not run model inference")


@tool_app.command("invoke")
def tools_invoke(
    name: Annotated[str, typer.Argument()],
    workspace: Annotated[
        Path | None, typer.Option("--workspace", "-w", help="Workspace directory (auto-resolved if omitted)")
    ] = None,
    arguments: Annotated[str, typer.Option("--arguments", "-a")] = "{}",
    allow_python_tools: Annotated[bool, typer.Option("--allow-python-tools")] = False,
    allow_process_tools: Annotated[bool, typer.Option("--allow-process-tools")] = False,
) -> None:
    target_workspace = _resolve_workspace(workspace)
    payload = json.loads(arguments)
    if not isinstance(payload, dict):
        raise typer.BadParameter("--arguments must decode to a JSON object")
    runtime = WakeRuntime(
        workspace=target_workspace,
        policy=_UnusedPolicy(),
        settings=RuntimeSettings(
            allow_python_tools=allow_python_tools,
            allow_process_tools=allow_process_tools,
        ),
    )
    result = asyncio.run(runtime.invoke_tool(ToolCall(tool=name, arguments=payload)))
    console.print_json(result.model_dump_json(indent=2))
    if not result.ok:
        raise typer.Exit(1)


@app.command()
def demo(
    workspace: Annotated[Path, typer.Option("--workspace", "-w")] = Path(".genesis/demo"),
    reset: Annotated[bool, typer.Option("--reset/--no-reset")] = True,
) -> None:
    """Run a compact Birth -> tool-only Wake -> Sleep -> promotion proof."""
    if reset and workspace.exists():
        shutil.rmtree(workspace)
    certificate = BirthRunner(workspace).run(_tiny_birth_spec())
    console.print(
        f"Birth completed: lineage={certificate.lineage_id}, release={certificate.release.release_id}"
    )

    class DemonstrationPolicy:
        def __init__(self) -> None:
            self.index = 0
            self.calls = [
                ToolCall(
                    tool="memory.append",
                    arguments={
                        "content": "The verified demonstration token is COBALT-731.",
                        "tags": ["demo", "verified"],
                        "importance": 1.0,
                    },
                ),
                ToolCall(
                    tool="communication.respond",
                    arguments={"text": "I recorded the verified demonstration token."},
                ),
                ToolCall(tool="runtime.yield", arguments={"reason": "demo trajectory complete"}),
            ]

        @property
        def self_state(self) -> dict[str, object]:
            return {
                "lineage_id": certificate.lineage_id,
                "release_id": certificate.release.release_id,
                "demo_controlled_trajectory": True,
                "wake_weights_mutable": False,
            }

        def generate_tool_call(self, *_: Any, **__: Any) -> tuple[ToolCall, str]:
            call = self.calls[min(self.index, len(self.calls) - 1)]
            self.index += 1
            return call, json.dumps(
                {"tool": call.tool, "arguments": call.arguments}, separators=(",", ":")
            )

    runtime = WakeRuntime(workspace=workspace, policy=DemonstrationPolicy())
    wake_result = asyncio.run(
        runtime.observe(
            Observation(
                source="user",
                content="Remember the verified demonstration token and acknowledge it.",
            ),
            session_id="demo-session",
        )
    )
    console.print(f"Wake tools: {[value.tool for value in wake_result.tool_results]}")
    for message in wake_result.messages:
        console.print(message)

    sleep_spec = SleepSpec(
        replay_examples=128,
        generation_samples=0,
        training=TrainingConfig(
            epochs=5,
            max_steps=60,
            batch_size=8,
            learning_rate=5e-4,
            warmup_steps=5,
            device="auto",
        ),
        gate=PromotionGateSpec(
            max_new_loss_regression=0.05,
            min_new_loss_improvement=0.0,
            max_foundation_relative_regression=0.25,
            max_tool_accuracy_drop=1.0,
        ),
    )
    sleep_result = SleepProgram(workspace).run(certificate.lineage_id, sleep_spec)
    console.print_json(sleep_result.model_dump_json(indent=2))
    valid, errors = ExperienceLedger(WorkspacePaths.from_root(workspace).database).verify()
    if not valid:
        raise RuntimeError(f"Demo ledger failed integrity: {errors}")
    console.print(
        f"Demo complete. Candidate {'promoted' if sleep_result.promoted else 'retained but rejected'}; "
        "all actions were tool calls and all durable updates occurred under Sleep."
    )


if __name__ == "__main__":
    app()
