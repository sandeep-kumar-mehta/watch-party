const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {

  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.userName = userName;
    socket.roomId = roomId;

    if (!rooms[roomId]) {
      rooms[roomId] = { users: [], videoTime: 0, isPlaying: false, videoUrl: '', videoName: '' };
    }
    rooms[roomId].users.push({ id: socket.id, name: userName });

    // Joiner ko room ka current state do (video URL bhi)
    socket.emit('join-confirmed', {
      users: rooms[roomId].users,
      videoUrl: rooms[roomId].videoUrl,
      videoName: rooms[roomId].videoName,
    });

    // Baaki sab ko batao
    socket.to(roomId).emit('user-joined', {
      userName,
      users: rooms[roomId].users,
    });
  });

  // Naya video set — URL server pe save karo, sab ko bhejo
  socket.on('set-video', ({ roomId, videoUrl, videoName }) => {
    if (rooms[roomId]) {
      rooms[roomId].videoUrl = videoUrl;
      rooms[roomId].videoName = videoName;
      rooms[roomId].videoTime = 0;
      rooms[roomId].isPlaying = false;
    }
    socket.to(roomId).emit('video-changed', {
      videoUrl, videoName, userName: socket.userName
    });
  });

  socket.on('chat-message', ({ roomId, message, userName }) => {
    io.to(roomId).emit('chat-message', {
      userName, message,
      time: new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('reaction', ({ roomId, emoji, userName }) => {
    io.to(roomId).emit('reaction', { emoji, userName });
  });

  socket.on('video-play', ({ roomId, currentTime }) => {
    if (rooms[roomId]) { rooms[roomId].isPlaying = true; rooms[roomId].videoTime = currentTime; }
    socket.to(roomId).emit('video-play', { currentTime, userName: socket.userName });
  });

  socket.on('video-pause', ({ roomId, currentTime }) => {
    if (rooms[roomId]) { rooms[roomId].isPlaying = false; rooms[roomId].videoTime = currentTime; }
    socket.to(roomId).emit('video-pause', { currentTime, userName: socket.userName });
  });

  socket.on('video-seek', ({ roomId, currentTime }) => {
    if (rooms[roomId]) rooms[roomId].videoTime = currentTime;
    socket.to(roomId).emit('video-seek', { currentTime, userName: socket.userName });
  });

  socket.on('request-sync', ({ roomId }) => {
    if (rooms[roomId]) {
      socket.emit('sync-state', {
        time: rooms[roomId].videoTime,
        isPlaying: rooms[roomId].isPlaying
      });
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].users = rooms[roomId].users.filter(u => u.id !== socket.id);
      io.to(roomId).emit('user-left', { userName: socket.userName, users: rooms[roomId].users });
      if (rooms[roomId].users.length === 0) delete rooms[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
