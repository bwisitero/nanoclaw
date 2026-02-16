#!/usr/bin/env python3
"""
Local embedding service for NanoClaw.
Uses sentence-transformers for zero-cost embeddings.
"""

import json
import sys
from typing import List
from sentence_transformers import SentenceTransformer

# Load model once at startup (80MB, caches locally)
# all-MiniLM-L6-v2: 384 dimensions, fast, good quality for RAG
model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')

def embed_texts(texts: List[str]) -> List[List[float]]:
    """Generate embeddings for a list of texts."""
    if not texts:
        return []
    embeddings = model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
    return embeddings.tolist()

def embed_query(query: str) -> List[float]:
    """Generate embedding for a single query."""
    if not query:
        return []
    embedding = model.encode([query], convert_to_numpy=True, show_progress_bar=False)[0]
    return embedding.tolist()

def main():
    """JSON-RPC style interface via stdin/stdout."""
    # Print ready message to stderr (won't interfere with JSON output)
    print("[embedding-service] Ready", file=sys.stderr, flush=True)

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
                result = None
                error = f'Unknown method: {method}'
                response = {'id': request.get('id'), 'error': error}
                print(json.dumps(response), flush=True)
                continue

            response = {'id': request.get('id'), 'result': result}
            print(json.dumps(response), flush=True)

        except json.JSONDecodeError as e:
            error_response = {'id': None, 'error': f'Invalid JSON: {str(e)}'}
            print(json.dumps(error_response), flush=True)
        except Exception as e:
            error_response = {'id': request.get('id'), 'error': str(e)}
            print(json.dumps(error_response), flush=True)

if __name__ == '__main__':
    main()
