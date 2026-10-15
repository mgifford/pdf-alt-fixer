import { defineConfig } from 'vite';

// Base './' keeps asset paths working on GitHub Pages project sites.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
