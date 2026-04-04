import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  optimizeDeps: {
    // Prevent Vite from pre-bundling transformers.js — it must load its own
    // WASM/worker internals at runtime, not be statically bundled.
    exclude: ['@huggingface/transformers'],
  },
  build: {
    rollupOptions: {
      // Do not attempt to bundle the ONNX WASM runtime
      external: ['@huggingface/transformers'],
    },
  },
});
