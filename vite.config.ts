import { defineConfig } from 'vite'
import { resolve } from 'path'
import { viteStaticCopy } from 'vite-plugin-static-copy'

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
          onnx:   ['onnxruntime-web/webgpu'],
        },
      },
    },
  },
  // onnxruntime-web's own execution-engine WASM is fetched by the library itself at runtime;
  // avoid pre-bundling the JS wrapper. Model *weights* (public/models/*.onnx) are separate
  // static assets, served via the plugin below, not part of this exclusion.
  optimizeDeps: {
    exclude: ['onnxruntime-web', 'onnxruntime-web/webgpu'],
  },
  plugins: [
    // pdf.js needs its cmaps/standard_fonts at runtime for CJK/glyph shaping (loader.ts fetches
    // them from /cmaps/, /standard_fonts/) — previously declared as a devDependency but never
    // wired up, so a real production build 404'd on these paths despite the dev server serving
    // node_modules directly and masking the gap. (Dewarp model weights don't need this plugin —
    // they're vendored directly under public/models/, which Vite serves as-is in both dev and
    // build with no extra config.)
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/cmaps/*',          dest: 'cmaps' },
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'standard_fonts' },
      ],
    }),
  ],
})
