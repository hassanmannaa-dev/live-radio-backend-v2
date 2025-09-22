const fs = require('fs').promises;
const path = require('path');

class TempFileManager {
  constructor(tmpDir) {
    this.tmpDir = tmpDir;
    this.fileMap = new Map(); // id -> filepath
    this.sweepInterval = null;

    this.startSweeper();
  }

  registerFile(id, filepath) {
    this.fileMap.set(id, filepath);
    console.log('File registered:', id, filepath);
  }

  async getFilePath(id) {
    return this.fileMap.get(id) || null;
  }

  async deleteFile(id) {
    const filepath = this.fileMap.get(id);
    if (!filepath) {
      console.log('File not found in registry for deletion:', id);
      return;
    }

    try {
      await this.safeUnlink(filepath);
      this.fileMap.delete(id);
      console.log('File deleted successfully:', id, filepath);
    } catch (error) {
      console.log('Failed to delete file:', error.message, 'id:', id, 'filepath:', filepath);
      throw error;
    }
  }

  async safeUnlink(filepath) {
    try {
      await fs.unlink(filepath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('File already deleted:', filepath);
        return;
      }

      console.log('Immediate deletion failed, scheduling delayed deletion:', filepath, error.message);

      setTimeout(async () => {
        try {
          await fs.unlink(filepath);
          console.log('Delayed deletion successful:', filepath);
        } catch (delayedError) {
          console.log('Delayed deletion also failed:', filepath, delayedError.message);
        }
      }, 5000);

      throw error;
    }
  }

  startSweeper() {
    const sweepIntervalMs = 60 * 60 * 1000; // 1 hour
    const maxAgeMs = 2 * 60 * 60 * 1000; // 2 hours

    this.sweepInterval = setInterval(async () => {
      try {
        await this.sweepOrphans(maxAgeMs);
      } catch (error) {
        console.log('Error during sweep:', error.message);
      }
    }, sweepIntervalMs);

    console.log('File sweeper started, interval:', sweepIntervalMs, 'maxAge:', maxAgeMs);
  }

  async sweepOrphans(maxAgeMs) {
    try {
      const files = await fs.readdir(this.tmpDir);
      const now = Date.now();
      let deletedCount = 0;

      for (const file of files) {
        const filepath = path.join(this.tmpDir, file);

        try {
          const stats = await fs.stat(filepath);
          const age = now - stats.mtimeMs;

          if (age > maxAgeMs) {
            await fs.unlink(filepath);
            deletedCount++;
            console.log('Orphan file deleted:', filepath, 'ageHours:', age / (60 * 60 * 1000));
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.log('Error processing file during sweep:', filepath, error.message);
          }
        }
      }

      if (deletedCount > 0) {
        console.log('Sweep completed, deleted:', deletedCount);
      }
    } catch (error) {
      console.log('Error reading tmp directory during sweep:', error.message);
    }
  }

  async cleanup() {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
    }

    for (const [id, filepath] of this.fileMap.entries()) {
      try {
        await this.safeUnlink(filepath);
        console.log('Cleanup: file deleted:', id, filepath);
      } catch (error) {
        console.log('Cleanup: failed to delete file:', error.message, 'id:', id, 'filepath:', filepath);
      }
    }

    this.fileMap.clear();
    console.log('TempFileManager cleanup completed');
  }
}

module.exports = TempFileManager;