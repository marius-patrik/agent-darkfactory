from __future__ import annotations

from pathlib import Path

from genesis_os.config import RuntimeSettings, WorkspacePaths
from genesis_os.model.organism import Organism
from genesis_os.reality import RealityModel
from genesis_os.runtime.wake import WakeRuntime
from genesis_os.storage import LineageStore


from genesis_os.training.trainer import resolve_device


def load_runtime(
    workspace: str | Path,
    *,
    lineage_id: str,
    device: str = "cpu",
    settings: RuntimeSettings | None = None,
) -> WakeRuntime:
    paths = WorkspacePaths.from_root(workspace)
    paths.ensure()
    resolved = resolve_device(device)
    reference = LineageStore(paths.lineages).current(lineage_id)
    organism = Organism.from_checkpoint(reference, state_root=paths.state, device=resolved)
    return WakeRuntime(
        workspace=workspace,
        policy=organism,
        settings=settings,
        services={"reality_model": RealityModel(organism.model, device=resolved)},
    )
