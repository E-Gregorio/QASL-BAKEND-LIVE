# QASL-BACKEND-LIVE

**Framework de observabilidad en tiempo real para APIs REST**
*Elyer Gregorio Maldonado - Lider Tecnico QA*

---

## Que es?

QASL-BACKEND-LIVE convierte cualquier coleccion Postman en un **dashboard cinematografico en tiempo real**.
Mientras Newman ejecuta los requests, un dashboard en el browser muestra **en vivo** cada llamada HTTP:
metodo, URL, status code, response time, request/response body y assertions.

Ademas, el motor de **deteccion de variables e integraciones** analiza automaticamente los datos que fluyen entre requests, detecta sistemas involucrados, identifica cadenas de dependencia y genera un **mapa de integraciones** visual.

Al finalizar, exporta automaticamente un **reporte HTML estatico** + **screenshot de evidencia**.

```
Newman ejecuta coleccion
        |
Custom reporter captura cada evento
        |
WebSocket server (Express + ws)
        |
Motor de Deteccion (Variables + Cadenas + Sistemas)
        |
Browser abierto automaticamente (Playwright Chromium)
        |
Dashboard en tiempo real (carousel slide-by-slide)
        |
Mapa de Integraciones (sistemas + flujos cross-system)
        |
Resumen final + Reporte HTML + Screenshot exportado
```

---

## Instalacion

```bash
git clone <repo>
cd qasl-backend-live
npm install
npm run install:browsers   # instala Chromium para Playwright
```

---

## Comandos de Ejecucion

### 1. Ejecucion basica (coleccion demo incluida)
```bash
node run.js
```
Usa la primera coleccion `.json` encontrada en `collections/`. Delay por defecto: **2000ms** entre requests.

### 2. Coleccion especifica
```bash
node run.js mi-coleccion.json
```
Busca el archivo en `collections/`, ruta relativa o ruta absoluta.

### 3. Con delay personalizado (modo presentacion)
```bash
node run.js --delay 5000              # 5 segundos entre requests
node run.js --delay 3000              # 3 segundos entre requests
node run.js --delay 2000              # 2 segundos (default)
```
Ideal para demos, presentaciones y capturas de video donde cada request debe verse con claridad.

### 4. Sin delay (ejecucion rapida)
```bash
node run.js --no-delay                # ejecucion continua sin pausas
```

### 5. Coleccion + delay combinados
```bash
node run.js Sigma-flujo-e2e.json --delay 5000
node run.js demo-qasl-tests.json --delay 3000
```

### 6. Solo servidor (sin browser automatico)
```bash
npm start
# Luego abrir http://localhost:4747 manualmente
```

### Que hace `run.js` automaticamente:
1. Mata cualquier proceso en el puerto 4747
2. Levanta el servidor Express + WebSocket
3. Abre Playwright Chromium maximizado
4. Ejecuta la coleccion Newman con el delay configurado
5. Genera el reporte HTML en `/reports/`
6. Toma screenshot del dashboard final
7. Mantiene el browser abierto para revision (`Ctrl+C` para cerrar)

---

## Motor de Deteccion de Variables e Integraciones

El servidor analiza automaticamente los datos que fluyen entre requests en tres capas:

### Capa 1: Value Index (Indexacion de Valores)
Cada response es procesada recursivamente. Los valores significativos (JWTs, UUIDs, tokens, IDs de expedientes, etc.) se indexan en un mapa con su request de origen y campo.

**Clasificacion automatica de tipos:**
| Tipo | Patron | Ejemplo |
|------|--------|---------|
| `JWT` | Comienza con `eyJ` | Tokens de autenticacion |
| `UUID` | Formato `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | Identificadores unicos |
| `EE_ID` | Formato `EX-YYYY-...` | Expedientes electronicos (GEDO) |
| `GEDO_ID` | Formato `IF-YYYY-...` | Informes (GEDO) |
| `TOKEN` | Strings > 100 caracteres | Tokens largos, hashes |
| `VALUE` | Strings 8-100 caracteres significativos | CUITs, IDs, nombres |

Se filtran automaticamente valores triviales (`true`, `false`, `null`, `application/json`, numeros cortos, etc.).

### Capa 2: Chain Detection (Deteccion de Cadenas)
Antes de cada request, el motor busca valores previamente indexados dentro de:
- **URL** del request
- **Headers** del request
- **Body** del request

Cuando un valor que nacio en Request A aparece en Request B, se registra una **cadena de dependencia**. Esto revela el flujo real de datos entre endpoints.

### Capa 3: System Detection (Deteccion de Sistemas)
Cada hostname se parsea y agrupa automaticamente. Por ejemplo:
- `sigma-be-qa.agip.gob.ar` → Sistema **SIGMA**
- `sso-qa.agip.gob.ar` → Sistema **SSO**
- `jsonplaceholder.typicode.com` → Sistema **JSONPLACEHOLDER**

El dashboard muestra en tiempo real cuantos requests van a cada sistema.

### Sidebar en tiempo real
Durante la ejecucion, el dashboard muestra un **sidebar lateral** con dos paneles:
- **Variables en Vuelo**: lista las variables detectadas con su tipo, request de origen y request donde fueron reutilizadas, incluyendo un badge con la cantidad de usos
- **Sistemas Detectados**: agrupa los hosts con conteo de requests por sistema

---

## Mapa de Integraciones

Al finalizar la ejecucion, si se detectaron multiples sistemas y flujos cross-system, el dashboard muestra automaticamente un **mapa de integraciones** a pantalla completa que incluye:

- **Sistemas detectados**: cards con hostname, label y cantidad de requests
- **Integraciones cross-system**: flechas que muestran que variable viajo de un sistema a otro
- **Metricas**: total de valores indexados, cadenas detectadas, sistemas involucrados
- **Boton "CONTINUAR AL RESUMEN"**: para avanzar a la vista resumen
- **Boton "VER MAPA DE INTEGRACIONES"**: desde el resumen, permite volver al mapa las veces que sea necesario

La navegacion es bidireccional: el mapa no se auto-cierra, el usuario controla cuando avanzar al resumen y puede regresar al mapa en cualquier momento.

---

## Dashboard

### Vista en vivo (carousel)
Cada request se muestra como un slide a pantalla completa con:
- **Header**: metodo HTTP + nombre + status code + response time
- **URL**: endpoint completo con hostname resaltado
- **Request body**: JSON syntax-highlighted
- **Response body**: JSON syntax-highlighted con tag de status
- **Assertions**: badges individuales pass/fail
- **Step dots**: indicadores de progreso clickeables
- **Navegacion**: flechas izq/der del teclado + click en dots
- **Sidebar lateral**: variables y sistemas detectados en tiempo real

### Vista resumen (al finalizar)
- **Metricas**: total requests, exitosos, errores, duracion
- **Lista completa**: cada request con status + response time
- **Click** en cualquier request para ver su detalle completo
- **Boton "Volver al Resumen"** para regresar del detalle
- **Boton "VER MAPA DE INTEGRACIONES"** para revisitar el mapa

### Colores de status:
- Verde: 2xx exitoso
- Rojo: 4xx / 5xx error o error de conexion
- Amarillo: falso positivo (HTTP 2xx pero body contiene error)
- Azul: info / pendiente

### Deteccion de Falsos Positivos
El dashboard detecta automaticamente cuando un endpoint retorna HTTP 200 pero el body contiene `error: true` o `success: false`, marcandolo como **falso positivo** con alerta amarilla. Esto es critico para APIs que envuelven errores de negocio dentro de respuestas HTTP exitosas.

---

---

## INGRID — Motor de Analisis Automatico

Al finalizar cada ejecucion, INGRID analiza automaticamente todos los requests y genera un diagnostico inteligente sin configuracion previa.

### Patrones detectados automaticamente:
| Tipo | Severidad | Descripcion |
|------|-----------|-------------|
| `BUG` | CRITICO | NullPointerException o errores no controlados en backend |
| `INTEGRACION` | ALTO | Fallas en servicios externos (SADE, NCCT, etc.) |
| `ERROR` | ALTO | HTTP 500 generico |
| `DUPLICADO` | INFO | HTTP 500 por datos duplicados (re-ejecucion de test) |
| `VALIDACION` | MEDIO | HTTP 400 con violations del contrato API |
| `TIMEOUT` | CRITICO | HTTP 504 Gateway Timeout |
| `TEST_FAIL` | ALTO | Assertions que fallaron |
| `ASYNC` | INFO | Respuesta vacia (data:[], totalCount:0) — procesamiento pendiente |
| `NEGOCIO` | ALTO | Regla de negocio incumplida: data vacia por dependencia SADE |
| `FALSO_POSITIVO` | MEDIO | HTTP 200 pero body contiene error:true o success:false |
| `PERFORMANCE` | MEDIO | Response time > 10 segundos |
| `SADE_LATENCY` | INFO/MEDIO | SADE proceso pero tardo mas de lo esperado |
| `SADE_TIMEOUT` | CRITICO | SADE no proceso dentro del tiempo limite |
| `SADE_SKIP` | INFO | Fase SADE omitida por dependencia previa fallida |
| `SADE_CASCADE` | ALTO | Requests fallidos en cascada por timeout SADE |

### Reporte INGRID incluye:
- **Nivel de riesgo**: BAJO / MEDIO / ALTO (calculado automaticamente)
- **Conteo PASS / WARN / FAIL**: resolucion por request considerando assertions + HTTP status + reglas de negocio
- **SADE Timeline**: barras de progreso para cada fase de polling asincrono
- **Recomendaciones**: texto automatico con acciones a tomar segun los hallazgos

---

## Colecciones Probadas (Universalidad)

QASL-BACKEND-LIVE es **completamente universal** — ejecuta cualquier coleccion Postman sin configuracion. Ha sido probado exitosamente con:

### Demo — APIs Publicas (`demo-qasl-tests.json`)
- **12 requests** | 11 PASS, 1 FAIL
- Endpoints: jsonplaceholder.typicode.com, httpbin.org
- Cubre: GET, POST, PUT, PATCH, DELETE, errores 4xx/5xx

### SIGMA QA — Gobierno AGIP (`Sigma-flujo-e2e.json`)
- **10 requests** | Flujo E2E completo
- Sistemas: SSO, SIGMA-BE, SIGMA-FE, PUC (NCCT)
- Features: captura dinamica de IDs, propagacion entre requests, deteccion de 4 sistemas

### SIGMA HML — Homologacion (`SIGMA-HML-E2E-Flujo-Completo-09032026.postman_collection.json`)
- **15+ requests** | Flujo E2E con SADE polling
- Features: espera SADE 40s, polling con reintentos, deteccion SKIP/TIMEOUT/CASCADE
- Diagnostico SADE Timeline + INGRID NEGOCIO

### SIGMA Regression (`regression2-apis-dynamic.json`)
- **61 requests** | 57 PASS, 2 WARN, 2 FAIL
- Coleccion de regresion completa generada por QASL-AUTOMATION
- 120/122 assertions pasadas, 5+ minutos de ejecucion

### Si.PQ — Gestion de Campos (`sipg.json`)
- **5 requests** | 4 PASS, 1 FAIL
- Backend: sipq-dev-agentes.minseg.gob.ar (Ministerio de Seguridad)
- INGRID detecto bug en PATCH: 500 al intentar cambiar estado a uno ya existente

### Binance — Crypto Exchange (`tomex-collection-1774685235867.json`)
- **136 requests** | 134 PASS, 2 FAIL (response time)
- **8+ sistemas detectados**: binance.com, accounts.binance.com, bin.bnbstatic.com, cdn.cookielaw.org, api.saasexch.co, google-analytics.com, sentry.io, awswaf.com
- Coleccion generada por QASL-TOMEX (captura automatica de APIs en navegacion)
- Cubre: auth, compliance, trading, futures, earn, fiat, copy-trading, news, chat, options, assets

```bash
# Ejecutar cualquier coleccion:
node run.js --collection collections/mi-coleccion.json --delay 5000

# Coleccion desde ruta externa:
node run.js --collection "C:/ruta/a/coleccion.json" --delay 5000
```

---

## Soporte para Colecciones Dinamicas

QASL-BACKEND-LIVE soporta colecciones que usan `pm.collectionVariables.set()` / `pm.collectionVariables.get()` para propagar datos entre requests en tiempo de ejecucion. Esto permite:

- **Captura de IDs frescos**: un request puede capturar un ID de la base de datos y pasarlo a requests posteriores
- **Tests resilientes**: assertions que se adaptan al estado real del ambiente (aceptan 200, 400 o 500 y reportan el comportamiento sin romper el flujo)
- **Independencia de estado**: cada ejecucion es idempotente, no depende de datos de ejecuciones anteriores
- **Deteccion automatica de cadenas**: el motor de variables detecta estas propagaciones automaticamente y las muestra en el sidebar y mapa de integraciones

---

## Evidencia exportada

Al finalizar cada ejecucion se generan automaticamente en `/reports/`:

```
reports/
  qasl-report-<timestamp>.html    -- Reporte HTML completo
  screenshot-<timestamp>.png      -- Screenshot del dashboard
```

El reporte HTML es **autocontenido** (CSS inline) y puede abrirse sin servidor.
Incluye: metricas, cada request con method/URL/status/response time, request body, response body, assertions pass/fail y alerta de falsos positivos.

---

## Seguridad

Los campos sensibles se enmascaran automaticamente en el dashboard y en los reportes:
- `Authorization: Bearer eyJ...` se muestra como `Bearer eyJhbGc...n3Kx`
- `client_secret` se muestra como `***REDACTED***`
- `password` se muestra como `***REDACTED***`
- `x-api-key` se muestra como `***REDACTED***`
- `accessToken` en responses se enmascara automaticamente

El motor de deteccion de variables usa los datos **raw** (sin enmascarar) internamente para la deteccion de cadenas, pero el dashboard y los reportes siempre muestran los datos sanitizados.

---

## Arquitectura tecnica

```
qasl-backend-live/
├── src/
│   └── server.js             -- Express + WebSocket + Newman runner + Motor de Deteccion
├── public/
│   └── index.html            -- Dashboard frontend (vanilla JS, sin frameworks)
├── collections/
│   ├── demo-qasl-tests.json  -- Coleccion demo contra APIs publicas
│   └── Sigma-flujo-e2e.json  -- Coleccion E2E real contra SIGMA (AGIP)
├── reports/                  -- Se crea automatico al ejecutar
├── run.js                    -- Single-command runner (kill port + server + browser + newman)
├── package.json
└── README.md
```

### Stack:
- **Backend**: Node.js + Express + WebSocket (ws)
- **Frontend**: Vanilla JS (zero frameworks, zero build tools)
- **Runner**: Newman (Postman CLI)
- **Browser**: Playwright Chromium (auto-launch)
- **Motor de Deteccion**: Value Index + Chain Detection + System Detection
- **Puerto**: 4747

### Eventos WebSocket:
| Evento | Descripcion |
|--------|-------------|
| `execution_start` | Inicio de ejecucion con nombre y total de requests |
| `request_start` | Request enviado (pending) |
| `request_done` | Response recibido con status, body, headers |
| `request_error` | Error de conexion |
| `assertion` | Resultado de test individual (pass/fail) |
| `variable_detected` | Variable reutilizada entre requests (cadena) |
| `systems_update` | Actualizacion de sistemas detectados |
| `chain_summary` | Resumen final de variables, sistemas e integraciones |
| `execution_done` | Fin de ejecucion con metricas completas |
| `report_ready` | Reporte HTML generado |

---

## Framework QASL

Este modulo es parte del ecosistema **QASL (Quality Assurance Shift-Left)**:

- `QASL` -- Framework principal Shift-Left
- `QASL-BACKEND-LIVE` -- Observabilidad Newman en tiempo real (este)
- `QASL-TOMEX` -- Captura automatica de APIs desde navegacion web (genera colecciones para QASL-BACKEND-LIVE)
- `INGRID` -- AI/LLM Testing Framework + Motor de Analisis integrado
- `QASL-MONITOR` -- Dashboard unificado Grafana
- `QASL-MOBILE` -- Mobile testing automation

---

*Elyer Gregorio Maldonado - Lider Tecnico QA - EPIDATA Consulting - 2025/2026*
