import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
    // Clean-URL rewrites for the two designed apps: /<screen> → index.html (console),
    // /portal/<screen> → portal.html. Anything with an extension (assets, .html entries,
    // /@vite internals) passes through untouched. Production hosting needs the same rewrites.
    {
      name: 'clean-url-rewrites',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const url = (req.url || '').split('?')[0]
          const passthrough = url.includes('.') || url.startsWith('/@') || url.startsWith('/api')
          if (!passthrough) {
            if (url === '/portal' || url.startsWith('/portal/')) req.url = '/portal.html'
            else if (url !== '/') req.url = '/index.html'
          } else if (url.startsWith('/portal/') && url !== '/portal.html') {
            // Relative asset refs inside portal.html (stimes-logo.svg, etc.) resolve under
            // /portal/<screen>/… at ANY depth on deep links — all assets live at the web root, so
            // serve by basename. (support.js itself is now an absolute /support.js reference.)
            req.url = '/' + url.split('/').pop()
          }
          next()
        })
      },
    },
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  // Deployable pages:
  //  - index.html       → PROVIDER CONSOLE: the designed static app (v3 .dc.html, self-contained,
  //                       dummy data, runs on public/support.js). Backend wiring comes later.
  //  - console-app.html → the older React console (main.tsx → App), kept parked with all its
  //                       API integration intact for the wiring phase.
  //  - portal.html      → CLIENT PORTAL: the designed static app (v2, partially wired).
  //  - portal-app.html  → the older React portal, parked, API integration intact.
  // Deploy portal.html to the portal domain (e.g. portal.stimes.sa).
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        console_app: path.resolve(__dirname, 'console-app.html'),
        portal: path.resolve(__dirname, 'portal.html'),
        portal_app: path.resolve(__dirname, 'portal-app.html'),
      },
    },
  },
})
