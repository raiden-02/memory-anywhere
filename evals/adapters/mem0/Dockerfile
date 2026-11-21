# mem0 OSS as a baseline (evals.md §7): mem0ai 2.2.1 with its NLP extra (spaCy lemmas and
# entities for its hybrid search) and fastembed (the BM25 half of that search), every package
# locked by hash in requirements.txt (uv pip compile requirements.in --generate-hashes).
# The LLM and the embedder are the host's Ollama; no API key is read anywhere.
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt

# The BM25 encoder is downloaded on first use; fetch it now so runs need no network but Ollama.
RUN python -c "from fastembed import SparseTextEmbedding; SparseTextEmbedding(model_name='Qdrant/bm25')"

COPY driver.py /app/driver.py
ENV MEM0_TELEMETRY=False MEM0_DIR=/data HF_HUB_OFFLINE=1
ENTRYPOINT ["python", "/app/driver.py"]
