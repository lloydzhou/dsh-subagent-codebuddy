/**
 * Build the browser half into the format the dsh client module loader expects:
 * a classic script that registers a CJS factory with `window.__ModuleLoader__`.
 *
 * `react` and `react/jsx-runtime` stay external — the loader resolves them from
 * the host's own module table.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const outfile = 'lib/client.js'
const bodyFile = 'lib/.client.body.js'

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: bodyFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  legalComments: 'none',
  logLevel: 'warning',
})

const body = fs.readFileSync(bodyFile, 'utf8')
fs.rmSync(bodyFile)

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`

fs.mkdirSync(path.dirname(outfile), { recursive: true })
fs.writeFileSync(outfile, wrapped)
console.log(`built ${outfile} (${(wrapped.length / 1024).toFixed(1)} KB)`)
