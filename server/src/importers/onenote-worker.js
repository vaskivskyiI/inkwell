// Runs the OneNote converter (tools/onenote, WebAssembly) off the main thread: big notebooks take a while.
import fs from 'node:fs';
import { WASI } from 'node:wasi';
import { workerData } from 'node:worker_threads';

const { root, input, out } = workerData;
const wasi = new WASI({ version: 'preview1', args: ['onenote-export', `/work/${input}`, `/work/${out}`], preopens: { '/work': root }, returnOnExit: true });
const mod = await WebAssembly.compile(fs.readFileSync(new URL('./onenote-export.wasm', import.meta.url)));
wasi.start(await WebAssembly.instantiate(mod, wasi.getImportObject()));
