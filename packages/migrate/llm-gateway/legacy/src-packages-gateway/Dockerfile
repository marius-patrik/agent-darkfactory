FROM python:3.13-slim

ARG AGENTS_VERSION=dev
ARG AGENTS_GIT_SHA=unknown
ARG AGENTS_IMAGE_TAG=agents-gateway:dev
ARG AGENTS_BUILD_TIME=unknown

LABEL org.opencontainers.image.version="${AGENTS_VERSION}" \
      org.opencontainers.image.revision="${AGENTS_GIT_SHA}" \
      org.opencontainers.image.created="${AGENTS_BUILD_TIME}" \
      org.opencontainers.image.title="agents-gateway"

ENV AGENTS_VERSION="${AGENTS_VERSION}" \
    AGENTS_GIT_SHA="${AGENTS_GIT_SHA}" \
    AGENTS_IMAGE_TAG="${AGENTS_IMAGE_TAG}" \
    AGENTS_BUILD_TIME="${AGENTS_BUILD_TIME}"

WORKDIR /app

COPY pyproject.toml ./
COPY gateway/ ./gateway/
COPY registry/ ./registry/
COPY tests/ ./tests/
RUN pip install --no-cache-dir -e .

ENV PYTHONUNBUFFERED=1
ENV GATEWAY_REGISTRY_PATH=/app/registry/models.yaml
ENV GATEWAY_ACTIVE_PATH=/app/registry/active.yaml

EXPOSE 4000

CMD ["python", "-m", "gateway.main"]
