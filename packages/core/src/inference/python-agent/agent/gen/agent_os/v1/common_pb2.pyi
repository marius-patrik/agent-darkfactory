import datetime

from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf import timestamp_pb2 as _timestamp_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class SwitcherAxis(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SWITCHER_AXIS_UNSPECIFIED: _ClassVar[SwitcherAxis]
    SWITCHER_AXIS_HOST: _ClassVar[SwitcherAxis]
    SWITCHER_AXIS_FABRIC: _ClassVar[SwitcherAxis]
    SWITCHER_AXIS_PROVIDER: _ClassVar[SwitcherAxis]
    SWITCHER_AXIS_MODEL: _ClassVar[SwitcherAxis]
    SWITCHER_AXIS_AGENT: _ClassVar[SwitcherAxis]

class SwitcherScope(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SWITCHER_SCOPE_UNSPECIFIED: _ClassVar[SwitcherScope]
    SWITCHER_SCOPE_SESSION: _ClassVar[SwitcherScope]
    SWITCHER_SCOPE_PROJECT: _ClassVar[SwitcherScope]
    SWITCHER_SCOPE_GLOBAL: _ClassVar[SwitcherScope]

class Fabric(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    FABRIC_UNSPECIFIED: _ClassVar[Fabric]
    FABRIC_CLUSTER: _ClassVar[Fabric]
    FABRIC_LOCAL: _ClassVar[Fabric]
    FABRIC_CLOUD: _ClassVar[Fabric]

class PermissionMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PERMISSION_MODE_UNSPECIFIED: _ClassVar[PermissionMode]
    PERMISSION_MODE_PLAN: _ClassVar[PermissionMode]
    PERMISSION_MODE_ASK: _ClassVar[PermissionMode]
    PERMISSION_MODE_AUTO_ACCEPT_EDITS: _ClassVar[PermissionMode]
    PERMISSION_MODE_FULL_AUTO: _ClassVar[PermissionMode]

class RunStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    RUN_STATUS_UNSPECIFIED: _ClassVar[RunStatus]
    RUN_STATUS_USEFUL_RESULT: _ClassVar[RunStatus]
    RUN_STATUS_NO_ARTIFACT: _ClassVar[RunStatus]
    RUN_STATUS_MISSING_EVIDENCE: _ClassVar[RunStatus]
    RUN_STATUS_UNRESOLVED: _ClassVar[RunStatus]
    RUN_STATUS_BLOCKED: _ClassVar[RunStatus]
    RUN_STATUS_FAILED: _ClassVar[RunStatus]
    RUN_STATUS_RELEASED: _ClassVar[RunStatus]
    RUN_STATUS_EXPIRED: _ClassVar[RunStatus]
    RUN_STATUS_RUNNING: _ClassVar[RunStatus]
    RUN_STATUS_PAUSED: _ClassVar[RunStatus]
SWITCHER_AXIS_UNSPECIFIED: SwitcherAxis
SWITCHER_AXIS_HOST: SwitcherAxis
SWITCHER_AXIS_FABRIC: SwitcherAxis
SWITCHER_AXIS_PROVIDER: SwitcherAxis
SWITCHER_AXIS_MODEL: SwitcherAxis
SWITCHER_AXIS_AGENT: SwitcherAxis
SWITCHER_SCOPE_UNSPECIFIED: SwitcherScope
SWITCHER_SCOPE_SESSION: SwitcherScope
SWITCHER_SCOPE_PROJECT: SwitcherScope
SWITCHER_SCOPE_GLOBAL: SwitcherScope
FABRIC_UNSPECIFIED: Fabric
FABRIC_CLUSTER: Fabric
FABRIC_LOCAL: Fabric
FABRIC_CLOUD: Fabric
PERMISSION_MODE_UNSPECIFIED: PermissionMode
PERMISSION_MODE_PLAN: PermissionMode
PERMISSION_MODE_ASK: PermissionMode
PERMISSION_MODE_AUTO_ACCEPT_EDITS: PermissionMode
PERMISSION_MODE_FULL_AUTO: PermissionMode
RUN_STATUS_UNSPECIFIED: RunStatus
RUN_STATUS_USEFUL_RESULT: RunStatus
RUN_STATUS_NO_ARTIFACT: RunStatus
RUN_STATUS_MISSING_EVIDENCE: RunStatus
RUN_STATUS_UNRESOLVED: RunStatus
RUN_STATUS_BLOCKED: RunStatus
RUN_STATUS_FAILED: RunStatus
RUN_STATUS_RELEASED: RunStatus
RUN_STATUS_EXPIRED: RunStatus
RUN_STATUS_RUNNING: RunStatus
RUN_STATUS_PAUSED: RunStatus

class Host(_message.Message):
    __slots__ = ("id", "online", "label")
    ID_FIELD_NUMBER: _ClassVar[int]
    ONLINE_FIELD_NUMBER: _ClassVar[int]
    LABEL_FIELD_NUMBER: _ClassVar[int]
    id: str
    online: bool
    label: str
    def __init__(self, id: _Optional[str] = ..., online: _Optional[bool] = ..., label: _Optional[str] = ...) -> None: ...

class Provider(_message.Message):
    __slots__ = ("id", "fabric", "enabled", "label")
    ID_FIELD_NUMBER: _ClassVar[int]
    FABRIC_FIELD_NUMBER: _ClassVar[int]
    ENABLED_FIELD_NUMBER: _ClassVar[int]
    LABEL_FIELD_NUMBER: _ClassVar[int]
    id: str
    fabric: Fabric
    enabled: bool
    label: str
    def __init__(self, id: _Optional[str] = ..., fabric: _Optional[_Union[Fabric, str]] = ..., enabled: _Optional[bool] = ..., label: _Optional[str] = ...) -> None: ...

class Model(_message.Message):
    __slots__ = ("id", "provider_id", "fabric", "role", "context_length", "quant", "enabled", "cloud")
    ID_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_ID_FIELD_NUMBER: _ClassVar[int]
    FABRIC_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_LENGTH_FIELD_NUMBER: _ClassVar[int]
    QUANT_FIELD_NUMBER: _ClassVar[int]
    ENABLED_FIELD_NUMBER: _ClassVar[int]
    CLOUD_FIELD_NUMBER: _ClassVar[int]
    id: str
    provider_id: str
    fabric: Fabric
    role: str
    context_length: int
    quant: str
    enabled: bool
    cloud: bool
    def __init__(self, id: _Optional[str] = ..., provider_id: _Optional[str] = ..., fabric: _Optional[_Union[Fabric, str]] = ..., role: _Optional[str] = ..., context_length: _Optional[int] = ..., quant: _Optional[str] = ..., enabled: _Optional[bool] = ..., cloud: _Optional[bool] = ...) -> None: ...

class SwitcherState(_message.Message):
    __slots__ = ("host", "fabric", "provider", "model", "agent", "scope_source")
    HOST_FIELD_NUMBER: _ClassVar[int]
    FABRIC_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    AGENT_FIELD_NUMBER: _ClassVar[int]
    SCOPE_SOURCE_FIELD_NUMBER: _ClassVar[int]
    host: str
    fabric: Fabric
    provider: str
    model: str
    agent: str
    scope_source: SwitcherScope
    def __init__(self, host: _Optional[str] = ..., fabric: _Optional[_Union[Fabric, str]] = ..., provider: _Optional[str] = ..., model: _Optional[str] = ..., agent: _Optional[str] = ..., scope_source: _Optional[_Union[SwitcherScope, str]] = ...) -> None: ...

class Node(_message.Message):
    __slots__ = ("id", "role", "online")
    ID_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    ONLINE_FIELD_NUMBER: _ClassVar[int]
    id: str
    role: str
    online: bool
    def __init__(self, id: _Optional[str] = ..., role: _Optional[str] = ..., online: _Optional[bool] = ...) -> None: ...

class Usage(_message.Message):
    __slots__ = ("input_tokens", "output_tokens", "cost_micros", "degraded_to_local", "provider", "model")
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    COST_MICROS_FIELD_NUMBER: _ClassVar[int]
    DEGRADED_TO_LOCAL_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    input_tokens: int
    output_tokens: int
    cost_micros: int
    degraded_to_local: bool
    provider: str
    model: str
    def __init__(self, input_tokens: _Optional[int] = ..., output_tokens: _Optional[int] = ..., cost_micros: _Optional[int] = ..., degraded_to_local: _Optional[bool] = ..., provider: _Optional[str] = ..., model: _Optional[str] = ...) -> None: ...

class Error(_message.Message):
    __slots__ = ("code", "message", "details")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DETAILS_FIELD_NUMBER: _ClassVar[int]
    code: str
    message: str
    details: _struct_pb2.Struct
    def __init__(self, code: _Optional[str] = ..., message: _Optional[str] = ..., details: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class Task(_message.Message):
    __slots__ = ("goal", "inputs", "acceptance", "priority", "source")
    GOAL_FIELD_NUMBER: _ClassVar[int]
    INPUTS_FIELD_NUMBER: _ClassVar[int]
    ACCEPTANCE_FIELD_NUMBER: _ClassVar[int]
    PRIORITY_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    goal: str
    inputs: _containers.RepeatedScalarFieldContainer[str]
    acceptance: str
    priority: int
    source: str
    def __init__(self, goal: _Optional[str] = ..., inputs: _Optional[_Iterable[str]] = ..., acceptance: _Optional[str] = ..., priority: _Optional[int] = ..., source: _Optional[str] = ...) -> None: ...

class Timestamps(_message.Message):
    __slots__ = ("created_at", "updated_at")
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    def __init__(self, created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...
