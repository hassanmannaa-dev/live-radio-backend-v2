const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const { v4: uuidv4 } = require("uuid");

class DownloadService {
  constructor() {
    this.ytDlpPath = process.env.YT_DLP_PATH || "yt-dlp";
    this.ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
    this.tmpDir = process.env.TMP_DIR || "./tmp";
    this.maxDurationSec = 15 * 60; // 15 minutes
    this.downloadTimeout = 5 * 60 * 1000; // 5 minutes
  }

  async download(videoId, progressCallback = null) {
    const jobId = uuidv4();
    const outputTemplate = path.join(this.tmpDir, `${jobId}-%(title)s.%(ext)s`);

    console.log("Starting download:", videoId, "jobId:", jobId);

    return new Promise((resolve, reject) => {
      const args = [
        "-f",
        "bestaudio",
        "--extract-audio",
        "--audio-format",
        "m4a",
        "--no-playlist",
        "--print-json",
        "--progress",
        "--newline",
        "-o",
        outputTemplate,
        `https://music.youtube.com/watch?v=${videoId}`,
      ];

      const ytDlp = spawn(this.ytDlpPath, args);
      let stdout = "";
      let stderr = "";

      const timeout = setTimeout(() => {
        ytDlp.kill("SIGTERM");
        reject(new Error("Download timeout exceeded"));
      }, this.downloadTimeout);

      ytDlp.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      ytDlp.stderr.on("data", (data) => {
        const output = data.toString();
        stderr += output;

        // Parse progress information from stderr
        if (progressCallback) {
          const lines = output.split("\n");
          for (const line of lines) {
            // Look for download progress lines
            const downloadMatch = line.match(/\[download\]\s+(\d+\.\d+)%/);
            if (downloadMatch) {
              const percentage = parseFloat(downloadMatch[1]);
              progressCallback({
                type: "download",
                percentage: Math.round(percentage),
                videoId,
                jobId,
              });
            }

            // Look for post-processing progress
            const postProcessMatch = line.match(/\[ExtractAudio\]/);
            if (postProcessMatch) {
              progressCallback({
                type: "processing",
                percentage: 95,
                videoId,
                jobId,
                stage: "Converting audio format",
              });
            }
          }
        }
      });

      ytDlp.on("close", async (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          console.log(
            "yt-dlp failed:",
            videoId,
            "jobId:",
            jobId,
            "code:",
            code,
            "stderr:",
            stderr
          );
          reject(new Error(`yt-dlp failed with code ${code}: ${stderr}`));
          return;
        }

        try {
          const jsonOutput = stdout
            .trim()
            .split("\n")
            .find((line) => {
              try {
                JSON.parse(line);
                return true;
              } catch {
                return false;
              }
            });

          if (!jsonOutput) {
            throw new Error("No JSON metadata found in yt-dlp output");
          }

          const metadata = JSON.parse(jsonOutput);
          const title = this.sanitizeTitle(
            metadata.title || `video-${videoId}`
          );
          const ext = metadata.ext || "m4a";

          const expectedPath = path.join(
            this.tmpDir,
            `${jobId}-${title}.${ext}`
          );

          let finalPath = expectedPath;
          try {
            await fs.access(expectedPath);
          } catch {
            const files = await fs.readdir(this.tmpDir);
            const matchingFile = files.find((file) =>
              file.startsWith(`${jobId}-`)
            );
            if (matchingFile) {
              finalPath = path.join(this.tmpDir, matchingFile);
            } else {
              throw new Error("Downloaded file not found");
            }
          }

          const stats = await fs.stat(finalPath);
          let durationSec = metadata.duration;

          if (!durationSec) {
            durationSec = await this.probeDuration(finalPath);
          }

          if (durationSec > this.maxDurationSec) {
            await fs.unlink(finalPath);
            throw new Error(
              `Duration ${durationSec}s exceeds maximum ${this.maxDurationSec}s`
            );
          }

          const result = {
            id: jobId,
            videoId,
            title: metadata.title || title,
            filepath: finalPath,
            ext,
            durationSec: Math.floor(durationSec),
            filesize: stats.size,
          };

          console.log("Download completed successfully:", result);
          resolve(result);
        } catch (error) {
          console.log(
            "Error processing download result:",
            videoId,
            "jobId:",
            jobId,
            "error:",
            error.message
          );
          reject(error);
        }
      });

      ytDlp.on("error", (error) => {
        clearTimeout(timeout);
        console.log(
          "yt-dlp spawn error:",
          videoId,
          "jobId:",
          jobId,
          "error:",
          error.message
        );
        reject(new Error(`Failed to spawn yt-dlp: ${error.message}`));
      });
    });
  }

  async probeDuration(filepath) {
    return new Promise((resolve, reject) => {
      const args = [
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        filepath,
      ];

      const ffprobe = spawn(this.ffprobePath, args);
      let stdout = "";

      ffprobe.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      ffprobe.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed with code ${code}`));
          return;
        }

        try {
          const data = JSON.parse(stdout);
          const duration = parseFloat(data.format.duration);
          resolve(duration);
        } catch (error) {
          reject(new Error(`Failed to parse ffprobe output: ${error.message}`));
        }
      });

      ffprobe.on("error", (error) => {
        reject(new Error(`Failed to spawn ffprobe: ${error.message}`));
      });
    });
  }

  async searchVideos(query, maxResults = 3) {
    console.log("Searching for videos:", query);

    return new Promise((resolve, reject) => {
      const args = [
        "--flat-playlist",
        "--dump-json",
        "--playlist-end",
        maxResults.toString(),
        `https://music.youtube.com/search?q=${encodeURIComponent(query)}`,
      ];

      const ytDlp = spawn(this.ytDlpPath, args);
      let stdout = "";
      let stderr = "";

      const timeout = setTimeout(() => {
        ytDlp.kill("SIGTERM");
        reject(new Error("Search timeout exceeded"));
      }, 30000); // 30 second timeout for search

      ytDlp.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      ytDlp.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ytDlp.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          console.log(
            "yt-dlp search failed:",
            query,
            "code:",
            code,
            "stderr:",
            stderr
          );
          reject(
            new Error(`yt-dlp search failed with code ${code}: ${stderr}`)
          );
          return;
        }

        try {
          const lines = stdout
            .trim()
            .split("\n")
            .filter((line) => line.trim());
          const results = [];

          for (const line of lines) {
            try {
              const videoData = JSON.parse(line);

              // Skip if it's not a valid video
              if (!videoData.id || !videoData.title) continue;

              results.push({
                videoId: videoData.id,
                title: videoData.title,
                channel: videoData.uploader || videoData.channel || "Unknown",
                duration: videoData.duration || null,
                thumbnail: this.getBestThumbnail(videoData.thumbnails),
                url:
                  videoData.webpage_url ||
                  `https://music.youtube.com/watch?v=${videoData.id}`,
              });

              if (results.length >= maxResults) break;
            } catch (parseError) {
              console.log(
                "Failed to parse search result line:",
                parseError.message
              );
              continue;
            }
          }

          console.log(
            `Search completed: ${results.length} results for "${query}"`
          );
          resolve(results);
        } catch (error) {
          console.log(
            "Error processing search results:",
            query,
            "error:",
            error.message
          );
          reject(error);
        }
      });

      ytDlp.on("error", (error) => {
        clearTimeout(timeout);
        console.log(
          "yt-dlp search spawn error:",
          query,
          "error:",
          error.message
        );
        reject(
          new Error(`Failed to spawn yt-dlp for search: ${error.message}`)
        );
      });
    });
  }

  getBestThumbnail(thumbnails) {
    if (!thumbnails || !Array.isArray(thumbnails)) {
      return null;
    }

    // Prefer medium quality thumbnails, fallback to highest available
    const preferred = thumbnails.find(
      (t) => t.id === "medium" || t.preference === 1
    );
    if (preferred) return preferred.url;

    // Find highest resolution thumbnail
    const sorted = thumbnails
      .filter((t) => t.url)
      .sort((a, b) => {
        const aRes = (a.width || 0) * (a.height || 0);
        const bRes = (b.width || 0) * (b.height || 0);
        return bRes - aRes;
      });

    return sorted[0]?.url || null;
  }

  sanitizeTitle(title) {
    return title
      .replace(/[^a-zA-Z0-9\s\-_.]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 50);
  }
}

module.exports = DownloadService;
