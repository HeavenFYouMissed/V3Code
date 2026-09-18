#!/usr/bin/env node
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// Surgically transpile ONE TypeScript file to the out/ ESM format the workbench
// build uses (esbuild + experimentalDecorators), WITHOUT touching the rest of
// out/. Used to land a tiny browser/ change live without a clean-out compile.
// Usage: node scripts/transpile-one.mjs <src.ts> <dest.js>
import { readFileSync, writeFileSync } from 'node:fs';
import esbuild from 'esbuild';

const [, , srcPath, destPath] = process.argv;
if (!srcPath || !destPath) { console.error('usage: transpile-one.mjs <src.ts> <dest.js>'); process.exit(2); }

const src = readFileSync(srcPath, 'utf8');
const res = await esbuild.transform(src, {
	loader: 'ts',
	format: 'esm',
	target: 'esnext',
	sourcemap: false,
	tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
});
writeFileSync(destPath, res.code);
console.log(`transpiled ${srcPath} -> ${destPath} (${res.code.length} bytes)`);
