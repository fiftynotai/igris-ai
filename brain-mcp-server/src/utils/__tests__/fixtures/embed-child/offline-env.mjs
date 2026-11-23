// TD-525 fixture embed module (ES8/ES8c): the REAL embeddings module (emb=<url of a compiled
// embeddings.js>) with transformers pointed at an empty cache dir (cache=<dir>) and a closed port,
// so neither a local hit nor a download is possible. arm=1 re-exports the real
// setEmbeddingsOffline; arm=0 replaces it with a no-op (the control: the fetch is attempted).
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const q = new URL(import.meta.url).searchParams;
const embUrl = q.get('emb');
const emb = await import(embUrl);
// The same module instance embeddings.js imports: resolve the package from embeddings.js's location.
const req = createRequire(fileURLToPath(embUrl));
const cjs = req.resolve('@huggingface/transformers');
const t = await import(pathToFileURL(cjs.replace(/transformers\.node\.cjs$/, 'transformers.node.mjs')).href);
t.env.cacheDir = q.get('cache');
t.env.remoteHost = 'http://127.0.0.1:9/';
export const generateEmbedding = (text) => emb.generateEmbedding(text);
export const disposeEmbeddingPipeline = () => emb.disposeEmbeddingPipeline();
export const setEmbeddingsOffline = q.get('arm') === '1' ? () => emb.setEmbeddingsOffline() : () => {};
