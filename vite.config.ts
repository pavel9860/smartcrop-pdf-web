import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@core':    resolve(__dirname, 'src/core'),
      '@pdf':     resolve(__dirname, 'src/pdf'),
      '@ui':      resolve(__dirname, 'src/ui'),
      '@workers': resolve(__dirname, 'src/workers'),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs:  ['pdfjs-dist'],
          pdflib: ['pdf-lib'],
          onnx:   ['onnxruntime-web'],
        },
      },
    },
  },
  // ONNX ships its own WASM via CDN; avoid pre-bundling it
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
})
