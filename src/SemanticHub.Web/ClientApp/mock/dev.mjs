// `npm run dev:mock`: the mock API (mock/server.mjs, :5090) and Vite in mock mode (:5173) in ONE process,
// so stopping it — Ctrl+C or killing the process — always stops both (no orphaned child processes on Windows).
import { createServer } from "vite";

await import("./server.mjs");
const vite = await createServer({ mode: "mock" });
await vite.listen();
vite.printUrls();
