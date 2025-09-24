class PlaybackCoordinator {
  constructor(downloadService, tempFileManager, clockService, io) {
    this.downloadService = downloadService;
    this.tempFileManager = tempFileManager;
    this.clockService = clockService;
    this.io = io;

    this.currentTrack = null;
    this.queue = [];
    this.phase = 'idle'; // 'idle' | 'downloading' | 'prepared' | 'playing'
    this.maxQueueLength = parseInt(process.env.MAX_QUEUE_LENGTH) || 20;
    this.startLeadMs = parseInt(process.env.START_LEAD_MS) || 5000;
    this.publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

    this.playbackTimer = null;
    this.endTimer = null;
  }

  async addToQueue(videoId) {
    if (this.queue.length >= this.maxQueueLength) {
      throw new Error('Queue is full');
    }

    const isDuplicate = this.queue.some(item => item.videoId === videoId) ||
                       (this.currentTrack && this.currentTrack.videoId === videoId);

    if (isDuplicate) {
      console.log('Duplicate video ID, ignoring:', videoId);
      return { accepted: false, reason: 'Duplicate video in queue' };
    }

    const queueItem = {
      id: require('uuid').v4(),
      videoId,
      addedAt: this.clockService.nowEpochMs()
    };

    if (this.phase === 'idle') {
      console.log('Starting immediate download:', videoId);
      this.currentTrack = queueItem;
      this.startDownload(queueItem);
      return { accepted: true, position: 0, id: queueItem.id };
    } else {
      this.queue.push(queueItem);
      this.broadcastQueueUpdate();
      console.log('Added to queue, starting background download:', videoId, 'position:', this.queue.length);

      // Start downloading immediately in the background
      this.startBackgroundDownload(queueItem);

      return { accepted: true, position: this.queue.length, id: queueItem.id };
    }
  }

  async startDownload(queueItem) {
    this.phase = 'downloading';
    this.io.emit('downloading', {
      id: queueItem.id,
      videoId: queueItem.videoId
    });

    try {
      // Create progress callback to emit real-time progress updates
      const progressCallback = (progressData) => {
        this.io.emit('downloadProgress', {
          id: queueItem.id,
          videoId: queueItem.videoId,
          ...progressData
        });
      };

      const downloadResult = await this.downloadService.download(queueItem.videoId, progressCallback);
      await this.onDownloadComplete(queueItem, downloadResult);
    } catch (error) {
      console.log('Download failed:', error.message, 'videoId:', queueItem.videoId);
      this.io.emit('error', {
        message: `Download failed: ${error.message}`,
        id: queueItem.id
      });
      await this.processNextInQueue();
    }
  }

  async startBackgroundDownload(queueItem) {
    console.log('Starting background download:', queueItem.videoId);

    // Emit downloading status for this specific queue item
    this.io.emit('downloading', {
      id: queueItem.id,
      videoId: queueItem.videoId
    });

    try {
      // Create progress callback to emit real-time progress updates
      const progressCallback = (progressData) => {
        this.io.emit('downloadProgress', {
          id: queueItem.id,
          videoId: queueItem.videoId,
          ...progressData
        });
      };

      const downloadResult = await this.downloadService.download(queueItem.videoId, progressCallback);

      // Store the download result in the queue item
      const queueIndex = this.queue.findIndex(item => item.id === queueItem.id);
      if (queueIndex !== -1) {
        this.queue[queueIndex] = {
          ...this.queue[queueIndex],
          ...downloadResult,
          downloaded: true
        };

        // Register the file with temp file manager
        this.tempFileManager.registerFile(downloadResult.id, downloadResult.filepath);

        console.log('Background download completed:', queueItem.videoId, downloadResult.title);

        // Emit that this queue item has finished downloading
        this.io.emit('queueItemDownloaded', {
          id: queueItem.id,
          videoId: queueItem.videoId,
          title: downloadResult.title
        });

        // Update the queue to reflect the new title
        this.broadcastQueueUpdate();
      }
    } catch (error) {
      console.log('Background download failed:', error.message, 'videoId:', queueItem.videoId);

      // Find the queue item and mark it as failed
      const queueIndex = this.queue.findIndex(item => item.id === queueItem.id);
      if (queueIndex !== -1) {
        this.queue[queueIndex].downloadFailed = true;
        this.queue[queueIndex].error = error.message;
      }

      this.io.emit('error', {
        message: `Background download failed: ${error.message}`,
        id: queueItem.id
      });
    }
  }

  async onDownloadComplete(queueItem, downloadResult) {
    console.log('Download completed, preparing playback:', downloadResult);

    this.tempFileManager.registerFile(downloadResult.id, downloadResult.filepath);

    const startEpochMs = this.clockService.nowEpochMs() + this.startLeadMs;
    const fileUrl = `${this.publicBaseUrl}/audio/${downloadResult.id}`;

    this.currentTrack = {
      ...queueItem,
      ...downloadResult,
      startEpochMs,
      fileUrl
    };

    this.phase = 'prepared';

    this.io.emit('prepare', {
      id: downloadResult.id,
      title: downloadResult.title,
      videoId: queueItem.videoId,
      fileUrl,
      durationSec: downloadResult.durationSec,
      startEpochMs
    });

    this.schedulePlayback(startEpochMs, downloadResult.durationSec);
  }

  schedulePlayback(startEpochMs, durationSec) {
    const delayMs = startEpochMs - this.clockService.nowEpochMs();

    this.playbackTimer = setTimeout(() => {
      this.phase = 'playing';
      this.io.emit('start', {
        id: this.currentTrack.id,
        startEpochMs
      });

      console.log('Playback started:', this.currentTrack.id, this.currentTrack.title, 'start:', startEpochMs, 'duration:', durationSec);

      this.scheduleEnd(durationSec * 1000);
    }, Math.max(0, delayMs));
  }

  scheduleEnd(durationMs) {
    this.endTimer = setTimeout(async () => {
      const trackId = this.currentTrack.id;
      const filepath = this.currentTrack.filepath;

      console.log('Playback ended:', trackId);

      this.io.emit('ended', { id: trackId });

      try {
        await this.tempFileManager.deleteFile(trackId);
        console.log('File deleted successfully:', trackId, filepath);
      } catch (error) {
        console.log('Failed to delete file:', error.message, 'id:', trackId);
      }

      this.currentTrack = null;
      await this.processNextInQueue();
    }, durationMs);
  }

  async processNextInQueue() {
    if (this.queue.length === 0) {
      this.phase = 'idle';
      this.broadcastQueueUpdate();
      console.log('Queue empty, returning to idle');
      return;
    }

    const nextItem = this.queue.shift();
    this.currentTrack = nextItem;
    this.broadcastQueueUpdate();

    // Check if the item has already been downloaded
    if (nextItem.downloaded && nextItem.filepath) {
      console.log('Using pre-downloaded file for:', nextItem.videoId, nextItem.title);

      // Create a download result object from the already downloaded item
      const downloadResult = {
        id: nextItem.id,
        title: nextItem.title,
        durationSec: nextItem.durationSec,
        filepath: nextItem.filepath
      };

      await this.onDownloadComplete(nextItem, downloadResult);
    } else if (nextItem.downloadFailed) {
      console.log('Skipping failed download:', nextItem.videoId, nextItem.error);

      this.io.emit('error', {
        message: `Skipping failed song: ${nextItem.error}`,
        id: nextItem.id
      });

      // Move to next item
      await this.processNextInQueue();
    } else {
      // Item hasn't been downloaded yet, start download normally
      await this.startDownload(nextItem);
    }
  }

  broadcastQueueUpdate() {
    this.io.emit('queueUpdated', {
      queue: this.queue.map(item => ({
        id: item.id,
        videoId: item.videoId,
        title: item.title || null,
        downloaded: item.downloaded || false,
        downloadFailed: item.downloadFailed || false
      }))
    });
  }

  getCurrentState() {
    const state = {
      phase: this.phase,
      queue: this.queue.map(item => ({
        id: item.id,
        videoId: item.videoId,
        title: item.title || null,
        downloaded: item.downloaded || false,
        downloadFailed: item.downloadFailed || false
      }))
    };

    if (this.currentTrack) {
      state.nowPlaying = {
        id: this.currentTrack.id,
        title: this.currentTrack.title || null,
        videoId: this.currentTrack.videoId,
        fileUrl: this.currentTrack.fileUrl || null,
        durationSec: this.currentTrack.durationSec || null,
        startEpochMs: this.currentTrack.startEpochMs || null
      };
    }

    return state;
  }

  async cancelSong(songId) {
    if (!songId) {
      throw new Error('Song ID is required');
    }

    // Check if canceling currently playing song
    if (this.currentTrack && this.currentTrack.id === songId) {
      console.log('Canceling currently playing song:', songId);

      // Clear any active timers
      if (this.playbackTimer) {
        clearTimeout(this.playbackTimer);
        this.playbackTimer = null;
      }

      if (this.endTimer) {
        clearTimeout(this.endTimer);
        this.endTimer = null;
      }

      // Clean up the current track file
      if (this.currentTrack.filepath) {
        try {
          await this.tempFileManager.deleteFile(this.currentTrack.id);
          console.log('Canceled song file deleted:', this.currentTrack.id);
        } catch (error) {
          console.log('Failed to delete canceled song file:', error.message);
        }
      }

      // Notify clients that the song was canceled
      this.io.emit('songCanceled', {
        id: this.currentTrack.id,
        title: this.currentTrack.title || 'Unknown'
      });

      this.currentTrack = null;

      // Process next song in queue
      await this.processNextInQueue();

      return { success: true, message: 'Currently playing song canceled' };
    }

    // Check if canceling a song in queue
    const queueIndex = this.queue.findIndex(item => item.id === songId);
    if (queueIndex !== -1) {
      const canceledSong = this.queue[queueIndex];
      this.queue.splice(queueIndex, 1);

      console.log('Removed song from queue:', songId);

      // If the song was already downloaded, clean up the file
      if (canceledSong.downloaded && canceledSong.filepath) {
        try {
          await this.tempFileManager.deleteFile(canceledSong.id);
          console.log('Canceled pre-downloaded song file deleted:', canceledSong.id);
        } catch (error) {
          console.log('Failed to delete canceled pre-downloaded song file:', error.message);
        }
      }

      // Update queue for all clients
      this.broadcastQueueUpdate();

      // Notify clients that the song was canceled
      this.io.emit('songCanceled', {
        id: canceledSong.id,
        title: canceledSong.title || 'Unknown'
      });

      return { success: true, message: 'Song removed from queue' };
    }

    throw new Error('Song not found in current track or queue');
  }

  async shutdown() {
    console.log('Shutting down PlaybackCoordinator');

    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
    }

    if (this.endTimer) {
      clearTimeout(this.endTimer);
    }

    if (this.currentTrack && this.currentTrack.filepath) {
      try {
        await this.tempFileManager.deleteFile(this.currentTrack.id);
      } catch (error) {
        console.log('Error during shutdown cleanup:', error.message);
      }
    }
  }
}

module.exports = PlaybackCoordinator;