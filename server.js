const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { MongoClient } = require('mongodb');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MONGODB SETUP ────────────────────────────────────────────────────────────
const DB_NAME = 'watchparty';
let db, roomsCol, messagesCol;

function buildMongoURI() {
  const raw = process.env.MONGO_URI || '';
  if (!raw) return '';
  try {
    // Parse + re-encode credentials to handle special characters
    const url = new URL(raw);
    if (url.username) url.username = encodeURIComponent(decodeURIComponent(url.username));
    if (url.password) url.password = encodeURIComponent(decodeURIComponent(url.password));
    if (!url.searchParams.has('retryWrites')) url.searchParams.set('retryWrites', 'true');
    if (!url.searchParams.has('w'))           url.searchParams.set('w', 'majority');
    return url.toString();
  } catch (_) {
    return raw;
  }
}

async function connectDB() {
  const MONGO_URI = buildMongoURI();

  if (!MONGO_URI) {
    console.log('ℹ️  No MONGO_URI — running in memory mode (data resets on restart)');
    return false;
  }

  const safeURI = MONGO_URI.replace(/:([^@]+)@/, ':****@');
  console.log('🔌 Connecting to MongoDB:', safeURI);

  try {
    // DO NOT pass tls:true manually — mongodb+srv handles TLS automatically
    // Passing it explicitly causes the SSL alert number 80 error on some Node versions
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS : 10000,
      connectTimeoutMS         : 15000,
      socketTimeoutMS          : 45000,
    });

    await client.connect();
    await client.db('admin').command({ ping: 1 });

    db          = client.db(DB_NAME);
    roomsCol    = db.collection('rooms');
    messagesCol = db.collection('messages');

    try {
      await roomsCol.createIndex({ roomId: 1 }, { unique: true });
      await roomsCol.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 * 7 });
      await messagesCol.createIndex({ roomId: 1, createdAt: 1 });
      await messagesCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 * 7 });
    } catch (_) {}

    console.log('✅ MongoDB Atlas connected!');
    client.on('error', e => console.warn('MongoDB error:', e.message));
    return true;

  } catch (e) {
    console.warn('⚠️  MongoDB failed — memory mode active.');
    console.warn('    Error:', e.message);
    console.warn('    IMPORTANT: In Atlas → Network Access → Add IP: 0.0.0.0/0');
    db = null; roomsCol = null; messagesCol = null;
    return false;
  }
}

// ─── IN-MEMORY FALLBACK ───────────────────────────────────────────────────────
const memRooms    = {};
const memMessages = {};

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function getRoom(roomId) {
  if (db) return roomsCol.findOne({ roomId });
  return memRooms[roomId] || null;
}

async function upsertRoom(roomId, update) {
  const now = new Date();
  if (db) {
    await roomsCol.updateOne(
      { roomId },
      { $set: { ...update, roomId, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    return roomsCol.findOne({ roomId });
  }
  memRooms[roomId] = { ...memRooms[roomId], ...update, roomId, updatedAt: now,
    createdAt: memRooms[roomId]?.createdAt || now };
  return memRooms[roomId];
}

async function saveMessage(roomId, msg) {
  if (db) { await messagesCol.insertOne({ ...msg, roomId, createdAt: new Date() }); return; }
  if (!memMessages[roomId]) memMessages[roomId] = [];
  memMessages[roomId].push({ ...msg, roomId, createdAt: new Date() });
  if (memMessages[roomId].length > 200) memMessages[roomId].shift();
}

async function getRecentMessages(roomId, limit = 50) {
  if (db) return messagesCol.find({ roomId }).sort({ createdAt: -1 }).limit(limit).toArray().then(a => a.reverse());
  return (memMessages[roomId] || []).slice(-limit);
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
const liveRooms = {};

io.on('connection', (socket) => {

  socket.on('join-room', async ({ roomId, userName }) => {
    socket.join(roomId);
    socket.userName = userName;
    socket.roomId   = roomId;
    socket.joinedAt = Date.now();

    if (!liveRooms[roomId]) {
      const saved = await getRoom(roomId);
      liveRooms[roomId] = {
        users      : [],
        videoTime  : saved?.videoTime  || 0,
        isPlaying  : false,
        videoUrl   : saved?.videoUrl   || '',
        videoName  : saved?.videoName  || '',
        creatorId  : saved?.creatorId  || socket.id,
      };
    }

    const room      = liveRooms[roomId];
    const isFirst   = room.users.length === 0;

    room.users.push({
      id        : socket.id,
      name      : userName,
      joinedAt  : Date.now(),
      watchTime : 0,
      isCreator : isFirst,
    });

    if (isFirst) {
      room.creatorId = socket.id;
      await upsertRoom(roomId, {
        videoUrl  : room.videoUrl,
        videoName : room.videoName,
        videoTime : room.videoTime,
        creatorId : socket.id,
      });
    }

    const history = await getRecentMessages(roomId, 50);

    socket.emit('join-confirmed', {
      users     : room.users,
      videoUrl  : room.videoUrl,
      videoName : room.videoName,
      videoTime : room.videoTime,
      isPlaying : room.isPlaying,
      isCreator : room.creatorId === socket.id,
      history,
    });

    socket.to(roomId).emit('user-joined', { userName, users: room.users });

    await saveMessage(roomId, { type: 'system', text: userName + ' joined', userName });
  });

  socket.on('set-video', async ({ roomId, videoUrl, videoName }) => {
    const room = liveRooms[roomId]; if (!room) return;
    room.videoUrl = videoUrl; room.videoName = videoName;
    room.videoTime = 0; room.isPlaying = false;
    await upsertRoom(roomId, { videoUrl, videoName, videoTime: 0 });
    socket.to(roomId).emit('video-changed', { videoUrl, videoName, userName: socket.userName });
  });

  socket.on('chat-message', async ({ roomId, message, userName }) => {
    const time = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    const msg  = { type: 'chat', userName, message, time };
    await saveMessage(roomId, msg);
    io.to(roomId).emit('chat-message', msg);
  });

  socket.on('typing', ({ roomId, userName }) => {
    socket.to(roomId).emit('typing', { userName });
  });

  socket.on('reaction', ({ roomId, emoji, userName }) => {
    io.to(roomId).emit('reaction', { emoji, userName });
  });

  socket.on('video-play', ({ roomId, currentTime }) => {
    const room = liveRooms[roomId];
    if (room) { room.isPlaying = true; room.videoTime = currentTime; }
    socket.to(roomId).emit('video-play', { currentTime, userName: socket.userName });
  });

  socket.on('video-pause', ({ roomId, currentTime }) => {
    const room = liveRooms[roomId];
    if (room) { room.isPlaying = false; room.videoTime = currentTime; }
    socket.to(roomId).emit('video-pause', { currentTime, userName: socket.userName });
  });

  socket.on('video-seek', ({ roomId, currentTime }) => {
    const room = liveRooms[roomId];
    if (room) room.videoTime = currentTime;
    socket.to(roomId).emit('video-seek', { currentTime, userName: socket.userName });
  });

  socket.on('heartbeat', ({ roomId, currentTime, watchTimeDelta }) => {
    const room = liveRooms[roomId]; if (!room) return;
    if (currentTime !== undefined) room.videoTime = currentTime;
    const user = room.users.find(u => u.id === socket.id);
    if (user && watchTimeDelta) user.watchTime = (user.watchTime || 0) + watchTimeDelta;
    io.to(roomId).emit('users-update', { users: room.users });
  });

  socket.on('request-sync', ({ roomId }) => {
    const room = liveRooms[roomId];
    if (room) socket.emit('sync-state', { time: room.videoTime, isPlaying: room.isPlaying });
  });

  socket.on('disconnect', async () => {
    const roomId = socket.roomId;
    if (!roomId || !liveRooms[roomId]) return;
    const room = liveRooms[roomId];
    room.users = room.users.filter(u => u.id !== socket.id);
    if (room.videoUrl) await upsertRoom(roomId, { videoTime: room.videoTime, videoUrl: room.videoUrl, videoName: room.videoName });
    io.to(roomId).emit('user-left', { userName: socket.userName, users: room.users });
    await saveMessage(roomId, { type: 'system', text: socket.userName + ' left', userName: socket.userName });
    if (room.users.length === 0) delete liveRooms[roomId];
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/room/:roomId', async (req, res) => {
  const live = liveRooms[req.params.roomId];
  if (live) return res.json({ exists: true, hasVideo: !!live.videoUrl, onlineCount: live.users.length });
  const saved = await getRoom(req.params.roomId);
  if (saved) return res.json({ exists: true, hasVideo: !!saved.videoUrl, onlineCount: 0 });
  res.json({ exists: false });
});

app.get('/health', (_, res) => res.json({ status: 'ok', db: !!db }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await connectDB();
  console.log('✅ Server running on http://localhost:' + PORT);
});
