"""CLI for the inference worker loop."""

from __future__ import annotations

import argparse
import asyncio
import json
import shlex
from pathlib import Path

from agent.loop.session import SessionConfig, run_session
from agent.loop.permissions import PermissionMode


def main() -> None:
    """Run the CLI."""
    parser = argparse.ArgumentParser(prog="agent-os-inference")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--session-id", required=True)
    run.add_argument("--agent-id", required=True)
    run.add_argument("--goal", required=True)
    run.add_argument("--task", required=True)
    run.add_argument("--acceptance-type", required=True)
    run.add_argument("--declared-outputs", nargs="*", default=[])
    run.add_argument("--build-cmd", help="Build command, parsed with shell-style splitting.")
    run.add_argument("--test-cmd", help="Test command, parsed with shell-style splitting.")
    run.add_argument("--model", default="qwen3-8b", help="Tool-capable model id; role aliases may reject tools.")
    run.add_argument(
        "--permission-mode",
        choices=[mode.value for mode in PermissionMode],
        default=PermissionMode.full_auto.value,
    )
    run.add_argument("--max-turns", type=int, default=12)
    run.add_argument("--workdir", default=".")
    args = parser.parse_args()
    if args.command == "run":
        outcome = asyncio.run(
            run_session(
                SessionConfig(
                    session_id=args.session_id,
                    agent_id=args.agent_id,
                    goal=args.goal,
                    task=args.task,
                    acceptance_type=args.acceptance_type,
                    declared_outputs=args.declared_outputs,
                    build_cmd=shlex.split(args.build_cmd) if args.build_cmd else None,
                    test_cmd=shlex.split(args.test_cmd) if args.test_cmd else None,
                    model=args.model,
                    max_turns=args.max_turns,
                    workdir=Path(args.workdir),
                    permission_mode=PermissionMode(args.permission_mode),
                )
            )
        )
        print(json.dumps(outcome.to_json_dict(), sort_keys=True))


if __name__ == "__main__":
    main()
