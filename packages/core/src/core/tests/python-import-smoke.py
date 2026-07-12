"""Smoke test: the generated Python stubs are importable by a consumer.

This test is invoked by ``scripts/python-smoke.mjs``. The test runner sets
``PYTHONPATH`` to the directory that contains the ``agent`` package, mirroring
the in-repository inference Python consumer layout.
"""

import agent.gen
from agent_os.v1 import common_pb2, registry_pb2, session_frames_pb2


def main() -> None:
    host = common_pb2.Host(id="smoke")
    assert host.id == "smoke", "protobuf message construction failed"

    req = registry_pb2.ListModelsRequest()
    assert req.DESCRIPTOR.full_name == "agent_os.v1.ListModelsRequest", (
        f"unexpected message descriptor: {req.DESCRIPTOR.full_name}"
    )

    registry_service = registry_pb2.DESCRIPTOR.services_by_name["RegistryService"]
    assert registry_service.full_name == "agent_os.v1.RegistryService", (
        "unexpected service descriptor"
    )

    frame = session_frames_pb2.ServerFrame()
    assert frame.DESCRIPTOR.full_name == "agent_os.v1.ServerFrame", (
        "unexpected frame descriptor"
    )

    print("Agent OS core Python import smoke test passed")


if __name__ == "__main__":
    main()
