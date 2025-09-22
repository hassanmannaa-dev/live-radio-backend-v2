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

app.use(express.json());
app.use(express.static('public'));

const downloadService = new DownloadService();
const tempFileManager = new TempFileManager(TMP_DIR);
const clockService = new ClockService();
const playbackCoordinator = new PlaybackCoordinator(downloadService, tempFileManager, clockService, io);

app.post('/request', async (req, res) => {
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

app.get('/current', (req, res) => {
  const state = playbackCoordinator.getCurrentState();
  res.json(state);
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: clockService.nowEpochMs() });
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  const currentState = playbackCoordinator.getCurrentState();
  socket.emit('nowPlaying', currentState);

  // If there's a song currently playing, send the start event to sync the new client
  if (currentState.phase === 'playing' && currentState.nowPlaying) {
    socket.emit('start', {
      id: currentState.nowPlaying.id,
      startEpochMs: currentState.nowPlaying.startEpochMs
    });
  }

  // If there's a song prepared (about to start), send the prepare event
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

  socket.on('request', async (data) => {
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

  socket.on('hello', (data) => {
    console.log('Client hello:', socket.id, 'version:', data?.clientVersion);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
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