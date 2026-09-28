import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Solo `src`: sin esto vitest recoge también los `.test.js` compilados que
    // quedan en `dist` y falla, porque no son ESM ni tienen las rutas bien.
    include: ['src/**/*.test.ts'],
    // El typecheck corre aparte (`npm run typecheck`, con tsconfig.test.json).
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },
});
