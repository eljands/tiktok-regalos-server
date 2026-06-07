const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// VALIDACIÓN DE SEGURIDAD CRÍTICA EN ARRANQUE
// ==========================================
if (!process.env.RESET_TOKEN) {
  throw new Error("RESET_TOKEN no configurado en las variables de entorno. Abortando inicio por seguridad.");
}

// Tiempo de inicio para calcular uptime
const uptimeInicio = Date.now();

// ==========================================
// 1. CONFIGURACIÓN (Altamente Modificable)
// ==========================================
const CONFIG = {
  // Modo de depuración (true: logs detallados, false: solo errores críticos)
  debug: false,

  // Token obligatorio provisto exclusivamente por variables de entorno
  resetToken: process.env.RESET_TOKEN,

  // Ventana de tiempo (en segundos) para la mitigación e ignorancia de eventos duplicados
  duplicateWindowSeconds: 5,

  // Método 1: Afiliación por Gift ID
  giftIdAffiliations: {
    "1001": "Player1",
    "1002": "Player2",
    "1003": "Player3",
    "1009": "Player9"
  },
  
  // Método 2: Afiliación por Comentario 
  commentAffiliations: {
    "Player1": "Player1",
    "Player2": "Player2",
    "Player3": "Player3"
  },

  // Límite liberado para permitir regalos masivos (León, Universo, etc.)
  maxCoinsPerEvent: Number.MAX_SAFE_INTEGER,

  // Historial máximo de eventos en memoria rodante
  maxEventHistory: 50000,
  
  // Tiempo límite para considerar inactividad de usuarios (en minutos)
  userTimeoutMinutes: 60
};

// ==========================================
// 2. ESTADO Y MEMORIA (Sin Bases de Datos)
// ==========================================

let partidaId = 1;

// --- SISTEMA LEGACY (Se mantiene intacto por compatibilidad) ---
const asignaciones = {
  'Rose': 'Player1',
  'TikTok': 'Player2',
  'White Rose': 'Player3',
  'Ice Cream Cone': 'Player4',
  'Maracas': 'Player5',
  'It’s corn': 'Player6',
  'GG': 'Player7',
  'Go Popular': 'Player8',
  'Guardian Wings': 'Player9',
};

const jugadores = {
  Player1: null, Player2: null, Player3: null,
  Player4: null, Player5: null, Player6: null,
  Player7: null, Player8: null, Player9: null,
};

let ultimoRegalo = null;

// --- NUEVO SISTEMA: Afiliaciones y Roblox ---
const afiliaciones = {};       // Formato normalizado: { "juan": "Player1" }
const actividadUsuarios = {};  // Control de actividad: { "juan": 1749200000 }

// Búfer histórico optimizado
let eventQueue = [];           

// Historial para control de deduplicación de eventos
const cacheDuplicados = new Map();

// Métricas de telemetría basadas en series temporales
const timestampsRegalos = [];
const timestampsEventos = [];
let ultimoTimestampEvento = null;
let sumaDiferenciasTiempoEventos = 0;
let conteoDiferenciasTiempoEventos = 0;
let acumuladoBytesEventos = 0;
let conteoBytesEventos = 0;

const estadisticas = {
  totalRegalosRecibidos: 0,
  totalEventosGenerados: 0,
  totalCambiosAfiliacion: 0 
};

let globalEventId = 0; 
let lastLegacyEventId = 0; 

// ==========================================
// 3. FUNCIONES AUXILIARES Y NORMALIZACIÓN
// ==========================================

// Log condicional basado en el estado del indicador DEBUG
function logDebug(tag, message, isError = false) {
  if (CONFIG.debug || isError) {
    const timestampLog = new Date().toISOString();
    console.log(`[${timestampLog}] [${tag}] ${message}`);
  }
}

// Búsqueda binaria optimizada O(log N) para segmentar el búfer de eventos sin barridos lineales
function buscarPrimerIndiceMayorQue(arr, targetId) {
  let inicio = 0;
  let fin = arr.length - 1;
  let resultado = arr.length;

  while (inicio <= fin) {
    let medio = Math.floor((inicio + fin) / 2);
    if (arr[medio].eventId > targetId) {
      resultado = medio;
      fin = medio - 1; // Intentar buscar un índice menor aún válido
    } else {
      inicio = medio + 1;
    }
  }
  return resultado;
}

// Limpieza de series temporales obsoletas para telemetría exacta en estado rodante
function limpiarMuestrasMétricas(arr, ahoraMs, ventanaMs = 60000) {
  while (arr.length > 0 && ahoraMs - arr[0] > ventanaMs) {
    arr.shift();
  }
}

// --- LECTURA COMPATIBLE MULTIFORMATO ---
function getGiftName(payload) {
  return payload.giftName || payload.giftname || payload.gift_name || null;
}

function getGiftId(payload) {
  return payload.giftId || payload.giftid || payload.gift_id || null;
}

function getComment(payload) {
  return payload.comment || payload.text || payload.message || null;
}

function getUsername(payload) {
  return payload.username || payload.userName || payload.user || payload.uniqueId || 'Desconocido';
}

// Captura de ID único de red provisto por TikTok o Webhook wrappers
function getPayloadMsgId(payload) {
  return payload.msgId || payload.messageId || payload.id || payload.eventId || null;
}

// Normaliza nombres de usuario para asegurar consistencia de claves
function normalizeUser(str) {
  if (!str) return 'desconocido';
  return String(str).trim().toLowerCase();
}

// Normalización avanzada y robusta de comentarios
function normalizeCommentRobust(str) {
  if (!str) return '';
  // Elimina espacios externos, múltiples espacios internos duplicados y fuerza minúsculas
  return String(str).replace(/\s+/g, '').trim().toLowerCase();
}

// Pre-normalizar la configuración estática de afiliaciones por comentarios en el arranque
const normalizedCommentConfig = {};
for (const [key, value] of Object.entries(CONFIG.commentAffiliations)) {
  const normalizedKey = normalizeCommentRobust(key);
  if (normalizedKey) {
    normalizedCommentConfig[normalizedKey] = value;
  }
}

// Extracción inteligente y segura de valores numéricos de monedas
function pickCoins(payload) {
  const keys = ['coins', 'value', 'giftvalue', 'diamonds', 'count'];
  for (const key of keys) {
    const val = parseInt(payload[key], 10);
    if (!isNaN(val) && val > 0) {
      return val;
    }
  }
  return 0; 
}

// Fábrica centralizada de eventos altamente descriptiva, modular y protegida
function crearEventoRoblox(playerAfiliado, userName, giftId, giftName, coins) {
  globalEventId++;
  
  const safeCoins = Math.min(coins, CONFIG.maxCoinsPerEvent);
  const ahoraSegundos = Math.floor(Date.now() / 1000);
  
  // Métricas de tracking de intervalos temporales entre eventos secuenciales exitosos
  if (ultimoTimestampEvento !== null) {
    const diferencia = Date.now() - ultimoTimestampEvento;
    sumaDiferenciasTiempoEventos += diferencia;
    conteoDiferenciasTiempoEventos++;
  }
  ultimoTimestampEvento = Date.now();

  const evento = {
    eventId: globalEventId,
    partidaId: partidaId,
    timestamp: ahoraSegundos,
    player: playerAfiliado,
    username: userName, 
    giftId: giftId || "0000",
    giftName: giftName,
    coins: safeCoins,
    type: "coins",      
    subType: "gift"
  };

  // Tracking del peso estimado de carga útil
  const pesoBytes = Buffer.byteLength(JSON.stringify(evento), 'utf8');
  acumuladoBytesEventos += pesoBytes;
  conteoBytesEventos++;

  return evento;
}

// Tarea Automática de Limpieza de Inactividad de Sesiones (Cada 5 minutos)
setInterval(() => {
  try {
    const ahora = Math.floor(Date.now() / 1000);
    const timeoutSegundos = CONFIG.userTimeoutMinutes * 60;
    
    for (const user in actividadUsuarios) {
      if (ahora - actividadUsuarios[user] > timeoutSegundos) {
        logDebug("CLEANUP", `🧹 Usuario eliminado por inactividad prolongada: ${user}`);
        delete afiliaciones[user];
        delete actividadUsuarios[user];
      }
    }
    
    // Limpieza de la caché de duplicados obsoleta para liberar memoria
    for (const [hash, expiration] of cacheDuplicados.entries()) {
      if (Date.now() > expiration) {
        cacheDuplicados.delete(hash);
      }
    }
  } catch (error) {
    logDebug("ERROR", `Excepción en intervalo de limpieza: ${error.message}`, true);
  }
}, 5 * 60 * 1000);

// Middlewares del ciclo de vida de Express
app.use(express.json({ limit: '10kb' })); 
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ==========================================
// 4. RECEPCIÓN DE TIKTOK (WEBHOOK)
// ==========================================

app.all('/webhook', (req, res) => {
  try {
    const payload = { ...req.query, ...req.body };
    
    let rawUserName = getUsername(payload);
    let giftName = getGiftName(payload);
    let giftId = getGiftId(payload);
    let comment = getComment(payload);

    // Sanitización estricta de longitudes de strings
    if (typeof rawUserName === 'string') rawUserName = rawUserName.substring(0, 48);
    if (typeof giftName === 'string') giftName = giftName.substring(0, 64);
    if (typeof giftId === 'string') giftId = giftId.substring(0, 32);
    if (typeof comment === 'string') comment = comment.substring(0, 128);

    const userNameNorm = normalizeUser(rawUserName); 
    const commentNorm = normalizeCommentRobust(comment); 
    const coins = pickCoins(payload);

    // --- PROTECCIÓN CONTRA EVENTOS DUPLICADOS ---
    const payloadMsgId = getPayloadMsgId(payload);
    
    // Si la plataforma envía ID único de red, deduplicamos por ese ID.
    // Si no, forzamos un hash con Date.now() para evitar falsos positivos de ráfagas legítimas.
    const hashUnicoEvento = payloadMsgId 
      ? `msg:${payloadMsgId}`
      : `${userNameNorm}:${giftId || 'none'}:${giftName || 'none'}:${coins}:${Date.now()}`;
    
    if (cacheDuplicados.has(hashUnicoEvento)) {
      if (Date.now() < cacheDuplicados.get(hashUnicoEvento)) {
        logDebug("DUPLICATE", `Evento repetido bloqueado con éxito para: ${userNameNorm}`);
        return res.sendStatus(200); 
      }
    }
    cacheDuplicados.set(hashUnicoEvento, Date.now() + (CONFIG.duplicateWindowSeconds * 1000));

    // Registrar marca de tiempo de actividad si hay una interacción válida
    if (comment || giftName) {
      actividadUsuarios[userNameNorm] = Math.floor(Date.now() / 1000);
    }

    // --- A. PROCESAMIENTO DE AFILIACIÓN CON PRIORIDAD ---
    let nuevaAfiliacion = null;

    if (giftId && CONFIG.giftIdAffiliations[giftId]) {
      nuevaAfiliacion = CONFIG.giftIdAffiliations[giftId];
    } 
    else if (commentNorm && normalizedCommentConfig[commentNorm]) {
      nuevaAfiliacion = normalizedCommentConfig[commentNorm];
    }

    if (nuevaAfiliacion) {
      if (afiliaciones[userNameNorm] !== nuevaAfiliacion) {
        afiliaciones[userNameNorm] = nuevaAfiliacion;
        estadisticas.totalCambiosAfiliacion++;
        logDebug("AFILIACION", `🔗 Usuario ${userNameNorm} asignado con éxito a ${nuevaAfiliacion}`);
      }
    }

    // --- B. PROCESAMIENTO DE REGALOS ---
    if (giftName) {
      logDebug("REGALO", `🎁 Recibido de ${rawUserName}: ${giftName} (Coins: ${coins})`);
      timestampsRegalos.push(Date.now());
      estadisticas.totalRegalosRecibidos++;

      // 1. Lógica Legacy (Mantenida intacta)
      const jugadorLegacy = asignaciones[giftName];
      if (jugadorLegacy) {
        jugadores[jugadorLegacy] = {
          nombre: rawUserName,
          timestamp: Date.now()
        };
        ultimoRegalo = { userName: rawUserName, giftName };
        logDebug("LEGACY", `✅ Asignado ${rawUserName} a ${jugadorLegacy}`);
      } else {
        logDebug("LEGACY", `⚠️ Regalo sin mapeo en tabla de asignaciones clásicas: ${giftName}`);
      }

      // 2. Lógica de Cola de Eventos para Roblox
      if (coins > 0) {
        const playerAfiliado = afiliaciones[userNameNorm];
        
        if (playerAfiliado) {
          const nuevoEvento = crearEventoRoblox(playerAfiliado, rawUserName, giftId, giftName, coins);
          timestampsEventos.push(Date.now());

          // [MEJORA FUTURA] Cuando el historial escale a cientos de miles de eventos, 
          // considerar reemplazar shift() por un puntero circular o LinkedList.
          // Para la escala actual, el impacto no es notable.
          if (eventQueue.length >= CONFIG.maxEventHistory) {
            eventQueue.shift(); 
            logDebug("QUEUE", `⚠️ Límite del búfer alcanzado. Evento antiguo desplazado.`);
          }

          eventQueue.push(nuevoEvento);
          estadisticas.totalEventosGenerados++;
          logDebug("ROBLOX", `🚀 Evento #${nuevoEvento.eventId} inyectado al canal de ${playerAfiliado}`);
        } else {
          logDebug("ROBLOX", `Skip de evento. El usuario ${rawUserName} no cuenta con afiliación activa.`);
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    logDebug("ERROR", `Fallo crítico en webhook: ${error.message}`, true);
    res.sendStatus(500);
  }
});

// ==========================================
// 5. ENDPOINTS LEGACY (Intactos)
// ==========================================

app.get('/nombres', (req, res) => {
  res.json(jugadores);
});

app.get('/asignaciones', (req, res) => {
  res.json(asignaciones);
});

app.get('/ultimo', (req, res) => {
  if (ultimoRegalo) {
    res.json(ultimoRegalo);
  } else {
    res.json({ userName: "", giftName: "" });
  }
});

// ==========================================
// 6. ENDPOINTS PROFESIONALES DE CONTROL Y MONITOREO
// ==========================================

app.get('/eventos', (req, res) => {
  try {
    const lastEventIdParam = req.query.lastEventId;

    if (lastEventIdParam !== undefined) {
      const parsedId = parseInt(lastEventIdParam, 10);
      if (isNaN(parsedId)) {
        return res.status(400).json({ error: "El parámetro lastEventId debe ser un número entero válido." });
      }
      
      const indiceInicial = buscarPrimerIndiceMayorQue(eventQueue, parsedId);
      const eventosFiltrados = eventQueue.slice(indiceInicial);
      
      return res.json(eventosFiltrados);
    } else {
      const indiceInicialLegacy = buscarPrimerIndiceMayorQue(eventQueue, lastLegacyEventId);
      const eventosLegacy = eventQueue.slice(indiceInicialLegacy);
      lastLegacyEventId = globalEventId; 
      return res.json(eventosLegacy);
    }
  } catch (error) {
    logDebug("ERROR", `Fallo en endpoint /eventos: ${error.message}`, true);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/afiliaciones', (req, res) => {
  res.json(afiliaciones);
});

app.post('/reset', (req, res) => {
  try {
    const tokenProvisto = req.query.token || req.headers['x-reset-token'];
    
    if (!tokenProvisto || tokenProvisto !== CONFIG.resetToken) {
      logDebug("SECURITY", "Intento fallido de reset sin token de autorización válido.", true);
      return res.status(403).json({ success: false, error: "Forbidden: Token de seguridad inválido o ausente." });
    }

    for (const key in afiliaciones) delete afiliaciones[key];
    for (const key in actividadUsuarios) delete actividadUsuarios[key];
    
    for (const player in jugadores) {
      jugadores[player] = null;
    }

    eventQueue = [];
    cacheDuplicados.clear();
    ultimoRegalo = null;
    ultimoTimestampEvento = null;
    sumaDiferenciasTiempoEventos = 0;
    conteoDiferenciasTiempoEventos = 0;
    acumuladoBytesEventos = 0;
    conteoBytesEventos = 0;
    
    estadisticas.totalRegalosRecibidos = 0;
    estadisticas.totalEventosGenerados = 0;
    estadisticas.totalCambiosAfiliacion = 0;
    globalEventId = 0;
    lastLegacyEventId = 0;
    
    partidaId++;
    
    console.log(`[RESET] 🔄 Reinicio de partida exitoso. ID de la nueva sesión: #${partidaId}`);
    res.json({
      success: true,
      message: "Partida reiniciada"
    });
  } catch (error) {
    logDebug("ERROR", `Error crítico durante la ejecución del reset: ${error.message}`, true);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - uptimeInicio) / 1000),
    eventosPendientes: eventQueue.length,
    usuariosAfiliados: Object.keys(afiliaciones).length
  });
});

app.get('/estado', (req, res) => {
  try {
    const ahoraMs = Date.now();
    
    limpiarMuestrasMétricas(timestampsRegalos, ahoraMs);
    limpiarMuestrasMétricas(timestampsEventos, ahoraMs);

    const afiliacionesActivasPorEquipo = {
      Player1: 0, Player2: 0, Player3: 0, Player4: 0, Player5: 0,
      Player6: 0, Player7: 0, Player8: 0, Player9: 0
    };
    for (const user in afiliaciones) {
      const equipo = afiliaciones[user];
      if (afiliacionesActivasPorEquipo[equipo] !== undefined) {
        afiliacionesActivasPorEquipo[equipo]++;
      }
    }

    const tiempoPromedioEntreEventos = conteoDiferenciasTiempoEventos > 0 
      ? Math.floor(sumaDiferenciasTiempoEventos / conteoDiferenciasTiempoEventos) 
      : 0;

    const tamañoPromedioEventoBytes = conteoBytesEventos > 0 
      ? Math.floor(acumuladoBytesEventos / conteoBytesEventos) 
      : 0;

    const memoriaEstimadaBytes = Buffer.byteLength(JSON.stringify(eventQueue), 'utf8');

    res.json({
      usuariosAfiliados: Object.keys(afiliaciones).length,
      eventosPendientes: eventQueue.length,
      capacidadMaximaCola: CONFIG.maxEventHistory,
      espacioDisponibleCola: Math.max(0, CONFIG.maxEventHistory - eventQueue.length),
      memoriaColaActual: eventQueue.length,
      totalRegalosRecibidos: estadisticas.totalRegalosRecibidos,
      totalEventosGenerados: estadisticas.totalEventosGenerados,
      totalCambiosAfiliacion: estadisticas.totalCambiosAfiliacion,
      ultimoEventoId: globalEventId,
      partidaIdActual: partidaId, 
      uptimeSegundos: Math.floor((ahoraMs - uptimeInicio) / 1000), 
      memoriaEstimadaBytes: memoriaEstimadaBytes,
      telemetriaAvanzada: {
        regalosPorMinuto: timestampsRegalos.length,
        eventosPorMinuto: timestampsEventos.length,
        tiempoPromedioEntreEventosMs: tiempoPromedioEntreEventos,
        tamañoPromedioEventoBytes: tamañoPromedioEventoBytes,
        afiliacionesActivasPorEquipo
      }
    });
  } catch (error) {
    logDebug("ERROR", `Fallo al compilar telemetría avanzada: ${error.message}`, true);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// 7. INICIO DEL SERVIDOR
// ==========================================

app.listen(port, () => {
  console.log(`✅ Servidor intermediario profesional activo en puerto ${port}`);
});
