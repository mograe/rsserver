const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
const AdmZip = require("adm-zip");

function createHlsUploadRouter(options = {}) {
    const router = express.Router();

    const {
        hlsDir = path.join(process.cwd(), "hls"),
        keysDir = path.join(process.cwd(), "keys_private"),
        imagesDir = path.join(process.cwd(), "static", "movie-thumbs"),
        imageUrlPrefix = "/movie-thumbs",
        moviesDbPath = path.join(process.cwd(), "movies.json"),
        uploadToken = process.env.HLS_UPLOAD_TOKEN,
        maxUploadMb = 4096,
        maxImageMb = 20
    } = options;

    const tmpDir = path.join(os.tmpdir(), "hls_uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(hlsDir, { recursive: true });
    fs.mkdirSync(keysDir, { recursive: true });
    fs.mkdirSync(imagesDir, { recursive: true });

    // Public thumbnails. If your main server already serves ./static, this is still OK.
    router.use(imageUrlPrefix, express.static(imagesDir, {
        maxAge: "7d",
        immutable: true
    }));

    const upload = multer({
        dest: tmpDir,
        limits: {
            fileSize: maxUploadMb * 1024 * 1024
        }
    });

    function isSafeId(value) {
        return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
    }

    function isKeyHash(value) {
        return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    }

    function requireUploadToken(req, res, next) {
        if (!uploadToken) {
            return res.status(500).json({ error: "Server upload token is not configured" });
        }

        const token = req.headers["x-upload-token"];

        if (token !== uploadToken) {
            return res.status(403).json({ error: "Invalid upload token" });
        }

        next();
    }

    function readMovies() {
        if (!fs.existsSync(moviesDbPath)) return [];

        const raw = fs.readFileSync(moviesDbPath, "utf8").trim();
        if (!raw) return [];

        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }

    function writeMovies(movies) {
        fs.writeFileSync(moviesDbPath, JSON.stringify(movies, null, 2), "utf8");
    }

    function removeTempFiles(files) {
        for (const item of files) {
            if (!item) continue;
            try {
                fs.rmSync(item.path, { force: true });
            } catch (_) {}
        }
    }

    function assertInside(parent, child) {
        const relative = path.relative(parent, child);
        return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    }

    function safeExtractZip(zipPath, targetDir) {
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();

        if (!entries.some((entry) => entry.entryName === "index.m3u8")) {
            throw new Error("Archive must contain index.m3u8 at root");
        }

        fs.mkdirSync(targetDir, { recursive: true });

        for (const entry of entries) {
            const normalizedName = entry.entryName.replace(/\\/g, "/");

            if (entry.isDirectory) continue;
            if (normalizedName.startsWith("/") || normalizedName.includes("../")) {
                throw new Error(`Unsafe zip entry: ${entry.entryName}`);
            }

            const ext = path.extname(normalizedName).toLowerCase();
            const allowed = [".m3u8", ".ts", ".m4s", ".mp4", ".vtt"];

            if (!allowed.includes(ext)) {
                throw new Error(`Unsupported file in zip: ${entry.entryName}`);
            }

            const destination = path.join(targetDir, normalizedName);

            if (!assertInside(targetDir, destination)) {
                throw new Error(`Unsafe destination: ${entry.entryName}`);
            }

            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, entry.getData());
        }
    }

    function getImageExtension(imageFile) {
        if (!imageFile) return null;

        if (imageFile.size > maxImageMb * 1024 * 1024) {
            throw new Error(`Image is too large. Max size: ${maxImageMb} MB`);
        }

        const originalExt = path.extname(imageFile.originalname || "").toLowerCase();
        const mime = String(imageFile.mimetype || "").toLowerCase();

        const byMime = {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp"
        };

        const allowedExt = [".jpg", ".jpeg", ".png", ".webp"];

        if (byMime[mime]) {
            return byMime[mime];
        }

        if (allowedExt.includes(originalExt)) {
            return originalExt === ".jpeg" ? ".jpg" : originalExt;
        }

        throw new Error("Unsupported image format. Use JPG, PNG or WEBP");
    }

    function saveMovieImage(imageFile, ext) {
        const imageName = `${crypto.randomBytes(24).toString("hex")}${ext}`;
        const imagePath = path.join(imagesDir, imageName);

        if (!assertInside(imagesDir, imagePath)) {
            throw new Error("Unsafe image path");
        }

        fs.copyFileSync(imageFile.path, imagePath);

        return {
            path: imagePath,
            uri: `${imageUrlPrefix}/${imageName}`
        };
    }

    function removeMovieImageByUri(uri) {
        if (!uri || typeof uri !== "string") return;
        if (!uri.startsWith(`${imageUrlPrefix}/`)) return;

        const imageName = path.basename(uri);
        const imagePath = path.join(imagesDir, imageName);

        if (!assertInside(imagesDir, imagePath)) return;

        try {
            fs.rmSync(imagePath, { force: true });
        } catch (_) {}
    }

    router.post(
        "/api/admin/hls-upload",
        requireUploadToken,
        upload.fields([
            { name: "hlsZip", maxCount: 1 },
            { name: "keyFile", maxCount: 1 },
            { name: "imageFile", maxCount: 1 }
        ]),
        (req, res) => {
            const uploaded = [
                ...(req.files?.hlsZip || []),
                ...(req.files?.keyFile || []),
                ...(req.files?.imageFile || [])
            ];

            let newImage = null;

            try {
                const movieId = String(req.body.movieId || "").trim();
                const title = String(req.body.title || "").trim();
                const durationSec = Number(req.body.durationSec || 0);
                const keyRefHash = String(req.body.keyHash || "").trim();
                const replace = String(req.body.replace || "false") === "true";

                if (!isSafeId(movieId)) {
                    return res.status(400).json({ error: "Invalid movieId" });
                }

                if (!title) {
                    return res.status(400).json({ error: "Title is required" });
                }

                if (!Number.isFinite(durationSec) || durationSec <= 0) {
                    return res.status(400).json({ error: "Invalid durationSec" });
                }

                if (!isKeyHash(keyRefHash)) {
                    return res.status(400).json({ error: "Invalid keyHash" });
                }

                const hlsZip = req.files?.hlsZip?.[0];
                const keyFile = req.files?.keyFile?.[0];
                const imageFile = req.files?.imageFile?.[0] || null;
                const imageExt = getImageExtension(imageFile);

                if (!hlsZip || !keyFile) {
                    return res.status(400).json({ error: "hlsZip and keyFile are required" });
                }

                if (keyFile.size !== 16) {
                    return res.status(400).json({ error: "AES-128 key file must be exactly 16 bytes" });
                }

                const movieDir = path.join(hlsDir, movieId);
                const keyPath = path.join(keysDir, `${keyRefHash}.key`);

                if ((fs.existsSync(movieDir) || fs.existsSync(keyPath)) && !replace) {
                    return res.status(409).json({
                        error: "Movie or key already exists. Use replace=true to overwrite."
                    });
                }

                const movies = readMovies();
                const existingIndex = movies.findIndex((movie) => movie.id === movieId);
                const existingMovie = existingIndex >= 0 ? movies[existingIndex] : null;

                if (replace) {
                    fs.rmSync(movieDir, { recursive: true, force: true });
                    fs.rmSync(keyPath, { force: true });
                }

                safeExtractZip(hlsZip.path, movieDir);
                fs.copyFileSync(keyFile.path, keyPath);

                const playlistPath = path.join(movieDir, "index.m3u8");
                const playlist = fs.readFileSync(playlistPath, "utf8");

                if (!playlist.includes(`/keys/${keyRefHash}`)) {
                    return res.status(400).json({
                        error: "index.m3u8 does not reference the provided keyHash"
                    });
                }

                let thumbUri = existingMovie?.thumbUri || null;

                if (imageFile) {
                    newImage = saveMovieImage(imageFile, imageExt);
                    thumbUri = newImage.uri;
                }

                const nowIso = new Date().toISOString();

                const record = {
                    id: movieId,
                    title,
                    length: Math.ceil(durationSec / 60),
                    minutes: Math.ceil(durationSec / 60),
                    durationSec,
                    videoUri: `/hls/${movieId}/index.m3u8`,
                    type: "hls",
                    hls: true,
                    keyRefHash,
                    updatedAtUtc: nowIso,
                    createdAtUtc: existingMovie?.createdAtUtc || nowIso
                };

                if (thumbUri) {
                    record.thumbUri = thumbUri;
                }

                if (existingIndex >= 0) {
                    movies[existingIndex] = {
                        ...existingMovie,
                        ...record
                    };
                } else {
                    movies.push(record);
                }

                writeMovies(movies);

                if (newImage && existingMovie?.thumbUri && existingMovie.thumbUri !== newImage.uri) {
                    removeMovieImageByUri(existingMovie.thumbUri);
                }

                res.json({
                    ok: true,
                    movie: record,
                    hlsUrl: record.videoUri,
                    thumbUri: record.thumbUri || null,
                    keyRefHash
                });
            } catch (error) {
                if (newImage?.path) {
                    try {
                        fs.rmSync(newImage.path, { force: true });
                    } catch (_) {}
                }

                console.error("[HLS UPLOAD ERROR]", error);
                res.status(500).json({ error: error.message || "Upload failed" });
            } finally {
                removeTempFiles(uploaded);
            }
        }
    );


    router.get("/api/admin/movies", requireUploadToken, (req, res) => {
        try {
            const movies = readMovies()
                .slice()
                .sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id), "ru"));

            res.json({
                ok: true,
                count: movies.length,
                movies
            });
        } catch (error) {
            console.error("[HLS MOVIES LIST ERROR]", error);
            res.status(500).json({ error: error.message || "Failed to read movies" });
        }
    });

    router.delete("/api/admin/movies/:movieId", requireUploadToken, (req, res) => {
        try {
            const movieId = String(req.params.movieId || "").trim();

            if (!isSafeId(movieId)) {
                return res.status(400).json({ error: "Invalid movieId" });
            }

            const movies = readMovies();
            const index = movies.findIndex((movie) => movie.id === movieId);

            if (index < 0) {
                return res.status(404).json({ error: "Movie not found" });
            }

            const movie = movies[index];
            const movieDir = path.join(hlsDir, movieId);

            if (assertInside(hlsDir, movieDir)) {
                fs.rmSync(movieDir, { recursive: true, force: true });
            }

            const keyCandidates = [];

            if (isKeyHash(movie.keyRefHash)) {
                keyCandidates.push(path.join(keysDir, `${movie.keyRefHash}.key`));
            }

            // Backward-compatible cleanup for old manually added movies.
            keyCandidates.push(path.join(keysDir, `${movieId}.key`));

            for (const keyPath of keyCandidates) {
                if (assertInside(keysDir, keyPath)) {
                    fs.rmSync(keyPath, { force: true });
                }
            }

            removeMovieImageByUri(movie.thumbUri);

            movies.splice(index, 1);
            writeMovies(movies);

            res.json({
                ok: true,
                deleted: {
                    id: movie.id,
                    title: movie.title || movie.id,
                    videoUri: movie.videoUri || null,
                    thumbUri: movie.thumbUri || null
                },
                count: movies.length
            });
        } catch (error) {
            console.error("[HLS MOVIE DELETE ERROR]", error);
            res.status(500).json({ error: error.message || "Failed to delete movie" });
        }
    });

    return router;
}

module.exports = createHlsUploadRouter;
