const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function createProtectedHlsRouter(options = {}) {
    const router = express.Router();

    const {
        hlsDir = path.join(process.cwd(), "hls"),
        keysDir = path.join(process.cwd(), "keys_private"),
        moviesDbPath = path.join(process.cwd(), "movies.json"),
        devMode = false,
        playerSharedSecret = process.env.PLAYER_SHARED_SECRET || "CHANGE_THIS_PLAYER_SECRET",
        sessionTtlMs = 15 * 60 * 1000,
        maxTimeSkewMs = 60 * 1000
    } = options;

    const sessions = new Map();

    function isSafeId(value) {
        return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
    }

    function isKeyHash(value) {
        return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    }

    function hmacHex(secret, payload) {
        return crypto.createHmac("sha256", secret).update(payload).digest("hex");
    }

    function safeEqualHex(a, b) {
        if (typeof a !== "string" || typeof b !== "string") return false;
        if (a.length !== b.length) return false;

        try {
            return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
        } catch {
            return false;
        }
    }

    function readMovies() {
        if (!fs.existsSync(moviesDbPath)) return [];
        const raw = fs.readFileSync(moviesDbPath, "utf8").trim();
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }

    function findMovieById(movieId) {
        return readMovies().find((movie) => movie.id === movieId) || null;
    }

    function findMovieByKeyHash(keyHash) {
        return readMovies().find((movie) => movie.keyRefHash === keyHash) || null;
    }

    function getMovieKeyHash(movieId) {
        const movie = findMovieById(movieId);
        if (movie?.keyRefHash) return movie.keyRefHash;

        // Backward-compatible fallback for old manually added movies.
        // Old format expected keys_private/<movieId>.key.
        if (isSafeId(movieId) && fs.existsSync(path.join(keysDir, `${movieId}.key`))) {
            return movieId;
        }

        return null;
    }

    function createSessionToken(playerId, movieId, ip) {
        const token = crypto.randomBytes(32).toString("hex");

        sessions.set(token, {
            playerId,
            movieId,
            ip,
            expiresAt: Date.now() + sessionTtlMs
        });

        return token;
    }

    function cleanupSessions() {
        const now = Date.now();

        for (const [token, session] of sessions.entries()) {
            if (session.expiresAt <= now) sessions.delete(token);
        }
    }

    const cleanupTimer = setInterval(cleanupSessions, 60 * 1000);
    if (cleanupTimer.unref) cleanupTimer.unref();

    function getBearerToken(req) {
        const auth = req.headers.authorization || "";
        if (!auth.startsWith("Bearer ")) return null;
        return auth.slice("Bearer ".length).trim();
    }

    function getValidSession(req, res) {
        const token = getBearerToken(req);

        if (!token) {
            res.status(403).send("Missing session token");
            return null;
        }

        const session = sessions.get(token);

        if (!session) {
            res.status(403).send("Invalid session token");
            return null;
        }

        if (session.expiresAt <= Date.now()) {
            sessions.delete(token);
            res.status(403).send("Session expired");
            return null;
        }

        return session;
    }

    function requireMovieSession(req, res, next) {
        const session = getValidSession(req, res);
        if (!session) return;

        const movieId = req.params.movieId;

        if (session.movieId !== movieId) {
            return res.status(403).send("Token is not valid for this movie");
        }

        req.session = session;
        next();
    }

    function requireKeySession(req, res, next) {
        const session = getValidSession(req, res);
        if (!session) return;

        const keyHash = req.params.keyHash;

        if (!isKeyHash(keyHash)) {
            return res.sendStatus(400);
        }

        const movie = findMovieByKeyHash(keyHash);

        if (!movie) {
            return res.status(404).send("Key record not found");
        }

        if (movie.id !== session.movieId) {
            return res.status(403).send("Token is not valid for this key");
        }

        req.session = session;
        req.movie = movie;
        next();
    }

    function checkMovieFiles(movieId) {
        const playlistPath = path.join(hlsDir, movieId, "index.m3u8");
        const keyHash = getMovieKeyHash(movieId);
        const keyPath = keyHash ? path.join(keysDir, `${keyHash}.key`) : null;

        if (!fs.existsSync(playlistPath)) {
            return {
                ok: false,
                status: 404,
                error: "Movie playlist not found",
                path: playlistPath
            };
        }

        if (!keyHash || !keyPath || !fs.existsSync(keyPath)) {
            return {
                ok: false,
                status: 404,
                error: "Movie key not found",
                path: keyPath
            };
        }

        return {
            ok: true,
            playlistPath,
            keyPath,
            keyHash
        };
    }

    router.post("/api/player/session", (req, res) => {
        const { playerId, movieId, timestamp, nonce, signature } = req.body || {};

        if (!playerId || !movieId || !timestamp || !nonce || !signature) {
            return res.status(400).json({ error: "Missing fields" });
        }

        if (!isSafeId(playerId) || !isSafeId(movieId)) {
            return res.status(400).json({ error: "Invalid playerId or movieId" });
        }

        const timestampNumber = Number(timestamp);

        if (!Number.isFinite(timestampNumber)) {
            return res.status(400).json({ error: "Invalid timestamp" });
        }

        if (Math.abs(Date.now() - timestampNumber) > maxTimeSkewMs) {
            return res.status(403).json({ error: "Timestamp expired" });
        }

        const files = checkMovieFiles(movieId);

        if (!files.ok) {
            return res.status(files.status).json({ error: files.error, path: files.path });
        }

        const payload = `${playerId}.${movieId}.${timestamp}.${nonce}`;
        const expectedSignature = hmacHex(playerSharedSecret, payload);

        if (!safeEqualHex(signature, expectedSignature)) {
            return res.status(403).json({ error: "Invalid player signature" });
        }

        const token = createSessionToken(playerId, movieId, req.ip);

        res.json({
            token,
            expiresInMs: sessionTtlMs,
            hlsUrl: `/hls/${movieId}/index.m3u8`
        });
    });

    router.get("/api/dev/session/:movieId", (req, res) => {
        if (!devMode) return res.sendStatus(404);

        const movieId = req.params.movieId;

        if (!isSafeId(movieId)) {
            return res.status(400).json({ error: "Invalid movieId" });
        }

        const files = checkMovieFiles(movieId);

        if (!files.ok) {
            return res.status(files.status).json({ error: files.error, path: files.path });
        }

        const token = createSessionToken("dev_player", movieId, req.ip);
        const protocol = req.protocol;
        const host = req.get("host");

        res.json({
            token,
            expiresInMs: sessionTtlMs,
            hlsUrl: `/hls/${movieId}/index.m3u8`,
            fullHlsUrl: `${protocol}://${host}/hls/${movieId}/index.m3u8`
        });
    });

    router.use("/hls/:movieId", requireMovieSession, (req, res, next) => {
        const movieId = req.params.movieId;

        if (!isSafeId(movieId)) return res.sendStatus(400);

        const movieDir = path.join(hlsDir, movieId);

        if (!fs.existsSync(movieDir)) return res.sendStatus(404);

        express.static(movieDir, {
            setHeaders(res, filePath) {
                if (filePath.endsWith(".m3u8")) {
                    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
                }

                if (filePath.endsWith(".ts")) {
                    res.setHeader("Content-Type", "video/mp2t");
                }

                res.setHeader("Cache-Control", "no-store");
            }
        })(req, res, next);
    });

    router.get("/keys/:keyHash", requireKeySession, (req, res) => {
        const keyHash = req.params.keyHash;
        const keyPath = path.join(keysDir, `${keyHash}.key`);

        if (!fs.existsSync(keyPath)) return res.sendStatus(404);

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Cache-Control", "no-store");
        res.sendFile(keyPath);
    });

    router.get("/api/hls/health", (req, res) => {
        res.json({
            ok: true,
            devMode,
            sessions: sessions.size,
            hlsDir,
            keysDir,
            moviesDbPath
        });
    });

    return router;
}

module.exports = createProtectedHlsRouter;
