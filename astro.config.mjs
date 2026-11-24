import { defineConfig } from 'astro/config';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default defineConfig({
    site: 'https://flow-study.me',
    output: 'static',
    build: { format: 'file' },
    vite: {
        // Never inline a script into the page: the Content-Security-Policy forbids inline scripts.
        // esbuild, not Lightning CSS, minifies the CSS: Lightning folds animation-timeline into the animation
        // shorthand, which Chrome rejects, and every scroll-driven animation silently stops (the nav pill, the footer sunset).
        build: { assetsInlineLimit: 0, cssMinify: 'esbuild' },
        plugins: [{
            name: 'flow-local-api',
            configureServer(server) {
                const app = require('./server.js');
                server.middlewares.use((req, res, next) => {
                    if (req.url?.startsWith('/api/')) app(req, res, next);
                    else next();
                });
            }
        }]
    }
});
