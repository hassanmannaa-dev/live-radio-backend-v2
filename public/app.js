class LiveRadioClient {
    constructor() {
        this.socket = null;
        this.audio = document.getElementById('audioPlayer');
        this.clockOffset = 0;
        this.lastSync = 0;
        this.currentTrack = null;
        this.syncCheckInterval = null;
        this.audioEnabled = false;
        this.pendingPlay = null;
        this.user = null;
        this.userId = null;
        this.authenticated = false;

        this.checkAuthentication();
    }

    checkAuthentication() {
        const userId = localStorage.getItem('userId');
        const userData = localStorage.getItem('user');

        if (!userId || !userData) {
            window.location.href = '/register.html';
            return;
        }

        try {
            this.user = JSON.parse(userData);
            this.userId = userId;

            fetch(`/user/${userId}`)
                .then(response => {
                    if (!response.ok) {
                        throw new Error('User not found');
                    }
                    return response.json();
                })
                .then(userData => {
                    this.user = userData;
                    this.initializeSocket();
                    this.setupEventListeners();
                    this.setupAudioEnabling();
                    this.audio.addEventListener('loadeddata', () => this.onAudioLoaded());
                })
                .catch(error => {
                    console.error('Authentication check failed:', error);
                    localStorage.removeItem('userId');
                    localStorage.removeItem('user');
                    window.location.href = '/register.html';
                });
        } catch (error) {
            console.error('Invalid user data:', error);
            localStorage.removeItem('userId');
            localStorage.removeItem('user');
            window.location.href = '/register.html';
        }
    }

    initializeSocket() {
        this.socket = io();

        this.socket.on('connect', () => {
            this.updateConnectionStatus(true);
            this.socket.emit('authenticate', { userId: this.userId });
        });

        this.socket.on('authenticated', (data) => {
            this.authenticated = true;
            this.user = data.user;
            console.log('Authenticated as:', this.user.username);
            this.updateUserDisplay();
        });

        this.socket.on('authError', (data) => {
            console.error('Authentication failed:', data.message);
            localStorage.removeItem('userId');
            localStorage.removeItem('user');
            window.location.href = '/register.html';
        });

        this.socket.on('chatHistory', (data) => {
            this.loadChatHistory(data.messages);
        });

        this.socket.on('newMessage', (message) => {
            this.addChatMessage(message);
        });

        this.socket.on('userJoined', (data) => {
            this.showSystemMessage(`${data.username} joined the radio! 👋`);
        });

        this.socket.on('userLeft', (data) => {
            this.showSystemMessage(`${data.username} left the radio 👋`);
        });

        this.socket.on('disconnect', () => {
            this.updateConnectionStatus(false);
        });

        this.socket.on('nowPlaying', (data) => this.handleNowPlaying(data));
        this.socket.on('downloading', (data) => this.handleDownloading(data));
        this.socket.on('prepare', (data) => this.handlePrepare(data));
        this.socket.on('start', (data) => this.handleStart(data));
        this.socket.on('ended', (data) => this.handleEnded(data));
        this.socket.on('queueUpdated', (data) => this.handleQueueUpdate(data));
        this.socket.on('timesync', (data) => this.handleTimesync(data));
        this.socket.on('error', (data) => this.handleError(data));
        this.socket.on('requestResult', (data) => this.handleRequestResult(data));
        this.socket.on('cancelResult', (data) => this.handleCancelResult(data));
        this.socket.on('songCanceled', (data) => this.handleSongCanceled(data));
    }

    setupEventListeners() {
        document.getElementById('searchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.searchSong();
            }
        });

        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendChatMessage();
                }
            });
        }

        const sendButton = document.getElementById('sendButton');
        if (sendButton) {
            sendButton.addEventListener('click', () => this.sendChatMessage());
        }

        const logoutButton = document.getElementById('logoutButton');
        if (logoutButton) {
            logoutButton.addEventListener('click', () => this.logout());
        }
    }

    setupAudioEnabling() {
        // Add click listener to enable audio on any user interaction
        const enableAudio = async (event) => {
            if (this.audioEnabled) return;

            try {
                console.log('Attempting to enable audio via user interaction');

                // Create and play a silent audio context
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const buffer = audioContext.createBuffer(1, 1, 22050);
                const source = audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(audioContext.destination);
                source.start();

                this.audioEnabled = true;
                this.hideAudioNotification();

                // If there's a pending play, execute it now
                if (this.pendingPlay) {
                    console.log('Executing pending play request');
                    this.pendingPlay();
                    this.pendingPlay = null;
                }

                console.log('Audio enabled by user interaction');

                // Remove the event listeners since audio is now enabled
                ['click', 'keydown', 'touchstart'].forEach(eventType => {
                    document.removeEventListener(eventType, enableAudio);
                });

            } catch (e) {
                console.log('Audio enabling failed:', e);
                // Keep trying on subsequent interactions
            }
        };

        // Listen for any user interaction
        ['click', 'keydown', 'touchstart'].forEach(event => {
            document.addEventListener(event, enableAudio);
        });
    }

    updateConnectionStatus(connected) {
        const status = document.getElementById('connectionStatus');
        status.textContent = connected ? 'Connected' : 'Disconnected';
        status.className = connected ? 'connected' : 'disconnected';
    }

    handleTimesync(data) {
        const now = Date.now();
        this.clockOffset = data.serverEpochMs - now;
        this.lastSync = now;
    }

    getCorrectedTime() {
        return Date.now() + this.clockOffset;
    }

    handleNowPlaying(data) {
        console.log('Now playing state:', data);

        if (data.phase === 'idle') {
            this.updateStatus('Ready - No active playback', 'idle');
            this.hideNowPlaying();
        } else if (data.nowPlaying) {
            this.currentTrack = data.nowPlaying;
            this.showNowPlaying(data.nowPlaying);

            if (data.phase === 'playing') {
                this.handleLateJoin(data.nowPlaying);
            } else if (data.phase === 'prepared') {
                this.handlePrepare(data.nowPlaying);
            }
        }

        this.handleQueueUpdate(data);
    }

    handleDownloading(data) {
        this.updateStatus(`Downloading: ${data.videoId}`, 'downloading');
    }

    handlePrepare(data) {
        console.log('Prepare received:', data);
        this.currentTrack = data;
        this.updateStatus(`Preparing: ${data.title}`, 'prepared');
        this.showNowPlaying(data);

        this.audio.src = data.fileUrl;
        this.audio.load();

        this.schedulePlayback(data.startEpochMs);
    }

    handleStart(data) {
        console.log('Start received:', data);
        this.updateStatus(`Playing: ${this.currentTrack.title}`, 'playing');

        // If this is a newly connected client during playback, calculate offset and play
        if (this.currentTrack && this.currentTrack.startEpochMs) {
            const now = this.getCorrectedTime();
            const offset = (now - this.currentTrack.startEpochMs) / 1000;

            if (offset > 0 && offset < this.currentTrack.durationSec) {
                // Late join - seek to correct position
                console.log('Start with late join - seeking to offset:', offset);
                if (this.audio.src) {
                    this.audio.currentTime = Math.max(0, offset);
                    this.attemptPlay();
                }
            } else if (offset <= 0) {
                // Synchronized start
                console.log('Synchronized start');
                if (this.audio.src) {
                    this.audio.currentTime = 0;
                    this.attemptPlay();
                }
            }
        }

        this.startSyncCheck();
    }

    handleEnded(data) {
        console.log('Ended received:', data);
        this.audio.pause();
        this.audio.src = '';
        this.hideNowPlaying();
        this.updateStatus('Ready - No active playback', 'idle');
        this.stopSyncCheck();
        this.currentTrack = null;
    }

    handleLateJoin(trackData) {
        if (!trackData.startEpochMs || !trackData.durationSec) return;

        const now = this.getCorrectedTime();
        const offset = (now - trackData.startEpochMs) / 1000;

        if (offset < 0 || offset >= trackData.durationSec) {
            return;
        }

        console.log('Late join - seeking to offset:', offset);
        this.updateStatus(`Playing: ${trackData.title}`, 'playing');

        this.audio.src = trackData.fileUrl;
        this.audio.addEventListener('loadeddata', () => {
            this.audio.currentTime = Math.max(0, offset);
            this.attemptPlay();
            this.startSyncCheck();
        }, { once: true });
        this.audio.load();
    }

    schedulePlayback(startEpochMs) {
        const now = this.getCorrectedTime();
        const delay = startEpochMs - now;

        console.log('Scheduling playback in', delay, 'ms');

        if (delay <= 200) {
            this.startPlayback();
        } else {
            setTimeout(() => this.startPlayback(), Math.max(0, delay - 50));
        }
    }

    startPlayback() {
        if (!this.audio.src) return;

        console.log('Starting playback');
        this.audio.currentTime = 0;
        this.attemptPlay();
        this.startSyncCheck();
    }

    attemptPlay() {
        if (!this.audioEnabled) {
            console.log('Audio not enabled yet, storing play request');
            this.pendingPlay = () => {
                this.audio.play().catch(e => console.error('Play failed:', e));
            };
            this.showAudioNotification();
            return;
        }

        this.audio.play().catch(e => {
            console.error('Play failed:', e);
            this.showAudioNotification();
        });
    }

    onAudioLoaded() {
        console.log('Audio loaded, duration:', this.audio.duration);
    }

    startSyncCheck() {
        this.stopSyncCheck();
        this.syncCheckInterval = setInterval(() => this.checkSync(), 2000);
    }

    stopSyncCheck() {
        if (this.syncCheckInterval) {
            clearInterval(this.syncCheckInterval);
            this.syncCheckInterval = null;
        }
    }

    checkSync() {
        if (!this.currentTrack || !this.currentTrack.startEpochMs || this.audio.paused) {
            return;
        }

        const now = this.getCorrectedTime();
        const expectedOffset = (now - this.currentTrack.startEpochMs) / 1000;
        const actualOffset = this.audio.currentTime;
        const drift = Math.abs(expectedOffset - actualOffset);

        const syncInfo = document.getElementById('syncInfo');
        syncInfo.textContent = `Sync: ${drift.toFixed(1)}s drift`;

        if (drift > 0.5 && expectedOffset > 0 && expectedOffset < this.currentTrack.durationSec) {
            console.log('Correcting sync drift:', drift, 'seconds');
            this.audio.currentTime = Math.max(0, expectedOffset);
        }
    }

    handleQueueUpdate(data) {
        const queueList = document.getElementById('queueList');
        const queueCount = document.getElementById('queueCount');

        if (!data.queue || data.queue.length === 0) {
            queueList.innerHTML = '<div style="color: #666; font-style: italic;">Queue is empty</div>';
            queueCount.textContent = '0';
            return;
        }

        queueCount.textContent = data.queue.length;
        queueList.innerHTML = data.queue.map((item, index) => `
            <div class="queue-item">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        ${index + 1}. ${item.title || `Video ${item.videoId}`}
                        <small style="color: #666; display: block;">ID: ${item.videoId}</small>
                    </div>
                    <button onclick="cancelSong('${item.id}')" style="background-color: #dc3545; color: white; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 12px; margin-left: 10px;">✕</button>
                </div>
            </div>
        `).join('');
    }

    handleError(data) {
        console.error('Server error:', data);

        // Don't show "Song not found" errors as status updates - they're expected when double-clicking
        if (data.message && data.message.includes('Song not found')) {
            console.log('Song already canceled or not found');
            return;
        }

        this.updateStatus(`Error: ${data.message}`, 'error');
    }

    handleRequestResult(data) {
        if (data.accepted) {
            console.log('Request accepted, position:', data.position);
        } else {
            alert(data.reason || 'Request was not accepted');
        }
    }

    handleCancelResult(data) {
        console.log('Cancel result:', data);
        if (data.success) {
            console.log('Song canceled successfully:', data.message);
        } else {
            console.error('Cancel failed:', data);
        }
    }

    handleSongCanceled(data) {
        console.log('Song canceled:', data);
        this.showSystemMessage(`🚫 Song canceled: ${data.title}`);

        // If the canceled song is the current track, clean up the frontend
        if (this.currentTrack && this.currentTrack.id === data.id) {
            console.log('Cleaning up canceled current track');
            this.audio.pause();
            this.audio.src = '';
            this.hideNowPlaying();
            this.updateStatus('Ready - No active playback', 'idle');
            this.stopSyncCheck();
            this.currentTrack = null;
        }
    }

    updateStatus(message, type) {
        const status = document.getElementById('status');
        status.textContent = message;
        status.className = `status ${type}`;
    }

    showNowPlaying(track) {
        const nowPlaying = document.getElementById('nowPlaying');
        const trackInfo = document.getElementById('trackInfo');

        trackInfo.innerHTML = `
            <strong>${track.title || 'Unknown Title'}</strong><br>
            <small>Video ID: ${track.videoId}</small><br>
            <small>Duration: ${track.durationSec ? Math.floor(track.durationSec / 60) + ':' + String(track.durationSec % 60).padStart(2, '0') : 'Unknown'}</small>
            <button onclick="cancelSong('${track.id}')" style="margin-top: 10px; background-color: #dc3545; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;">🚫 Cancel Song</button>
        `;

        nowPlaying.style.display = 'block';
    }

    hideNowPlaying() {
        document.getElementById('nowPlaying').style.display = 'none';
        document.getElementById('syncInfo').textContent = '';
    }

    showAudioNotification() {
        let notification = document.getElementById('audioNotification');
        if (!notification) {
            notification = document.createElement('div');
            notification.id = 'audioNotification';
            notification.style.cssText = `
                position: fixed;
                top: 50px;
                left: 50%;
                transform: translateX(-50%);
                background: #ff9800;
                color: white;
                padding: 15px 25px;
                border-radius: 5px;
                font-weight: bold;
                z-index: 1000;
                box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                cursor: pointer;
            `;
            notification.textContent = '🔊 Click anywhere to enable audio playback';
            document.body.appendChild(notification);

            notification.addEventListener('click', () => {
                // This will trigger the enableAudio function
            });
        }
    }

    hideAudioNotification() {
        const notification = document.getElementById('audioNotification');
        if (notification) {
            notification.remove();
        }
    }

    extractVideoId(input) {
        // If it's already a valid 11-character video ID, return it
        if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
            return input;
        }

        // Try to extract video ID from various YouTube URL formats
        const patterns = [
            // youtube.com/watch?v=VIDEO_ID
            /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
            // youtu.be/VIDEO_ID
            /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
            // music.youtube.com/watch?v=VIDEO_ID
            /(?:music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
            // youtube.com/embed/VIDEO_ID
            /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
            // youtube.com/v/VIDEO_ID
            /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/
        ];

        for (const pattern of patterns) {
            const match = input.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }

        return null;
    }

    async searchSong() {
        const input = document.getElementById('searchInput');
        const query = input.value.trim();

        if (!query) {
            alert('Please enter a search term');
            return;
        }

        // Check if it's a YouTube URL or ID, if so, use direct add
        const videoId = this.extractVideoId(query);
        if (videoId) {
            this.requestSongById(videoId);
            input.value = '';
            return;
        }

        // Show loading state
        const searchButton = document.getElementById('searchButton');
        const originalText = searchButton.textContent;
        searchButton.innerHTML = 'Searching <div class="loading-spinner"></div>';
        searchButton.disabled = true;

        try {
            // Make API call to search for songs
            const response = await fetch('/api/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ query })
            });

            if (!response.ok) {
                throw new Error('Search failed');
            }

            const data = await response.json();
            this.displaySearchResults(data.results || []);
        } catch (error) {
            console.error('Search error:', error);
            alert('Search failed. Please try again.');
        } finally {
            // Reset button
            searchButton.textContent = originalText;
            searchButton.disabled = false;
        }
    }

    displaySearchResults(results) {
        const searchResults = document.getElementById('searchResults');
        const searchResultsList = document.getElementById('searchResultsList');

        if (!results || results.length === 0) {
            searchResults.style.display = 'none';
            alert('No results found. Try a different search term.');
            return;
        }

        // Show only first 3 results
        const topResults = results.slice(0, 3);

        searchResultsList.innerHTML = topResults.map(result => `
            <div class="search-result-item" onclick="selectSearchResult('${result.videoId}')">
                <img src="${result.thumbnail}" alt="Thumbnail" class="result-thumbnail" onerror="this.style.display='none'">
                <div class="result-info">
                    <div class="result-title">${this.escapeHtml(result.title)}</div>
                    <div class="result-channel">${this.escapeHtml(result.channel)}</div>
                    <div class="result-duration">${this.formatDuration(result.duration)}</div>
                </div>
            </div>
        `).join('');

        searchResults.style.display = 'block';
    }

    selectSearchResult(videoId) {
        // Hide search results
        document.getElementById('searchResults').style.display = 'none';

        // Clear search input
        document.getElementById('searchInput').value = '';

        // Request the selected song
        this.requestSongById(videoId);
    }

    formatDuration(seconds) {
        if (!seconds) return 'Unknown';
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    async requestSong() {
        const input = document.getElementById('searchInput');
        const inputValue = input.value.trim();

        if (!inputValue) {
            alert('Please enter a YouTube URL or video ID');
            return;
        }

        // Extract video ID from URL or use directly if it's already an ID
        let videoId = this.extractVideoId(inputValue);

        if (!videoId) {
            alert('Invalid YouTube URL or video ID');
            return;
        }

        this.requestSongById(videoId);
        input.value = '';
    }

    async requestSongById(videoId) {
        if (!videoId) {
            alert('Invalid video ID');
            return;
        }

        // Enable audio when user requests a song (this is a user interaction)
        if (!this.audioEnabled) {
            try {
                console.log('Enabling audio context from song request');
                // Create a silent audio blob
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const buffer = audioContext.createBuffer(1, 1, 22050);
                const source = audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(audioContext.destination);
                source.start();

                this.audioEnabled = true;
                this.hideAudioNotification();
                console.log('Audio enabled from song request');
            } catch (e) {
                console.log('Could not enable audio from song request:', e);
            }
        }

        this.socket.emit('request', { videoId });
        input.value = '';
    }

    updateUserDisplay() {
        const userInfo = document.getElementById('userInfo');
        if (userInfo && this.user) {
            const avatarEmojis = [
                '😀', '😎', '🤓', '😇', '🥸', '🤠', '🥳', '😋', '🙂', '😌',
                '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
                '🚀', '⭐', '🎵', '🎸', '🎤', '🎧', '🎹', '🥁', '🎺', '🎷',
                '🍕', '🍔', '🍟', '🌮', '🍰', '🍪', '🍩', '☕', '🧋', '🍓',
                '⚽', '🏀', '🎾', '🏓', '🎮', '🕹️', '🎯', '🎲', '🃏', '🎪'
            ];

            const avatar = avatarEmojis[this.user.avatarId - 1] || '😀';
            userInfo.innerHTML = `
                <span class="user-avatar">${avatar}</span>
                <span class="username">${this.user.username}</span>
                <button id="logoutButton" class="logout-btn">Logout</button>
            `;

            const logoutButton = document.getElementById('logoutButton');
            if (logoutButton) {
                logoutButton.addEventListener('click', () => this.logout());
            }
        }
    }

    logout() {
        localStorage.removeItem('userId');
        localStorage.removeItem('user');
        if (this.socket) {
            this.socket.disconnect();
        }
        window.location.href = '/register.html';
    }

    cancelSong(songId) {
        if (!this.authenticated || !songId) {
            console.error('Cannot cancel song: not authenticated or no songId provided');
            return;
        }

        console.log('Canceling song:', songId);
        this.socket.emit('cancelSong', { songId });
    }

    sendChatMessage() {
        const chatInput = document.getElementById('chatInput');
        if (!chatInput || !this.authenticated) return;

        const message = chatInput.value.trim();
        if (!message) return;

        if (message.length > 500) {
            alert('Message too long (max 500 characters)');
            return;
        }

        this.socket.emit('chatMessage', { message });
        chatInput.value = '';
    }

    loadChatHistory(messages) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        chatMessages.innerHTML = '';
        messages.forEach(message => {
            this.addChatMessage(message, false);
        });

        this.scrollChatToBottom();
    }

    addChatMessage(message, shouldScroll = true) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        const avatarEmojis = [
            '😀', '😎', '🤓', '😇', '🥸', '🤠', '🥳', '😋', '🙂', '😌',
            '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
            '🚀', '⭐', '🎵', '🎸', '🎤', '🎧', '🎹', '🥁', '🎺', '🎷',
            '🍕', '🍔', '🍟', '🌮', '🍰', '🍪', '🍩', '☕', '🧋', '🍓',
            '⚽', '🏀', '🎾', '🏓', '🎮', '🕹️', '🎯', '🎲', '🃏', '🎪'
        ];

        const messageElement = document.createElement('div');
        messageElement.className = 'chat-message';

        const avatar = avatarEmojis[message.avatarId - 1] || '😀';
        const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isOwn = this.user && message.userId === this.user.id;

        messageElement.innerHTML = `
            <div class="message-header">
                <span class="message-avatar">${avatar}</span>
                <span class="message-username ${isOwn ? 'own-message' : ''}">${message.username}</span>
                <span class="message-time">${time}</span>
            </div>
            <div class="message-content">${this.escapeHtml(message.message)}</div>
        `;

        chatMessages.appendChild(messageElement);

        if (shouldScroll) {
            this.scrollChatToBottom();
        }
    }

    showSystemMessage(message) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        const messageElement = document.createElement('div');
        messageElement.className = 'system-message';
        messageElement.innerHTML = `<span class="system-text">${this.escapeHtml(message)}</span>`;

        chatMessages.appendChild(messageElement);
        this.scrollChatToBottom();
    }

    scrollChatToBottom() {
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

window.searchSong = function() {
    window.client.searchSong();
};

window.requestSong = function() {
    window.client.requestSong();
};

window.selectSearchResult = function(videoId) {
    window.client.selectSearchResult(videoId);
};

window.cancelSong = function(songId) {
    window.client.cancelSong(songId);
};

window.addEventListener('DOMContentLoaded', () => {
    window.client = new LiveRadioClient();
});