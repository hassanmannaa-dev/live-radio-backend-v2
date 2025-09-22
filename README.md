# Live Radio Sync

A synchronized YouTube Music streaming application that allows multiple clients to play the same audio in perfect sync.

## Features

- **Synchronized Playback**: All connected clients play audio simultaneously with server-controlled timing
- **Queue System**: FIFO queue for multiple song requests
- **Real-time Sync**: Sub-second synchronization between clients using WebSocket timesync
- **Late Join Support**: Clients joining mid-song automatically seek to the correct position
- **Automatic Cleanup**: Temporary files are automatically deleted after playback

## Prerequisites

- Node.js (v14 or higher)
- `yt-dlp` installed and available in PATH
- `ffmpeg` and `ffprobe` installed and available in PATH

### Installing Dependencies

```bash
# Install yt-dlp
pip install yt-dlp

# Install ffmpeg (macOS)
brew install ffmpeg

# Install ffmpeg (Ubuntu/Debian)
sudo apt update && sudo apt install ffmpeg
```

## Setup

1. Clone or download this project
2. Install Node.js dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables (optional):
   ```bash
   cp .env.example .env
   # Edit .env with your preferred settings
   ```

4. Start the server:
   ```bash
   npm start
   ```

5. Open your browser to `http://localhost:3000`

## Usage

1. **Get a YouTube Music Video ID**:
   - Go to YouTube Music (music.youtube.com)
   - Play any song
   - Copy the 11-character video ID from the URL
   - Example: From `https://music.youtube.com/watch?v=dQw4w9WgXcQ`, use `dQw4w9WgXcQ`

2. **Add to Queue**:
   - Paste the video ID into the input field
   - Click "Add to Queue" or press Enter

3. **Synchronized Playback**:
   - The first request starts downloading immediately
   - All connected clients will receive a "prepare" event with a synchronized start time
   - Playback begins simultaneously across all clients
   - Late joiners automatically seek to the correct position

4. **Queue Management**:
   - Additional requests are added to the queue
   - Songs play in FIFO order
   - Queue is displayed in real-time

## API Endpoints

### HTTP API

- `POST /request` - Add a video to the queue
  ```json
  {
    "videoId": "dQw4w9WgXcQ"
  }
  ```

- `GET /current` - Get current playback state
- `GET /audio/:id` - Stream audio file (with range support)
- `GET /health` - Health check

### WebSocket Events

**Server → Client:**
- `downloading` - Download started
- `prepare` - Audio ready, includes sync timing
- `start` - Playback started
- `ended` - Playback finished
- `queueUpdated` - Queue changed
- `timesync` - Clock synchronization (every 5s)
- `nowPlaying` - Current state (sent on connect)
- `error` - Error occurred

**Client → Server:**
- `request` - Add video to queue
- `hello` - Client identification

## Configuration

Environment variables in `.env`:

```bash
PORT=3000                    # Server port
TMP_DIR=./tmp               # Temporary file directory
PUBLIC_BASE_URL=http://localhost:3000  # Base URL for audio files
START_LEAD_MS=5000          # Lead time before synchronized start
MAX_QUEUE_LENGTH=20         # Maximum queue size
YT_DLP_PATH=yt-dlp          # Path to yt-dlp binary
FFMPEG_PATH=ffmpeg          # Path to ffmpeg binary
FFPROBE_PATH=ffprobe        # Path to ffprobe binary
```

## Testing Synchronization

1. Open multiple browser tabs/windows to `http://localhost:3000`
2. Add a video ID in one tab
3. Watch all tabs download, prepare, and start playback simultaneously
4. Try reloading one tab during playback - it should resume at the correct position

## Troubleshooting

**"yt-dlp not found"**: Ensure yt-dlp is installed and in your PATH
**"ffmpeg not found"**: Install ffmpeg and ensure it's in your PATH
**Download fails**: Check video ID format and ensure the video is accessible
**Sync issues**: Check your network connection; large latency may affect synchronization

## Legal Notice

⚠️ **Important**: Ensure you have the rights to download and stream the requested content. YouTube/YouTube Music Terms of Service may prohibit downloading. This application is intended for private use and testing only. Obtain proper licenses and permissions before any public or commercial use.

## Architecture

- **Backend**: Node.js with Express and Socket.IO
- **Frontend**: Vanilla JavaScript with WebSocket client
- **Download**: yt-dlp for audio extraction
- **Sync**: Server-coordinated timing with client-side clock adjustment
- **Storage**: Temporary local files with automatic cleanup