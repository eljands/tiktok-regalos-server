const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// 1. CONFIGURACIÓN GLOBAL
// ==========================================
const CONFIG = {
  debug: true,
  duplicateWindowSeconds: 5,
  maxEventHistory: 50000,
  userTimeoutMinutes: 60,
  // Comandos de chat base (se sobrescriben dinámicamente desde Roblox)
  commentAffiliations: {
    "Player1": "Player1", "Player2": "Player2", "Player3": "Player3"
  }
};

// ==========================================
// 2. GESTOR DE MÚLTIPLES SALAS (MULTI-TENANT)
// ==========================================
const salas = {};

// Esta función busca la sala (ej. "pepito"). Si no existe, crea un universo nuevo para él.
function obtenerSala(playerid) {
  const id = playerid ? String(playerid).toLowerCase() : "default";
  
  if (!salas[id]) {
    console.log(`[SISTEMA] 🟢 Creando nueva sala aislada para el streamer: ${id}`);
    salas[id] = {
      afiliaciones: {},
      actividadUsuarios: {},
      eventQueue: [],
      cacheDuplicados: new Map(),
      globalEventId: 0,
      lastLegacyEventId: 0,
      normalizedCommentConfig: {}
    };
  }
  return salas[id];
}

// ==========================================
// 3. FUNCIONES AUXILIARES
// ==========================================
function getUsername(payload) { return payload.username || payload.userName || payload.uniqueId || 'Desconocido'; }
function getGiftName(payload) { return payload.giftName || payload.giftname || null; }
function getGiftId(payload) { return payload.giftId || payload.giftid || null; }
function getComment(payload) { return payload.comment || payload.text || null; }
function normalizeUser(str) { return str ? String(str).trim().toLowerCase() : 'desconocido'; }
function normalizeCommentRobust(str) { return str ? String(str).replace(/\s+/g, '').trim().toLowerCase() : ''; }

function pickCoins(payload) {
  const keys = ['coins', 'value', 'diamonds'];
  for (const key of keys) {
    const val = parseInt(payload[key], 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 0; 
}

function buscarPrimerIndiceMayorQue(arr, targetId) {
  let inicio = 0, fin = arr.length - 1, resultado = arr.length;
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

// Tarea Automática de Limpieza (Aplica a todas las salas)
setInterval(() => {
  const ahora = Math.floor(Date.now() / 1000);
  const timeoutSegundos = CONFIG.userTimeoutMinutes * 60;
  
  for (const salaId in salas) {
    const sala = salas[salaId];
    for (const user in sala.actividadUsuarios) {
      if (ahora - sala.actividadUsuarios[user] > timeoutSegundos) {
        delete sala.afiliaciones[user];
        delete sala.actividadUsuarios[user];
      }
    }
    for (const [hash, expiration] of sala.cacheDuplicados.entries()) {
      if (Date.now() > expiration) sala.cacheDuplicados.delete(hash);
    }
  }
}, 5 * 60 * 1000);

app.use(express.json({ limit: '10kb' })); 
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ==========================================
// 4. RECEPCIÓN DE TIKTOK (WEBHOOK)
// ==========================================
app.all('/webhook', (req, res) => {
  try {
    const payload = { ...req.query, ...req.body };
    
    // 🔥 AQUÍ SE LEE EL PARÁMETRO URL: ?playerid=pepito
    const sala = obtenerSala(payload.playerid);
    
    let rawUserName = getUsername(payload);
    let giftName = getGiftName(payload);
    let giftId = getGiftId(payload);
    let comment = getComment(payload);

    const userNameNorm = normalizeUser(rawUserName); 
    const commentNorm = normalizeCommentRobust(comment); 
    const coins = pickCoins(payload);

    // ANTI-DUPLICADOS AISLADO POR SALA
    const hashUnicoEvento = payload.msgId 
      ? `msg:${payload.msgId}` 
      : `${userNameNorm}:${giftId}:${coins}:${Date.now()}`;
      
    if (sala.cacheDuplicados.has(hashUnicoEvento) && Date.now() < sala.cacheDuplicados.get(hashUnicoEvento)) {
      return res.sendStatus(200); 
    }
    sala.cacheDuplicados.set(hashUnicoEvento, Date.now() + (CONFIG.duplicateWindowSeconds * 1000));

    if (comment || giftName) sala.actividadUsuarios[userNameNorm] = Math.floor(Date.now() / 1000);

    // PROCESAMIENTO DE AFILIACIÓN (CHAT)
    let nuevaAfiliacion = null;
    if (commentNorm && sala.normalizedCommentConfig[commentNorm]) {
      nuevaAfiliacion = sala.normalizedCommentConfig[commentNorm];
    }

    if (nuevaAfiliacion && sala.afiliaciones[userNameNorm] !== nuevaAfiliacion) {
      sala.afiliaciones[userNameNorm] = nuevaAfiliacion;
      
      // Evento de "Se unió"
      sala.globalEventId++;
      sala.eventQueue.push({
        eventId: sala.globalEventId,
        player: nuevaAfiliacion,
        username: rawUserName,
        giftName: "Join",
        coins: 0,
        type: "join"
      });
      if (CONFIG.debug) console.log(`[${payload.playerid || 'default'}] 🔗 ${rawUserName} se unió a ${nuevaAfiliacion}`);
    }

    // PROCESAMIENTO DE REGALOS
    if (giftName && coins > 0) {
      const playerAfiliado = sala.afiliaciones[userNameNorm];
      if (playerAfiliado) {
        sala.globalEventId++;
        sala.eventQueue.push({
          eventId: sala.globalEventId,
          player: playerAfiliado,
          username: rawUserName,
          giftId: giftId,
          giftName: giftName,
          coins: coins,
          type: "coins"
        });
        if (CONFIG.debug) console.log(`[${payload.playerid || 'default'}] 🎁 Regalo de ${rawUserName}: ${coins} coins para ${playerAfiliado}`);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.log("Fallo crítico en webhook:", error.message);
    res.sendStatus(500);
  }
});

// ==========================================
// 5. SINCRONIZACIÓN DE ROBLOX A NODE.JS
// ==========================================
app.post('/set-names', (req, res) => {
  try {
    const salaId = req.query.playerid;
    const sala = obtenerSala(salaId);
    const nombres = req.body;
    
    // Limpiamos los comandos viejos de esta sala
    sala.normalizedCommentConfig = {};
    
    // Guardamos los comandos nuevos recibidos desde Roblox
    for (const slot in nombres) {
      const nombreReal = nombres[slot];
      const normalizedKey = normalizeCommentRobust(nombreReal);
      if (normalizedKey) {
        sala.normalizedCommentConfig[normalizedKey] = slot;
      }
    }
    
    res.json({ success: true, message: `Comandos de chat actualizados para la sala ${salaId || 'default'}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 6. SOLICITUD DE EVENTOS (POLLING DE ROBLOX)
// ==========================================
app.get('/eventos', (req, res) => {
  try {
    const salaId = req.query.playerid;
    const sala = obtenerSala(salaId);

    const indiceInicial = buscarPrimerIndiceMayorQue(sala.eventQueue, sala.lastLegacyEventId);
    const eventosFiltrados = sala.eventQueue.slice(indiceInicial);
    
    sala.lastLegacyEventId = sala.globalEventId; 
    return res.json(eventosFiltrados);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(port, () => {
  console.log(`✅ Servidor MULTI-SALA activo en puerto ${port}`);
});
