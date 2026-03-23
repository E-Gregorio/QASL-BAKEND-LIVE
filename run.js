#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  QASL-BACKEND-LIVE — Single Command Runner
 *  Elyer Gregorio Maldonado — Líder Técnico QA
 *
 *  USO:
 *    node run.js                           → usa la primera colección en collections/
 *    node run.js mi-coleccion.json         → colección específica
 *    node run.js --delay 2000              → delay de 2s entre requests (modo presentación)
 *    node run.js mi-col.json --delay 3000  → colección + delay
 *
 *  AUTOMATIZA:
 *    1. Mata cualquier proceso en el puerto
 *    2. Levanta el servidor
 *    3. Abre el browser (Playwright Chromium)
 *    4. Ejecuta la colección Newman
 *    5. Genera reporte HTML
 *    6. Toma screenshot
 * ═══════════════════════════════════════════════════════════════
 */

const { execSync, fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 4747;
const ROOT = __dirname;
const COLLECTIONS_DIR = path.join(ROOT, 'collections');
const REPORTS_DIR = path.join(ROOT, 'reports');

// ── Banner ───────────────────────────────────────────────────────
function banner(collName) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║            ⚡  QASL-BACKEND-LIVE  v1.0.0                 ║
║            Elyer Gregorio Maldonado                      ║
║            Líder Técnico QA                              ║
╠══════════════════════════════════════════════════════════╣
║  Colección : ${(collName || '').padEnd(40)}║
╚══════════════════════════════════════════════════════════╝
`);
}

// ── 1. Kill port ─────────────────────────────────────────────────
function killPort() {
  try {
    const result = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const pids = new Set();
    result.split('\n').forEach(line => {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0' && /^\d+$/.test(pid)) pids.add(pid);
    });
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
        console.log(`🔪 Proceso ${pid} terminado (puerto ${PORT} liberado)`);
      } catch {}
    }
    // Small wait for port release
    if (pids.size > 0) {
      execSync('ping -n 2 127.0.0.1 > nul', { stdio: 'ignore' });
    }
  } catch {
    // Port is free
  }
}

// ── 2. Parse args ────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let collArg = null;
  let delay = 2000; // Default: 2s delay for step-by-step visualization
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--delay' && args[i + 1]) { delay = parseInt(args[i + 1]); i++; }
    else if (args[i] === '--no-delay') { delay = 0; }
    else if (!args[i].startsWith('--')) { collArg = args[i]; }
  }
  return { collArg, delay };
}

// ── 3. Resolve collection ────────────────────────────────────────
function resolveCollection(collArg) {
  const arg = collArg;

  if (arg) {
    // Absolute path
    if (path.isAbsolute(arg) && fs.existsSync(arg)) return arg;
    // Relative to collections/
    const inColl = path.join(COLLECTIONS_DIR, arg);
    if (fs.existsSync(inColl)) return inColl;
    // Relative to cwd
    const inCwd = path.resolve(arg);
    if (fs.existsSync(inCwd)) return inCwd;
    console.error(`❌ Colección no encontrada: ${arg}`);
    process.exit(1);
  }

  // Auto-detect: first .json in collections/
  if (fs.existsSync(COLLECTIONS_DIR)) {
    const jsons = fs.readdirSync(COLLECTIONS_DIR).filter(f => f.endsWith('.json'));
    if (jsons.length > 0) return path.join(COLLECTIONS_DIR, jsons[0]);
  }

  console.error('❌ No hay colecciones en collections/');
  console.error('   Coloca un archivo .json de Postman en la carpeta collections/');
  process.exit(1);
}

// ── 3. Wait for server ───────────────────────────────────────────
function waitForServer(maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.get(`http://localhost:${PORT}/api/state`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (attempts >= maxAttempts) reject(new Error('Server timeout'));
        else setTimeout(check, 500);
      });
      req.setTimeout(2000, () => { req.destroy(); });
    };
    check();
  });
}

// ── 4. Trigger Newman ────────────────────────────────────────────
function triggerNewman(collectionPath) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ collectionPath });
    const req = http.request({
      hostname: 'localhost', port: PORT, path: '/api/run',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── 5. Open browser ──────────────────────────────────────────────
async function openBrowser() {
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
    const ctx = await browser.newContext({ viewport: null });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'load' });
    console.log(`🌐 Browser abierto: http://localhost:${PORT}`);
    return { browser, page };
  } catch (e) {
    console.log(`⚠  Playwright no disponible, abre manualmente: http://localhost:${PORT}`);
    return null;
  }
}

// ── 6. Wait for completion & screenshot ──────────────────────────
function waitForCompletion(maxWait = 300000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      http.get(`http://localhost:${PORT}/api/state`, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const state = JSON.parse(body);
            if (!state.running && state.summary.endTime) {
              resolve(state);
              return;
            }
          } catch {}
          if (Date.now() - start > maxWait) resolve(null);
          else setTimeout(check, 1000);
        });
      }).on('error', () => {
        if (Date.now() - start > maxWait) resolve(null);
        else setTimeout(check, 2000);
      });
    };
    setTimeout(check, 2000);
  });
}

// ── MAIN ─────────────────────────────────────────────────────────
(async () => {
  const { collArg, delay } = parseArgs();
  const collPath = resolveCollection(collArg);
  const collName = path.basename(collPath);
  banner(collName);
  if (delay > 0) console.log(`⏱  Delay entre requests: ${delay}ms (modo presentación)`);

  // Step 1: Kill port
  killPort();

  // Step 2: Start server with delay env
  const serverProc = fork(path.join(ROOT, 'src', 'server.js'), [], {
    stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, QASL_DELAY: String(delay) }
  });

  // Handle server exit
  serverProc.on('exit', (code) => {
    if (code && code !== 0) console.error(`\n❌ Servidor terminó con error: ${code}`);
  });

  // Graceful shutdown
  const cleanup = () => {
    serverProc.kill();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // Step 3: Wait for server ready
    await waitForServer();

    // Step 4: Open browser
    const bw = await openBrowser();

    // Step 5: Execute Newman
    const result = await triggerNewman(collPath);
    console.log(`▶ Newman iniciado: ${JSON.stringify(result)}`);

    // Step 6: Wait for completion
    const finalState = await waitForCompletion();
    if (finalState) {
      const s = finalState.summary;
      const successCount = finalState.requests.filter(r => r.status === 'success').length;
      const errorCount = finalState.requests.filter(r => r.status === 'error').length;
      console.log(`\n✅ Ejecución completada`);
      console.log(`   Requests: ${finalState.requests.length}`);
      console.log(`   Exitosos: ${successCount}`);
      console.log(`   Errores:  ${errorCount}`);
      console.log(`   Duración: ${s.durationFormatted || '-'}`);
    }

    // Step 7: Screenshot
    if (bw && bw.page) {
      try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
        const ssPath = path.join(REPORTS_DIR, `screenshot-${Date.now()}.png`);
        await bw.page.waitForTimeout(2000);
        await bw.page.screenshot({ path: ssPath, fullPage: false });
        console.log(`📸 Screenshot: ${ssPath}`);
      } catch {}
    }

    // Keep alive for review
    console.log('\n⏸  Browser abierto para revisión. Ctrl+C para cerrar.');

  } catch (e) {
    console.error('❌ Error:', e.message);
    serverProc.kill();
    process.exit(1);
  }
})();
