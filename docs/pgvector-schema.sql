-- PostgreSQL + pgvector Schema for NanoClaw Semantic Search
-- Run with: psql nanoclaw_vectors < docs/pgvector-schema.sql

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Conversation chunks with embeddings
CREATE TABLE IF NOT EXISTS conversation_embeddings (
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
CREATE INDEX IF NOT EXISTS idx_embeddings_chat ON conversation_embeddings(chat_jid);
CREATE INDEX IF NOT EXISTS idx_embeddings_folder ON conversation_embeddings(group_folder);
CREATE INDEX IF NOT EXISTS idx_embeddings_timestamp ON conversation_embeddings(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_embeddings_content_hash ON conversation_embeddings(content_hash);

-- HNSW index for vector similarity (faster than IVFFlat for < 1M vectors)
-- m=16: connections per layer, ef_construction=64: build quality
CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON conversation_embeddings
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- GIN index for keyword search (hybrid search)
CREATE INDEX IF NOT EXISTS idx_embeddings_content_gin ON conversation_embeddings
USING gin (to_tsvector('english', content));

-- Memory facts embeddings
CREATE TABLE IF NOT EXISTS memory_embeddings (
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

CREATE INDEX IF NOT EXISTS idx_memory_folder ON memory_embeddings(group_folder);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_embeddings(category);
CREATE INDEX IF NOT EXISTS idx_memory_vector ON memory_embeddings
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Query log for tracking search quality
CREATE TABLE IF NOT EXISTS search_queries (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    query_embedding vector(384),
    group_folder TEXT,
    results_count INTEGER,
    search_method TEXT,  -- 'semantic', 'keyword', 'hybrid'
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_queries_folder ON search_queries(group_folder);
CREATE INDEX IF NOT EXISTS idx_queries_timestamp ON search_queries(executed_at DESC);

-- Grant permissions (adjust username as needed)
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_username;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_username;
