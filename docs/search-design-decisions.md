# Search System — Design Decisions (Resolved)

## Architecture

```
Document (PDF, image, CSV)
        │
        ▼
    Marker (extracts text locally, includes Surya OCR)
        │
        ▼
    Chunks (~500 token pieces)
        │
        ▼
    SQLite + FTS5 (keyword search) + BLOB embeddings (semantic search)
        │
        ▼
    Agent searches via MCP tools
```

## Resolved Decisions

### 1. Container-side SQLite access → Direct read
Add `better-sqlite3` to container. Agent reads `/workspace/project/store/messages.db` directly for keyword search. Main group only (has project mounted). Semantic search goes through IPC (host embeds query + cosine similarity).

### 2. Embedding runtime → ONNX (~200MB)
Use `onnxruntime` + `tokenizers` + `huggingface-hub` instead of PyTorch. Same model (all-MiniLM-L6-v2), same quality, 10x smaller install. Note: Marker requires torch separately for OCR models.

### 3. Python environment → Shared virtualenv
One venv at `services/venv/` for both embedding service and Marker. Auto-created on first use.

### 4. File naming → Strip timestamp prefixes for display
`1771214781180-HomeDepotInvWB18387555.pdf` → `HomeDepotInvWB18387555.pdf` in search results. Full path stored for internal lookups.

### 5. Initial indexing → Auto on startup (background)
Scan uploads on startup, skip already-indexed files (content hash), process new ones in background. NanoClaw responds to messages immediately while indexing runs.

### 6. Text extraction → Marker (with pdftotext fallback)
Marker handles PDFs (digital + scanned), images (OCR via Surya), tables (markdown output). Falls back to pdftotext if Marker not installed. CSVs read directly.

### 7. Embedding service lifecycle → Spawn on demand, keep alive
Python process starts on first semantic search, stays in memory (~300MB). Zero CPU when idle. Respawns after NanoClaw restart on next search.

### 8. New document uploads → Auto-index via file watcher
Host watches `groups/{name}/uploads/` for new files. New file → extract → chunk → store → embed. Searchable by next message.
