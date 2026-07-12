from google.protobuf import struct_pb2 as _struct_pb2
from agent_os.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class SessionEventKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SESSION_EVENT_KIND_UNSPECIFIED: _ClassVar[SessionEventKind]
    SESSION_EVENT_KIND_SWITCH: _ClassVar[SessionEventKind]
    SESSION_EVENT_KIND_MODE: _ClassVar[SessionEventKind]
    SESSION_EVENT_KIND_PLAN: _ClassVar[SessionEventKind]
    SESSION_EVENT_KIND_WORKER: _ClassVar[SessionEventKind]
    SESSION_EVENT_KIND_COMPACTION: _ClassVar[SessionEventKind]
    SESSION_EVENT_KIND_ATTACH: _ClassVar[SessionEventKind]
    SESSION_EVENT_KIND_PAUSE: _ClassVar[SessionEventKind]
SESSION_EVENT_KIND_UNSPECIFIED: SessionEventKind
SESSION_EVENT_KIND_SWITCH: SessionEventKind
SESSION_EVENT_KIND_MODE: SessionEventKind
SESSION_EVENT_KIND_PLAN: SessionEventKind
SESSION_EVENT_KIND_WORKER: SessionEventKind
SESSION_EVENT_KIND_COMPACTION: SessionEventKind
SESSION_EVENT_KIND_ATTACH: SessionEventKind
SESSION_EVENT_KIND_PAUSE: SessionEventKind

class TextDelta(_message.Message):
    __slots__ = ("text", "worker_id")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    text: str
    worker_id: str
    def __init__(self, text: _Optional[str] = ..., worker_id: _Optional[str] = ...) -> None: ...

class Thinking(_message.Message):
    __slots__ = ("text", "worker_id")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    text: str
    worker_id: str
    def __init__(self, text: _Optional[str] = ..., worker_id: _Optional[str] = ...) -> None: ...

class ToolCall(_message.Message):
    __slots__ = ("call_id", "name", "args", "host", "worker_id")
    CALL_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    ARGS_FIELD_NUMBER: _ClassVar[int]
    HOST_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    call_id: str
    name: str
    args: _struct_pb2.Struct
    host: str
    worker_id: str
    def __init__(self, call_id: _Optional[str] = ..., name: _Optional[str] = ..., args: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., host: _Optional[str] = ..., worker_id: _Optional[str] = ...) -> None: ...

class ToolResult(_message.Message):
    __slots__ = ("call_id", "output", "is_error", "status", "artifact_ref")
    CALL_ID_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_FIELD_NUMBER: _ClassVar[int]
    IS_ERROR_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_REF_FIELD_NUMBER: _ClassVar[int]
    call_id: str
    output: str
    is_error: bool
    status: _common_pb2.RunStatus
    artifact_ref: str
    def __init__(self, call_id: _Optional[str] = ..., output: _Optional[str] = ..., is_error: _Optional[bool] = ..., status: _Optional[_Union[_common_pb2.RunStatus, str]] = ..., artifact_ref: _Optional[str] = ...) -> None: ...

class ApprovalRequest(_message.Message):
    __slots__ = ("approval_id", "tool_name", "host", "preview", "mode", "worker_id", "role")
    APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    TOOL_NAME_FIELD_NUMBER: _ClassVar[int]
    HOST_FIELD_NUMBER: _ClassVar[int]
    PREVIEW_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    approval_id: str
    tool_name: str
    host: str
    preview: str
    mode: _common_pb2.PermissionMode
    worker_id: str
    role: str
    def __init__(self, approval_id: _Optional[str] = ..., tool_name: _Optional[str] = ..., host: _Optional[str] = ..., preview: _Optional[str] = ..., mode: _Optional[_Union[_common_pb2.PermissionMode, str]] = ..., worker_id: _Optional[str] = ..., role: _Optional[str] = ...) -> None: ...

class Status(_message.Message):
    __slots__ = ("state", "detail", "run_status")
    STATE_FIELD_NUMBER: _ClassVar[int]
    DETAIL_FIELD_NUMBER: _ClassVar[int]
    RUN_STATUS_FIELD_NUMBER: _ClassVar[int]
    state: str
    detail: str
    run_status: _common_pb2.RunStatus
    def __init__(self, state: _Optional[str] = ..., detail: _Optional[str] = ..., run_status: _Optional[_Union[_common_pb2.RunStatus, str]] = ...) -> None: ...

class UsageFrame(_message.Message):
    __slots__ = ("usage",)
    USAGE_FIELD_NUMBER: _ClassVar[int]
    usage: _common_pb2.Usage
    def __init__(self, usage: _Optional[_Union[_common_pb2.Usage, _Mapping]] = ...) -> None: ...

class ErrorFrame(_message.Message):
    __slots__ = ("error",)
    ERROR_FIELD_NUMBER: _ClassVar[int]
    error: _common_pb2.Error
    def __init__(self, error: _Optional[_Union[_common_pb2.Error, _Mapping]] = ...) -> None: ...

class WorkerState(_message.Message):
    __slots__ = ("worker_id", "role", "parent", "status", "model", "phase", "claim", "claim_ttl_seconds", "activity")
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    PARENT_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    CLAIM_FIELD_NUMBER: _ClassVar[int]
    CLAIM_TTL_SECONDS_FIELD_NUMBER: _ClassVar[int]
    ACTIVITY_FIELD_NUMBER: _ClassVar[int]
    worker_id: str
    role: str
    parent: str
    status: _common_pb2.RunStatus
    model: str
    phase: str
    claim: str
    claim_ttl_seconds: int
    activity: str
    def __init__(self, worker_id: _Optional[str] = ..., role: _Optional[str] = ..., parent: _Optional[str] = ..., status: _Optional[_Union[_common_pb2.RunStatus, str]] = ..., model: _Optional[str] = ..., phase: _Optional[str] = ..., claim: _Optional[str] = ..., claim_ttl_seconds: _Optional[int] = ..., activity: _Optional[str] = ...) -> None: ...

class SwitchState(_message.Message):
    __slots__ = ("state",)
    STATE_FIELD_NUMBER: _ClassVar[int]
    state: _common_pb2.SwitcherState
    def __init__(self, state: _Optional[_Union[_common_pb2.SwitcherState, _Mapping]] = ...) -> None: ...

class ModeState(_message.Message):
    __slots__ = ("mode",)
    MODE_FIELD_NUMBER: _ClassVar[int]
    mode: _common_pb2.PermissionMode
    def __init__(self, mode: _Optional[_Union[_common_pb2.PermissionMode, str]] = ...) -> None: ...

class PlanStep(_message.Message):
    __slots__ = ("text", "status", "worker_id")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    text: str
    status: _common_pb2.RunStatus
    worker_id: str
    def __init__(self, text: _Optional[str] = ..., status: _Optional[_Union[_common_pb2.RunStatus, str]] = ..., worker_id: _Optional[str] = ...) -> None: ...

class PlanState(_message.Message):
    __slots__ = ("title", "steps")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    STEPS_FIELD_NUMBER: _ClassVar[int]
    title: str
    steps: _containers.RepeatedCompositeFieldContainer[PlanStep]
    def __init__(self, title: _Optional[str] = ..., steps: _Optional[_Iterable[_Union[PlanStep, _Mapping]]] = ...) -> None: ...

class CompactionState(_message.Message):
    __slots__ = ("turns_compacted", "summary_label")
    TURNS_COMPACTED_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_LABEL_FIELD_NUMBER: _ClassVar[int]
    turns_compacted: int
    summary_label: str
    def __init__(self, turns_compacted: _Optional[int] = ..., summary_label: _Optional[str] = ...) -> None: ...

class AttachState(_message.Message):
    __slots__ = ("client_id", "action", "attached_clients")
    CLIENT_ID_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    ATTACHED_CLIENTS_FIELD_NUMBER: _ClassVar[int]
    client_id: str
    action: str
    attached_clients: int
    def __init__(self, client_id: _Optional[str] = ..., action: _Optional[str] = ..., attached_clients: _Optional[int] = ...) -> None: ...

class PauseState(_message.Message):
    __slots__ = ("paused", "reason")
    PAUSED_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    paused: bool
    reason: str
    def __init__(self, paused: _Optional[bool] = ..., reason: _Optional[str] = ...) -> None: ...

class SessionEvent(_message.Message):
    __slots__ = ("kind", "switch", "mode", "plan", "worker", "compaction", "attach", "pause")
    KIND_FIELD_NUMBER: _ClassVar[int]
    SWITCH_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    PLAN_FIELD_NUMBER: _ClassVar[int]
    WORKER_FIELD_NUMBER: _ClassVar[int]
    COMPACTION_FIELD_NUMBER: _ClassVar[int]
    ATTACH_FIELD_NUMBER: _ClassVar[int]
    PAUSE_FIELD_NUMBER: _ClassVar[int]
    kind: SessionEventKind
    switch: SwitchState
    mode: ModeState
    plan: PlanState
    worker: WorkerState
    compaction: CompactionState
    attach: AttachState
    pause: PauseState
    def __init__(self, kind: _Optional[_Union[SessionEventKind, str]] = ..., switch: _Optional[_Union[SwitchState, _Mapping]] = ..., mode: _Optional[_Union[ModeState, _Mapping]] = ..., plan: _Optional[_Union[PlanState, _Mapping]] = ..., worker: _Optional[_Union[WorkerState, _Mapping]] = ..., compaction: _Optional[_Union[CompactionState, _Mapping]] = ..., attach: _Optional[_Union[AttachState, _Mapping]] = ..., pause: _Optional[_Union[PauseState, _Mapping]] = ...) -> None: ...

class ServerFrame(_message.Message):
    __slots__ = ("seq", "text_delta", "thinking", "tool_call", "tool_result", "approval_request", "status", "usage", "error", "session_event")
    SEQ_FIELD_NUMBER: _ClassVar[int]
    TEXT_DELTA_FIELD_NUMBER: _ClassVar[int]
    THINKING_FIELD_NUMBER: _ClassVar[int]
    TOOL_CALL_FIELD_NUMBER: _ClassVar[int]
    TOOL_RESULT_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    SESSION_EVENT_FIELD_NUMBER: _ClassVar[int]
    seq: int
    text_delta: TextDelta
    thinking: Thinking
    tool_call: ToolCall
    tool_result: ToolResult
    approval_request: ApprovalRequest
    status: Status
    usage: UsageFrame
    error: ErrorFrame
    session_event: SessionEvent
    def __init__(self, seq: _Optional[int] = ..., text_delta: _Optional[_Union[TextDelta, _Mapping]] = ..., thinking: _Optional[_Union[Thinking, _Mapping]] = ..., tool_call: _Optional[_Union[ToolCall, _Mapping]] = ..., tool_result: _Optional[_Union[ToolResult, _Mapping]] = ..., approval_request: _Optional[_Union[ApprovalRequest, _Mapping]] = ..., status: _Optional[_Union[Status, _Mapping]] = ..., usage: _Optional[_Union[UsageFrame, _Mapping]] = ..., error: _Optional[_Union[ErrorFrame, _Mapping]] = ..., session_event: _Optional[_Union[SessionEvent, _Mapping]] = ...) -> None: ...

class UserInput(_message.Message):
    __slots__ = ("text", "mentions")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    MENTIONS_FIELD_NUMBER: _ClassVar[int]
    text: str
    mentions: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, text: _Optional[str] = ..., mentions: _Optional[_Iterable[str]] = ...) -> None: ...

class ApprovalResponse(_message.Message):
    __slots__ = ("approval_id", "decision")
    class Decision(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
        __slots__ = ()
        DECISION_UNSPECIFIED: _ClassVar[ApprovalResponse.Decision]
        DECISION_ALLOW_ONCE: _ClassVar[ApprovalResponse.Decision]
        DECISION_ALLOW_SESSION: _ClassVar[ApprovalResponse.Decision]
        DECISION_ALLOW_ALWAYS: _ClassVar[ApprovalResponse.Decision]
        DECISION_DENY: _ClassVar[ApprovalResponse.Decision]
    DECISION_UNSPECIFIED: ApprovalResponse.Decision
    DECISION_ALLOW_ONCE: ApprovalResponse.Decision
    DECISION_ALLOW_SESSION: ApprovalResponse.Decision
    DECISION_ALLOW_ALWAYS: ApprovalResponse.Decision
    DECISION_DENY: ApprovalResponse.Decision
    APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    DECISION_FIELD_NUMBER: _ClassVar[int]
    approval_id: str
    decision: ApprovalResponse.Decision
    def __init__(self, approval_id: _Optional[str] = ..., decision: _Optional[_Union[ApprovalResponse.Decision, str]] = ...) -> None: ...

class Interrupt(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class Switch(_message.Message):
    __slots__ = ("axis", "value")
    AXIS_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    axis: _common_pb2.SwitcherAxis
    value: str
    def __init__(self, axis: _Optional[_Union[_common_pb2.SwitcherAxis, str]] = ..., value: _Optional[str] = ...) -> None: ...

class Attach(_message.Message):
    __slots__ = ("action", "client_id")
    ACTION_FIELD_NUMBER: _ClassVar[int]
    CLIENT_ID_FIELD_NUMBER: _ClassVar[int]
    action: str
    client_id: str
    def __init__(self, action: _Optional[str] = ..., client_id: _Optional[str] = ...) -> None: ...

class ClientFrame(_message.Message):
    __slots__ = ("user_input", "approval_response", "interrupt", "switch", "attach")
    USER_INPUT_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_RESPONSE_FIELD_NUMBER: _ClassVar[int]
    INTERRUPT_FIELD_NUMBER: _ClassVar[int]
    SWITCH_FIELD_NUMBER: _ClassVar[int]
    ATTACH_FIELD_NUMBER: _ClassVar[int]
    user_input: UserInput
    approval_response: ApprovalResponse
    interrupt: Interrupt
    switch: Switch
    attach: Attach
    def __init__(self, user_input: _Optional[_Union[UserInput, _Mapping]] = ..., approval_response: _Optional[_Union[ApprovalResponse, _Mapping]] = ..., interrupt: _Optional[_Union[Interrupt, _Mapping]] = ..., switch: _Optional[_Union[Switch, _Mapping]] = ..., attach: _Optional[_Union[Attach, _Mapping]] = ...) -> None: ...
