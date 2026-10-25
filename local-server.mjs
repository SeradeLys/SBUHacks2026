// Local-only web server for the Wolfie Butler site (development on this laptop).
//   - Listens on 127.0.0.1 only, so nothing else on your network (or the Internet) can reach it.
//   - Serves only what the page uses: index.html, assets/ and data/. Never photon/, .env or anything else.
//   - Does not start, change or proxy the agent. The page talks to the agent at http://localhost:8787 by itself.
// Run it with start-local.bat (or: node local-server.mjs [port]).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WANTED = Number(process.argv[2]) || 5500;
const AGENT = "http://localhost:8787";
const ALLOWED = [/^\/index\.html$/, /^\/assets\/[^/]+$/, /^\/data\/[^/]+$/];
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = createServer(async (req, res) => {
  const headers = { "x-wolfie-local-server": "1", "cache-control": "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, headers); return res.end(); }
  let path;
  try { path = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { res.writeHead(400, headers); return res.end(); }
  if (path === "/") path = "/index.html";
  const file = resolve(join(ROOT, path));
  if (path.includes("..") || path.includes("\\") || !file.startsWith(ROOT + sep) || !ALLOWED.some(r => r.test(path))) { res.writeHead(404, headers); return res.end("Not found"); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headers, "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch { res.writeHead(404, headers); res.end("Not found"); }
});

async function isOurServer(port) {   // is whatever holds this port already this same local server?
  try { const r = await fetch(`http://127.0.0.1:${port}/index.html`, { method: "HEAD", signal: AbortSignal.timeout(2000) }); return r.headers.get("x-wolfie-local-server") === "1"; }
  catch { return false; }
}
function listen(port) {
  return new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", () => { server.off("error", fail); ok(); }); });
}
function openChrome(url) {   // Chrome if it is installed, otherwise the default browser
  const run = args => new Promise(done => { const p = spawn("cmd", ["/c", "start", "", ...args], { stdio: "ignore", windowsHide: true }); p.on("error", () => done(1)); p.on("exit", code => done(code ?? 1)); });
  return run(["chrome", url]).then(code => code === 0 ? "Chrome" : run([url]).then(() => "your default browser"));
}
async function agentStatus() {
  try { const r = await fetch(`${AGENT}/chat`, { signal: AbortSignal.timeout(2000) }); return r.ok ? "running" : "answering with an error"; } catch { return "not running"; }
}

// What is on a busy port? A different copy of the site usually talks to a different agent address (the one in its agentUrl).
async function describeBusy(port) {
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/index.html`, { signal: AbortSignal.timeout(2000) })).text();
    const theirs = /agentUrl:\s*"([^"]*)"/.exec(html)?.[1], mine = /agentUrl:\s*"([^"]*)"/.exec(await readFile(join(ROOT, "index.html"), "utf8"))?.[1];
    if (theirs && theirs !== mine) return `It is serving a DIFFERENT copy of the site, one that talks to the agent at ${theirs} instead of ${mine}.`;
    if (theirs) return "It is serving a copy of this site, but not from this folder.";
  } catch {}
  return "It is not serving this site.";
}

// No automatic fallback to another port: the browser keeps your account key (and so your profile) per address,
// so the same site on a different port would open a different, empty profile and not match your iMessage profile.
const port = WANTED;
try { await listen(port); }
catch (e) {
  if (e.code !== "EADDRINUSE") { console.error(`\nCould not start the server: ${e.message}`); process.exit(1); }
  if (await isOurServer(port)) {
    console.log(`\nThe local site is already running on port ${port}, so I will not start a second copy.`);
    const url = `http://localhost:${port}/index.html`; console.log(`Opening ${url} in ${await openChrome(url)}.`); process.exit(0);
  }
  console.error(`\nPort ${port} is already used by another program. ${await describeBusy(port)}`);
  console.error(`Stop that program, then run this again. To find it:  netstat -ano | findstr :${port}   (the last number is the process id; stop it with: taskkill /PID <id>)`);
  console.error(`Not switching to another port on purpose: your profile is saved per address, so another port would show a different profile.`);
  process.exit(1);
}

const url = `http://localhost:${port}/index.html`;
const agent = await agentStatus();
console.log("\n  Wolfie Butler site is running (this computer only)\n");
console.log(`  Open:   ${url}`);
console.log(`  Agent:  ${agent} at ${AGENT}${agent === "running" ? "" : "   <- start it separately: cd photon, then: bun agent.ts"}`);
console.log("\n  Press Ctrl+C (or close this window) to stop.\n");
console.log(`  Opening ${url} in ${await openChrome(url)}...`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.log("\nStopping the local site. Goodbye!"); server.close(); setTimeout(() => process.exit(0), 200); });
