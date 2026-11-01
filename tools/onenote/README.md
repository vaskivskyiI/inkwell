# onenote-export

Turns OneNote files (`.one`, `.onetoc2`, `.onepkg`) into `doc.json` plus a `files/` folder, using the
[onenote_parser](https://github.com/msiemens/onenote.rs) crate (MPL-2.0). `server/src/importers/onenote.js` reads the result.

It runs as WebAssembly, so a server needs no Rust. The built `server/src/importers/onenote-export.wasm` is checked in;
after changing this tool rebuild it:

```bash
rustup target add wasm32-wasip1
cargo build --release --target wasm32-wasip1
cp target/wasm32-wasip1/release/onenote-export.wasm ../../server/src/importers/onenote-export.wasm
```
