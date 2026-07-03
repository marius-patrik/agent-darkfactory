FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    GATEWAY_TRACE_DIR=/var/lib/agentos-gateway/traces

WORKDIR /app

RUN python -m pip install --no-cache-dir uv

COPY pyproject.toml uv.lock README.md ./
COPY agentos_gateway ./agentos_gateway
COPY registry ./registry
COPY scripts ./scripts

RUN python -m uv sync --locked --no-dev

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4000/healthz', timeout=5).read()"

CMD ["python", "-m", "uv", "run", "--no-dev", "gateway", "serve", "--host", "0.0.0.0", "--port", "4000"]
