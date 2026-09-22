import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // GitHub Pages project site: https://tawfeks.github.io/decisionkit/
  site: 'https://tawfeks.github.io',
  base: '/decisionkit',
  // Load PUBLIC_* variables (e.g. PUBLIC_X_PROFILE) from the repo-root .env
  // without committing it. The file itself is never read by humans.
  vite: {
    envDir: '..',
  },
});
