/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Относительный base: работает и на <user>.github.io/<repo>/, и локально.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
