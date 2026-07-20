"""Gateway CLI: model registry management and server control."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer
import yaml
from rich.console import Console
from rich.table import Table

from agentos_gateway.registry import ModelRegistry, ActiveRoleManager, ModelEntry, RegistryError
from agentos_gateway.task_routing import TaskRouter, TaskRoutingError

app = typer.Typer(name="gateway", help="Agentos Gateway CLI")
console = Console()


def _registry() -> ModelRegistry:
    return ModelRegistry()


def _active() -> ActiveRoleManager:
    return ActiveRoleManager()


def _task_router() -> TaskRouter:
    return TaskRouter(_registry())


@app.command("serve")
def serve(
    host: str = typer.Option("0.0.0.0", "--host", "-h"),
    port: int = typer.Option(4000, "--port", "-p"),
    reload: bool = typer.Option(False, "--reload"),
) -> None:
    """Start the gateway server."""
    import uvicorn
    uvicorn.run("agentos_gateway.main:app", host=host, port=port, reload=reload)


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
    table.add_column("Cloud")
    table.add_column("Enabled")
    table.add_column("Fallback")

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
            "yes" if m.cloud else "no",
            "yes" if m.enabled else "no",
            m.fallback_model or "-",
        )
    console.print(table)


@app.command("model-add")
def model_add(
    file: Path = typer.Argument(..., help="YAML file with model definition"),
) -> None:
    """Add a model to the registry from a YAML file."""
    reg = _registry()
    with open(file, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    if not isinstance(raw, dict):
        console.print("[red]File must contain a single model dict[/red]")
        raise typer.Exit(1)

    entry = ModelEntry(raw)
    if reg.get(entry.id):
        console.print(f"[yellow]Model '{entry.id}' already exists. Use model-update to change it.[/yellow]")
        raise typer.Exit(1)

    reg.add(entry)
    console.print(f"[green]Added model '{entry.id}'[/green]")


@app.command("model-remove")
def model_remove(
    model_id: str = typer.Argument(...),
    force: bool = typer.Option(False, "--force"),
) -> None:
    """Remove a model from the registry."""
    reg = _registry()
    entry = reg.get(model_id)
    if entry is None:
        console.print(f"[red]Model '{model_id}' not found[/red]")
        raise typer.Exit(1)

    if not force:
        confirm = typer.confirm(f"Remove model '{model_id}'?")
        if not confirm:
            raise typer.Abort()

    reg.remove(model_id)
    console.print(f"[green]Removed model '{model_id}'[/green]")


@app.command("model-update")
def model_update(
    model_id: str = typer.Argument(...),
    field: str = typer.Argument(..., help="Field name to update"),
    value: str = typer.Argument(..., help="New value"),
) -> None:
    """Update a field on an existing model."""
    reg = _registry()
    entry = reg.get(model_id)
    if entry is None:
        console.print(f"[red]Model '{model_id}' not found[/red]")
        raise typer.Exit(1)

    # Coerce common types
    coerced: Any = value
    if field in ("context_length", "tensor_parallel"):
        coerced = int(value)
    elif field in ("enabled", "cloud"):
        coerced = value.lower() in ("true", "1", "yes", "on")
    elif field == "fallback_model" and value.lower() in ("null", "none", ""):
        coerced = None
    elif field == "api_base" and value.lower() in ("null", "none", ""):
        coerced = None

    updated = reg.update(model_id, {field: coerced})
    if updated:
        console.print(f"[green]Updated '{field}' on '{model_id}'[/green]")
    else:
        console.print("[red]Update failed[/red]")


@app.command("model-select")
def model_select(
    role: str = typer.Argument(..., help="Role: general | coding | conversation | judge | embedding"),
    model_id: str = typer.Argument(...),
) -> None:
    """Set the active model for a role."""
    reg = _registry()
    active = _active()

    entry = reg.get(model_id)
    if entry is None:
        console.print(f"[red]Model '{model_id}' not found[/red]")
        raise typer.Exit(1)
    if not entry.enabled:
        console.print(f"[red]Model '{model_id}' is disabled[/red]")
        raise typer.Exit(1)

    previous = active.set(role, model_id)
    console.print(f"[green]Role '{role}' → '{model_id}' (was '{previous or 'unset'}')[/green]")


@app.command("model-active")
def model_active() -> None:
    """Show active models per role."""
    active = _active()
    table = Table(title="Active Models")
    table.add_column("Role", style="cyan")
    table.add_column("Model ID")
    for role, model_id in active.all().items():
        table.add_row(role, model_id or "[dim]unset[/dim]")
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
    allow_cloud: bool = typer.Option(False, "--allow-cloud", help="Allow enabled cloud candidates"),
    json_output: bool = typer.Option(False, "--json", help="Emit JSON for automation"),
) -> None:
    """Resolve a task class to provider, model, and params."""
    try:
        resolution = _task_router().resolve(task_class, allow_cloud=allow_cloud).to_dict()
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
