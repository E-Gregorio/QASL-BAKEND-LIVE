/**
 * ═══════════════════════════════════════════════════════════════
 *  QASL-BACKEND-LIVE  v1.0.0
 *  Newman Live Dashboard — WebSocket + Express + Newman
 *  Elyer Gregorio Maldonado — Líder Técnico QA
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const newman = require('newman');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 4747;
let clients = new Set();
let executionState = {
  running: false,
  collection: null,
  requests: [],
  summary: { total: 0, passed: 0, failed: 0, errors: 0, startTime: null, endTime: null }
};

// ── Variable/Chain Detection State ──
let valorIndex = new Map();
let chainRelations = [];
let systemsMap = {};
let variableUsageCount = new Map();

// ── Static & API ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.use('/reports', express.static(path.join(__dirname, '../reports')));
app.use(express.json());

app.get('/api/state', (req, res) => res.json(executionState));

app.get('/api/reports', (req, res) => {
  const dir = path.join(__dirname, '../reports');
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.html'))
    .map(f => ({ filename: f, url: `/reports/${f}`, created: fs.statSync(path.join(dir, f)).mtime }))
    .sort((a, b) => b.created - a.created);
  res.json(files);
});

app.post('/api/run', (req, res) => {
  const { collectionPath, environmentPath } = req.body;
  if (executionState.running) return res.status(409).json({ error: 'Ya hay una ejecución en curso' });
  runNewman(collectionPath, environmentPath);
  res.json({ ok: true, message: 'Ejecución iniciada' });
});

// ── WebSocket ────────────────────────────────────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const c of clients) { if (c.readyState === 1) c.send(msg); }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ event: 'state', data: executionState, ts: Date.now() }));
  ws.on('close', () => clients.delete(ws));
});

// ── Variable Detection Helpers ──────────────────────────────────
function classifyValue(value) {
  if (typeof value !== 'string') return null;
  if (value.length < 8 || value.length > 500) return null;
  const lv = value.toLowerCase().trim();
  if (['true','false','null','ok','success','error','pending','active','inactive',
       'enabled','disabled','yes','no','get','post','put','delete','patch',
       'application/json','text/html','text/plain','utf-8','gzip'].includes(lv)) return null;
  if (/^\d+$/.test(value) && value.length < 10) return null;
  if (/^\s*$/.test(value)) return null;
  if (value.startsWith('eyJ')) return 'JWT';
  if (/^EX-\d{4}/.test(value)) return 'EE_ID';
  if (/^IF-\d{4}/.test(value)) return 'GEDO_ID';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return 'UUID';
  if (value.length > 100) return 'TOKEN';
  return 'VALUE';
}

function extractValues(obj, prefix) {
  const r = [];
  if (obj == null) return r;
  if (typeof obj === 'string') {
    const t = classifyValue(obj);
    if (t) r.push({ campo: prefix || '_value', value: obj, tipo: t });
    return r;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => r.push(...extractValues(v, (prefix || '') + '[' + i + ']')));
    return r;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      r.push(...extractValues(v, prefix ? prefix + '.' + k : k));
    }
  }
  return r;
}

function findChains(target, vIndex, basePath) {
  const hits = [];
  if (!target) return hits;
  const seen = new Set();
  function walk(obj, path) {
    if (typeof obj === 'string' && obj.length >= 8) {
      for (const [val, info] of vIndex) {
        const key = info.campo + '|' + (path || basePath);
        if (obj.includes(val) && !seen.has(key)) {
          seen.add(key);
          hits.push({ variable: info.campo, tipo: info.tipo, origen: info.origen, via: path || basePath });
        }
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, (path ? path + '[' + i + ']' : '[' + i + ']')));
    } else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) walk(v, path ? path + '.' + k : k);
    }
  }
  walk(target, '');
  return hits;
}

function getRawResponseBody(response) {
  if (!response) return null;
  try {
    let text = '';
    if (response.stream) {
      if (Buffer.isBuffer(response.stream)) text = response.stream.toString('utf8');
      else if (response.stream instanceof Uint8Array) text = Buffer.from(response.stream).toString('utf8');
      else if (typeof response.stream === 'string') text = response.stream;
      else if (Array.isArray(response.stream)) text = Buffer.from(response.stream).toString('utf8');
      else text = String(response.stream);
    }
    if (!text && response.body) text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    if (!text) return null;
    return JSON.parse(text);
  } catch { return null; }
}

// ── Newman Runner ────────────────────────────────────────────────
function runNewman(collectionPath, environmentPath) {
  // Auto-detect collection: argument > first .json in collections/
  let collFile = collectionPath;
  if (!collFile) {
    const collDir = path.join(__dirname, '../collections');
    if (fs.existsSync(collDir)) {
      const jsons = fs.readdirSync(collDir).filter(f => f.endsWith('.json'));
      if (jsons.length > 0) collFile = path.join(collDir, jsons[0]);
    }
  }
  if (!collFile || !fs.existsSync(collFile)) {
    broadcast('error', { message: `Colección no encontrada: ${collFile || 'ninguna'}` });
    return;
  }

  const collectionData = JSON.parse(fs.readFileSync(collFile, 'utf8'));

  // Count total items (flatten folders)
  function countItems(items) {
    let n = 0;
    if (!items) return 0;
    for (const item of items) {
      if (item.item) n += countItems(item.item);
      else n++;
    }
    return n;
  }
  const totalItems = countItems(collectionData.item);

  executionState = {
    running: true,
    collection: collectionData.info?.name || path.basename(collFile, '.json'),
    requests: [],
    summary: { total: 0, passed: 0, failed: 0, errors: 0, startTime: Date.now(), endTime: null }
  };

  // Reset detection state
  valorIndex = new Map();
  chainRelations = [];
  systemsMap = {};
  variableUsageCount = new Map();

  broadcast('execution_start', {
    collection: executionState.collection,
    totalItems,
    startTime: executionState.summary.startTime
  });

  // Delay between requests for step-by-step visualization (ms)
  // Set via CLI arg: --delay 2000  or env: QASL_DELAY=2000
  const delay = parseInt(process.env.QASL_DELAY) || 0;

  const options = {
    collection: collectionData,
    reporters: ['cli'],
    timeoutRequest: 30000,
    insecure: true,
    delayRequest: delay
  };

  if (environmentPath && fs.existsSync(environmentPath)) {
    options.environment = environmentPath;
  }

  const run = newman.run(options);

  // ── beforeRequest ──
  run.on('beforeRequest', (err, args) => {
    if (err) return;
    const req = args.request;
    const item = args.item;
    const reqEntry = {
      id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: item.name,
      method: req.method,
      url: req.url?.toString() || '',
      headers: sanitizeHeaders(req.headers?.toObject() || {}),
      body: getRequestBody(req),
      status: 'pending',
      responseStatus: null,
      responseTime: null,
      responseBody: null,
      assertions: [],
      timestamp: Date.now(),
      authType: detectAuthType(req)
    };
    executionState.requests.push(reqEntry);
    broadcast('request_start', reqEntry);

    // ── Chain Detection ──
    const rawUrl = req.url?.toString() || '';
    const rawHeaders = req.headers?.toObject() || {};
    let rawBody = null;
    try { rawBody = req.body?.raw ? JSON.parse(req.body.raw) : null; } catch { rawBody = req.body?.raw || null; }

    const allHits = [];
    // Search URL
    for (const [val, info] of valorIndex) {
      if (rawUrl.includes(val)) {
        allHits.push({ variable: info.campo, tipo: info.tipo, origen: info.origen, via: 'URL' });
      }
    }
    // Search headers
    for (const [hk, hv] of Object.entries(rawHeaders)) {
      if (typeof hv === 'string' && hv.length >= 8) {
        for (const [val, info] of valorIndex) {
          if (hv.includes(val)) {
            allHits.push({ variable: info.campo, tipo: info.tipo, origen: info.origen, via: hk + ' header' });
          }
        }
      }
    }
    // Search body
    allHits.push(...findChains(rawBody, valorIndex, 'body'));

    // Broadcast detected chains (deduplicated per variable per request)
    const seenVars = new Set();
    for (const hit of allHits) {
      const key = hit.variable + '→' + item.name;
      if (seenVars.has(key)) continue;
      seenVars.add(key);
      const rel = { variable: hit.variable, tipo: hit.tipo, nacio_en: hit.origen, usado_en: item.name, via: hit.via };
      chainRelations.push(rel);
      const cnt = (variableUsageCount.get(hit.variable) || 0) + 1;
      variableUsageCount.set(hit.variable, cnt);
      broadcast('variable_detected', { ...rel, usadoCount: cnt, totalRequests: totalItems });
    }

    // ── System Detection ──
    try {
      const pu = new URL(rawUrl);
      const hn = pu.hostname;
      if (!systemsMap[hn]) {
        const parts = hn.split(/[-\.]/);
        systemsMap[hn] = { requests: [], count: 0, label: parts[0].toUpperCase() };
      }
      if (!systemsMap[hn].requests.includes(item.name)) systemsMap[hn].requests.push(item.name);
      systemsMap[hn].count++;
      broadcast('systems_update', { sistemas: systemsMap });
    } catch {}
  });

  // ── SADE Polling State ──
  let sadePolling = { selection: { attempts: 0, startTime: null, endTime: null, found: false }, expedient: { attempts: 0, startTime: null, endTime: null, found: false } };

  // ── request (response received) ──
  run.on('request', (err, args) => {
    if (err) {
      const last = executionState.requests[executionState.requests.length - 1];
      if (last) {
        last.status = 'error';
        last.error = err.message;
        broadcast('request_error', last);
        executionState.summary.errors++;
      }
      return;
    }

    const response = args.response;
    const item = args.item;
    const reqEntry = executionState.requests.find(r => r.name === item.name && r.status === 'pending');

    if (reqEntry) {
      reqEntry.responseStatus = response.code;
      reqEntry.responseTime = response.responseTime;
      reqEntry.responseBody = parseResponseBody(response);
      reqEntry.responseHeaders = sanitizeHeaders(response.headers?.toObject() || {});
      reqEntry.status = response.code >= 400 ? 'error' : 'success';
      executionState.summary.total++;

      // ── SADE Wait/Polling Detection ──
      const isWaitImport = item.name.includes('02B') && item.name.includes('Espera SADE');
      if (isWaitImport) {
        reqEntry._sadeWait = true;
        broadcast('sade_wait', { phase: 'import', elapsed: reqEntry.responseTime || 0 });
      }
      const isPollingSelection = item.name.includes('04B') && item.name.includes('SADE Polling');
      const isPollingExpedient = item.name.includes('10B') && item.name.includes('SADE Polling');
      if (isPollingSelection || isPollingExpedient) {
        const key = isPollingSelection ? 'selection' : 'expedient';
        reqEntry._sadePolling = key;
        sadePolling[key].attempts++;
        if (!sadePolling[key].startTime) sadePolling[key].startTime = Date.now();
        const body = reqEntry.responseBody;
        const hasData = body && body.data && Array.isArray(body.data) && body.data.length > 0;
        if (hasData) {
          sadePolling[key].endTime = Date.now();
          sadePolling[key].found = true;
        }
        // Broadcast polling progress in real-time
        broadcast('sade_polling', {
          phase: key,
          attempt: sadePolling[key].attempts,
          maxRetries: 1,
          elapsed: sadePolling[key].startTime ? Math.round((Date.now() - sadePolling[key].startTime) / 1000) : 0,
          found: hasData,
          status: hasData ? 'found' : 'waiting'
        });
      }

      broadcast('request_done', reqEntry);

      // ── Value Indexing (raw, unmasked for chain detection) ──
      const rawResp = getRawResponseBody(response);
      if (rawResp) {
        const vals = extractValues(rawResp);
        for (const v of vals) {
          if (!valorIndex.has(v.value)) {
            valorIndex.set(v.value, { origen: item.name, campo: v.campo, tipo: v.tipo });
          }
        }
      }
    }
  });

  // ── assertion ──
  run.on('assertion', (err, args) => {
    const assertion = args.assertion;
    const item = args.item;
    const reqEntry = executionState.requests.find(r => r.name === item.name);
    if (reqEntry) {
      const name = typeof assertion === 'string' ? assertion : (assertion?.name || assertion?.message || 'Test');
      const result = { name, passed: !err, error: err ? err.message : null };
      reqEntry.assertions.push(result);
      if (!err) {
        executionState.summary.passed++;
        reqEntry._assertPass = (reqEntry._assertPass || 0) + 1;
      } else {
        executionState.summary.failed++;
        reqEntry._assertFail = (reqEntry._assertFail || 0) + 1;
      }
      broadcast('assertion', { requestId: reqEntry.id, requestName: item.name, assertion: result });
    }
  });

  // ── done ──
  run.on('done', (err, summary) => {
    executionState.running = false;
    executionState.summary.endTime = Date.now();
    const duration = executionState.summary.endTime - executionState.summary.startTime;
    executionState.summary = {
      ...executionState.summary,
      duration,
      durationFormatted: fmtDur(duration),
      totalRequests: executionState.requests.length,
      successRequests: executionState.requests.filter(r => r.status === 'success').length,
      errorRequests: executionState.requests.filter(r => r.status === 'error').length,
    };
    // ── Resolve request statuses (PASS/WARN/FAIL) ──
    executionState.requests.forEach(r => {
      // Mark polling/wait retries as 'polling' status (not pass/warn/fail)
      if (r._sadePolling || r._sadeWait) { r.resolvedStatus = 'polling'; return; }
      const ap = r._assertPass || 0;
      const af = r._assertFail || 0;
      const has = ap + af > 0;
      const httpErr = r.responseStatus >= 400;
      if (af > 0) r.resolvedStatus = 'fail';
      else if (httpErr && has && af === 0) r.resolvedStatus = 'warn';
      else if (httpErr && !has) r.resolvedStatus = 'fail';
      else r.resolvedStatus = 'pass';
    });

    // ── SADE Cascade: Business Rule Violations ──
    // When SADE selection times out, downstream 200+empty are NOT pass — business rules not met
    if (sadePolling.selection.attempts > 0 && !sadePolling.selection.found) {
      executionState.requests.forEach(r => {
        if (r._sadePolling || r.resolvedStatus !== 'pass') return;
        if (r.responseStatus === 200 && r.responseBody &&
            r.responseBody.data && Array.isArray(r.responseBody.data) &&
            r.responseBody.data.length === 0 && r.responseBody.totalCount === 0) {
          r.resolvedStatus = 'warn';
          r._sadeDownstream = true;
        }
      });
    }

    // ── Chain Summary ──
    const integraciones = [];
    const seenInteg = new Set();
    for (const rel of chainRelations) {
      let sOrigen = null, sDestino = null;
      for (const [hn, info] of Object.entries(systemsMap)) {
        if (info.requests.includes(rel.nacio_en)) sOrigen = hn;
        if (info.requests.includes(rel.usado_en)) sDestino = hn;
      }
      if (sOrigen && sDestino && sOrigen !== sDestino) {
        const ik = sOrigen + '→' + sDestino + ':' + rel.variable;
        if (!seenInteg.has(ik)) { seenInteg.add(ik); integraciones.push({ de: sOrigen, a: sDestino, via: rel.variable }); }
      }
    }
    broadcast('chain_summary', { variables: chainRelations, sistemas: systemsMap, integraciones, valorCount: valorIndex.size });

    // ── INGRID Analysis ──
    const ingridAnalysis = generateIngridAnalysis(executionState, sadePolling);
    broadcast('ingrid_analysis', ingridAnalysis);

    broadcast('execution_done', { summary: executionState.summary, requests: executionState.requests });
    exportHTMLReport(executionState, ingridAnalysis);
  });

  run.on('error', (err) => {
    broadcast('error', { message: err.message });
    executionState.running = false;
  });
}

// ── INGRID Analysis Engine ───────────────────────────────────────
function generateIngridAnalysis(state, sadePolling) {
  const findings = [];
  let riskLevel = 'BAJO';
  let pass = 0, warn = 0, fail = 0;

  // Filter out polling retry requests for main counts (only count last attempt)
  const pollingNames = new Set();
  const mainRequests = [];
  const pollingRequests = [];

  state.requests.forEach(r => {
    if (r._sadePolling) {
      pollingRequests.push(r);
      pollingNames.add(r.name);
    } else if (r._sadeWait) {
      // Skip wait iterations from counting
    } else {
      mainRequests.push(r);
    }
  });

  // Count resolved statuses only for non-polling/non-wait requests
  mainRequests.forEach(r => {
    if (r.resolvedStatus === 'pass') pass++;
    else if (r.resolvedStatus === 'warn') warn++;
    else fail++;
  });

  // Analyze all requests (including polling) for patterns
  state.requests.forEach(r => {
    // Skip polling/wait retries for pattern detection (handled separately)
    if (r._sadePolling || r._sadeWait) return;

    // Pattern: HTTP 500
    if (r.responseStatus === 500 && r.responseBody) {
      const desc = r.responseBody.description || r.responseBody.message || '';
      const descLower = desc.toLowerCase();
      if (desc.includes('null') || desc.includes('NullPointer') || desc.includes('Cannot invoke')) {
        findings.push({ type: 'BUG', severity: 'CRITICO', request: r.name, status: 500,
          message: 'NullPointerException en el backend. El servidor no valida datos nulos.',
          detail: desc.substring(0, 250) });
        riskLevel = 'ALTO';
      } else if (desc.includes('SADE') || desc.includes('GENETAION') || desc.includes('Taxpayer')) {
        findings.push({ type: 'INTEGRACION', severity: 'ALTO', request: r.name, status: 500,
          message: 'Error en integracion con SADE. El servicio externo no procesa la solicitud.',
          detail: desc.substring(0, 250) });
        if (riskLevel !== 'ALTO') riskLevel = 'MEDIO-ALTO';
      } else if (descLower.includes('duplicad') || descLower.includes('ya existe')) {
        findings.push({ type: 'DUPLICADO', severity: 'INFO', request: r.name, status: 500,
          message: 'Datos duplicados: el registro ya fue importado en una ejecucion anterior.',
          detail: desc.substring(0, 250) });
      } else {
        findings.push({ type: 'ERROR', severity: 'ALTO', request: r.name, status: 500,
          message: 'Error interno del servidor (500).',
          detail: desc.substring(0, 250) });
        if (riskLevel === 'BAJO') riskLevel = 'MEDIO';
      }
    }

    // Pattern: HTTP 400 with violations
    if (r.responseStatus === 400 && r.responseBody && r.responseBody.violations) {
      const viol = r.responseBody.violations.map(v => v.field + ': ' + v.message).join('; ');
      findings.push({ type: 'VALIDACION', severity: 'MEDIO', request: r.name, status: 400,
        message: 'Error de validacion. El contrato API no coincide con los datos enviados.',
        detail: viol.substring(0, 250) });
    }

    // Pattern: 504 Gateway Timeout
    if (r.responseStatus === 504) {
      findings.push({ type: 'TIMEOUT', severity: 'CRITICO', request: r.name, status: 504,
        message: 'Gateway Timeout. El backend no respondio a tiempo.', detail: '' });
      riskLevel = 'ALTO';
    }

    // Pattern: Assertion failures
    if ((r._assertFail || 0) > 0) {
      const failedNames = (r.assertions || []).filter(a => !a.passed).map(a => a.name).join(', ');
      findings.push({ type: 'TEST_FAIL', severity: 'ALTO', request: r.name, status: r.responseStatus,
        message: r._assertFail + ' assertion(s) fallaron.',
        detail: failedNames.substring(0, 250) });
      riskLevel = 'ALTO';
    }

    // Pattern: Empty data (async pending) — skip if polling handled it
    if (r.responseStatus === 200 && r.responseBody && r.responseBody.data &&
        Array.isArray(r.responseBody.data) && r.responseBody.data.length === 0 && r.responseBody.totalCount === 0) {
      findings.push({ type: 'ASYNC', severity: 'INFO', request: r.name, status: 200,
        message: 'Respuesta vacia (data:[], totalCount:0). Procesamiento asincrono pendiente o sin datos.',
        detail: '' });
    }

    // Pattern: False positive
    if (r.responseStatus >= 200 && r.responseStatus < 300 && r.responseBody &&
        (r.responseBody.error === true || r.responseBody.success === false)) {
      findings.push({ type: 'FALSO_POSITIVO', severity: 'MEDIO', request: r.name, status: r.responseStatus,
        message: 'HTTP 200 pero body contiene error. Falso positivo.', detail: '' });
      if (riskLevel === 'BAJO') riskLevel = 'MEDIO';
    }

    // Pattern: Slow response
    if (r.responseTime && r.responseTime > 10000) {
      findings.push({ type: 'PERFORMANCE', severity: 'MEDIO', request: r.name, status: r.responseStatus,
        message: 'Respuesta lenta: ' + r.responseTime + 'ms (>10s).', detail: '' });
    }
  });

  // ── SADE Latency Analysis ──
  const sadeTimeline = { selection: null, expedient: null };

  if (sadePolling) {
    for (const phase of ['selection', 'expedient']) {
      const sp = sadePolling[phase];
      if (sp.attempts > 0) {
        const elapsed = sp.endTime && sp.startTime ? Math.round((sp.endTime - sp.startTime) / 1000) : (sp.startTime ? Math.round((Date.now() - sp.startTime) / 1000) : 0);

        // Detect SKIP: expedient was not truly polled because selection failed first
        const isSkipped = phase === 'expedient' && !sp.found &&
          sadePolling.selection.attempts > 0 && !sadePolling.selection.found;

        sadeTimeline[phase] = { attempts: sp.attempts, elapsed, found: sp.found, skipped: isSkipped };

        if (sp.found) {
          // SADE responded — classify by latency
          let severity, msg;
          if (elapsed <= 10) {
            severity = 'INFO';
            msg = 'SADE ' + phase + ' proceso en ' + elapsed + 's (' + sp.attempts + ' intentos). Latencia aceptable.';
          } else if (elapsed <= 30) {
            severity = 'MEDIO';
            msg = 'SADE ' + phase + ' tardo ' + elapsed + 's (' + sp.attempts + ' intentos). Latencia elevada.';
            if (riskLevel === 'BAJO') riskLevel = 'MEDIO';
          } else {
            severity = 'ALTO';
            msg = 'SADE ' + phase + ' tardo ' + elapsed + 's (' + sp.attempts + ' intentos). Latencia critica — posible cuello de botella.';
            if (riskLevel === 'BAJO' || riskLevel === 'MEDIO') riskLevel = 'MEDIO-ALTO';
          }
          findings.push({ type: 'SADE_LATENCY', severity, request: 'SADE ' + phase, status: 'OK',
            message: msg, detail: 'Intentos: ' + sp.attempts + ' | Tiempo: ' + elapsed + 's' });
        } else if (isSkipped) {
          // SADE expedient SKIPPED — selection failed first, no candidateId available
          findings.push({ type: 'SADE_SKIP', severity: 'INFO', request: 'SADE ' + phase, status: 'SKIP',
            message: 'SADE expedient OMITIDO — la fase de Seleccion no completo. Sin candidateId disponible.',
            detail: 'El expediente nunca se genero porque SADE no proceso la Seleccion a tiempo.' });
        } else {
          // SADE timeout — truly polled but didn't respond
          findings.push({ type: 'SADE_TIMEOUT', severity: 'CRITICO', request: 'SADE ' + phase, status: 'TIMEOUT',
            message: 'SADE ' + phase + ' NO respondio tras ' + sp.attempts + ' intentos (' + elapsed + 's). Cola SADE saturada o servicio caido.',
            detail: 'El flujo downstream quedo incompleto por esta dependencia.' });
          riskLevel = 'ALTO';
        }
      }
    }
  }

  // Count cascade failures caused by SADE
  let sadeCascade = 0;
  if (sadePolling && !sadePolling.selection.found && sadePolling.selection.attempts > 0) {
    // If selection polling failed, count downstream requests that failed or have empty data
    const downstreamNames = ['05.', '06.', '07.', '08.', '09.', '10.', '10B.', '11.', '12.', '13.', '14.'];
    mainRequests.forEach(r => {
      if (downstreamNames.some(p => r.name.startsWith(p)) && (r.resolvedStatus === 'fail' || r.resolvedStatus === 'warn')) {
        sadeCascade++;
      }
    });
    if (sadeCascade > 0) {
      findings.push({ type: 'SADE_CASCADE', severity: 'ALTO', request: 'Flujo downstream', status: sadeCascade + ' afectados',
        message: sadeCascade + ' request(s) fallaron en cascada por timeout de SADE Seleccion.',
        detail: 'Incluye errores HTTP 500 y respuestas con data vacia (regla de negocio incumplida).' });
    }

    // Upgrade ASYNC → NEGOCIO: empty data after SADE timeout is a business rule violation
    findings.forEach(f => {
      if (f.type === 'ASYNC') {
        f.type = 'NEGOCIO';
        f.severity = 'ALTO';
        f.message = 'Regla de negocio incumplida: data vacia porque SADE no completo Seleccion.';
      }
    });
  }

  // Recommendation
  const bugs = findings.filter(f => f.type === 'BUG').length;
  const integs = findings.filter(f => f.type === 'INTEGRACION').length;
  const valids = findings.filter(f => f.type === 'VALIDACION').length;
  const testFails = findings.filter(f => f.type === 'TEST_FAIL').length;
  const sadeLatency = findings.filter(f => f.type === 'SADE_LATENCY').length;
  const sadeTimeout = findings.filter(f => f.type === 'SADE_TIMEOUT').length;
  const sadeSkip = findings.filter(f => f.type === 'SADE_SKIP').length;
  const negocio = findings.filter(f => f.type === 'NEGOCIO').length;
  let rec = '';
  if (sadeTimeout > 0) rec += 'CRITICO: SADE no proceso dentro del tiempo limite — escalar al equipo de infraestructura. ';
  if (negocio > 0) rec += negocio + ' endpoint(s) con data vacia — regla de negocio incumplida por dependencia SADE. ';
  if (bugs > 0) rec += 'Escalar ' + bugs + ' bug(s) critico(s) al equipo de backend. ';
  if (integs > 0) rec += 'Revisar integracion con SADE — servicio inestable. ';
  if (sadeLatency > 0) rec += 'Monitorear latencia SADE — ' + sadeLatency + ' fase(s) con demora medida. ';
  if (sadeSkip > 0) rec += 'Fase Expediente omitida — depende de que Seleccion complete primero. ';
  if (sadeCascade > 0) rec += sadeCascade + ' request(s) impactados por dependencia SADE. ';
  if (valids > 0) rec += 'Corregir ' + valids + ' error(es) de contrato API. ';
  if (testFails > 0) rec += testFails + ' test(s) fallaron — revisar assertions o datos. ';
  if (!rec) rec = 'Todos los endpoints respondieron correctamente. Sin hallazgos criticos.';

  return {
    timestamp: new Date().toISOString(),
    collection: state.collection,
    totalRequests: mainRequests.length,
    pollingAttempts: pollingRequests.length,
    pass, warn, fail,
    riskLevel,
    findings,
    recommendation: rec,
    sadeTimeline,
    assertionsTotal: (state.summary.passed || 0) + (state.summary.failed || 0),
    assertionsPassed: state.summary.passed || 0,
    assertionsFailed: state.summary.failed || 0
  };
}

// ── Helpers ──────────────────────────────────────────────────────
function sanitizeHeaders(headers) {
  const sensitive = ['authorization', 'client_secret', 'password', 'x-api-key'];
  const clean = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    clean[k] = sensitive.some(s => lk.includes(s))
      ? (lk.includes('authorization') ? maskToken(v) : '***REDACTED***')
      : v;
  }
  return clean;
}

function maskToken(v) {
  if (!v) return '***';
  if (v.toLowerCase().startsWith('bearer ')) {
    const t = v.substring(7);
    return `Bearer ${t.substring(0, 12)}...${t.substring(t.length - 4)}`;
  }
  return `${v.substring(0, 6)}...`;
}

function detectAuthType(req) {
  const h = req.headers?.toObject() || {};
  const auth = h['Authorization'] || h['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer')) return 'Bearer';
  if (h['client_id'] && h['client_secret']) return 'ClientID/Secret';
  if (h['x-api-key']) return 'ApiKey';
  return 'None';
}

function getRequestBody(req) {
  try {
    const raw = req.body?.raw;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const sensitive = ['password', 'client_secret'];
    for (const key of sensitive) {
      if (parsed[key]) parsed[key] = '***REDACTED***';
    }
    return parsed;
  } catch {
    return req.body?.raw || null;
  }
}

function parseResponseBody(response) {
  if (!response) return null;
  try {
    let text = '';
    // Newman v6: stream can be Buffer, Uint8Array, or string
    if (response.stream) {
      if (Buffer.isBuffer(response.stream)) {
        text = response.stream.toString('utf8');
      } else if (response.stream instanceof Uint8Array) {
        text = Buffer.from(response.stream).toString('utf8');
      } else if (typeof response.stream === 'string') {
        text = response.stream;
      } else if (Array.isArray(response.stream)) {
        text = Buffer.from(response.stream).toString('utf8');
      } else {
        text = String(response.stream);
      }
    }
    if (!text && response.body) {
      text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    }
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed.accessToken) {
        parsed.accessToken = maskToken('Bearer ' + parsed.accessToken).replace('Bearer ', '');
      }
      return parsed;
    } catch {
      return { _raw: text.substring(0, 2000) };
    }
  } catch (e) {
    return { _error: e.message };
  }
}

function fmtDur(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// ── HTML Report ──────────────────────────────────────────────────
function exportHTMLReport(state, ingridAnalysis) {
  const dir = path.join(__dirname, '../reports');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `qasl-report-${Date.now()}.html`;
  const reportPath = path.join(dir, filename);
  fs.writeFileSync(reportPath, generateHTMLReport(state, ingridAnalysis), 'utf8');
  broadcast('report_ready', { path: reportPath, filename });
  console.log(`\n📄 Reporte HTML exportado: ${reportPath}`);
}

function generateHTMLReport(state, ingridAnalysis) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  const ia = ingridAnalysis || {};

  // Separate polling/wait from main requests
  const mainReqs = [];
  const pollingGroups = {};
  const waitGroups = {};
  state.requests.forEach(r => {
    if (r._sadePolling) {
      const key = r.name.includes('04B') ? '04B' : '10B';
      if (!pollingGroups[key]) pollingGroups[key] = { requests: [], found: false, name: r.name };
      pollingGroups[key].requests.push(r);
      if (r.responseBody && r.responseBody.data && r.responseBody.data.length > 0) pollingGroups[key].found = true;
    } else if (r._sadeWait) {
      const key = '02B';
      if (!waitGroups[key]) waitGroups[key] = { requests: [], name: r.name };
      waitGroups[key].requests.push(r);
    } else {
      mainReqs.push(r);
    }
  });

  // Build main request rows
  let num = 0;
  const rows = [];
  const pollingInserted = {};
  const waitInserted = {};
  const maxRetries = pollingGroups['04B'] ? pollingGroups['04B'].requests.length : 1;
  state.requests.forEach(r => {
    if (r._sadeWait) {
      const key = '02B';
      if (waitInserted[key]) return;
      waitInserted[key] = true;
      num++;
      const wg = waitGroups[key];
      const iters = wg.requests.length;
      const elapsed = iters * 5; // approx 5s per iteration
      const allAsserts = wg.requests.flatMap(pr => pr.assertions || []);
      const assertsHtml = allAsserts.length > 0 ? allAsserts.map(a =>
        `<div class="a ${a.passed ? 'pass' : 'fail'}">${a.passed ? '&#10003;' : '&#10007;'} ${esc(a.name)}</div>`
      ).join('') : '';
      rows.push(`<div class="req-card poll" style="border-left-color:var(--cyan);">
      <div class="req-head">
        <span class="num">#${num}</span>
        <span class="method GET" style="background:#0d2e3d;color:var(--cyan);">WAIT</span>
        <span class="rname">${esc(wg.name)}</span>
        <span class="auth-badge">SADE</span>
        <span class="sc" style="color:var(--cyan)">~${elapsed}s</span>
        <span class="rt">${iters} ciclos</span>
      </div>
      <div class="poll-bar"><div class="poll-bar-fill ok" style="width:100%;background:linear-gradient(90deg,#0d2e3d,var(--cyan));opacity:.4"></div><span class="poll-bar-label">Espera post-import: ~${elapsed}s (${iters} ciclos x ~5s)</span></div>
      <div class="asserts">${assertsHtml}</div>
    </div>`);
      return;
    }
    if (r._sadePolling) {
      const key = r.name.includes('04B') ? '04B' : '10B';
      if (pollingInserted[key]) return;
      pollingInserted[key] = true;
      num++;
      const pg = pollingGroups[key];
      const attempts = pg.requests.length;
      const found = pg.found;
      // Detect SKIP: expedient (10B) was not truly polled because selection failed
      const isSkipped = key === '10B' && !found &&
        pollingGroups['04B'] && pollingGroups['04B'].requests.length > 0 && !pollingGroups['04B'].found;
      let label, cls, barLabel, borderColor;
      if (isSkipped) {
        label = 'SKIP'; cls = 'skip'; borderColor = 'var(--muted)';
        barLabel = 'SKIP &mdash; Seleccion no completo, expediente no ejecutado';
      } else if (found) {
        label = 'ENCONTRADO'; cls = 'ok'; borderColor = 'var(--grn)';
        barLabel = attempts + '/' + maxRetries + ' intentos | Procesado';
      } else {
        label = 'TIMEOUT'; cls = 'err'; borderColor = 'var(--red)';
        barLabel = attempts + '/' + maxRetries + ' intentos | TIMEOUT &mdash; SADE no proceso dentro del limite';
      }
      const allAsserts = pg.requests.flatMap(pr => pr.assertions || []);
      const assertsHtml = allAsserts.length > 0 ? allAsserts.slice(-3).map(a =>
        `<div class="a ${a.passed ? 'pass' : 'fail'}">${a.passed ? '&#10003;' : '&#10007;'} ${esc(a.name)}</div>`
      ).join('') : '';
      const barFillPct = isSkipped ? 100 : Math.min(100, Math.round((attempts / Math.max(maxRetries, 1)) * 100));
      const barFillCls = isSkipped ? 'skip' : cls;
      rows.push(`<div class="req-card poll" style="border-left-color:${borderColor};">
      <div class="req-head">
        <span class="num">#${num}</span>
        <span class="method POST" style="background:${isSkipped ? '#1a1a2e' : '#0d3349'};color:${borderColor};">${isSkipped ? 'SKIP' : 'POLL'}</span>
        <span class="rname">${esc(pg.name)}</span>
        <span class="auth-badge">SADE</span>
        <span class="sc" style="color:${borderColor}">${label}</span>
        <span class="rt">${isSkipped ? 'omitido' : attempts + ' intentos'}</span>
      </div>
      <div class="poll-bar"><div class="poll-bar-fill ${barFillCls}" style="width:${barFillPct}%"></div><span class="poll-bar-label">${barLabel}</span></div>
      <div class="asserts">${assertsHtml}</div>
    </div>`);
      return;
    }
    num++;
    const rs = r.resolvedStatus || 'pass';
    const scClass = rs === 'fail' ? 'err' : rs === 'warn' ? 'warn' : 'ok';
    const isFp = r.responseBody && r.responseStatus >= 200 && r.responseStatus < 300 &&
      (r.responseBody.error === true || r.responseBody.success === false);

    const assertsHtml = (r.assertions || []).map(a =>
      `<div class="a ${a.passed ? 'pass' : 'fail'}">${a.passed ? '&#10003;' : '&#10007;'} ${esc(a.name)}</div>`
    ).join('');

    const reqBody = r.body ? `<div class="body-section"><div class="body-label">REQUEST BODY</div><pre>${esc(JSON.stringify(r.body, null, 2))}</pre></div>` : '';
    const respBody = r.responseBody ? `<div class="body-section"><div class="body-label">RESPONSE BODY <span class="sc-r ${scClass}">${r.responseStatus}</span></div><pre>${esc(JSON.stringify(r.responseBody, null, 2))}</pre></div>` : '';
    const fpAlert = isFp ? '<div class="fp-alert-r">FALSO POSITIVO: HTTP 200 pero body contiene error</div>' : '';

    rows.push(`<div class="req-card ${scClass}">
      <div class="req-head">
        <span class="num">#${num}</span>
        <span class="method ${r.method}">${r.method}</span>
        <span class="rname">${esc(r.name)}</span>
        <span class="auth-badge">${r.authType || '--'}</span>
        <span class="sc ${scClass}">${r.responseStatus || 'ERR'}</span>
        <span class="rt">${r.responseTime ? r.responseTime + 'ms' : '-'}</span>
      </div>
      <div class="req-url">${esc(r.url)}</div>
      ${fpAlert}${reqBody}${respBody}
      <div class="asserts">${assertsHtml}</div>
    </div>`);
  });

  // INGRID + SADE section
  let ingridHtml = '';
  if (ia.findings && ia.findings.length > 0) {
    const findingsRows = ia.findings.map(f => {
      const sev = f.severity === 'CRITICO' ? 'err' : f.severity === 'ALTO' ? 'err' : f.severity === 'MEDIO' ? 'warn' : 'info';
      return `<div class="ig-row ${sev}"><span class="ig-badge ${f.type.replace(/ /g,'_')}">${esc(f.type.replace(/_/g,' '))}</span><span class="ig-req">${esc(f.request)} (${f.status})</span><span class="ig-msg">${esc(f.message)}</span>${f.detail ? '<span class="ig-detail">' + esc(f.detail) + '</span>' : ''}</div>`;
    }).join('');
    ingridHtml = `<div class="ingrid-section">
    <div class="ig-header"><span class="ig-icon">I</span><span class="ig-title">INGRID &mdash; Analisis de Ejecucion</span><span class="ig-risk ${ia.riskLevel}">RIESGO: ${ia.riskLevel}</span></div>
    <div class="ig-stats"><span class="igs pass">PASS: ${ia.pass}</span><span class="igs warn">WARN: ${ia.warn}</span><span class="igs fail">FAIL: ${ia.fail}</span><span class="igs info">ASSERTIONS: ${ia.assertionsPassed}/${ia.assertionsTotal}</span></div>
    <div class="ig-findings">${findingsRows}</div>
    <div class="ig-rec">RECOMENDACION: ${esc(ia.recommendation)}</div>
    </div>`;
  }

  // SADE Timeline
  let sadeHtml = '';
  if (ia.sadeTimeline) {
    const phases = [];
    for (const phase of ['selection', 'expedient']) {
      const p = ia.sadeTimeline[phase];
      if (!p) continue;
      let cls, label, infoHtml;
      if (p.skipped) {
        cls = 'skip';
        label = 'SKIP';
        infoHtml = '<b style="color:var(--muted)">SKIP</b> | no ejecutado';
      } else if (p.found) {
        cls = p.elapsed <= 10 ? 'ok' : p.elapsed <= 30 ? 'slow' : 'critical';
        label = p.elapsed + 's';
        infoHtml = '<b style="color:var(--grn)">' + p.elapsed + 's</b> | ' + p.attempts + ' intentos';
      } else {
        cls = 'timeout';
        label = 'TIMEOUT';
        infoHtml = '<b style="color:var(--red)">TIMEOUT</b> | ' + p.attempts + ' intentos';
      }
      const pct = p.skipped ? 100 : Math.min(100, Math.round((p.elapsed / 60) * 100));
      phases.push(`<div class="sade-phase"><span class="sp-label">${phase.toUpperCase()}</span><div class="sp-bar-wrap"><div class="sp-bar ${cls}" style="width:${pct}%"><span class="sp-bar-text">${label}</span></div></div><span class="sp-info">${infoHtml}</span></div>`);
    }
    if (phases.length > 0) {
      sadeHtml = `<div class="sade-section"><div class="sade-header"><span class="sade-icon">S</span><span class="sade-title">SADE DIAGNOSTICS &mdash; Timeline de Procesamiento Asincrono</span></div><div class="sade-body">${phases.join('')}</div></div>`;
    }
  }

  const passCount = ia.pass || mainReqs.filter(r => r.resolvedStatus === 'pass').length;
  const warnCount = ia.warn || mainReqs.filter(r => r.resolvedStatus === 'warn').length;
  const failCount = ia.fail || mainReqs.filter(r => r.resolvedStatus === 'fail').length;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>QASL-BACKEND-LIVE Report — ${state.collection}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a0e1a;--panel:#111827;--bdr:#1e2d45;--grn:#00ff88;--red:#ff4757;--yel:#ffd32a;--blu:#00d2ff;--pur:#a78bfa;--cyan:#06b6d4;--txt:#e2e8f0;--muted:#64748b;}
body{background:var(--bg);color:var(--txt);font-family:'Syne',sans-serif;padding:1.5rem;max-width:1200px;margin:0 auto;}
h1{font-size:1.6rem;font-weight:800;color:var(--grn);margin-bottom:.15rem;}
.sub{color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:.75rem;margin-bottom:.3rem;}
.author{color:var(--grn);font-family:'JetBrains Mono',monospace;font-size:.65rem;opacity:.8;margin-bottom:1.5rem;}
.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:.8rem;margin-bottom:1.5rem;}
.met{background:var(--panel);border:1px solid var(--bdr);border-radius:10px;padding:1rem;border-top:3px solid var(--bdr);}
.met .v{font-size:1.8rem;font-weight:800;}.met .l{color:var(--muted);font-size:.7rem;font-family:'JetBrains Mono',monospace;}
.met.total{border-top-color:var(--blu);}.met.total .v{color:var(--blu);}
.met.ok{border-top-color:var(--grn);}.met.ok .v{color:var(--grn);}
.met.warn{border-top-color:var(--yel);}.met.warn .v{color:var(--yel);}
.met.fail{border-top-color:var(--red);}.met.fail .v{color:var(--red);}
.met.time{border-top-color:var(--cyan);}.met.time .v{color:var(--cyan);}
.req-card{background:var(--panel);border:1px solid var(--bdr);border-radius:8px;margin-bottom:.8rem;overflow:hidden;border-left:3px solid var(--bdr);}
.req-card.ok{border-left-color:var(--grn);}.req-card.err{border-left-color:var(--red);}.req-card.fp,.req-card.warn{border-left-color:var(--yel);}
.req-head{display:flex;align-items:center;gap:.5rem;padding:.6rem .8rem;flex-wrap:wrap;}
.num{font-family:'JetBrains Mono',monospace;font-size:.65rem;color:var(--muted);}
.method{padding:2px 6px;border-radius:3px;font-family:'JetBrains Mono',monospace;font-size:.65rem;font-weight:700;}
.method.GET{background:#0d3349;color:var(--blu);}.method.POST{background:#0d3325;color:var(--grn);}
.method.PUT{background:#2d2200;color:var(--yel);}.method.DELETE{background:#2d0d0d;color:var(--red);}
.method.PATCH{background:#1a1030;color:var(--pur);}
.rname{font-weight:700;font-size:.8rem;flex:1;}
.auth-badge{padding:2px 6px;border-radius:3px;font-family:'JetBrains Mono',monospace;font-size:.6rem;background:#1a1a2e;color:var(--pur);}
.sc{font-family:'JetBrains Mono',monospace;font-size:.85rem;font-weight:700;}
.sc.ok{color:var(--grn);}.sc.err{color:var(--red);}.sc.fp,.sc.warn{color:var(--yel);}
.rt{font-family:'JetBrains Mono',monospace;font-size:.7rem;color:var(--muted);}
.req-url{padding:0 .8rem .4rem;font-family:'JetBrains Mono',monospace;font-size:.6rem;color:var(--muted);word-break:break-all;}
.body-section{margin:.3rem .6rem;border:1px solid var(--bdr);border-radius:5px;overflow:hidden;}
.body-label{padding:.25rem .5rem;background:#0d1117;font-family:'JetBrains Mono',monospace;font-size:.6rem;color:var(--muted);border-bottom:1px solid var(--bdr);display:flex;justify-content:space-between;align-items:center;}
.sc-r{font-weight:700;font-size:.7rem;}.sc-r.ok{color:var(--grn);}.sc-r.err{color:var(--red);}.sc-r.fp,.sc-r.warn{color:var(--yel);}
pre{padding:.5rem;font-family:'JetBrains Mono',monospace;font-size:.65rem;color:#8faabb;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;line-height:1.5;}
.fp-alert-r{margin:.3rem .6rem;padding:.3rem .5rem;background:#332900;border:1px solid var(--yel);border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:.6rem;color:var(--yel);}
.asserts{padding:.3rem .8rem .5rem;display:flex;flex-direction:column;gap:.15rem;}
.a{font-family:'JetBrains Mono',monospace;font-size:.65rem;}.a.pass{color:var(--grn);}.a.fail{color:var(--red);}
.poll-bar{margin:.3rem .8rem .5rem;height:22px;background:#0d1117;border:1px solid var(--bdr);border-radius:4px;position:relative;overflow:hidden;}
.poll-bar-fill{height:100%;border-radius:3px;}.poll-bar-fill.ok{background:linear-gradient(90deg,#0a2e1a80,#00ff8830);}.poll-bar-fill.err{background:repeating-linear-gradient(45deg,#2e0a0a,#2e0a0a 4px,#3e1a1a 4px,#3e1a1a 8px);}.poll-bar-fill.skip{background:repeating-linear-gradient(45deg,#1a1a2e,#1a1a2e 4px,#252540 4px,#252540 8px);}
.poll-bar-label{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:.6rem;color:var(--txt);z-index:1;}
.ingrid-section{background:var(--panel);border:1px solid var(--bdr);border-radius:10px;margin-bottom:1rem;overflow:hidden;border-left:3px solid var(--cyan);}
.ig-header{display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;background:#0d1420;border-bottom:1px solid var(--bdr);}
.ig-icon{font-family:'JetBrains Mono',monospace;font-size:.7rem;font-weight:900;color:var(--bg);width:22px;height:22px;background:var(--cyan);border-radius:5px;display:flex;align-items:center;justify-content:center;}
.ig-title{font-family:'JetBrains Mono',monospace;font-size:.7rem;font-weight:700;color:var(--cyan);flex:1;letter-spacing:1px;}
.ig-risk{font-family:'JetBrains Mono',monospace;font-size:.55rem;font-weight:700;padding:.15rem .5rem;border-radius:4px;}
.ig-risk.BAJO{background:#0a2e1a;color:var(--grn);border:1px solid #1a4a2e;}
.ig-risk.MEDIO,.ig-risk.MEDIO-ALTO{background:#2e2a0a;color:var(--yel);border:1px solid #5a4a0e;}
.ig-risk.ALTO{background:#2e0a0a;color:var(--red);border:1px solid #5a1a1a;}
.ig-stats{display:flex;gap:1rem;padding:.3rem .8rem;border-bottom:1px solid var(--bdr);font-family:'JetBrains Mono',monospace;font-size:.6rem;}
.igs.pass{color:var(--grn);}.igs.warn{color:var(--yel);}.igs.fail{color:var(--red);}.igs.info{color:var(--muted);}
.ig-findings{padding:.4rem .6rem;display:flex;flex-direction:column;gap:.25rem;}
.ig-row{display:flex;align-items:flex-start;gap:.4rem;padding:.3rem .5rem;background:#0a0e1a;border:1px solid var(--bdr);border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:.6rem;line-height:1.5;flex-wrap:wrap;}
.ig-badge{font-size:.45rem;font-weight:700;padding:2px 5px;border-radius:3px;flex-shrink:0;text-transform:uppercase;letter-spacing:.5px;}
.ig-badge.BUG,.ig-badge.TEST_FAIL,.ig-badge.SADE_TIMEOUT{background:#2e0a0a;color:var(--red);}
.ig-badge.INTEGRACION,.ig-badge.ERROR,.ig-badge.SADE_CASCADE{background:#2e2a0a;color:var(--yel);}
.ig-badge.VALIDACION{background:#1a1040;color:var(--pur);}
.ig-badge.ASYNC,.ig-badge.SADE_LATENCY{background:#0d3349;color:var(--blu);}
.ig-badge.FALSO_POSITIVO,.ig-badge.PERFORMANCE{background:#2e2a0a;color:var(--yel);}
.ig-badge.TIMEOUT{background:#2e0a0a;color:var(--red);}
.ig-badge.SADE_SKIP{background:#1a1a2e;color:var(--muted);}
.ig-badge.NEGOCIO{background:#2e0a2e;color:#f472b6;}
.ig-req{color:var(--muted);flex-shrink:0;}.ig-msg{color:var(--txt);flex:1;}
.ig-detail{width:100%;color:#4a5a6c;font-size:.5rem;word-break:break-all;}
.ig-rec{padding:.5rem .8rem;border-top:1px solid var(--bdr);font-family:'JetBrains Mono',monospace;font-size:.6rem;color:var(--cyan);line-height:1.6;}
.sade-section{background:var(--panel);border:1px solid var(--bdr);border-radius:10px;margin-bottom:1rem;overflow:hidden;border-left:3px solid var(--cyan);}
.sade-header{display:flex;align-items:center;gap:.6rem;padding:.5rem .8rem;background:#0d1420;border-bottom:1px solid var(--bdr);}
.sade-icon{font-family:'JetBrains Mono',monospace;font-size:.65rem;font-weight:900;color:var(--bg);width:22px;height:22px;background:var(--cyan);border-radius:50%;display:flex;align-items:center;justify-content:center;}
.sade-title{font-family:'JetBrains Mono',monospace;font-size:.65rem;font-weight:700;color:var(--cyan);letter-spacing:1px;}
.sade-body{padding:.5rem .8rem;display:flex;flex-direction:column;gap:.4rem;}
.sade-phase{display:flex;align-items:center;gap:.6rem;font-family:'JetBrains Mono',monospace;font-size:.6rem;}
.sp-label{width:80px;color:var(--muted);font-size:.55rem;letter-spacing:1px;flex-shrink:0;}
.sp-bar-wrap{flex:1;height:18px;background:#0a0e1a;border:1px solid var(--bdr);border-radius:3px;overflow:hidden;position:relative;}
.sp-bar{height:100%;border-radius:2px;display:flex;align-items:center;justify-content:flex-end;padding-right:.3rem;}
.sp-bar.ok{background:linear-gradient(90deg,#0a2e1a,#00ff8830);}.sp-bar.slow{background:linear-gradient(90deg,#2e2a0a,#ffd32a30);}
.sp-bar.critical{background:linear-gradient(90deg,#2e0a0a,#ff475730);}.sp-bar.timeout{background:repeating-linear-gradient(45deg,#2e0a0a,#2e0a0a 4px,#3e1a1a 4px,#3e1a1a 8px);}
.sp-bar.skip{background:repeating-linear-gradient(45deg,#1a1a2e,#1a1a2e 4px,#252540 4px,#252540 8px);}
.sp-bar-text{font-size:.5rem;font-weight:700;}.sp-bar.ok .sp-bar-text{color:var(--grn);}.sp-bar.slow .sp-bar-text{color:var(--yel);}.sp-bar.critical .sp-bar-text,.sp-bar.timeout .sp-bar-text{color:var(--red);}.sp-bar.skip .sp-bar-text{color:var(--muted);}
.sp-info{width:120px;text-align:right;font-size:.55rem;color:var(--muted);flex-shrink:0;}
.footer{margin-top:1.5rem;text-align:center;color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:.65rem;}
</style>
</head>
<body>
<h1>&#9889; QASL-BACKEND-LIVE</h1>
<div class="sub">Coleccion: ${esc(state.collection)} | Generado: ${new Date().toLocaleString('es-AR')} | Duracion: ${state.summary.durationFormatted || '-'}</div>
<div class="author">Elyer Gregorio Maldonado &middot; Lider Tecnico QA</div>
<div class="metrics">
  <div class="met total"><div class="v">${mainReqs.length}</div><div class="l">REQUESTS</div></div>
  <div class="met ok"><div class="v">${passCount}</div><div class="l">PASS</div></div>
  <div class="met warn"><div class="v">${warnCount}</div><div class="l">WARN</div></div>
  <div class="met fail"><div class="v">${failCount}</div><div class="l">FAIL</div></div>
  <div class="met time"><div class="v">${state.summary.durationFormatted || '-'}</div><div class="l">DURACION</div></div>
</div>
${sadeHtml}
${ingridHtml}
${rows.join('')}
<div class="footer">QASL-BACKEND-LIVE &middot; Elyer Gregorio Maldonado &middot; Lider Tecnico QA</div>
</body>
</html>`;
}

// ── Start ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         ⚡  QASL-BACKEND-LIVE  v1.0.0                ║
║         Elyer Gregorio Maldonado                     ║
║         Líder Técnico QA                             ║
╠══════════════════════════════════════════════════════╣
║  Dashboard : http://localhost:${PORT}                  ║
║  WebSocket : ws://localhost:${PORT}                    ║
╚══════════════════════════════════════════════════════╝
`);
});

module.exports = { server, broadcast, runNewman };
