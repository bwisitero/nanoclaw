#!/usr/bin/env python3
"""
Local embedding service for NanoClaw.
Uses ONNX Runtime for efficient local embeddings with all-MiniLM-L6-v2.
"""

import json
import sys
import numpy as np
from onnxruntime import InferenceSession
from tokenizers import Tokenizer
from huggingface_hub import hf_hub_download

MODEL_REPO = 'sentence-transformers/all-MiniLM-L6-v2'

# Download ONNX model and tokenizer from HuggingFace Hub
print("[embedding-service] Loading ONNX model...", file=sys.stderr, flush=True)
model_path = hf_hub_download(repo_id=MODEL_REPO, filename='onnx/model.onnx')
tokenizer_path = hf_hub_download(repo_id=MODEL_REPO, filename='tokenizer.json')

session = InferenceSession(model_path, providers=['CPUExecutionProvider'])
tokenizer = Tokenizer.from_file(tokenizer_path)
tokenizer.enable_padding(pad_id=0, pad_token='[PAD]')
tokenizer.enable_truncation(max_length=256)
print("[embedding-service] Ready", file=sys.stderr, flush=True)


def mean_pooling(token_embeddings, attention_mask):
    """Mean Pooling - average token embeddings weighted by attention mask."""
    mask_expanded = np.expand_dims(attention_mask, axis=-1).astype(np.float32)
    sum_embeddings = np.sum(token_embeddings * mask_expanded, axis=1)
    sum_mask = np.clip(np.sum(mask_expanded, axis=1), a_min=1e-9, a_max=None)
    return sum_embeddings / sum_mask


def normalize_embeddings(embeddings):
    """L2-normalize embeddings."""
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.clip(norms, a_min=1e-9, a_max=None)
    return embeddings / norms


def embed_texts(texts):
    """Generate normalized embeddings for a list of texts."""
    if not texts:
        return []

    encodings = tokenizer.encode_batch(texts)
    input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
    attention_mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
    token_type_ids = np.zeros_like(input_ids, dtype=np.int64)

    outputs = session.run(None, {
        'input_ids': input_ids,
        'attention_mask': attention_mask,
        'token_type_ids': token_type_ids,
    })

    pooled = mean_pooling(outputs[0], attention_mask)
    normalized = normalize_embeddings(pooled)
    return normalized.tolist()


def embed_query(query):
    """Generate normalized embedding for a single query."""
    if not query:
        return []
    result = embed_texts([query])
    return result[0] if result else []


def main():
    """JSON-RPC style interface via stdin/stdout."""
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request.get('method')
            params = request.get('params', {})
            req_id = request.get('id')

            if method == 'embed_texts':
                result = embed_texts(params.get('texts', []))
            elif method == 'embed_query':
                result = embed_query(params.get('query', ''))
            else:
                print(json.dumps({'id': req_id, 'error': f'Unknown method: {method}'}), flush=True)
                continue

            print(json.dumps({'id': req_id, 'result': result}), flush=True)

        except json.JSONDecodeError as e:
            print(json.dumps({'id': None, 'error': f'Invalid JSON: {str(e)}'}), flush=True)
        except Exception as e:
            req_id = None
            try:
                req_id = request.get('id')
            except Exception:
                pass
            print(json.dumps({'id': req_id, 'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()
