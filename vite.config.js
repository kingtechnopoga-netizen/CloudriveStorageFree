import { defineConfig } from 'vite';

// CloudVault — Vite config
// Vanilla JS project. Build output goes to ./dist for Render Static Site deployment.
export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2019'
  },
  server: {
    port: 5173,
    host: true
  },
  preview: {
    port: 4173,
    host: true
  }
});
