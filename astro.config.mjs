import { defineConfig } from 'astro/config';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default defineConfig({
    site: 'https://flow-study.me',
    output: 'static',
    build: { format: 'file' },
    vite: {
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
