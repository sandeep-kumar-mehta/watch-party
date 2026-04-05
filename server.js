const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// Serve everything inside /public folder (index.html lives there)
app.use(express.static(path.join(__dirname, 'public')));

// rooms object — stores state for every active room
// Structure: { [roomId]: { users, videoTime, isPlaying, videoUrl, videoName } }
const rooms = {};

io.on('connection', (socket) => {

  // ─── USER JOINS A ROOM ───────────────────────────────────────────
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);          // Socket.IO room join
    socket.userName = userName;   // store on socket for later use
    socket.roomId   = roomId;

    // Create room if it doesn't exist yet
    if (!rooms[roomId]) {
      rooms[roomId] = {
        users     : [],
        videoTime : 0,
        isPlaying : false,
        videoUrl  : '',
        videoName : '',
      };
    }

    // Add this user to room's user list
    rooms[roomId].users.push({ id: socket.id, name: userName });

    // Send current room state to the newly joined user
    socket.emit('join-confirmed', {
      users     : rooms[roomId].users,
      videoUrl  : rooms[roomId].videoUrl,
      videoName : rooms[roomId].videoName,
    });

    // Tell everyone else someone joined
    socket.to(roomId).emit('user-joined', {
      userName,
      users : rooms[roomId].users,
    });
  });

  // ─── VIDEO SET (new video URL shared to room) ─────────────────────
  socket.on('set-video', ({ roomId, videoUrl, videoName }) => {
    if (rooms[roomId]) {
      rooms[roomId].videoUrl  = videoUrl;
      rooms[roomId].videoName = videoName;
      rooms[roomId].videoTime = 0;        // reset position on new video
      rooms[roomId].isPlaying = false;
    }
    // Tell everyone else (not the sender) about new video
    socket.to(roomId).emit('video-changed', {
      videoUrl,
      videoName,
      userName : socket.userName,
    });
  });

  // ─── CHAT MESSAGE ────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message, userName }) => {
    // io.to sends to ALL users in room including sender
    io.to(roomId).emit('chat-message', {
      userName,
      message,
      time : new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }),
    });
  });

  // ─── REACTION ────────────────────────────────────────────────────
  socket.on('reaction', ({ roomId, emoji, userName }) => {
    io.to(roomId).emit('reaction', { emoji, userName });
  });

  // ─── VIDEO PLAY ──────────────────────────────────────────────────
  socket.on('video-play', ({ roomId, currentTime }) => {
    if (rooms[roomId]) {
      rooms[roomId].isPlaying = true;
      rooms[roomId].videoTime = currentTime;
    }
    // Tell others to play at this timestamp
    socket.to(roomId).emit('video-play', {
      currentTime,
      userName : socket.userName,
    });
  });

  // ─── VIDEO PAUSE ─────────────────────────────────────────────────
  socket.on('video-pause', ({ roomId, currentTime }) => {
    if (rooms[roomId]) {
      rooms[roomId].isPlaying = false;
      rooms[roomId].videoTime = currentTime;
    }
    socket.to(roomId).emit('video-pause', {
      currentTime,
      userName : socket.userName,
    });
  });

  // ─── VIDEO SEEK ──────────────────────────────────────────────────
  // Also used by auto-sync heartbeat (every 5s from client)
  // so videoTime stays fresh for late joiners
  socket.on('video-seek', ({ roomId, currentTime }) => {
    if (rooms[roomId]) rooms[roomId].videoTime = currentTime;
    socket.to(roomId).emit('video-seek', {
      currentTime,
      userName : socket.userName,
    });
  });

  // ─── SYNC REQUEST (user clicked Sync button) ──────────────────────
  socket.on('request-sync', ({ roomId }) => {
    if (rooms[roomId]) {
      socket.emit('sync-state', {
        time      : rooms[roomId].videoTime,
        isPlaying : rooms[roomId].isPlaying,
      });
    }
  });

  // ─── DISCONNECT ──────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      // Remove user from room list
      rooms[roomId].users = rooms[roomId].users.filter(u => u.id !== socket.id);

      // Tell remaining users
      io.to(roomId).emit('user-left', {
        userName : socket.userName,
        users    : rooms[roomId].users,
      });

      // Clean up empty rooms to free memory
      if (rooms[roomId].users.length === 0) delete rooms[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('✅ Server running on http://localhost:' + PORT));
