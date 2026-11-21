"""mem0 OSS behind a JSON-lines pipe, for evals/adapters/mem0.ts (evals.md §7, §8.1).

One request per stdin line, one reply per stdout line, in order:

    {"op": "hello"}                                   -> {"ok": true, "result": {versions and models}}
    {"op": "reset"}                                   -> {"ok": true, "result": null}
    {"op": "add", "text": "...", "user_id": "...",
     "infer": false, "metadata": {...}}               -> {"ok": true, "result": [{"id", "memory", "event"}]}
    {"op": "update", "id": "...", "text": "..."}       -> {"ok": true, "result": null}
    {"op": "search", "query": "...", "user_id": "...",
     "top_k": 10}                                     -> {"ok": true, "result": [{"id", "memory", "score"}]}
    {"op": "delete", "id": "..."}                     -> {"ok": true, "result": null}

A failed request answers {"ok": false, "error": "..."} and the driver keeps serving.

Everything mem0 itself prints goes to stderr: stdout carries replies only. The LLM and the embedder
are the host's Ollama (no API key); the vector store is mem0's default, an in-process Qdrant.
"""

import json
import os
import sys
from importlib.metadata import version

# Claim stdout for the protocol before mem0 is imported, so a stray print cannot corrupt a reply.
_replies = sys.stdout
sys.stdout = sys.stderr

from mem0 import Memory  # noqa: E402
from ollama import Client  # noqa: E402

OLLAMA_URL = os.environ["OLLAMA_URL"]
LLM_MODEL = os.environ["MEM0_LLM_MODEL"]
EMBED_MODEL = os.environ["MEM0_EMBED_MODEL"]
EMBED_DIMS = int(os.environ["MEM0_EMBED_DIMS"])
DATA_DIR = os.environ.get("MEM0_DIR", "/data")

CONFIG = {
    "llm": {"provider": "ollama", "config": {"model": LLM_MODEL, "ollama_base_url": OLLAMA_URL, "temperature": 0}},
    "embedder": {"provider": "ollama", "config": {"model": EMBED_MODEL, "ollama_base_url": OLLAMA_URL, "embedding_dims": EMBED_DIMS}},
    "vector_store": {"provider": "qdrant", "config": {"path": os.path.join(DATA_DIR, "qdrant"), "embedding_model_dims": EMBED_DIMS}},
    "history_db_path": os.path.join(DATA_DIR, "history.db"),
}


def ollama_digests() -> dict:
    """The exact Ollama models in use, by digest, so a report can name them."""
    wanted = {m if ":" in m else f"{m}:latest" for m in (LLM_MODEL, EMBED_MODEL)}
    models = Client(host=OLLAMA_URL).list().get("models", [])
    return {m["model"]: m["digest"] for m in models if m["model"] in wanted}


def hello() -> dict:
    return {
        "python": sys.version.split()[0],
        "packages": {p: version(p) for p in ("mem0ai", "qdrant-client", "fastembed", "spacy", "en_core_web_sm", "ollama")},
        "llm": LLM_MODEL,
        "embedder": EMBED_MODEL,
        "embedding_dims": EMBED_DIMS,
        "ollama_digests": ollama_digests(),
    }


def handle(memory: Memory, req: dict):
    op = req.get("op")
    if op == "hello":
        return hello()
    if op == "reset":
        memory.reset()
        return None
    if op == "add":
        out = memory.add(req["text"], user_id=req["user_id"], metadata=req.get("metadata"), infer=bool(req.get("infer", True)))
        return [{"id": r["id"], "memory": r.get("memory"), "event": r.get("event")} for r in out.get("results", [])]
    if op == "update":
        memory.update(req["id"], text=req["text"])
        return None
    if op == "search":
        out = memory.search(req["query"], filters={"user_id": req["user_id"]}, top_k=int(req["top_k"]))
        return [{"id": r["id"], "memory": r.get("memory"), "score": r.get("score")} for r in out.get("results", [])]
    if op == "delete":
        memory.delete(req["id"])
        return None
    raise ValueError(f"unknown op {op!r}")


def main() -> None:
    memory = Memory.from_config(CONFIG)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            reply = {"ok": True, "result": handle(memory, json.loads(line))}
        except Exception as e:  # one bad request must not end the session
            reply = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        _replies.write(json.dumps(reply) + "\n")
        _replies.flush()


if __name__ == "__main__":
    main()
