/**
 * Smoke test do pacote: sobe o servidor e confere que API e página respondem.
 * Na pipeline roda dentro do Node do Electron (ELECTRON_RUN_AS_NODE=1), o mesmo runtime do .exe.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "fin-control-smoke-"));
process.env.FIN_CONTROL_ROOT = root;

console.log(`Runtime: node ${process.versions.node}${process.versions.electron ? ` / electron ${process.versions.electron}` : ""}`);

const { startServer, stopServer } = await import("../src/server.ts");
let failed = false;
try {
  const { url } = await startServer({ openBrowser: false, port: 0 });
  for (const pathname of ["/api/status", "/", "/app.js"]) {
    const res = await fetch(`${url}${pathname}`);
    console.log(`${res.status} ${pathname}`);
    if (!res.ok) failed = true;
  }
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  await stopServer();
  await rm(root, { recursive: true, force: true });
}

console.log(failed ? "✘ smoke test falhou" : "✔ smoke test ok");
process.exit(failed ? 1 : 0);
