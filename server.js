const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Room state store karo
const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User room join kare
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.userName = userName;
    socket.roomId = roomId;

    // Room initialize karo agar nahi hai
    if (!rooms[roomId]) {
      rooms[roomId] = { users: [], videoTime: 0, isPlaying: false };
    }
    rooms[roomId].users.push({ id: socket.id, name: userName });

    // Sab ko batao naya user aaya
    io.to(roomId).emit('user-joined', {
      userName,
      users: rooms[roomId].users,
      videoState: { time: rooms[roomId].videoTime, isPlaying: rooms[roomId].isPlaying }
    });

    console.log(`${userName} joined room ${roomId}`);
  });

  // Chat message receive karo aur sab ko bhejo
  socket.on('chat-message', ({ roomId, message, userName }) => {
    io.to(roomId).emit('chat-message', {
      userName,
      message,
      time: new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // Reaction receive karo
  socket.on('reaction', ({ roomId, emoji, userName }) => {
    io.to(roomId).emit('reaction', { emoji, userName });
  });

  // Video play event
  socket.on('video-play', ({ roomId, currentTime }) => {
    if (rooms[roomId]) {
      rooms[roomId].isPlaying = true;
      rooms[roomId].videoTime = currentTime;
    }
    // Sirf dusron ko bhejo (sender ko nahi)
    socket.to(roomId).emit('video-play', { currentTime, userName: socket.userName });
  });

  // Video pause event
  socket.on('video-pause', ({ roomId, currentTime }) => {
    if (rooms[roomId]) {
      rooms[roomId].isPlaying = false;
      rooms[roomId].videoTime = currentTime;
    }
    socket.to(roomId).emit('video-pause', { currentTime, userName: socket.userName });
  });

  // Video seek event
  socket.on('video-seek', ({ roomId, currentTime }) => {
    if (rooms[roomId]) rooms[roomId].videoTime = currentTime;
    socket.to(roomId).emit('video-seek', { currentTime, userName: socket.userName });
  });

  // Sync request
  socket.on('request-sync', ({ roomId }) => {
    if (rooms[roomId]) {
      socket.emit('sync-state', {
        time: rooms[roomId].videoTime,
        isPlaying: rooms[roomId].isPlaying
      });
    }
  });

  // User disconnect
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].users = rooms[roomId].users.filter(u => u.id !== socket.id);
      io.to(roomId).emit('user-left', {
        userName: socket.userName,
        users: rooms[roomId].users
      });
      // Room empty ho toh delete karo
      if (rooms[roomId].users.length === 0) delete rooms[roomId];
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Watch Party server chal raha hai port ${PORT} pe`);
});
