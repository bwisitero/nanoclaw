# PostgreSQL + pgvector Implementation Plan

**Goal:** Semantic search with local embeddings to minimize LLM costs through better retrieval.

**Date:** 2026-02-16
**Status:** Implementation Ready

---

## Architecture Overview

### Dual-Database Strategy

**SQLite (Operational Data):**
- Messages, tasks, costs, registered groups
- Real-time writes, frequent updates
- Already integrated, no migration needed

**PostgreSQL (Embeddings & Search):**
- Conversation embeddings with pgvector
- Semantic search queries
- Read-heavy, batch updates
- Hybrid search (BM25 + vector similarity)

### Data Flow

```
User Message
    ↓
SQLite (store message)
    ↓
Background: Chunk & Embed
    ↓
PostgreSQL (store embedding)
    ↓
Search Query → Postgres (semantic) + SQLite FTS5 (keyword)
    ↓
Rerank & Merge Results
    ↓
Top 5-10 relevant chunks (2-3K tokens)
    ↓
Send to LLM (instead of 50K token history)
    ↓
COST SAVINGS: 90%+ reduction
```

---

## Component 1: PostgreSQL + pgvector Setup

### Installation (macOS)

```bash
# Install PostgreSQL 16
brew install postgresql@16

# Install pgvector extension
brew install pgvector

# Start PostgreSQL
brew services start postgresql@16

# Create database
createdb nanoclaw_vectors

# Enable extensions
psql nanoclaw_vectors << EOF
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- For hybrid search
EOF
```

### Database Schema

```sql
-- Conversation chunks with embeddings
CREATE TABLE conversation_embeddings (
    id BIGSERIAL PRIMARY KEY,
    chunk_id TEXT UNIQUE NOT NULL,
    chat_jid TEXT NOT NULL,
    group_folder TEXT NOT NULL,

    -- Content
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,

    -- Metadata
    timestamp TIMESTAMPTZ NOT NULL,
    message_ids TEXT[],  -- Array of message IDs in this chunk
    sender_names TEXT[],

    -- Vector embedding (384 dimensions for all-MiniLM-L6-v2)
    embedding vector(384) NOT NULL,

    -- Search optimization
    tokens_count INTEGER,
    chunk_sequence INTEGER,  -- Order within conversation

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_embeddings_chat ON conversation_embeddings(chat_jid);
CREATE INDEX idx_embeddings_folder ON conversation_embeddings(group_folder);
CREATE INDEX idx_embeddings_timestamp ON conversation_embeddings(timestamp DESC);
CREATE INDEX idx_embeddings_content_hash ON conversation_embeddings(content_hash);

-- HNSW index for vector similarity (faster than IVFFlat for < 1M vectors)
CREATE INDEX idx_embeddings_vector ON conversation_embeddings
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- GIN index for keyword search (hybrid)
CREATE INDEX idx_embeddings_content_gin ON conversation_embeddings
USING gin (to_tsvector('english', content));

-- Memory facts embeddings
CREATE TABLE memory_embeddings (
    id BIGSERIAL PRIMARY KEY,
    fact_id TEXT UNIQUE NOT NULL,
    group_folder TEXT NOT NULL,

    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    category TEXT,
    confidence TEXT,

    timestamp TIMESTAMPTZ NOT NULL,
    embedding vector(384) NOT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memory_folder ON memory_embeddings(group_folder);
CREATE INDEX idx_memory_category ON memory_embeddings(category);
CREATE INDEX idx_memory_vector ON memory_embeddings
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Query log for tracking search quality
CREATE TABLE search_queries (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    query_embedding vector(384),
    group_folder TEXT,
    results_count INTEGER,
    search_method TEXT,  -- 'semantic', 'keyword', 'hybrid'
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_queries_folder ON search_queries(group_folder);
CREATE INDEX idx_queries_timestamp ON search_queries(executed_at DESC);
```

---

## Component 2: Local Embedding Service

### Python Embedding Server

**File: `/Users/emil/Documents/NanoClaw/nanoclaw/services/embedding-service/server.py`**

```python
#!/usr/bin/env python3
"""
Local embedding service for NanoClaw.
Uses sentence-transformers for zero-cost embeddings.
"""

import json
import sys
from typing import List, Dict
from sentence_transformers import SentenceTransformer
import numpy as np

# Load model once at startup (80MB, caches locally)
model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')

def embed_texts(texts: List[str]) -> List[List[float]]:
    """Generate embeddings for a list of texts."""
    embeddings = model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
    return embeddings.tolist()

def embed_query(query: str) -> List[float]:
    """Generate embedding for a single query."""
    embedding = model.encode([query], convert_to_numpy=True, show_progress_bar=False)[0]
    return embedding.tolist()

def main():
    """JSON-RPC style interface via stdin/stdout."""
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request.get('method')
            params = request.get('params', {})

            if method == 'embed_texts':
                texts = params.get('texts', [])
                result = embed_texts(texts)
            elif method == 'embed_query':
                query = params.get('query', '')
                result = embed_query(query)
            else:
                result = {'error': f'Unknown method: {method}'}

            response = {'id': request.get('id'), 'result': result}
            print(json.dumps(response), flush=True)

        except Exception as e:
            error_response = {'id': request.get('id'), 'error': str(e)}
            print(json.dumps(error_response), flush=True)

if __name__ == '__main__':
    main()
```

**Requirements file:**

```bash
# services/embedding-service/requirements.txt
sentence-transformers==2.3.1
torch==2.1.0
numpy==1.24.3
```

**Installation:**

```bash
cd services/embedding-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Test
echo '{"id":1,"method":"embed_query","params":{"query":"hello world"}}' | python server.py
```

### Node.js Client Wrapper

**File: `src/embedding-client.ts`**

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { logger } from './logger.js';

interface EmbeddingRequest {
  id: number;
  method: 'embed_texts' | 'embed_query';
  params: {
    texts?: string[];
    query?: string;
  };
}

interface EmbeddingResponse {
  id: number;
  result?: number[] | number[][];
  error?: string;
}

class EmbeddingClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, (result: any) => void>();

  async start(): Promise<void> {
    const pythonPath = 'services/embedding-service/venv/bin/python';
    const scriptPath = 'services/embedding-service/server.py';

    this.process = spawn(pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({
      input: this.process.stdout!,
    });

    rl.on('line', (line) => {
      try {
        const response: EmbeddingResponse = JSON.parse(line);
        const resolve = this.pendingRequests.get(response.id);
        if (resolve) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            logger.error({ error: response.error }, 'Embedding error');
            resolve(null);
          } else {
            resolve(response.result);
          }
        }
      } catch (err) {
        logger.error({ err, line }, 'Failed to parse embedding response');
      }
    });

    this.process.stderr!.on('data', (data) => {
      logger.debug({ stderr: data.toString() }, 'Embedding service stderr');
    });

    this.process.on('exit', (code) => {
      logger.warn({ code }, 'Embedding service exited');
      this.process = null;
    });

    logger.info('Embedding service started');
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.process) {
      throw new Error('Embedding service not started');
    }

    const id = ++this.requestId;
    const request: EmbeddingRequest = {
      id,
      method: 'embed_texts',
      params: { texts },
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, resolve);
      this.process!.stdin!.write(JSON.stringify(request) + '\n');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Embedding request timeout'));
        }
      }, 30000);
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    if (!this.process) {
      throw new Error('Embedding service not started');
    }

    const id = ++this.requestId;
    const request: EmbeddingRequest = {
      id,
      method: 'embed_query',
      params: { query },
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, resolve);
      this.process!.stdin!.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Embedding request timeout'));
        }
      }, 30000);
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

export const embeddingClient = new EmbeddingClient();
```

---

## Component 3: PostgreSQL Client

**File: `src/pgvector-client.ts`**

```typescript
import pg from 'pg';
import crypto from 'crypto';
import { logger } from './logger.js';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.PGVECTOR_HOST || 'localhost',
  port: parseInt(process.env.PGVECTOR_PORT || '5432'),
  database: process.env.PGVECTOR_DB || 'nanoclaw_vectors',
  user: process.env.PGVECTOR_USER || process.env.USER,
  password: process.env.PGVECTOR_PASSWORD,
  max: 20,
});

export interface ConversationChunk {
  chunkId: string;
  chatJid: string;
  groupFolder: string;
  content: string;
  contentHash: string;
  timestamp: string;
  messageIds: string[];
  senderNames: string[];
  embedding: number[];
  tokensCount?: number;
  chunkSequence?: number;
}

export interface SearchResult {
  chunkId: string;
  content: string;
  timestamp: string;
  similarity: number;
  messageIds: string[];
  senderNames: string[];
}

export async function storeConversationChunk(chunk: ConversationChunk): Promise<void> {
  const query = `
    INSERT INTO conversation_embeddings
    (chunk_id, chat_jid, group_folder, content, content_hash, timestamp,
     message_ids, sender_names, embedding, tokens_count, chunk_sequence)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (chunk_id) DO UPDATE SET
      content = EXCLUDED.content,
      embedding = EXCLUDED.embedding,
      timestamp = EXCLUDED.timestamp
  `;

  const values = [
    chunk.chunkId,
    chunk.chatJid,
    chunk.groupFolder,
    chunk.content,
    chunk.contentHash,
    chunk.timestamp,
    chunk.messageIds,
    chunk.senderNames,
    `[${chunk.embedding.join(',')}]`, // pgvector format
    chunk.tokensCount,
    chunk.chunkSequence,
  ];

  try {
    await pool.query(query, values);
    logger.debug({ chunkId: chunk.chunkId }, 'Stored conversation chunk');
  } catch (err) {
    logger.error({ err, chunkId: chunk.chunkId }, 'Failed to store chunk');
    throw err;
  }
}

export async function semanticSearch(
  queryEmbedding: number[],
  groupFolder: string,
  limit: number = 10,
  similarityThreshold: number = 0.3,
): Promise<SearchResult[]> {
  const query = `
    SELECT
      chunk_id,
      content,
      timestamp,
      message_ids,
      sender_names,
      1 - (embedding <=> $1::vector) AS similarity
    FROM conversation_embeddings
    WHERE group_folder = $2
      AND 1 - (embedding <=> $1::vector) > $3
    ORDER BY embedding <=> $1::vector
    LIMIT $4
  `;

  const values = [
    `[${queryEmbedding.join(',')}]`,
    groupFolder,
    similarityThreshold,
    limit,
  ];

  try {
    const result = await pool.query(query, values);
    return result.rows.map((row) => ({
      chunkId: row.chunk_id,
      content: row.content,
      timestamp: row.timestamp,
      similarity: parseFloat(row.similarity),
      messageIds: row.message_ids,
      senderNames: row.sender_names,
    }));
  } catch (err) {
    logger.error({ err }, 'Semantic search failed');
    throw err;
  }
}

export async function hybridSearch(
  queryEmbedding: number[],
  queryText: string,
  groupFolder: string,
  limit: number = 10,
): Promise<SearchResult[]> {
  // Combine semantic (vector) and keyword (tsvector) search with RRF (Reciprocal Rank Fusion)
  const query = `
    WITH semantic AS (
      SELECT
        chunk_id,
        content,
        timestamp,
        message_ids,
        sender_names,
        1 - (embedding <=> $1::vector) AS score,
        ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
      FROM conversation_embeddings
      WHERE group_folder = $2
      LIMIT 20
    ),
    keyword AS (
      SELECT
        chunk_id,
        content,
        timestamp,
        message_ids,
        sender_names,
        ts_rank(to_tsvector('english', content), plainto_tsquery('english', $3)) AS score,
        ROW_NUMBER() OVER (ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $3)) DESC) AS rank
      FROM conversation_embeddings
      WHERE group_folder = $2
        AND to_tsvector('english', content) @@ plainto_tsquery('english', $3)
      LIMIT 20
    )
    SELECT
      COALESCE(s.chunk_id, k.chunk_id) AS chunk_id,
      COALESCE(s.content, k.content) AS content,
      COALESCE(s.timestamp, k.timestamp) AS timestamp,
      COALESCE(s.message_ids, k.message_ids) AS message_ids,
      COALESCE(s.sender_names, k.sender_names) AS sender_names,
      (COALESCE(1.0 / (60 + s.rank), 0.0) + COALESCE(1.0 / (60 + k.rank), 0.0)) AS combined_score
    FROM semantic s
    FULL OUTER JOIN keyword k ON s.chunk_id = k.chunk_id
    ORDER BY combined_score DESC
    LIMIT $4
  `;

  const values = [`[${queryEmbedding.join(',')}]`, groupFolder, queryText, limit];

  try {
    const result = await pool.query(query, values);
    return result.rows.map((row) => ({
      chunkId: row.chunk_id,
      content: row.content,
      timestamp: row.timestamp,
      similarity: parseFloat(row.combined_score),
      messageIds: row.message_ids,
      senderNames: row.sender_names,
    }));
  } catch (err) {
    logger.error({ err }, 'Hybrid search failed');
    throw err;
  }
}

export async function isDuplicateChunk(contentHash: string): Promise<boolean> {
  const query = `SELECT 1 FROM conversation_embeddings WHERE content_hash = $1 LIMIT 1`;
  const result = await pool.query(query, [contentHash]);
  return result.rows.length > 0;
}

export async function deleteOldChunks(groupFolder: string, olderThan: Date): Promise<number> {
  const query = `
    DELETE FROM conversation_embeddings
    WHERE group_folder = $1 AND timestamp < $2
    RETURNING chunk_id
  `;
  const result = await pool.query(query, [groupFolder, olderThan.toISOString()]);
  return result.rows.length;
}
```

---

## Component 4: Chunking Strategy

**File: `src/chunking.ts`**

```typescript
import { getRecentMessages } from './db.js';
import crypto from 'crypto';

export interface Message {
  id: string;
  chat_jid: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

export interface Chunk {
  chunkId: string;
  content: string;
  contentHash: string;
  messageIds: string[];
  senderNames: string[];
  timestamp: string;
  tokensCount: number;
  chunkSequence: number;
}

/**
 * Chunk messages into semantically meaningful units.
 * Strategy: Group messages into ~500 token chunks with overlap.
 */
export function chunkMessages(
  messages: Message[],
  maxTokens: number = 500,
  overlapTokens: number = 50,
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentChunk: Message[] = [];
  let currentTokens = 0;
  let chunkSequence = 0;

  for (const msg of messages) {
    // Rough token estimate: ~4 chars per token
    const msgTokens = Math.ceil(msg.content.length / 4);

    // If adding this message exceeds max, finalize current chunk
    if (currentTokens + msgTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(finalizeChunk(currentChunk, chunkSequence++));

      // Keep last N messages for overlap
      const overlapSize = Math.min(
        currentChunk.length,
        Math.floor(overlapTokens / (currentTokens / currentChunk.length)),
      );
      currentChunk = currentChunk.slice(-overlapSize);
      currentTokens = currentChunk.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    }

    currentChunk.push(msg);
    currentTokens += msgTokens;
  }

  // Finalize last chunk
  if (currentChunk.length > 0) {
    chunks.push(finalizeChunk(currentChunk, chunkSequence));
  }

  return chunks;
}

function finalizeChunk(messages: Message[], sequence: number): Chunk {
  const content = messages
    .map((m) => `[${m.timestamp}] ${m.sender_name}: ${m.content}`)
    .join('\n');

  const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

  return {
    chunkId: `chunk-${messages[0].chat_jid}-${sequence}-${contentHash}`,
    content,
    contentHash,
    messageIds: messages.map((m) => m.id),
    senderNames: [...new Set(messages.map((m) => m.sender_name))],
    timestamp: messages[messages.length - 1].timestamp,
    tokensCount: Math.ceil(content.length / 4),
    chunkSequence: sequence,
  };
}
```

---

## Component 5: Background Embedding Worker

**File: `src/embedding-worker.ts`**

```typescript
import { embeddingClient } from './embedding-client.js';
import { storeConversationChunk, isDuplicateChunk } from './pgvector-client.js';
import { chunkMessages, Chunk } from './chunking.js';
import { getRecentMessages } from './db.js';
import { logger } from './logger.js';

const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 30000; // 30 seconds

let isRunning = false;

export async function startEmbeddingWorker(): Promise<void> {
  if (isRunning) {
    logger.warn('Embedding worker already running');
    return;
  }

  isRunning = true;
  logger.info('Starting embedding worker');

  await embeddingClient.start();

  // Process loop
  while (isRunning) {
    try {
      await processRecentMessages();
    } catch (err) {
      logger.error({ err }, 'Embedding worker error');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export function stopEmbeddingWorker(): void {
  isRunning = false;
  embeddingClient.stop();
  logger.info('Stopped embedding worker');
}

async function processRecentMessages(): Promise<void> {
  // Get messages from last 24 hours that aren't embedded yet
  const messages = getRecentMessages(24 * 60 * 60 * 1000); // 24 hours

  if (messages.length === 0) {
    return;
  }

  // Group by chat
  const messagesByChat = new Map<string, typeof messages>();
  for (const msg of messages) {
    if (!messagesByChat.has(msg.chat_jid)) {
      messagesByChat.set(msg.chat_jid, []);
    }
    messagesByChat.get(msg.chat_jid)!.push(msg);
  }

  // Process each chat
  for (const [chatJid, chatMessages] of messagesByChat) {
    const chunks = chunkMessages(chatMessages);

    // Filter out duplicates
    const newChunks: Chunk[] = [];
    for (const chunk of chunks) {
      const isDupe = await isDuplicateChunk(chunk.contentHash);
      if (!isDupe) {
        newChunks.push(chunk);
      }
    }

    if (newChunks.length === 0) {
      continue;
    }

    logger.info(
      { chatJid, chunks: newChunks.length },
      'Embedding new conversation chunks',
    );

    // Batch embed
    for (let i = 0; i < newChunks.length; i += BATCH_SIZE) {
      const batch = newChunks.slice(i, i + BATCH_SIZE);
      const embeddings = await embeddingClient.embedTexts(batch.map((c) => c.content));

      // Store in pgvector
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embedding = embeddings[j];

        await storeConversationChunk({
          chunkId: chunk.chunkId,
          chatJid,
          groupFolder: 'main', // TODO: derive from registered_groups
          content: chunk.content,
          contentHash: chunk.contentHash,
          timestamp: chunk.timestamp,
          messageIds: chunk.messageIds,
          senderNames: chunk.senderNames,
          embedding,
          tokensCount: chunk.tokensCount,
          chunkSequence: chunk.chunkSequence,
        });
      }
    }

    logger.info({ chatJid, embedded: newChunks.length }, 'Embedded chunks');
  }
}
```

---

## Component 6: MCP Search Tools

**Add to `container/agent-runner/src/ipc-mcp-stdio.ts`:**

```typescript
server.tool(
  'semantic_search',
  'Search past conversations using semantic/meaning-based search. Finds relevant content even when exact keywords differ. Better than keyword search for vague queries like "deployment discussions" or "email problems".',
  {
    query: z.string().describe('Natural language search query (e.g., "How did we fix the authentication bug?")'),
    limit: z.number().default(5).describe('Number of results to return (default: 5)'),
    search_type: z.enum(['semantic', 'hybrid']).default('hybrid').describe('semantic=vector only, hybrid=vector+keyword (recommended)'),
  },
  async (args) => {
    // Write IPC task for semantic search
    const data = {
      type: 'semantic_search',
      query: args.query,
      limit: args.limit,
      search_type: args.search_type,
      group_folder: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);
    const resultPath = path.join(TASKS_DIR, filename.replace('.json', '.result.json'));

    // Poll for result (max 10 seconds)
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(resultPath)) {
        const results = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        fs.unlinkSync(resultPath);

        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No results found for "${args.query}". Try different phrasing or broader terms.`
            }]
          };
        }

        const formatted = results.map((r: any, idx: number) =>
          `${idx + 1}. [${new Date(r.timestamp).toLocaleString()}] (similarity: ${(r.similarity * 100).toFixed(1)}%)\n${r.content.slice(0, 300)}...\n`
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Found ${results.length} relevant result(s):\n\n${formatted.join('\n')}`
          }]
        };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return {
      content: [{ type: 'text' as const, text: 'Search timed out' }],
      isError: true
    };
  }
);
```

---

## Component 7: IPC Handler

**Add to `src/ipc.ts`:**

```typescript
import { embeddingClient } from './embedding-client.js';
import { semanticSearch, hybridSearch } from './pgvector-client.js';

// In processTask function:
case 'semantic_search': {
  const { query, limit, search_type, group_folder } = taskData;

  // Generate query embedding
  const queryEmbedding = await embeddingClient.embedQuery(query);

  // Execute search
  const results = search_type === 'semantic'
    ? await semanticSearch(queryEmbedding, group_folder, limit)
    : await hybridSearch(queryEmbedding, query, group_folder, limit);

  // Write result
  fs.writeFileSync(resultPath, JSON.stringify(results));
  break;
}
```

---

## Installation & Setup

### 1. Install Dependencies

```bash
# PostgreSQL + pgvector
brew install postgresql@16 pgvector
brew services start postgresql@16

# Create database
createdb nanoclaw_vectors
psql nanoclaw_vectors -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;"

# Python embedding service
cd services/embedding-service
python3 -m venv venv
source venv/bin/activate
pip install sentence-transformers torch numpy

# Node.js dependencies
npm install pg
```

### 2. Configure Environment

**Add to `.env`:**

```bash
# PostgreSQL
PGVECTOR_HOST=localhost
PGVECTOR_PORT=5432
PGVECTOR_DB=nanoclaw_vectors
PGVECTOR_USER=your_username

# Optional: if you set a password
# PGVECTOR_PASSWORD=your_password
```

### 3. Initialize Database

```bash
# Run schema creation
psql nanoclaw_vectors < docs/pgvector-schema.sql
```

### 4. Update src/index.ts

```typescript
import { startEmbeddingWorker, stopEmbeddingWorker } from './embedding-worker.js';

async function main(): Promise<void> {
  // ... existing setup ...

  // Start embedding worker
  await startEmbeddingWorker();

  // Shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    stopEmbeddingWorker();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };

  // ... rest of main ...
}
```

### 5. Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Testing

### 1. Verify Embedding Service

```bash
cd services/embedding-service
source venv/bin/activate
echo '{"id":1,"method":"embed_query","params":{"query":"test"}}' | python server.py
# Should return: {"id":1,"result":[0.123, -0.456, ...]}  (384 dimensions)
```

### 2. Check PostgreSQL

```bash
psql nanoclaw_vectors -c "SELECT COUNT(*) FROM conversation_embeddings;"
```

### 3. Test Search

Send a message in WhatsApp that triggers semantic search:
```
User: "search for discussions about Docker"
Agent: [Uses semantic_search tool]
```

### 4. Monitor Logs

```bash
tail -f logs/nanoclaw.log | grep -E "(Embedding|semantic)"
```

---

## Performance Expectations

### Embedding Speed
- **Local model load time**: ~2 seconds (first time only)
- **Embed single query**: ~20ms
- **Embed batch of 10 chunks**: ~150ms
- **Memory usage**: ~300MB (model + embeddings)

### Search Speed
- **Semantic search**: 10-50ms (with HNSW index)
- **Hybrid search**: 20-100ms (vector + keyword)
- **Result quality**: 85-90% precision for semantic queries

### Storage
- **Per chunk**: ~2KB (384 floats + metadata)
- **10K messages**: ~2K chunks = ~4MB in Postgres
- **100K messages**: ~20K chunks = ~40MB

---

## Cost Savings Analysis

### Before (Current)
- Average query: 50K tokens context
- Cost: $0.15 per query (Sonnet 4.5)
- 100 queries/day: **$450/month**

### After (With pgvector RAG)
- Retrieve top 5 chunks: ~2.5K tokens
- Cost: $0.0075 per query
- 100 queries/day: **$22.50/month**

### Savings
- **$427.50/month (95% reduction)**
- ROI on setup time: ~5 hours @ $100/hr = $500
- **Payback period: 1.2 months**

---

## Maintenance

### Daily
- Embedding worker runs automatically every 30 seconds
- New messages embedded in batches

### Weekly
- Monitor Postgres disk usage: `psql nanoclaw_vectors -c "SELECT pg_size_pretty(pg_database_size('nanoclaw_vectors'));"`
- Check search quality logs

### Monthly
- Archive old embeddings (>6 months) if needed
- Vacuum Postgres: `psql nanoclaw_vectors -c "VACUUM ANALYZE conversation_embeddings;"`

### Troubleshooting
- **Embedding service crashes**: Check `logs/nanoclaw.log`, restart service
- **Slow searches**: Rebuild HNSW index: `REINDEX INDEX idx_embeddings_vector;`
- **High memory**: Reduce BATCH_SIZE in embedding-worker.ts

---

## Next Steps

1. ✅ Review this plan
2. ⏸️ Execute installation (Section: Installation & Setup)
3. ⏸️ Test semantic search
4. ⏸️ Monitor cost savings
5. ⏸️ Optimize chunking strategy based on results

---

## References

- **pgvector docs**: https://github.com/pgvector/pgvector
- **sentence-transformers**: https://www.sbert.net/
- **Reciprocal Rank Fusion**: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
- **HNSW algorithm**: https://arxiv.org/abs/1603.09320
