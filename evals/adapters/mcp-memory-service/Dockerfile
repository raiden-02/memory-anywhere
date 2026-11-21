# mcp-memory-service 12.7.0 as a baseline (evals.md §7): the SQLite-vec backend with local
# ONNX embeddings (all-MiniLM-L6-v2, which the service fetches from a SHA-256-pinned archive),
# every package locked by hash in requirements.txt (uv pip compile requirements.in --generate-hashes).
# It speaks MCP over stdio (`memory server`); no API key is read anywhere.
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt

# The embedding model is downloaded on first use; fetch it now so runs need no network.
RUN python -c "from mcp_memory_service.embeddings import get_onnx_embedding_model as g; m = g('all-MiniLM-L6-v2'); assert m is not None; m.encode(['warm up'])"

ENV MCP_MEMORY_STORAGE_BACKEND=sqlite_vec MCP_MEMORY_BASE_DIR=/data MCP_MEMORY_SQLITE_PATH=/data/memory.db \
  MCP_MEMORY_ONNX_ALLOW_DOWNLOAD=0 HF_HUB_OFFLINE=1
ENTRYPOINT ["memory", "server"]
