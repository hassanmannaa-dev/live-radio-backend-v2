class ClockService {
  constructor() {
    this.timesyncInterval = null;
  }

  nowEpochMs() {
    return Date.now();
  }

  startTimesync(io) {
    const interval = 5000; // 5 seconds

    this.timesyncInterval = setInterval(() => {
      io.emit('timesync', {
        serverEpochMs: this.nowEpochMs()
      });
    }, interval);
  }

  stopTimesync() {
    if (this.timesyncInterval) {
      clearInterval(this.timesyncInterval);
      this.timesyncInterval = null;
    }
  }
}

module.exports = ClockService;