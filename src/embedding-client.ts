/**
 * Node.js client for the Python ONNX embedding service.
 * Spawns the Python process on demand, communicates via JSON-RPC over stdin/stdout.
 */

import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { logger } from './logger.js';

const SERVICES_DIR = path.resolve(process.cwd(), 'services');
const VENV_DIR = path.join(SERVICES_DIR, 'venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python');
const EMBEDDING_SCRIPT = path.join(SERVICES_DIR, 'embedding-service', 'server.py');
const EMBEDDING_REQUIREMENTS = path.join(SERVICES_DIR, 'embedding-service', 'requirements.txt');

const EMBEDDING_DIMS = 384; // all-MiniLM-L6-v2 output dimensions

let proc: ChildProcess | null = null;
let rl: readline.Interface | null = null;
let requestId = 0;
let ready = false;
let startPromise: Promise<void> | null = null;

const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
>();

function ensureVenv(): void {
  if (fs.existsSync(VENV_PYTHON)) return;

  logger.info('Creating Python virtual environment for embedding service...');
  execSync(`python3 -m venv "${VENV_DIR}"`, { stdio: 'pipe' });
  execSync(`"${VENV_PYTHON}" -m pip install --quiet -r "${EMBEDDING_REQUIREMENTS}"`, {
    stdio: 'pipe',
    timeout: 300000, // 5 min for first install
  });
  logger.info('Embedding service dependencies installed');
}

function start(): Promise<void> {
  if (ready && proc && !proc.killed) return Promise.resolve();
  if (startPromise) return startPromise;

  try {
    ensureVenv();
  } catch (err) {
    return Promise.reject(err);
  }

  startPromise = new Promise<void>((resolve, reject) => {

    proc = spawn(VENV_PYTHON, [EMBEDDING_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: SERVICES_DIR,
    });

    rl = readline.createInterface({ input: proc.stdout! });

    rl.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        const pending = pendingRequests.get(response.id);
        if (pending) {
          pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    proc.stderr!.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg.includes('Ready')) {
        ready = true;
        startPromise = null;
        resolve();
      }
      logger.debug({ service: 'embedding' }, msg);
    });

    proc.on('close', (code) => {
      ready = false;
      proc = null;
      rl = null;
      startPromise = null;
      for (const [, pending] of pendingRequests) {
        pending.reject(new Error(`Embedding service exited with code ${code}`));
      }
      pendingRequests.clear();
    });

    proc.on('error', (err) => {
      ready = false;
      startPromise = null;
      reject(err);
    });

    // Timeout for startup (model download on first run can be slow)
    setTimeout(() => {
      if (!ready) {
        if (proc && !proc.killed) proc.kill('SIGKILL');
        startPromise = null;
        reject(new Error('Embedding service startup timeout (120s)'));
      }
    }, 120000);
  });

  // Clear cache on rejection so retries can re-attempt
  startPromise.catch(() => { startPromise = null; });

  return startPromise;
}

async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  await start();

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });

    const request = JSON.stringify({ id, method, params }) + '\n';
    proc!.stdin!.write(request);

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Embedding request ${id} timed out (30s)`));
      }
    }, 30000);
  });
}

/**
 * Generate embeddings for a batch of texts.
 * Returns array of float32 arrays (384 dimensions each).
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return (await call('embed_texts', { texts })) as number[][];
}

/**
 * Generate embedding for a single query.
 * Returns float32 array (384 dimensions).
 */
export async function embedQuery(query: string): Promise<number[]> {
  return (await call('embed_query', { query })) as number[];
}

/**
 * Pack a float32 array into a Buffer for SQLite BLOB storage.
 */
export function packEmbedding(embedding: number[]): Buffer {
  const buf = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

/**
 * Unpack a Buffer from SQLite BLOB back to float32 array.
 */
export function unpackEmbedding(buf: Buffer): number[] {
  const result = new Array<number>(buf.length / 4);
  for (let i = 0; i < result.length; i++) {
    result[i] = buf.readFloatLE(i * 4);
  }
  return result;
}

/**
 * Compute cosine similarity between two embeddings.
 * Embeddings should be L2-normalized (dot product = cosine similarity).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export { EMBEDDING_DIMS };

export function stopEmbeddingService(): void {
  if (proc && !proc.killed) {
    proc.kill();
    proc = null;
    ready = false;
    startPromise = null;
  }
}
