// Builds a static copy of the app (no server) into dist/, for GitHub Pages or any static host.
// The browser falls back to its built-in SQLite backend when /api/health is missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const sqlJs = path.join(root, 'node_modules', 'sql.js', 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
for (const file of ['sql-wasm.js', 'sql-wasm.wasm']) fs.copyFileSync(path.join(sqlJs, file), path.join(out, 'vendor', file));
// Serve files as-is (no Jekyll processing on GitHub Pages).
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Static site written to ${path.relative(root, out)}/`);
