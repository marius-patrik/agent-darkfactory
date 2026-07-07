FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @moonshot-ai/kimi-code@latest

WORKDIR /workspace

ENTRYPOINT ["bash"]
