import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import wasm from 'vite-plugin-wasm'
import strip from '@rollup/plugin-strip'
import tailwindcss from '@tailwindcss/vite'
import { createBundleBoundaryReportPlugin } from './util/bundle-boundary-report'
import { createViteBuildWarningPolicy } from './util/vite-warning-policy'
import { createLocaleChunkUrlsPlugin } from './util/locale-chunk-urls'
import { resolveBuildIdentity } from './server/fastify/src/buildIdentity'
// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const sourceRoot = fileURLToPath(new URL('./', import.meta.url))
  const configuredBuild = loadEnv(mode, sourceRoot, 'VITE_').VITE_RISU_BUILD_ID
  const frontendBuildIdentity =
    command === 'build' ? resolveBuildIdentity({ sourceRoot, configuredBuild: configuredBuild ?? null }) : undefined
  const frontendGitBuild = frontendBuildIdentity?.source === 'git' ? frontendBuildIdentity.build : undefined
  return {
    plugins: [
      createLocaleChunkUrlsPlugin(process.cwd()),
      svelte({
        preprocess: vitePreprocess(),
      }),
      tailwindcss(),
      wasm(),
      command === 'build'
        ? strip({
            include: '**/*.(mjs|js|svelte|ts)',
          })
        : null,
      command === 'build' && process.env.VITE_FAST_BOOTSTRAP_REPORT === 'TRUE'
        ? createBundleBoundaryReportPlugin(process.cwd())
        : null,
    ],

    clearScreen: false,
    ...(frontendGitBuild
      ? {
          define: {
            'import.meta.env.VITE_RISU_BUILD_ID': JSON.stringify(frontendGitBuild),
          },
        }
      : {}),
    server: {
      host: '0.0.0.0', // listen on all addresses
      port: 5174,
      strictPort: true,
      watch: {
        ignored: ['**/data/**', '**/dist/**', '**/test-results/**'],
      },
      proxy: {
        '/api': {
          target: process.env.RISU_API_PROXY_TARGET ?? 'http://localhost:6002',
          changeOrigin: true,
        },
      },
    },
    envPrefix: ['VITE_'],
    build: {
      target: 'baseline-widely-available',
      minify: 'oxc',
      chunkSizeWarningLimit: 2000,
      manifest: process.env.VITE_FASTIFY_BROWSER_SMOKE === 'TRUE' ? 'vite-assets-manifest.json' : false,
      rolldownOptions: {
        onLog: createViteBuildWarningPolicy(process.cwd()),
      },
    },

    optimizeDeps: {
      // Scan every production frontend module up front so dependencies behind
      // lazy routes and optional features are optimized before they are opened.
      // Vite's default index.html crawl only follows the initial application
      // graph and can otherwise trigger a later dependency re-bundle/reload.
      entries: [
        'src/**/*.{ts,svelte}',
        '!src/**/*.d.ts',
        '!src/**/*.test.*',
        '!src/**/*.test[A-Z-]*',
        '!src/**/{tests,__tests__,__fixtures__,testHarness}/**',
      ],
      needsInterop: ['@mlc-ai/web-tokenizers'],
    },

    resolve: {
      alias: {
        src: '/src',
      },
    },
    worker: {
      format: 'es',
    },
  }
})
