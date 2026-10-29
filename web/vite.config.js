import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8080', ws: true } },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/@tiptap') || id.includes('node_modules/prosemirror') ? 'editor'
          : id.includes('node_modules/yjs') || id.includes('node_modules/@hocuspocus') || id.includes('node_modules/y-') || id.includes('node_modules/lib0') ? 'sync' : undefined),
      },
    },
  },
});
