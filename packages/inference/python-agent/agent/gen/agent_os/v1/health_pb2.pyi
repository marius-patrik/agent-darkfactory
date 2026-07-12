from agent_os.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetHealthRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ComponentHealth(_message.Message):
    __slots__ = ("name", "state", "detail")
    NAME_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    DETAIL_FIELD_NUMBER: _ClassVar[int]
    name: str
    state: str
    detail: str
    def __init__(self, name: _Optional[str] = ..., state: _Optional[str] = ..., detail: _Optional[str] = ...) -> None: ...

class GetHealthResponse(_message.Message):
    __slots__ = ("paused", "nodes", "components", "usage")
    PAUSED_FIELD_NUMBER: _ClassVar[int]
    NODES_FIELD_NUMBER: _ClassVar[int]
    COMPONENTS_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    paused: bool
    nodes: _containers.RepeatedCompositeFieldContainer[_common_pb2.Node]
    components: _containers.RepeatedCompositeFieldContainer[ComponentHealth]
    usage: _common_pb2.Usage
    def __init__(self, paused: _Optional[bool] = ..., nodes: _Optional[_Iterable[_Union[_common_pb2.Node, _Mapping]]] = ..., components: _Optional[_Iterable[_Union[ComponentHealth, _Mapping]]] = ..., usage: _Optional[_Union[_common_pb2.Usage, _Mapping]] = ...) -> None: ...
