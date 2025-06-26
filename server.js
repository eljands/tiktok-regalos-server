const express = require('express');
const app = express();
const port = 3000;

// Tabla de asignación regalo → jugador
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

// Almacenamiento temporal de nombres por jugador
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

// Middleware
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
    console.log(`✅ Asignado ${userName} a ${jugador}`);
  } else {
    console.log(`❌ Regalo no asignado: ${giftName}`);
  }

  res.sendStatus(200);
});

// Endpoint para que Roblox consulte los nombres
app.get('/nombres', (req, res) => {
  res.json(jugadores);
});
// Ruta para devolver los datos actuales de asignación por regalo
app.get('/asignaciones', (req, res) => {
  res.json(asignaciones); // Esto lo agregamos en el servidor antes
});

app.listen(port, () => {
  console.log(`✅ Servidor activo en http://localhost:${port}/webhook`);
});
