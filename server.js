require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const DownloadService = require('./services/DownloadService');
const PlaybackCoordinator = require('./services/PlaybackCoordinator');
const TempFileManager = require('./services/TempFileManager');
const ClockService = require('./services/ClockService');
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const TMP_DIR = process.env.TMP_DIR || './tmp';

const users = new Map();
const chatHistory = [];
const MAX_CHAT_HISTORY = 100;

app.use(express.json());
app.use(express.static('public'));

function generateUserId() {
  return 'user_' + Math.random().toString(36).substr(2, 9);
}

function isValidUsername(username) {
  return username && username.length >= 2 && username.length <= 20 && /^[a-zA-Z0-9_-]+$/.test(username);
}

function isValidAvatarId(avatarId) {
  return avatarId && /^[1-9][0-9]?$/.test(avatarId.toString()) && parseInt(avatarId) >= 1 && parseInt(avatarId) <= 50;
}

app.post('/register', (req, res) => {
  try {
    const { username, avatarId } = req.body;

    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: 'Invalid username. Must be 2-20 characters, alphanumeric, underscore, or dash only.'
      });
    }

    if (!isValidAvatarId(avatarId)) {
      return res.status(400).json({
        error: 'Invalid avatar ID. Must be a number between 1 and 50.'
      });
    }

    const existingUser = Array.from(users.values()).find(user => user.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const userId = generateUserId();
    const user = {
      id: userId,
      username: username.trim(),
      avatarId: parseInt(avatarId),
      joinedAt: new Date().toISOString(),
      isOnline: false
    };

    users.set(userId, user);

    res.json({
      success: true,
      userId: userId,
      user: {
        id: user.id,
        username: user.username,
        avatarId: user.avatarId
      }
    });

    console.log('User registered:', user.username, 'ID:', userId);
  } catch (error) {
    console.log('Error in registration:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/user/:userId', (req, res) => {
  const { userId } = req.params;
  const user = users.get(userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    id: user.id,
    username: user.username,
    avatarId: user.avatarId
  });
});

const downloadService = new DownloadService();
const tempFileManager = new TempFileManager(TMP_DIR);
const clockService = new ClockService();
const playbackCoordinator = new PlaybackCoordinator(downloadService, tempFileManager, clockService, io);

function authenticateUser(req, res, next) {
  const userId = req.headers['user-id'];
  if (!userId || !users.has(userId)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = users.get(userId);
  next();
}

app.post('/request', authenticateUser, async (req, res) => {
  try {
    const { videoId } = req.body;

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: 'Invalid videoId format' });
    }

    const result = await playbackCoordinator.addToQueue(videoId);
    res.json(result);
  } catch (error) {
    console.log('Error handling request:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/current', authenticateUser, (req, res) => {
  const state = playbackCoordinator.getCurrentState();
  res.json(state);
});

app.post('/cancel', authenticateUser, async (req, res) => {
  try {
    const { songId } = req.body;

    if (!songId) {
      return res.status(400).json({ error: 'Song ID is required' });
    }

    const result = await playbackCoordinator.cancelSong(songId);
    res.json(result);
  } catch (error) {
    console.log('Error canceling song:', error.message);
    if (error.message === 'Song not found in current track or queue') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/audio/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const filePath = await tempFileManager.getFilePath(id);

    if (!filePath) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const stat = await fs.stat(filePath);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;

      const readStream = require('fs').createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store'
      });

      readStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });

      require('fs').createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    console.log('Error serving audio file:', error.message, 'id:', req.params.id);
    res.status(500).json({ error: 'Error serving audio file' });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required' });
    }

    if (query.trim().length > 100) {
      return res.status(400).json({ error: 'Query too long (max 100 characters)' });
    }

    // Use the download service to search for videos
    const results = await downloadService.searchVideos(query.trim());
    res.json({ results });
  } catch (error) {
    console.log('Error handling search request:', error.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: clockService.nowEpochMs() });
});

function addChatMessage(userId, message) {
  const user = users.get(userId);
  if (!user) return null;

  const chatMessage = {
    id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    userId: user.id,
    username: user.username,
    avatarId: user.avatarId,
    message: message.trim(),
    timestamp: new Date().toISOString()
  };

  chatHistory.push(chatMessage);

  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory.shift();
  }

  return chatMessage;
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.userId = null;
  socket.authenticated = false;

  socket.on('authenticate', (data) => {
    const { userId } = data;

    if (!userId || !users.has(userId)) {
      socket.emit('authError', { message: 'Invalid user ID' });
      return;
    }

    const user = users.get(userId);
    socket.userId = userId;
    socket.authenticated = true;
    user.isOnline = true;
    user.socketId = socket.id;

    console.log('User authenticated:', user.username, 'Socket:', socket.id);

    socket.emit('authenticated', { user: { id: user.id, username: user.username, avatarId: user.avatarId } });

    socket.emit('chatHistory', { messages: chatHistory });

    const currentState = playbackCoordinator.getCurrentState();
    socket.emit('nowPlaying', currentState);

    if (currentState.phase === 'playing' && currentState.nowPlaying) {
      socket.emit('start', {
        id: currentState.nowPlaying.id,
        startEpochMs: currentState.nowPlaying.startEpochMs
      });
    }

    if (currentState.phase === 'prepared' && currentState.nowPlaying) {
      socket.emit('prepare', {
        id: currentState.nowPlaying.id,
        title: currentState.nowPlaying.title,
        videoId: currentState.nowPlaying.videoId,
        fileUrl: currentState.nowPlaying.fileUrl,
        durationSec: currentState.nowPlaying.durationSec,
        startEpochMs: currentState.nowPlaying.startEpochMs
      });
    }

    socket.broadcast.emit('userJoined', { username: user.username, avatarId: user.avatarId });
  });

  socket.on('request', async (data) => {
    if (!socket.authenticated) {
      socket.emit('error', { message: 'Authentication required' });
      return;
    }

    try {
      const { videoId } = data;

      if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        socket.emit('error', { message: 'Invalid videoId format' });
        return;
      }

      const result = await playbackCoordinator.addToQueue(videoId);
      socket.emit('requestResult', result);
    } catch (error) {
      console.log('Error handling socket request:', error.message, 'socketId:', socket.id);
      socket.emit('error', { message: 'Internal server error' });
    }
  });

  socket.on('cancelSong', async (data) => {
    if (!socket.authenticated) {
      socket.emit('error', { message: 'Authentication required' });
      return;
    }

    try {
      const { songId } = data;

      if (!songId) {
        socket.emit('error', { message: 'Song ID is required' });
        return;
      }

      const result = await playbackCoordinator.cancelSong(songId);
      socket.emit('cancelResult', result);
    } catch (error) {
      console.log('Error handling socket cancel request:', error.message, 'socketId:', socket.id);
      if (error.message === 'Song not found in current track or queue') {
        socket.emit('error', { message: error.message });
      } else {
        socket.emit('error', { message: 'Internal server error' });
      }
    }
  });

  socket.on('chatMessage', (data) => {
    if (!socket.authenticated) {
      socket.emit('error', { message: 'Authentication required' });
      return;
    }

    const { message } = data;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      socket.emit('error', { message: 'Invalid message' });
      return;
    }

    if (message.trim().length > 500) {
      socket.emit('error', { message: 'Message too long (max 500 characters)' });
      return;
    }

    const chatMessage = addChatMessage(socket.userId, message);
    if (chatMessage) {
      io.emit('newMessage', chatMessage);
      console.log('Chat message from', chatMessage.username + ':', chatMessage.message);
    }
  });

  socket.on('hello', (data) => {
    console.log('Client hello:', socket.id, 'version:', data?.clientVersion);
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      const user = users.get(socket.userId);
      if (user) {
        user.isOnline = false;
        user.socketId = null;
        socket.broadcast.emit('userLeft', { username: user.username, avatarId: user.avatarId });
        console.log('Authenticated user disconnected:', user.username, 'Socket:', socket.id);
      }
    } else {
      console.log('Unauthenticated client disconnected:', socket.id);
    }
  });
});

clockService.startTimesync(io);

const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');

  await playbackCoordinator.shutdown();
  await tempFileManager.cleanup();

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

server.listen(PORT, () => {
  console.log('Live Radio Sync server started on port:', PORT, 'tmpDir:', TMP_DIR);
});