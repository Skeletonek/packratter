import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, new URL('..', import.meta.url).pathname, '');
  const apiPort = env.PORT || '8080';

  return {
    plugins: [sveltekit()],
    build: {
      // Vite 8 runs on rolldown, whose Rust core is fast enough that the
      // framework's own JS compile and this theme's Bootstrap SCSS dominate
      // the plugin-share heuristic, printing a [PLUGIN_TIMINGS] report on
      // every build. It is a profiling aid only; restore it by deleting this.
      rolldownOptions: {
        checks: { bundlerTimings: false },
      },
    },
    css: {
      preprocessorOptions: {
        scss: {
          // Bootstrap 5.3's own SCSS still uses the legacy patterns; silence
          // only those, so genuinely new warnings remain visible.
          silenceDeprecations: ['import', 'if-function', 'global-builtin', 'color-functions'],
        },
      },
    },
    server: {
      // Expose externally when run inside a container (see docker-compose.dev.yml).
      host: process.env.VITE_HOST === '1',
      proxy: {
        '/api/v1': `http://127.0.0.1:${apiPort}`,
        '/r': `http://127.0.0.1:${apiPort}`,
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  };
});
