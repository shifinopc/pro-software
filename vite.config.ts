import { defineConfig, transformWithEsbuild } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

/**
 * THE BUILD WAS DOING ALMOST NOTHING, AND THIS IS WHY.
 *
 * Both front ends keep their logic in a `<script type="text/x-dc" data-dc-script>` block — a data
 * island, not a script. The browser never executes it; support.js reads it with `.textContent` and
 * evaluates it. Which also means Vite does not recognise it as code, so it was shipped exactly as
 * written: 2.1MB of the console's 4.05MB document, comments and all. Measured, the whole production
 * build came out 1.1% smaller than the file on disk.
 *
 * So this minifies that one block. Measured on the console's island:
 *
 *                              raw        gzip      brotli
 *   as written             2,160,056     628,257   470,552
 *   whitespace + syntax    1,156,840     343,605   268,119   ← this
 *   full minify            1,037,767     321,011   252,924
 *
 * IDENTIFIERS ARE DELIBERATELY KEPT. Full minification is 15KB better over the wire — 5% of this
 * block once brotli has had it — and it costs every local name in the console. The app reports its
 * own errors to /api/error-reports, and the useful ones read like "_ago9 is not defined"; renaming
 * turns those into "a is not defined" for 15KB. Line numbers go either way, so names are all the
 * signal that is left. Not a trade worth making.
 *
 * Even so this is the larger half of the cost: raw bytes are what the JS parser walks, and that is
 * 2.16MB down to 1.16MB on every cold load and after every deploy.
 *
 * WHAT WOULD BREAK IT, checked rather than assumed. Nothing may depend on the island's source text
 * or on a local's name: it holds no `eval`, no `with`, no `new Function`, no `arguments.callee` and
 * no `constructor.name` (the 770 `.name` reads are all data fields, which are never renamed). The
 * one name the RUNTIME resolves by text is `Component` — support.js appends
 * `return (typeof Component!=="undefined"&&Component)` after evaluating the island — and esbuild in
 * transform mode leaves top-level declarations alone, since in a script they could be globals.
 * `scripts/island-minify-check.ts` asserts all of that against the built output.
 */
const minifyDcIsland = {
  name: 'minify-dc-island',
  apply: 'build' as const,
  // After Vite's own HTML handling, so the tag it rewrites is the one that ships.
  enforce: 'post' as const,
  async transformIndexHtml(html: string) {
    const open = /<script\b[^>]*\bdata-dc-script\b[^>]*>/i.exec(html)
    if (!open) return html                       // console-app.html / portal-app.html have no island
    const start = open.index + open[0].length
    // The island cannot itself contain `</script>` — the browser would have ended the element
    // there and the app would never have run — so the first one is the real close tag.
    const end = html.indexOf('</script>', start)
    if (end < 0) return html
    const src = html.slice(start, end)
    const out = await transformWithEsbuild(src, 'dc-island.js', {
      loader: 'js',
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,
    })
    const pct = ((1 - out.code.length / src.length) * 100).toFixed(0)
    console.log(`  dc-island: ${(src.length / 1024).toFixed(0)}KB → ${(out.code.length / 1024).toFixed(0)}KB (-${pct}%)`)
    return html.slice(0, start) + out.code + html.slice(end)
  },
}

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
    minifyDcIsland,
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
