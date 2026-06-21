const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// VALIDACIÓN DE SEGURIDAD CRÍTICA EN ARRANQUE
// ==========================================
if (!process.env.RESET_TOKEN) {
  throw new Error("RESET_TOKEN no configurado en las variables de entorno. Abortando inicio por seguridad.");
}

// Tiempo de inicio global para calcular uptime
const uptimeInicio = Date.now();

// ==========================================
// 1. CONFIGURACIÓN (Estructura Original)
// ==========================================
const CONFIG = {
  // Modo de depuración (true: logs detallados, false: solo errores críticos)
  debug: false,

  // Token obligatorio provisto exclusivamente por variables de entorno
  resetToken: process.env.RESET_TOKEN,

  // Ventana de tiempo (en segundos) para la mitigación e ignorancia de eventos duplicados
  duplicateWindowSeconds: 5,

  // Método 1: Afiliación estática por Gift ID original
  giftIdAffiliations: {
    "5655": "Player1",
    "5269": "Player2",
    "8239": "Player3",
    "5827": "Player4",
    "7032": "Player5",
    "7096": "Player6",
    "6064": "Player7",
    "null": "Player8",
    "15232": "Player8",
    "15104": "Player9"
  },

  // Método 2: Afiliación base por Comentario (Mantenido por compatibilidad)
  commentAffiliations: {
    "Player1": "Player1",
    "Player2": "Player2",
    "Player3": "Player3"
  },

  // Límite liberado para permitir regalos masivos (León, Universo, etc.)
  maxCoinsPerEvent: Number.MAX_SAFE_INTEGER,

  // Historial máximo de eventos en memoria rodante por sala
  maxEventHistory: 50000,

  // Tiempo límite para considerar inactividad de usuarios (en minutos)
  userTimeoutMinutes: 60
};

// --- DICCIONARIO LEGACY GLOBAL STATIC ---
const asignacionesClasicas = {
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

// ==========================================
// 2. GESTOR MULTI-SALA COMPLETO (MULTI-TENANT)
// ==========================================
const salas = {};

// Factoría e inicializador dinámico de estado por sala aislada
function obtenerSala(playerid) {
  const id = playerid ? String(playerid).trim().toLowerCase() : "default";
  
  if (!salas[id]) {
    salas[id] = {
      partidaId: 1,
      ultimoRegalo: null,
      globalEventId: 0,
      lastLegacyEventId: 0,
      ultimoTimestampEvento: null,
      sumaDiferenciasTiempoEventos: 0,
      conteoDiferenciasTiempoEventos: 0,
      acumuladoBytesEventos: 0,
      conteoBytesEventos: 0,
      
      jugadores: {
        Player1: null, Player2: null, Player3: null,
        Player4: null, Player5: null, Player6: null,
        Player7: null, Player8: null, Player9: null,
      },
      
      afiliaciones: {},
      actividadUsuarios: {},
      eventQueue: [],
      cacheDuplicados: new Map(),
      timestampsRegalos: [],
      timestampsEventos: [],
      normalizedCommentConfig: {},
      
      estadisticas: {
        totalRegalosRecibidos: 0,
        totalEventosGenerados: 0,
        totalCambiosAfiliacion: 0 
      }
    };

    // Pre-normalizar la configuración estática para esta nueva sala en su arranque
    for (const [key, value] of Object.entries(CONFIG.commentAffiliations)) {
      const normalizedKey = normalizeCommentRobust(key);
      if (normalizedKey) {
        salas[id].normalizedCommentConfig[normalizedKey] = value;
      }
    }
  }
  return salas[id];
}

// ==========================================
// 3. FUNCIONES AUXILIARES Y NORMALIZACIÓN
// ==========================================

function logDebug(tag, message, isError = false) {
  if (CONFIG.debug || isError) {
    const timestampLog = new Date().toISOString();
    console.log(`[${timestampLog}] [${tag}] ${message}`);
  }
}

function buscarPrimerIndiceMayorQue(arr, targetId) {
  let inicio = 0;
  let fin = arr.length - 1;
  let resultado = arr.length;

  while (inicio <= fin) {
    let medio = Math.floor((inicio + fin) / 2);
    if (arr[medio].eventId > targetId) {
      resultado = medio;
      fin = medio - 1;
    } else {
      inicio = medio + 1;
    }
  }
  return resultado;
}

function limpiarMuestrasMétricas(arr, ahoraMs, ventanaMs = 60000) {
  while (arr.length > 0 && ahoraMs - arr[0] > ventanaMs) {
    arr.shift();
  }
}

function getGiftName(payload) { return payload.giftName || payload.giftname || payload.gift_name || null; }
function getGiftId(payload) { return payload.giftId || payload.giftid || payload.gift_id || null; }
function getComment(payload) { return payload.comment || payload.text || payload.message || null; }
function getUsername(payload) { return payload.username || payload.userName || payload.user || payload.uniqueId || 'Desconocido'; }
function getPayloadMsgId(payload) { return payload.msgId || payload.messageId || payload.id || payload.eventId || null; }
function normalizeUser(str) { return str ? String(str).trim().toLowerCase() : 'desconocido'; }

function normalizeCommentRobust(str) {
  if (!str) return '';
  return String(str).replace(/\s+/g, '').trim().toLowerCase();
}

function pickCoins(payload) {
  const keys = ['coins', 'value', 'giftvalue', 'diamonds', 'count'];
  for (const key of keys) {
    const val = parseInt(payload[key], 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 0; 
}

function crearEventoRoblox(sala, playerAfiliado, userName, giftId, giftName, coins, tipoEvent = "coins", subTipoEvent = "gift") {
  sala.globalEventId++;

  const safeCoins = Math.min(coins, CONFIG.maxCoinsPerEvent);
  const ahoraSegundos = Math.floor(Date.now() / 1000);

  if (sala.ultimoTimestampEvento !== null) {
    const diferencia = Date.now() - sala.ultimoTimestampEvento;
    sala.sumaDiferenciasTiempoEventos += diferencia;
    sala.conteoDiferenciasTiempoEventos++;
  }
  sala.ultimoTimestampEvento = Date.now();

  const evento = {
    eventId: sala.globalEventId,
    partidaId: sala.partidaId,
    timestamp: ahoraSegundos,
    player: playerAfiliado,
    username: userName, 
    giftId: giftId || "0000",
    giftName: giftName,
    coins: safeCoins,
    type: tipoEvent,      
    subType: subTipoEvent
  };

  const pesoBytes = Buffer.byteLength(JSON.stringify(evento), 'utf8');
  sala.acumuladoBytesEventos += pesoBytes;
  sala.conteoBytesEventos++;

  return evento;
}

// Limpieza Automatizada de Inactividad Distribuida para todas las salas (Cada 5 minutos)
setInterval(() => {
  try {
    const ahora = Math.floor(Date.now() / 1000);
    const timeoutSegundos = CONFIG.userTimeoutMinutes * 60;

    for (const salaId in salas) {
      const sala = salas[salaId];
      
      for (const user in sala.actividadUsuarios) {
        if (ahora - sala.actividadUsuarios[user] > timeoutSegundos) {
          logDebug(`CLEANUP [Sala: ${salaId}]`, `🧹 Usuario eliminado por inactividad: ${user}`);
          delete sala.afiliaciones[user];
          delete sala.actividadUsuarios[user];
        }
      }

      for (const [hash, expiration] of sala.cacheDuplicados.entries()) {
        if (Date.now() > expiration) {
          sala.cacheDuplicados.delete(hash);
        }
      }
    }
  } catch (error) {
    logDebug("ERROR GLOBAL CLEANUP", `Excepción en intervalo de limpieza: ${error.message}`, true);
  }
}, 5 * 60 * 1000);

app.use(express.json({ limit: '10kb' })); 
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ==========================================
// 4. RECEPCIÓN DE TIKTOK (WEBHOOK MULTI-SALA)
// ==========================================
app.all('/webhook', (req, res) => {
  try {
    const payload = { ...req.query, ...req.body };

    // Extracción dinámica del ID de sala de streamer (?playerid=X)
    const salaTargetId = payload.playerid || 'default';
    const sala = obtenerSala(salaTargetId);

    console.log(`📥 [Sala: ${salaTargetId}] DATOS CRUDOS RECIBIDOS:`, payload);

    let rawUserName = getUsername(payload);
    let giftName = getGiftName(payload);
    let giftId = getGiftId(payload);
    let comment = getComment(payload);

    if (typeof rawUserName === 'string') rawUserName = rawUserName.substring(0, 48);
    if (typeof giftName === 'string') giftName = giftName.substring(0, 64);
    if (typeof giftId === 'string') giftId = giftId.substring(0, 32);
    if (typeof comment === 'string') comment = comment.substring(0, 128);

    const userNameNorm = normalizeUser(rawUserName); 
    const commentNorm = normalizeCommentRobust(comment); 
    const coins = pickCoins(payload);

    const payloadMsgId = getPayloadMsgId(payload);
    const hashUnicoEvento = payloadMsgId 
      ? `msg:${payloadMsgId}`
      : `${userNameNorm}:${giftId || 'none'}:${giftName || 'none'}:${coins}:${Date.now()}`;

    if (sala.cacheDuplicados.has(hashUnicoEvento)) {
      if (Date.now() < sala.cacheDuplicados.get(hashUnicoEvento)) {
        logDebug(`DUPLICATE [Sala: ${salaTargetId}]`, `Evento repetido bloqueado para: ${userNameNorm}`);
        return res.sendStatus(200); 
      }
    }
    sala.cacheDuplicados.set(hashUnicoEvento, Date.now() + (CONFIG.duplicateWindowSeconds * 1000));

    if (comment || giftName) {
      sala.actividadUsuarios[userNameNorm] = Math.floor(Date.now() / 1000);
    }

    // --- A. PROCESAMIENTO DE AFILIACIÓN CON PRIORIDAD ---
    let nuevaAfiliacion = null;

    if (giftId && CONFIG.giftIdAffiliations[giftId]) {
      nuevaAfiliacion = CONFIG.giftIdAffiliations[giftId];
    } 
    else if (commentNorm && sala.normalizedCommentConfig[commentNorm]) {
      nuevaAfiliacion = sala.normalizedCommentConfig[commentNorm];
    }

    if (nuevaAfiliacion) {
      if (sala.afiliaciones[userNameNorm] !== nuevaAfiliacion) {
        sala.afiliaciones[userNameNorm] = nuevaAfiliacion;
        sala.estadisticas.totalCambiosAfiliacion++;
        logDebug(`AFILIACION [Sala: ${salaTargetId}]`, `🔗 Usuario ${userNameNorm} asignado a ${nuevaAfiliacion}`);
        
        // Inyección instantánea a la cola del evento estructurado de tipo "join" para Roblox
        const eventoJoin = crearEventoRoblox(sala, nuevaAfiliacion, rawUserName, "0000", "Join", 0, "join", "chat");
        
        if (sala.eventQueue.length >= CONFIG.maxEventHistory) {
          sala.eventQueue.shift();
        }
        sala.eventQueue.push(eventoJoin);
        sala.estadisticas.totalEventosGenerados++;
      }
    }

    // --- B. PROCESAMIENTO DE REGALOS ---
    if (giftName) {
      logDebug(`REGALO [Sala: ${salaTargetId}]`, `🎁 Recibido de ${rawUserName}: ${giftName} (Coins: ${coins})`);
      sala.timestampsRegalos.push(Date.now());
      sala.estadisticas.totalRegalosRecibidos++;

      // 1. Lógica Clásica Legacy por Sala
      const jugadorLegacy = asignacionesClasicas[giftName];
      if (jugadorLegacy) {
        sala.jugadores[jugadorLegacy] = {
          nombre: rawUserName,
          timestamp: Date.now()
        };
        sala.ultimoRegalo = { userName: rawUserName, giftName };
      }

      // 2. Lógica de Cola de Eventos de Crecimiento para Roblox (Suma sin pérdidas)
      if (coins > 0) {
        const playerAfiliado = sala.afiliaciones[userNameNorm];

        if (playerAfiliado) {
          const nuevoEvento = crearEventoRoblox(sala, playerAfiliado, rawUserName, giftId, giftName, coins, "coins", "gift");
          sala.timestampsEventos.push(Date.now());

          if (sala.eventQueue.length >= CONFIG.maxEventHistory) {
            sala.eventQueue.shift(); 
          }

          sala.eventQueue.push(nuevoEvento);
          sala.estadisticas.totalEventosGenerados++;
          logDebug(`ROBLOX [Sala: ${salaTargetId}]`, `🚀 Evento #${nuevoEvento.eventId} inyectado al canal de ${playerAfiliado}`);
        } else {
          logDebug(`ROBLOX [Sala: ${salaTargetId}]`, `Skip de evento. El usuario ${rawUserName} no cuenta con afiliación activa.`);
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    logDebug("ERROR CRÍTICO WEBHOOK", `${error.message}`, true);
    res.sendStatus(500);
  }
});

// ==========================================
// 5. ENDPOINTS LEGACY AISLADOS POR STREAMER
// ==========================================
app.get('/nombres', (req, res) => {
  const sala = obtenerSala(req.query.playerid);
  res.json(sala.jugadores);
});

app.get('/asignaciones', (req, res) => {
  res.json(asignacionesClasicas);
});

app.get('/ultimo', (req, res) => {
  const sala = obtenerSala(req.query.playerid);
  if (sala.ultimoRegalo) {
    res.json(sala.ultimoRegalo);
  } else {
    res.json({ userName: "", giftName: "" });
  }
});

// ==========================================
// 6. ENDPOINTS DE CONTROL Y MONITOREO DINÁMICOS
// ==========================================
app.get('/eventos', (req, res) => {
  try {
    const sala = obtenerSala(req.query.playerid);
    const lastEventIdParam = req.query.lastEventId;

    if (lastEventIdParam !== undefined) {
      const parsedId = parseInt(lastEventIdParam, 10);
      if (isNaN(parsedId)) {
        return res.status(400).json({ error: "El parámetro lastEventId debe ser un entero válido." });
      }

      const indiceInicial = buscarPrimerIndiceMayorQue(sala.eventQueue, parsedId);
      return res.json(sala.eventQueue.slice(indiceInicial));
    } else {
      const indiceInicialLegacy = buscarPrimerIndiceMayorQue(sala.eventQueue, sala.lastLegacyEventId);
      const eventosLegacy = sala.eventQueue.slice(indiceInicialLegacy);
      sala.lastLegacyEventId = sala.globalEventId; 
      return res.json(eventosLegacy);
    }
  } catch (error) {
    logDebug("ERROR ENDPOINT EVENTOS", `${error.message}`, true);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/afiliaciones', (req, res) => {
  const sala = obtenerSala(req.query.playerid);
  res.json(sala.afiliaciones);
});

app.post('/reset', (req, res) => {
  try {
    const tokenProvisto = req.query.token || req.headers['x-reset-token'];

    if (!tokenProvisto || tokenProvisto !== CONFIG.resetToken) {
      logDebug("SECURITY", "Intento fallido de reset sin token de autorización válido.", true);
      return res.status(403).json({ success: false, error: "Forbidden: Token de seguridad inválido o ausente." });
    }

    const salaId = req.query.playerid || 'default';
    const sala = obtenerSala(salaId);

    for (const key in sala.afiliaciones) delete sala.afiliaciones[key];
    for (const key in sala.actividadUsuarios) delete sala.actividadUsuarios[key];
    for (const player in sala.jugadores) sala.jugadores[player] = null;

    sala.eventQueue = [];
    sala.cacheDuplicados.clear();
    sala.ultimoRegalo = null;
    sala.ultimoTimestampEvento = null;
    sala.sumaDiferenciasTiempoEventos = 0;
    sala.conteoDiferenciasTiempoEventos = 0;
    sala.acumuladoBytesEventos = 0;
    sala.conteoBytesEventos = 0;

    sala.estadisticas.totalRegalosRecibidos = 0;
    sala.estadisticas.totalEventosGenerados = 0;
    sala.estadisticas.totalCambiosAfiliacion = 0;
    sala.globalEventId = 0;
    sala.lastLegacyEventId = 0;

    sala.partidaId++;

    console.log(`[RESET] 🔄 Reinicio de partida exitoso [Sala: ${salaId}]. Nueva sesión: #${sala.partidaId}`);
    res.json({ success: true, message: `Partida reiniciada para la sala: ${salaId}` });
  } catch (error) {
    logDebug("ERROR CRÍTICO RESET", `${error.message}`, true);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  const sala = obtenerSala(req.query.playerid);
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - uptimeInicio) / 1000),
    eventosPendientes: sala.eventQueue.length,
    usuariosAfiliados: Object.keys(sala.afiliaciones).length
  });
});

app.get('/estado', (req, res) => {
  try {
    const salaId = req.query.playerid || 'default';
    const sala = obtenerSala(salaId);
    const ahoraMs = Date.now();

    limpiarMuestrasMétricas(sala.timestampsRegalos, ahoraMs);
    limpiarMuestrasMétricas(sala.timestampsEventos, ahoraMs);

    const afiliacionesActivasPorEquipo = {
      Player1: 0, Player2: 0, Player3: 0, Player4: 0, Player5: 0,
      Player6: 0, Player7: 0, Player8: 0, Player9: 0
    };
    for (const user in sala.afiliaciones) {
      const equipo = sala.afiliaciones[user];
      if (afiliacionesActivasPorEquipo[equipo] !== undefined) {
        afiliacionesActivasPorEquipo[equipo]++;
      }
    }

    const tiempoPromedioEntreEventos = sala.conteoDiferenciasTiempoEventos > 0 
      ? Math.floor(sala.sumaDiferenciasTiempoEventos / sala.conteoDiferenciasTiempoEventos) 
      : 0;

    const tamañoPromedioEventoBytes = sala.conteoBytesEventos > 0 
      ? Math.floor(sala.acumuladoBytesEventos / sala.conteoBytesEventos) 
      : 0;

    const memoriaEstimadaBytes = Buffer.byteLength(JSON.stringify(sala.eventQueue), 'utf8');

    res.json({
      salaIdConfigurada: salaId,
      usuariosAfiliados: Object.keys(sala.afiliaciones).length,
      eventosPendientes: sala.eventQueue.length,
      capacidadMaximaCola: CONFIG.maxEventHistory,
      espacioDisponibleCola: Math.max(0, CONFIG.maxEventHistory - sala.eventQueue.length),
      memoriaColaActual: sala.eventQueue.length,
      totalRegalosRecibidos: sala.estadisticas.totalRegalosRecibidos,
      totalEventosGenerados: sala.estadisticas.totalEventosGenerados,
      totalCambiosAfiliacion: sala.estadisticas.totalCambiosAfiliacion,
      ultimoEventoId: sala.globalEventId,
      partidaIdActual: sala.partidaId, 
      uptimeSegundos: Math.floor((ahoraMs - uptimeInicio) / 1000), 
      memoriaEstimadaBytes: memoriaEstimadaBytes,
      telemetriaAvanzada: {
        regalosPorMinuto: sala.timestampsRegalos.length,
        eventosPorMinuto: sala.timestampsEventos.length,
        tiempoPromedioEntreEventosMs: tiempoPromedioEntreEventos,
        tamañoPromedioEventoBytes: tamañoPromedioEventoBytes,
        afiliacionesActivasPorEquipo
      }
    });
  } catch (error) {
    logDebug("ERROR TELEMETRÍA AVANZADA", `${error.message}`, true);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// =================================================================
// 7. SINCRONIZACIÓN DINÁMICA DE COMANDOS DESDE ROBLOX (MUEVE-PAÍSES)
// =================================================================
app.post('/set-names', (req, res) => {
  try {
    const salaId = req.query.playerid || 'default';
    const sala = obtenerSala(salaId);
    const nombres = req.body;
    
    // Limpiamos la configuración de comentarios anterior de esta sala
    sala.normalizedCommentConfig = {};
    
    // Asignamos las nuevas palabras clave dinámicas de la pista a los carriles correspondientes
    for (const slot in nombres) {
      const nombreReal = nombres[slot];
      const normalizedKey = normalizeCommentRobust(nombreReal);
      if (normalizedKey) {
        sala.normalizedCommentConfig[normalizedKey] = slot;
        logDebug(`NAMES [Sala: ${salaId}]`, `✅ Enlace automático: Escribir "${normalizedKey}" afilia a ${slot}`);
      }
    }
    
    res.json({ success: true, message: `Nombres vinculados con éxito para la sala: ${salaId}` });
  } catch (error) {
    logDebug("ERROR SINCRONIZACIÓN NOMBRES", `${error.message}`, true);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`✅ Servidor intermediario profesional MULTI-SALA activo en puerto ${port}`);
});
