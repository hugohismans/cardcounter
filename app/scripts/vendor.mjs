// Copie les fichiers d'onnxruntime-web nécessaires dans vendor/ort (servis tels quels, hors ligne).
import { cpSync, mkdirSync } from 'node:fs';
const src = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);
const dst = new URL('../vendor/ort/', import.meta.url);
mkdirSync(dst, { recursive: true });
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  cpSync(new URL(f, src), new URL(f, dst));
}
console.log('onnxruntime-web copié dans vendor/ort');
