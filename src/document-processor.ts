/**
 * Document Processor for NanoClaw
 * Extracts text from documents (PDF, CSV, images), chunks content,
 * stores in SQLite for FTS5 keyword search, and generates embeddings.
 */

import crypto from 'crypto';
import { execFile, execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import {
  deleteDocumentChunks,
  getChunksWithoutEmbeddings,
  getFileContentHash,
  getIndexedFiles,
  storeDocumentChunks,
  storeDocumentEmbeddings,
  DocumentChunk,
} from './db.js';
import { embedTexts, packEmbedding } from './embedding-client.js';
import { logger } from './logger.js';

const CHUNK_SIZE = 2000; // ~500 tokens
const CHUNK_OVERLAP = 200; // ~50 tokens
const EMBED_BATCH_SIZE = 32; // Texts per embedding batch
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB max file size

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.csv', '.txt', '.md',
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
]);

/**
 * Strip timestamp prefix from uploaded file names.
 * e.g. "1771214781180-HomeDepotInvWB18387555.pdf" → "HomeDepotInvWB18387555.pdf"
 */
function displayName(filePath: string): string {
  const basename = path.basename(filePath);
  // Match timestamp prefix: digits followed by a dash, then sanitize
  return basename.replace(/^\d{10,}-/, '').replace(/[/\\]/g, '_').replace(/\.\./g, '__');
}

/**
 * Compute a hash of the file content for change detection.
 */
function fileContentHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// --- Text extraction ---

interface ExtractionResult {
  text: string;
  pages: string[]; // Text split by page (single element for non-PDFs)
}

async function extractPdf(filePath: string): Promise<ExtractionResult | null> {
  try {
    // Try pdftotext -layout first (preserves table columns)
    const { stdout: text } = await execFileAsync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB
      timeout: 60000,
    });

    if (text.trim().length < 50) {
      // Very little text — might be a scanned PDF, try without -layout
      const { stdout: fallback } = await execFileAsync('pdftotext', [filePath, '-'], {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 60000,
      });
      if (fallback.trim().length > text.trim().length) {
        const pages = fallback.split('\f').filter((p) => p.trim().length > 0);
        return { text: fallback, pages: pages.length > 0 ? pages : [fallback] };
      }
    }

    // Split by form feed (page separator)
    const pages = text.split('\f').filter((p) => p.trim().length > 0);
    return { text, pages: pages.length > 0 ? pages : [text] };
  } catch (err) {
    logger.warn({ filePath, err }, 'pdftotext extraction failed');
    return null;
  }
}

function extractCsv(filePath: string): ExtractionResult | null {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    return { text, pages: [text] };
  } catch (err) {
    logger.warn({ filePath, err }, 'CSV read failed');
    return null;
  }
}

function extractText(filePath: string): ExtractionResult | null {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    return { text, pages: [text] };
  } catch (err) {
    logger.warn({ filePath, err }, 'Text read failed');
    return null;
  }
}

function extractImage(filePath: string): ExtractionResult | null {
  // Check if marker_single is available in the shared venv
  const venvMarker = path.join(process.cwd(), 'services', 'venv', 'bin', 'marker_single');
  if (!fs.existsSync(venvMarker)) {
    logger.info(
      { filePath },
      'Skipping image (Marker not installed). Run: services/venv/bin/pip install marker-pdf',
    );
    return null;
  }

  try {
    const tmpDir = fs.mkdtempSync('/tmp/nanoclaw-marker-');
    execSync(
      `"${venvMarker}" "${filePath}" "${tmpDir}" --output_format markdown`,
      { stdio: 'pipe', timeout: 120000 },
    );

    // Find the output markdown file
    const mdFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.md'));
    if (mdFiles.length === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return null;
    }

    const text = fs.readFileSync(path.join(tmpDir, mdFiles[0]), 'utf-8');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { text, pages: [text] };
  } catch (err) {
    logger.warn({ filePath, err }, 'Marker image extraction failed');
    return null;
  }
}

async function extractDocument(filePath: string): Promise<ExtractionResult | null> {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.pdf':
      return extractPdf(filePath);
    case '.csv':
      return extractCsv(filePath);
    case '.txt':
    case '.md':
      return extractText(filePath);
    case '.jpg':
    case '.jpeg':
    case '.png':
    case '.gif':
    case '.webp':
      return extractImage(filePath);
    default:
      logger.debug({ filePath, ext }, 'Unsupported file type');
      return null;
  }
}

// --- Chunking ---

interface TextChunk {
  content: string;
  pageNumber: number | null;
}

function chunkText(pages: string[], chunkSize: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): TextChunk[] {
  const chunks: TextChunk[] = [];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageText = pages[pageIdx].trim();
    if (pageText.length === 0) continue;

    const pageNumber = pages.length > 1 ? pageIdx + 1 : null;

    // Split by paragraphs (double newline) to preserve boundaries
    const paragraphs = pageText.split(/\n\s*\n/);
    let currentChunk = '';

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length === 0) continue;

      if (currentChunk.length + trimmed.length + 2 > chunkSize && currentChunk.length > 0) {
        // Save current chunk
        chunks.push({ content: currentChunk.trim(), pageNumber });

        // Start new chunk with overlap from end of previous
        if (overlap > 0 && currentChunk.length > overlap) {
          currentChunk = currentChunk.slice(-overlap) + '\n\n' + trimmed;
        } else {
          currentChunk = trimmed;
        }
      } else {
        currentChunk += (currentChunk.length > 0 ? '\n\n' : '') + trimmed;
      }
    }

    // Don't forget the last chunk of the page
    if (currentChunk.trim().length > 0) {
      chunks.push({ content: currentChunk.trim(), pageNumber });
    }
  }

  return chunks;
}

// --- Indexing pipeline ---

/**
 * Process a single document: extract text, chunk, store in SQLite.
 * Returns number of chunks created, or 0 if skipped/failed.
 */
export async function processDocument(filePath: string, groupFolder: string): Promise<number> {
  if (!fs.existsSync(filePath)) {
    logger.warn({ filePath }, 'File not found');
    return 0;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return 0;
  }

  // Reject oversized files to prevent DoS
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    logger.warn({ filePath, size: stat.size, maxSize: MAX_FILE_SIZE }, 'File exceeds size limit, skipping');
    return 0;
  }

  // Check if file has changed since last indexing
  const hash = fileContentHash(filePath);
  const existingHash = getFileContentHash(filePath);
  if (existingHash === hash) {
    return 0; // Already indexed with same content
  }

  // Remove old chunks if re-indexing
  if (existingHash) {
    deleteDocumentChunks(filePath);
  }

  // Extract text
  const extraction = await extractDocument(filePath);
  if (!extraction || extraction.text.trim().length === 0) {
    logger.info({ filePath }, 'No text extracted');
    return 0;
  }

  // Chunk
  const textChunks = chunkText(extraction.pages);
  if (textChunks.length === 0) return 0;

  // Store chunks
  const fileName = displayName(filePath);
  const now = new Date().toISOString();
  const totalPages = extraction.pages.length > 1 ? extraction.pages.length : null;

  const dbChunks: Omit<DocumentChunk, 'embedding'>[] = textChunks.map((chunk, idx) => ({
    file_path: filePath,
    file_name: fileName,
    group_folder: groupFolder,
    chunk_index: idx,
    content: chunk.content,
    content_hash: hash,
    page_number: chunk.pageNumber,
    total_pages: totalPages,
    tokens_count: Math.ceil(chunk.content.length / 4), // Rough estimate
    indexed_at: now,
  }));

  storeDocumentChunks(dbChunks);
  logger.info({ filePath: fileName, chunks: dbChunks.length }, 'Document indexed');

  return dbChunks.length;
}

/**
 * Process all documents in a group's uploads directory.
 * Skips already-indexed files (by content hash).
 * Returns total chunks created.
 */
export async function processAllDocuments(groupFolder: string): Promise<number> {
  const uploadsDir = path.join(process.cwd(), 'groups', groupFolder, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    logger.debug({ groupFolder }, 'No uploads directory');
    return 0;
  }

  const files = fs.readdirSync(uploadsDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  });

  let totalChunks = 0;
  for (const file of files) {
    const filePath = path.join(uploadsDir, file);
    try {
      totalChunks += await processDocument(filePath, groupFolder);
    } catch (err) {
      logger.error({ file, err }, 'Failed to process document');
    }
  }

  return totalChunks;
}

/**
 * Generate embeddings for all chunks that don't have them yet.
 * Processes in batches to manage memory.
 */
export async function generateEmbeddings(groupFolder: string): Promise<number> {
  let totalEmbedded = 0;

  while (true) {
    const chunks = getChunksWithoutEmbeddings(groupFolder, EMBED_BATCH_SIZE);
    if (chunks.length === 0) break;

    const texts = chunks.map((c) => c.content);
    const embeddings = await embedTexts(texts);

    const updates = chunks.map((chunk, idx) => ({
      id: chunk.id,
      embedding: packEmbedding(embeddings[idx]),
    }));

    storeDocumentEmbeddings(updates);
    totalEmbedded += updates.length;

    logger.debug({ batch: updates.length, total: totalEmbedded }, 'Embeddings generated');
  }

  return totalEmbedded;
}

/**
 * Full indexing pipeline: extract, chunk, store, embed.
 * Runs in background, non-blocking.
 */
export async function indexAllDocuments(groupFolder: string): Promise<void> {
  logger.info({ groupFolder }, 'Starting document indexing');

  // Phase 1: Extract and chunk
  const chunks = await processAllDocuments(groupFolder);
  if (chunks > 0) {
    logger.info({ groupFolder, chunks }, 'Documents extracted and chunked');
  }

  // Phase 2: Generate embeddings (async, slower)
  try {
    const embedded = await generateEmbeddings(groupFolder);
    if (embedded > 0) {
      logger.info({ groupFolder, embedded }, 'Embeddings generated');
    }
  } catch (err) {
    // Embedding failure is non-fatal — keyword search still works
    logger.warn({ groupFolder, err }, 'Embedding generation failed (keyword search still available)');
  }
}

/**
 * Watch a group's uploads directory for new files.
 * Returns a cleanup function to stop watching.
 */
export function watchUploads(
  groupFolder: string,
  onNewFile?: (filePath: string) => void,
): () => void {
  const uploadsDir = path.join(process.cwd(), 'groups', groupFolder, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  // Debounce: track recently seen files to avoid duplicate processing
  const recentFiles = new Set<string>();

  const watcher = fs.watch(uploadsDir, (eventType, filename) => {
    if (!filename || eventType !== 'rename') return;

    const ext = path.extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;

    const filePath = path.join(uploadsDir, filename);

    // Debounce: skip if we just saw this file
    if (recentFiles.has(filename)) return;
    recentFiles.add(filename);
    setTimeout(() => recentFiles.delete(filename), 5000);

    // Wait a moment for the file to be fully written
    setTimeout(async () => {
      if (!fs.existsSync(filePath)) return;

      try {
        const chunks = await processDocument(filePath, groupFolder);
        if (chunks > 0) {
          onNewFile?.(filePath);
          // Generate embeddings in background
          generateEmbeddings(groupFolder).catch((err) => {
            logger.warn({ err }, 'Background embedding generation failed');
          });
        }
      } catch (err) {
        logger.error({ filePath, err }, 'Failed to index new upload');
      }
    }, 2000);
  });

  logger.info({ groupFolder, uploadsDir }, 'Watching uploads directory');

  return () => watcher.close();
}
