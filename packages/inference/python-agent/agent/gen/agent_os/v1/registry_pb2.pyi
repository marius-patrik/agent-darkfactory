from agent_os.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ListModelsRequest(_message.Message):
    __slots__ = ("fabric", "provider_id", "role")
    FABRIC_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_ID_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    fabric: _common_pb2.Fabric
    provider_id: str
    role: str
    def __init__(self, fabric: _Optional[_Union[_common_pb2.Fabric, str]] = ..., provider_id: _Optional[str] = ..., role: _Optional[str] = ...) -> None: ...

class ListModelsResponse(_message.Message):
    __slots__ = ("models",)
    MODELS_FIELD_NUMBER: _ClassVar[int]
    models: _containers.RepeatedCompositeFieldContainer[_common_pb2.Model]
    def __init__(self, models: _Optional[_Iterable[_Union[_common_pb2.Model, _Mapping]]] = ...) -> None: ...

class ListProvidersRequest(_message.Message):
    __slots__ = ("fabric",)
    FABRIC_FIELD_NUMBER: _ClassVar[int]
    fabric: _common_pb2.Fabric
    def __init__(self, fabric: _Optional[_Union[_common_pb2.Fabric, str]] = ...) -> None: ...

class ListProvidersResponse(_message.Message):
    __slots__ = ("providers",)
    PROVIDERS_FIELD_NUMBER: _ClassVar[int]
    providers: _containers.RepeatedCompositeFieldContainer[_common_pb2.Provider]
    def __init__(self, providers: _Optional[_Iterable[_Union[_common_pb2.Provider, _Mapping]]] = ...) -> None: ...

class ListHostsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListHostsResponse(_message.Message):
    __slots__ = ("hosts",)
    HOSTS_FIELD_NUMBER: _ClassVar[int]
    hosts: _containers.RepeatedCompositeFieldContainer[_common_pb2.Host]
    def __init__(self, hosts: _Optional[_Iterable[_Union[_common_pb2.Host, _Mapping]]] = ...) -> None: ...

class ListNodesRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListNodesResponse(_message.Message):
    __slots__ = ("nodes",)
    NODES_FIELD_NUMBER: _ClassVar[int]
    nodes: _containers.RepeatedCompositeFieldContainer[_common_pb2.Node]
    def __init__(self, nodes: _Optional[_Iterable[_Union[_common_pb2.Node, _Mapping]]] = ...) -> None: ...
