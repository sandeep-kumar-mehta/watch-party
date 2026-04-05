const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MONGODB SETUP ────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME   = 'watchparty';
let db, roomsCol, messagesCol, eventsCol;

async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db           = client.db(DB_NAME);
    roomsCol     = db.collection('rooms');
    messagesCol  = db.collection('messages');
    eventsCol    = db.collection('events');
    await roomsCol.createIndex({ roomId: 1 }, { unique: true });
    await roomsCol.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 * 7 }); // 7 day TTL
    await messagesCol.createIndex({ roomId: 1, createdAt: 1 });
    await messagesCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 * 7 });
    console.log('✅ MongoDB connected');
    return true;
  } catch (e) {
    console.warn('⚠️  MongoDB not available — running in memory mode:', e.message);
    return false;
  }
}

// ─── IN-MEMORY FALLBACK ───────────────────────────────────────────────────────
const memRooms    = {};   // roomId → room doc
const memMessages = {};   // roomId → [msg, ...]

// ─── DB HELPERS (work with memory if mongo not connected) ──────────────────────
async function getRoom(roomId) {
  if (db) return roomsCol.findOne({ roomId });
  return memRooms[roomId] || null;
}

async function upsertRoom(roomId, update) {
  const now = new Date();
  if (db) {
    await roomsCol.updateOne(
      { roomId },
      { $set: { ...update, roomId, updatedAt: now },
        $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    return roomsCol.findOne({ roomId });
  }
  memRooms[roomId] = { ...memRooms[roomId], ...update, roomId, updatedAt: now,
    createdAt: memRooms[roomId]?.createdAt || now };
  return memRooms[roomId];
}

async function saveMessage(roomId, msg) {
  if (db) {
    await messagesCol.insertOne({ ...msg, roomId, createdAt: new Date() });
    return;
  }
  if (!memMessages[roomId]) memMessages[roomId] = [];
  memMessages[roomId].push({ ...msg, roomId, createdAt: new Date() });
  if (memMessages[roomId].length > 200) memMessages[roomId].shift(); // cap at 200
}

async function getRecentMessages(roomId, limit = 50) {
  if (db) {
    return messagesCol.find({ roomId }).sort({ createdAt: -1 }).limit(limit).toArray().then(a => a.reverse());
  }
  const msgs = memMessages[roomId] || [];
  return msgs.slice(-limit);
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
// In-memory socket tracking (needed even with mongo since it's ephemeral per-session)
const liveRooms = {};   // roomId → { users: [{id,name,joinedAt,watchTime}], videoTime, isPlaying, videoUrl, videoName, creatorId }

io.on('connection', (socket) => {

  // ── JOIN ROOM ──────────────────────────────────────────────────────────────
  socket.on('join-room', async ({ roomId, userName }) => {
    socket.join(roomId);
    socket.userName  = userName;
    socket.roomId    = roomId;
    socket.joinedAt  = Date.now();

    // Init live room state
    if (!liveRooms[roomId]) {
      // Try to restore from DB
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

    const room = liveRooms[roomId];
    const isCreator = room.users.length === 0 || room.creatorId === socket.id;

    room.users.push({
      id       : socket.id,
      name     : userName,
      joinedAt : Date.now(),
      watchTime: 0,
      isCreator: isCreator && room.users.length === 0,
    });

    if (room.users.length === 1) {
      room.creatorId = socket.id;
      // Persist to DB
      await upsertRoom(roomId, {
        videoUrl  : room.videoUrl,
        videoName : room.videoName,
        videoTime : room.videoTime,
        creatorId : socket.id,
      });
    }

    // Get recent messages for history
    const history = await getRecentMessages(roomId, 50);

    socket.emit('join-confirmed', {
      users      : room.users,
      videoUrl   : room.videoUrl,
      videoName  : room.videoName,
      videoTime  : room.videoTime,
      isPlaying  : room.isPlaying,
      isCreator  : room.creatorId === socket.id,
      history,
    });

    socket.to(roomId).emit('user-joined', {
      userName,
      users : room.users,
    });

    // Log event
    await saveMessage(roomId, {
      type    : 'system',
      text    : userName + ' joined the room',
      userName: userName,
    });
  });

  // ── SET VIDEO (only creator / room owner can do this) ─────────────────────
  socket.on('set-video', async ({ roomId, videoUrl, videoName }) => {
    const room = liveRooms[roomId];
    if (!room) return;
    room.videoUrl  = videoUrl;
    room.videoName = videoName;
    room.videoTime = 0;
    room.isPlaying = false;
    // Persist
    await upsertRoom(roomId, { videoUrl, videoName, videoTime: 0 });
    socket.to(roomId).emit('video-changed', { videoUrl, videoName, userName: socket.userName });
  });

  // ── CHAT MESSAGE ───────────────────────────────────────────────────────────
  socket.on('chat-message', async ({ roomId, message, userName }) => {
    const time = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    const msg  = { type: 'chat', userName, message, time };
    await saveMessage(roomId, msg);
    io.to(roomId).emit('chat-message', msg);
  });

  // ── REACTION ───────────────────────────────────────────────────────────────
  socket.on('reaction', ({ roomId, emoji, userName }) => {
    io.to(roomId).emit('reaction', { emoji, userName });
  });

  // ── VIDEO PLAY ─────────────────────────────────────────────────────────────
  socket.on('video-play', ({ roomId, currentTime }) => {
    const room = liveRooms[roomId];
    if (room) { room.isPlaying = true; room.videoTime = currentTime; }
    socket.to(roomId).emit('video-play', { currentTime, userName: socket.userName });
  });

  // ── VIDEO PAUSE ────────────────────────────────────────────────────────────
  socket.on('video-pause', ({ roomId, currentTime }) => {
    const room = liveRooms[roomId];
    if (room) { room.isPlaying = false; room.videoTime = currentTime; }
    socket.to(roomId).emit('video-pause', { currentTime, userName: socket.userName });
  });

  // ── VIDEO SEEK ─────────────────────────────────────────────────────────────
  socket.on('video-seek', ({ roomId, currentTime }) => {
    const room = liveRooms[roomId];
    if (room) room.videoTime = currentTime;
    socket.to(roomId).emit('video-seek', { currentTime, userName: socket.userName });
  });

  // ── HEARTBEAT — keeps videoTime + watchTime fresh ──────────────────────────
  socket.on('heartbeat', ({ roomId, currentTime, watchTimeDelta }) => {
    const room = liveRooms[roomId];
    if (!room) return;
    if (currentTime !== undefined) room.videoTime = currentTime;
    // Update this user's watch time
    const user = room.users.find(u => u.id === socket.id);
    if (user && watchTimeDelta) user.watchTime = (user.watchTime || 0) + watchTimeDelta;
    // Broadcast updated user list so everyone sees current watch times
    io.to(roomId).emit('users-update', { users: room.users });
  });

  // ── SYNC REQUEST ───────────────────────────────────────────────────────────
  socket.on('request-sync', ({ roomId }) => {
    const room = liveRooms[roomId];
    if (room) socket.emit('sync-state', { time: room.videoTime, isPlaying: room.isPlaying });
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const roomId = socket.roomId;
    if (!roomId || !liveRooms[roomId]) return;
    const room = liveRooms[roomId];
    room.users = room.users.filter(u => u.id !== socket.id);

    // Persist current videoTime before possibly deleting
    if (room.videoUrl) {
      await upsertRoom(roomId, { videoTime: room.videoTime, videoUrl: room.videoUrl, videoName: room.videoName });
    }

    io.to(roomId).emit('user-left', { userName: socket.userName, users: room.users });

    await saveMessage(roomId, {
      type    : 'system',
      text    : socket.userName + ' left the room',
      userName: socket.userName,
    });

    if (room.users.length === 0) {
      delete liveRooms[roomId]; // free memory; DB has state
    }
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────
// Get room info (used by client to check if room exists before joining)
app.get('/api/room/:roomId', async (req, res) => {
  const live = liveRooms[req.params.roomId];
  if (live) return res.json({ exists: true, hasVideo: !!live.videoUrl, onlineCount: live.users.length });
  const saved = await getRoom(req.params.roomId);
  if (saved) return res.json({ exists: true, hasVideo: !!saved.videoUrl, onlineCount: 0 });
  res.json({ exists: false });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await connectDB();
  console.log('✅ Server running on http://localhost:' + PORT);
});
