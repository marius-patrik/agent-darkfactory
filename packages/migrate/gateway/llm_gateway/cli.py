"""Gateway CLI: model registry inspection and native server control."""

from __future__ import annotations

import json

import typer
from rich.console import Console
from rich.table import Table

from llm_gateway.registry import ModelRegistry, RegistryError
from llm_gateway.task_routing import TaskRouter, TaskRoutingError

app = typer.Typer(name="agent-os-gateway", help="Agent OS gateway CLI")
console = Console()


def _registry() -> ModelRegistry:
    return ModelRegistry()


def _task_router() -> TaskRouter:
    return TaskRouter(_registry())


@app.command("serve")
def serve(
    host: str = typer.Option("127.0.0.1", "--host", "-h"),
    port: int = typer.Option(8787, "--port", "-p"),
    reload: bool = typer.Option(False, "--reload"),
) -> None:
    """Start the gateway server."""
    import uvicorn
    uvicorn.run("llm_gateway.main:app", host=host, port=port, reload=reload)


@app.command("model-list")
def model_list(
    role: str | None = typer.Option(None, "--role", "-r"),
    show_disabled: bool = typer.Option(False, "--all", "-a"),
) -> None:
    """List registered models."""
    reg = _registry()
    models = reg.list_all() if show_disabled else reg.list_enabled()
    if role:
        models = [m for m in models if m.role == role]

    table = Table(title="Model Registry")
    table.add_column("ID", style="cyan")
    table.add_column("Name")
    table.add_column("Provider")
    table.add_column("Role")
    table.add_column("Ctx")
    table.add_column("GPU")
    table.add_column("TP")
    table.add_column("Quant")
    table.add_column("Enabled")

    for m in models:
        table.add_row(
            m.id,
            m.name,
            m.provider,
            m.role,
            str(m.context_length),
            m.gpu or "-",
            str(m.tensor_parallel) if m.tensor_parallel is not None else "-",
            m.quant or "-",
            "yes" if m.enabled else "no",
        )
    console.print(table)


@app.command("validate")
def validate_registry() -> None:
    """Validate the registry file against its schema."""
    try:
        _registry()
        console.print("[green]Registry is valid[/green]")
    except RegistryError as exc:
        console.print(f"[red]Registry invalid: {exc}[/red]")
        raise typer.Exit(1)


@app.command("route")
def route_task(
    task_class: str = typer.Argument(..., help="Task class to resolve, such as mechanical or hard-impl"),
    json_output: bool = typer.Option(False, "--json", help="Emit JSON for automation"),
) -> None:
    """Resolve a task class to provider, model, and params."""
    try:
        resolution = _task_router().resolve(task_class).to_dict()
    except TaskRoutingError as exc:
        console.print(f"[red]Route failed: {exc}[/red]")
        raise typer.Exit(1) from exc

    if json_output:
        console.print(json.dumps(resolution, indent=2))
        return

    table = Table(title=f"Route: {task_class}")
    table.add_column("Provider", style="cyan")
    table.add_column("Model ID")
    table.add_column("Model")
    table.add_column("Params")
    table.add_row(
        resolution["provider"],
        resolution["model_id"],
        resolution["model"],
        json.dumps(resolution["params"], sort_keys=True),
    )
    console.print(table)


if __name__ == "__main__":
    app()
