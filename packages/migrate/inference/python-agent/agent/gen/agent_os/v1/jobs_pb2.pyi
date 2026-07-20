from agent_os.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Job(_message.Message):
    __slots__ = ("id", "session_id", "domain_id", "task", "status", "owner_node", "timestamps")
    ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    DOMAIN_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    OWNER_NODE_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMPS_FIELD_NUMBER: _ClassVar[int]
    id: str
    session_id: str
    domain_id: str
    task: _common_pb2.Task
    status: _common_pb2.RunStatus
    owner_node: str
    timestamps: _common_pb2.Timestamps
    def __init__(self, id: _Optional[str] = ..., session_id: _Optional[str] = ..., domain_id: _Optional[str] = ..., task: _Optional[_Union[_common_pb2.Task, _Mapping]] = ..., status: _Optional[_Union[_common_pb2.RunStatus, str]] = ..., owner_node: _Optional[str] = ..., timestamps: _Optional[_Union[_common_pb2.Timestamps, _Mapping]] = ...) -> None: ...

class Domain(_message.Message):
    __slots__ = ("id", "goal", "orchestrator_session_id", "running", "backlog_size", "status", "timestamps")
    ID_FIELD_NUMBER: _ClassVar[int]
    GOAL_FIELD_NUMBER: _ClassVar[int]
    ORCHESTRATOR_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    RUNNING_FIELD_NUMBER: _ClassVar[int]
    BACKLOG_SIZE_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMPS_FIELD_NUMBER: _ClassVar[int]
    id: str
    goal: str
    orchestrator_session_id: str
    running: bool
    backlog_size: int
    status: _common_pb2.RunStatus
    timestamps: _common_pb2.Timestamps
    def __init__(self, id: _Optional[str] = ..., goal: _Optional[str] = ..., orchestrator_session_id: _Optional[str] = ..., running: _Optional[bool] = ..., backlog_size: _Optional[int] = ..., status: _Optional[_Union[_common_pb2.RunStatus, str]] = ..., timestamps: _Optional[_Union[_common_pb2.Timestamps, _Mapping]] = ...) -> None: ...

class ListJobsRequest(_message.Message):
    __slots__ = ("domain_id", "active_only")
    DOMAIN_ID_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_ONLY_FIELD_NUMBER: _ClassVar[int]
    domain_id: str
    active_only: bool
    def __init__(self, domain_id: _Optional[str] = ..., active_only: _Optional[bool] = ...) -> None: ...

class ListJobsResponse(_message.Message):
    __slots__ = ("jobs",)
    JOBS_FIELD_NUMBER: _ClassVar[int]
    jobs: _containers.RepeatedCompositeFieldContainer[Job]
    def __init__(self, jobs: _Optional[_Iterable[_Union[Job, _Mapping]]] = ...) -> None: ...

class GetJobStatusRequest(_message.Message):
    __slots__ = ("job_id",)
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    job_id: str
    def __init__(self, job_id: _Optional[str] = ...) -> None: ...

class GetJobStatusResponse(_message.Message):
    __slots__ = ("job",)
    JOB_FIELD_NUMBER: _ClassVar[int]
    job: Job
    def __init__(self, job: _Optional[_Union[Job, _Mapping]] = ...) -> None: ...

class ListDomainsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ListDomainsResponse(_message.Message):
    __slots__ = ("domains",)
    DOMAINS_FIELD_NUMBER: _ClassVar[int]
    domains: _containers.RepeatedCompositeFieldContainer[Domain]
    def __init__(self, domains: _Optional[_Iterable[_Union[Domain, _Mapping]]] = ...) -> None: ...

class GetDomainStatusRequest(_message.Message):
    __slots__ = ("domain_id",)
    DOMAIN_ID_FIELD_NUMBER: _ClassVar[int]
    domain_id: str
    def __init__(self, domain_id: _Optional[str] = ...) -> None: ...

class GetDomainStatusResponse(_message.Message):
    __slots__ = ("domain", "runs")
    DOMAIN_FIELD_NUMBER: _ClassVar[int]
    RUNS_FIELD_NUMBER: _ClassVar[int]
    domain: Domain
    runs: _containers.RepeatedCompositeFieldContainer[Job]
    def __init__(self, domain: _Optional[_Union[Domain, _Mapping]] = ..., runs: _Optional[_Iterable[_Union[Job, _Mapping]]] = ...) -> None: ...
