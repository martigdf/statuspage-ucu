const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// La versión se define mediante variable de entorno inyectada en K8s
const APP_VERSION = process.env.APP_VERSION || 'v1';

// Persistencia: en K8s se monta un PersistentVolume en /data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LIVE_DIR = path.join(DATA_DIR, 'live');
const DAILY_DIR = path.join(DATA_DIR, 'daily');

// Cada réplica escribe sus propios archivos y la lectura los combina.
// Así dos pods nunca escriben el mismo archivo y no hace falta locking.
const POD = process.env.HOSTNAME || 'local';

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 60000);
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || 10000);
const WINDOW_DAYS = 90;

// Servicios reales de la Universidad Católica del Uruguay
const SERVICES = [
    {
        name: "Autogestión estudiantil",
        group: "Vida académica",
        detail: "Escolaridad, pagos y datos personales",
        url: "https://ucu.universitasxxi.cloud/portal/home",
        host: "ucu.universitasxxi.cloud"
    },
    {
        name: "Webasignatura",
        group: "Vida académica",
        detail: "Aula virtual, materiales y entregas",
        url: "https://webasignatura.ucu.edu.uy",
        host: "webasignatura.ucu.edu.uy"
    },
    {
        name: "Inscripción a cursos",
        group: "Vida académica",
        detail: "Matrícula de asignaturas y exámenes",
        url: "https://ucu.universitasxxi.cloud/jsloader/ac/matricula",
        host: "ucu.universitasxxi.cloud"
    },
    {
        name: "Correo estudiantil",
        group: "Cuenta e identidad",
        detail: "Casilla institucional en Microsoft 365",
        url: "https://outlook.office.com/mail/",
        host: "outlook.office.com"
    },
    {
        name: "Recuperación de contraseña",
        group: "Cuenta e identidad",
        detail: "Restablecer el acceso a la cuenta UCU",
        url: "https://passwordreset.microsoftonline.com/?whr=ucu.edu.uy",
        host: "passwordreset.microsoftonline.com"
    },
    {
        name: "Portal laboral",
        group: "Servicios al estudiante",
        detail: "Ofertas de empleo y pasantías",
        url: "https://portallaboral.ucu.edu.uy/worcket/home",
        host: "portallaboral.ucu.edu.uy"
    },
    {
        name: "Ágora Bibliotecas",
        group: "Servicios al estudiante",
        detail: "Catálogo en línea y recursos digitales",
        url: "https://www.ucu.edu.uy/Institucionales/Agora-Bibliotecas-uc464",
        host: "ucu.edu.uy"
    },
    {
        name: "Sitio institucional",
        group: "Servicios al estudiante",
        detail: "Portal público ucu.edu.uy",
        url: "https://www.ucu.edu.uy/",
        host: "ucu.edu.uy"
    }
];

// ---------------------------------------------------------------- utilidades

function ensureDirs() {
    for (const d of [DATA_DIR, LIVE_DIR, DAILY_DIR]) {
        fs.mkdirSync(d, { recursive: true });
    }
}

// Escritura atómica: archivo temporal + rename, para que un pod que muere
// a mitad de escritura no deje un JSON truncado.
function writeAtomic(file, obj) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

function isoDate(d) {
    return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------- sondeo

// Un servicio está operativo si responde algo por HTTP con código < 500.
// Un 401/403 significa que hay un login delante, no que el servicio esté caído.
async function checkOne(svc) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
        const res = await fetch(svc.url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'UCU-StatusPage/1.0' }
        });
        clearTimeout(timer);
        return {
            up: res.status < 500,
            httpStatus: res.status,
            ms: Date.now() - started
        };
    } catch (err) {
        clearTimeout(timer);
        return {
            up: false,
            httpStatus: null,
            error: err.name === 'AbortError' ? 'timeout' : err.code || err.name,
            ms: Date.now() - started
        };
    }
}

async function runProbe() {
    const results = {};
    await Promise.all(SERVICES.map(async svc => {
        results[svc.name] = await checkOne(svc);
    }));

    const now = new Date();

    // Estado instantáneo de esta réplica
    writeAtomic(path.join(LIVE_DIR, POD + '.json'), {
        ts: now.toISOString(),
        pod: POD,
        results
    });

    // Acumulado del día: se agrega en vez de guardar cada chequeo,
    // para que 90 días de historia sigan siendo unos pocos KB.
    const date = isoDate(now);
    const dailyFile = path.join(DAILY_DIR, date + '.' + POD + '.json');
    const daily = readJson(dailyFile) || { date, pod: POD, services: {} };

    for (const svc of SERVICES) {
        const r = results[svc.name];
        const bucket = daily.services[svc.name] || { ok: 0, fail: 0 };
        if (r.up) bucket.ok++; else bucket.fail++;
        daily.services[svc.name] = bucket;
    }
    daily.updatedAt = now.toISOString();
    writeAtomic(dailyFile, daily);

    const caidos = SERVICES.filter(s => !results[s.name].up).length;
    console.log(`[probe] ${now.toISOString()} ${SERVICES.length - caidos}/${SERVICES.length} operativos`);
}

// -------------------------------------------------------------- agregación

// Combina los archivos de todas las réplicas.
function readLive() {
    const merged = {};
    let newest = null;
    let files = [];
    try { files = fs.readdirSync(LIVE_DIR).filter(f => f.endsWith('.json')); } catch (e) { }

    for (const f of files) {
        const doc = readJson(path.join(LIVE_DIR, f));
        if (!doc || !doc.ts) continue;
        if (!newest || doc.ts > newest) newest = doc.ts;
        for (const [name, r] of Object.entries(doc.results || {})) {
            // Se queda con la observación más reciente de cada servicio
            if (!merged[name] || doc.ts > merged[name].ts) {
                merged[name] = { ...r, ts: doc.ts };
            }
        }
    }
    return { results: merged, ts: newest };
}

function readHistory() {
    const dias = [];
    const hoy = new Date();
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
        const d = new Date(hoy);
        d.setUTCDate(d.getUTCDate() - i);
        dias.push(isoDate(d));
    }

    let files = [];
    try { files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.json')); } catch (e) { }

    // date -> service -> {ok, fail}, sumando todas las réplicas
    const porDia = new Map();
    for (const f of files) {
        const doc = readJson(path.join(DAILY_DIR, f));
        if (!doc || !doc.date) continue;
        if (!porDia.has(doc.date)) porDia.set(doc.date, {});
        const acc = porDia.get(doc.date);
        for (const [name, b] of Object.entries(doc.services || {})) {
            const cur = acc[name] || { ok: 0, fail: 0 };
            cur.ok += b.ok || 0;
            cur.fail += b.fail || 0;
            acc[name] = cur;
        }
    }

    const salida = {};
    for (const svc of SERVICES) {
        let ok = 0, fail = 0;
        const serie = dias.map(date => {
            const b = (porDia.get(date) || {})[svc.name];
            if (!b || (b.ok + b.fail) === 0) return { date, state: 'nodata', ok: 0, fail: 0 };
            ok += b.ok;
            fail += b.fail;
            const state = b.fail === 0 ? 'ok' : (b.ok === 0 ? 'down' : 'warn');
            return { date, state, ok: b.ok, fail: b.fail };
        });
        const total = ok + fail;
        salida[svc.name] = {
            history: serie,
            checks: total,
            uptime: total === 0 ? null : Math.round((ok / total) * 10000) / 100
        };
    }
    return salida;
}

// Incidentes reales: días en los que quedó registrada al menos una falla.
function buildIncidents(hist) {
    const out = [];
    for (const svc of SERVICES) {
        for (const d of hist[svc.name].history) {
            if (d.fail > 0) {
                const total = d.ok + d.fail;
                out.push({
                    date: d.date,
                    service: svc.name,
                    severity: d.ok === 0 ? 'Alto' : 'Bajo',
                    title: d.ok === 0
                        ? svc.name + ' sin respuesta durante todo el día'
                        : svc.name + ' con respuestas fallidas intermitentes',
                    detail: d.fail + ' de ' + total + ' verificaciones fallaron.'
                });
            }
        }
    }
    out.sort((a, b) => b.date.localeCompare(a.date));
    return out.slice(0, 20);
}

// Releer 180 archivos en cada request sería innecesario: la historia
// solo cambia cuando corre una sonda.
let cache = { at: 0, value: null };
function snapshot() {
    if (cache.value && Date.now() - cache.at < 15000) return cache.value;
    const live = readLive();
    const hist = readHistory();

    // v1 informa unicamente si el servicio esta arriba o abajo ahora mismo.
    // v2 agrega el historico de 90 dias y el uptime acumulado.
    // Ambas versiones sondean y persisten igual: el historial se acumula
    // este quien este sirviendo trafico.
    const esV2 = APP_VERSION === 'v2';

    const services = SERVICES.map(svc => {
        const r = live.results[svc.name];
        const h = hist[svc.name];
        const base = {
            name: svc.name,
            group: svc.group,
            detail: svc.detail,
            url: svc.url,
            host: svc.host,
            status: r ? (r.up ? 'Operational' : 'Down') : 'Unknown',
            httpStatus: r ? r.httpStatus : null,
            latencyMs: r ? r.ms : null,
            checkedAt: r ? r.ts : null
        };
        if (!esV2) return base;
        return { ...base, uptime: h.uptime, checks: h.checks, history: h.history };
    });

    const value = {
        version: APP_VERSION,
        status: services.every(s => s.status === 'Operational')
            ? 'All Systems Operational'
            : 'Partial Outage',
        timestamp: live.ts || new Date().toISOString(),
        windowDays: esV2 ? WINDOW_DAYS : null,
        checkIntervalMs: CHECK_INTERVAL_MS,
        services,
        // Elemento diferenciador para la versión 2
        incidentHistory: esV2 ? buildIncidents(hist) : []
    };
    cache = { at: Date.now(), value };
    return value;
}

// ---------------------------------------------------------------- servidor

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
    res.json(snapshot());
});

app.get('/healthz', (req, res) => res.json({ ok: true, version: APP_VERSION }));

ensureDirs();
runProbe().catch(err => console.error('[probe] error inicial', err));
setInterval(() => runProbe().catch(err => console.error('[probe] error', err)), CHECK_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`Status Page (${APP_VERSION}) running on port ${PORT} · datos en ${DATA_DIR}`);
});
