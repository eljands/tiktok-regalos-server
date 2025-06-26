const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

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
  Player1: null,
  Player2: null,
  Player3: null,
  Player4: null,
  Player5: null,
  Player6: null,
  Player7: null,
  Player8: null,
  Player9: null,
};

// Guardar el último regalo recibido
let ultimoRegalo = null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook que recibe regalos
app.all('/webhook', (req, res) => {
  const userName = req.query.username || req.body.username || 'Desconocido';
  const giftName = req.query.giftName || req.body.giftName || 'Sin regalo';

  console.log('🎁 Recibido:', { userName, giftName });

  const jugador = asignaciones[giftName];
  if (jugador) {
    jugadores[jugador] = {
      nombre: userName,
      timestamp: Date.now()
    };
    ultimoRegalo = { userName, giftName }; // Guardamos el último regalo
    console.log(`✅ Asignado ${userName} a ${jugador}`);
  } else {
    console.log(`❌ Regalo no asignado: ${giftName}`);
  }

  res.sendStatus(200);
});

// Endpoint para que Roblox consulte nombres
app.get('/nombres', (req, res) => {
  res.json(jugadores);
});

// Endpoint para consultar la tabla de asignación
app.get('/asignaciones', (req, res) => {
  res.json(asignaciones);
});

// 🔥 NUEVO: Endpoint para consultar el último regalo
app.get('/ultimo', (req, res) => {
  if (ultimoRegalo) {
    res.json(ultimoRegalo);
  } else {
    res.json({ userName: "", giftName: "" });
  }
});

app.listen(port, () => {
  console.log(`✅ Servidor activo en http://localhost:${port}/webhook`);
});
