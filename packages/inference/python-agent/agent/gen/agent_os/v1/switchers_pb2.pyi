from agent_os.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetSwitcherStateRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class GetSwitcherStateResponse(_message.Message):
    __slots__ = ("state",)
    STATE_FIELD_NUMBER: _ClassVar[int]
    state: _common_pb2.SwitcherState
    def __init__(self, state: _Optional[_Union[_common_pb2.SwitcherState, _Mapping]] = ...) -> None: ...

class SetSwitcherRequest(_message.Message):
    __slots__ = ("axis", "value", "scope", "session_id")
    AXIS_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    axis: _common_pb2.SwitcherAxis
    value: str
    scope: _common_pb2.SwitcherScope
    session_id: str
    def __init__(self, axis: _Optional[_Union[_common_pb2.SwitcherAxis, str]] = ..., value: _Optional[str] = ..., scope: _Optional[_Union[_common_pb2.SwitcherScope, str]] = ..., session_id: _Optional[str] = ...) -> None: ...

class SetSwitcherResponse(_message.Message):
    __slots__ = ("state",)
    STATE_FIELD_NUMBER: _ClassVar[int]
    state: _common_pb2.SwitcherState
    def __init__(self, state: _Optional[_Union[_common_pb2.SwitcherState, _Mapping]] = ...) -> None: ...

class SwitcherOption(_message.Message):
    __slots__ = ("value", "label", "available", "unavailable_reason")
    VALUE_FIELD_NUMBER: _ClassVar[int]
    LABEL_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_FIELD_NUMBER: _ClassVar[int]
    UNAVAILABLE_REASON_FIELD_NUMBER: _ClassVar[int]
    value: str
    label: str
    available: bool
    unavailable_reason: str
    def __init__(self, value: _Optional[str] = ..., label: _Optional[str] = ..., available: _Optional[bool] = ..., unavailable_reason: _Optional[str] = ...) -> None: ...

class ListSwitcherOptionsRequest(_message.Message):
    __slots__ = ("axis", "session_id")
    AXIS_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    axis: _common_pb2.SwitcherAxis
    session_id: str
    def __init__(self, axis: _Optional[_Union[_common_pb2.SwitcherAxis, str]] = ..., session_id: _Optional[str] = ...) -> None: ...

class ListSwitcherOptionsResponse(_message.Message):
    __slots__ = ("options",)
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    options: _containers.RepeatedCompositeFieldContainer[SwitcherOption]
    def __init__(self, options: _Optional[_Iterable[_Union[SwitcherOption, _Mapping]]] = ...) -> None: ...
