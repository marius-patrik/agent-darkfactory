from agent_os.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Session(_message.Message):
    __slots__ = ("id", "title", "agent", "owner_node", "status", "live", "attached_clients", "worker_count", "timestamps")
    ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    AGENT_FIELD_NUMBER: _ClassVar[int]
    OWNER_NODE_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    LIVE_FIELD_NUMBER: _ClassVar[int]
    ATTACHED_CLIENTS_FIELD_NUMBER: _ClassVar[int]
    WORKER_COUNT_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMPS_FIELD_NUMBER: _ClassVar[int]
    id: str
    title: str
    agent: str
    owner_node: str
    status: _common_pb2.RunStatus
    live: bool
    attached_clients: int
    worker_count: int
    timestamps: _common_pb2.Timestamps
    def __init__(self, id: _Optional[str] = ..., title: _Optional[str] = ..., agent: _Optional[str] = ..., owner_node: _Optional[str] = ..., status: _Optional[_Union[_common_pb2.RunStatus, str]] = ..., live: _Optional[bool] = ..., attached_clients: _Optional[int] = ..., worker_count: _Optional[int] = ..., timestamps: _Optional[_Union[_common_pb2.Timestamps, _Mapping]] = ...) -> None: ...

class CreateSessionRequest(_message.Message):
    __slots__ = ("agent", "title", "task", "switcher")
    AGENT_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    TASK_FIELD_NUMBER: _ClassVar[int]
    SWITCHER_FIELD_NUMBER: _ClassVar[int]
    agent: str
    title: str
    task: _common_pb2.Task
    switcher: _common_pb2.SwitcherState
    def __init__(self, agent: _Optional[str] = ..., title: _Optional[str] = ..., task: _Optional[_Union[_common_pb2.Task, _Mapping]] = ..., switcher: _Optional[_Union[_common_pb2.SwitcherState, _Mapping]] = ...) -> None: ...

class CreateSessionResponse(_message.Message):
    __slots__ = ("session", "attach")
    SESSION_FIELD_NUMBER: _ClassVar[int]
    ATTACH_FIELD_NUMBER: _ClassVar[int]
    session: Session
    attach: AttachInfo
    def __init__(self, session: _Optional[_Union[Session, _Mapping]] = ..., attach: _Optional[_Union[AttachInfo, _Mapping]] = ...) -> None: ...

class ListSessionsRequest(_message.Message):
    __slots__ = ("filter", "live_only")
    FILTER_FIELD_NUMBER: _ClassVar[int]
    LIVE_ONLY_FIELD_NUMBER: _ClassVar[int]
    filter: str
    live_only: bool
    def __init__(self, filter: _Optional[str] = ..., live_only: _Optional[bool] = ...) -> None: ...

class ListSessionsResponse(_message.Message):
    __slots__ = ("sessions",)
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    sessions: _containers.RepeatedCompositeFieldContainer[Session]
    def __init__(self, sessions: _Optional[_Iterable[_Union[Session, _Mapping]]] = ...) -> None: ...

class AttachSessionRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class AttachInfo(_message.Message):
    __slots__ = ("session_id", "ws_url", "owner_node")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    WS_URL_FIELD_NUMBER: _ClassVar[int]
    OWNER_NODE_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    ws_url: str
    owner_node: str
    def __init__(self, session_id: _Optional[str] = ..., ws_url: _Optional[str] = ..., owner_node: _Optional[str] = ...) -> None: ...

class AttachSessionResponse(_message.Message):
    __slots__ = ("attach",)
    ATTACH_FIELD_NUMBER: _ClassVar[int]
    attach: AttachInfo
    def __init__(self, attach: _Optional[_Union[AttachInfo, _Mapping]] = ...) -> None: ...

class ForkSessionRequest(_message.Message):
    __slots__ = ("session_id", "at_turn_id", "title")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    AT_TURN_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    at_turn_id: str
    title: str
    def __init__(self, session_id: _Optional[str] = ..., at_turn_id: _Optional[str] = ..., title: _Optional[str] = ...) -> None: ...

class ForkSessionResponse(_message.Message):
    __slots__ = ("session", "attach")
    SESSION_FIELD_NUMBER: _ClassVar[int]
    ATTACH_FIELD_NUMBER: _ClassVar[int]
    session: Session
    attach: AttachInfo
    def __init__(self, session: _Optional[_Union[Session, _Mapping]] = ..., attach: _Optional[_Union[AttachInfo, _Mapping]] = ...) -> None: ...
