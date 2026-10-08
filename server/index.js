import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 4000);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = resolve(projectRoot, 'dist');
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = CLIENT_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
const allowedOriginSet = new Set(allowedOrigins);
const isLocalOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
const JWT_SECRET = process.env.JWT_SECRET || 'local-development-secret-change-me';
const OWNER_DISPLAY_NAME = 'rakheesubinukasim';
const MINIMUM_RESERVED_NAME_LENGTH = 'rakhee'.length;
const OWNER_NAME_PASSWORD = process.env.OWNER_NAME_PASSWORD;
const redisEnabled = Boolean(process.env.REDIS_URL);
const MATCH_DURATION_MS = 3 * 60 * 1000;
const CAMPUS_RADIUS_KM = 15;
const CAMPUSES = [
  { name: 'CUCEK', latitude: 9.4605554, longitude: 76.4373625 },
  { name: 'CUSAT', latitude: 10.0442634, longitude: 76.3278684 },
];
const fallbackIceServers = [
  { urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' },
  ...(process.env.VITE_SERVER_URL && process.env.VITE_TURN_USERNAME && process.env.VITE_TURN_PASSWORD
    ? [{
      urls: process.env.VITE_SERVER_URL,
      username: process.env.VITE_TURN_USERNAME,
      credential: process.env.VITE_TURN_PASSWORD,
    }]
    : []),
];
let cachedIceServers = null;
let cachedIceServersAt = 0;
const waitingUsers = [];
const pairedUsers = new Map();
const pairTimers = new Map();
const redisOptions = { lazyConnect: true, maxRetriesPerRequest: 1 };
const redis = redisEnabled ? new Redis(process.env.REDIS_URL, redisOptions) : null;
const redisPub = redis ? redis.duplicate() : null;
const redisSub = redis ? redis.duplicate() : null;
const onlineSocketsKey = 'cucek:online-sockets';
let onlineCountBroadcastTimer = null;
let redisConnectionPromise = null;
const mongoOptions = {
  serverApi: { version: '1', strict: true, deprecationErrors: true },
  ...(process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {}),
};

function connectRedisClient(client) {
  if (client.status === 'ready' || client.status === 'connect') return Promise.resolve();
  if (client.status === 'connecting') {
    return new Promise((resolve, reject) => {
      const handleReady = () => {
        cleanup();
        resolve();
      };
      const handleError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        client.removeListener('ready', handleReady);
        client.removeListener('error', handleError);
      };
      client.once('ready', handleReady);
      client.once('error', handleError);
      if (client.status === 'ready') handleReady();
    });
  }
  return client.connect();
}

function connectRedis() {
  if (!redis) return Promise.resolve();
  if (!redisConnectionPromise) {
    redisConnectionPromise = Promise.all([
      connectRedisClient(redis),
      connectRedisClient(redisPub),
      connectRedisClient(redisSub),
    ]).catch((error) => {
      redisConnectionPromise = null;
      throw error;
    });
  }
  return redisConnectionPromise;
}

async function getIceServers() {
  const cacheAge = Date.now() - cachedIceServersAt;
  if (cachedIceServers && cacheAge < 10 * 60 * 1000) return cachedIceServers;
  cachedIceServers = fallbackIceServers;
  cachedIceServersAt = Date.now();
  return fallbackIceServers;
}

const anonymousAuthSchema = z.object({ displayName: z.string().trim().min(1).max(32).optional() }).strict();
const reportInputSchema = z.object({ sessionId: z.string().max(100).optional(), reason: z.string().trim().min(3).max(500) }).strict();
const queueInputSchema = z.object({
  interest: z.string().trim().min(1).max(40),
  displayName: z.string().trim().min(1).max(32),
  ownerNamePassword: z.string().max(128).optional(),
  location: z.object({ latitude: z.number().finite(), longitude: z.number().finite() }).strict(),
}).strict();

function issueToken() {
  const userId = randomUUID();
  const token = jwt.sign({ sub: userId, role: 'student' }, JWT_SECRET, { expiresIn: '12h' });
  if (redis) redis.set(`session:${userId}`, 'active', 'EX', 43200).catch(() => {});
  return { userId, token };
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireAuth(request, response, next) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return response.status(401).json({ error: 'Bearer token required' });
  try {
    request.user = verifyToken(token);
    next();
  } catch {
    return response.status(401).json({ error: 'Invalid or expired token' });
  }
}

const reportSchema = new mongoose.Schema({
  reporterId: { type: String, required: true },
  sessionId: String,
  reason: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
const Report = mongoose.models.Report || mongoose.model('Report', reportSchema);

function isReservedDisplayName(displayName) {
  const normalizedName = displayName.trim().toLowerCase().replace(/\s+/g, '');
  return normalizedName.length >= MINIMUM_RESERVED_NAME_LENGTH && OWNER_DISPLAY_NAME.startsWith(normalizedName);
}

function hasOwnerAccess(displayName, ownerNamePassword) {
  return Boolean(OWNER_NAME_PASSWORD)
    && isReservedDisplayName(displayName)
    && ownerNamePassword === OWNER_NAME_PASSWORD;
}

function distanceInKilometres(first, second) {
  const earthRadius = 6371;
  const latitudeDelta = ((second.latitude - first.latitude) * Math.PI) / 180;
  const longitudeDelta = ((second.longitude - first.longitude) * Math.PI) / 180;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos((first.latitude * Math.PI) / 180)
    * Math.cos((second.latitude * Math.PI) / 180)
    * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestCampus(location) {
  return CAMPUSES
    .map((campus) => ({ ...campus, distance: distanceInKilometres(campus, location) }))
    .sort((first, second) => first.distance - second.distance)[0];
}

function removeFromQueue(socketId) {
  if (!redis) {
    const index = waitingUsers.findIndex((user) => user.socketId === socketId);
    if (index >= 0) waitingUsers.splice(index, 1);
    return Promise.resolve();
  }
  return redis.hgetall(`cucek:queue-user:${socketId}`).then(async (user) => {
    if (user.interest) await redis.zrem(`cucek:queue:${user.interest}`, socketId);
    await redis.del(`cucek:queue-user:${socketId}`);
  });
}

function unpair(socketId) {
  const timer = pairTimers.get(socketId);
  if (timer) {
    clearTimeout(timer);
    const peerId = redis ? null : pairedUsers.get(socketId);
    pairTimers.delete(socketId);
    if (peerId) pairTimers.delete(peerId);
  }
  if (redis) {
    return redis.get(`cucek:pair:${socketId}`).then(async (peerId) => {
      if (!peerId) return null;
      await redis.del(`cucek:pair:${socketId}`, `cucek:pair:${peerId}`);
      return peerId;
    });
  }
  const peerId = pairedUsers.get(socketId);
  if (!peerId) return;
  pairedUsers.delete(socketId);
  pairedUsers.delete(peerId);
  return peerId;
}

async function takeCandidate(interest, socketId) {
  if (!redis) {
    const candidateIndex = waitingUsers.findIndex((user) => user.interest === interest && user.socketId !== socketId);
    return candidateIndex >= 0 ? waitingUsers.splice(candidateIndex, 1)[0] : null;
  }
  const candidateIds = await redis.zrange(`cucek:queue:${interest}`, 0, 20);
  for (const candidateId of candidateIds) {
    if (candidateId === socketId) continue;
    if (!(await redis.zrem(`cucek:queue:${interest}`, candidateId))) continue;
    const candidate = await redis.hgetall(`cucek:queue-user:${candidateId}`);
    await redis.del(`cucek:queue-user:${candidateId}`);
    if (candidate.socketId) return candidate;
  }
  return null;
}

async function addToQueue(user) {
  if (!redis) {
    waitingUsers.push(user);
    return;
  }
  await redis.hset(`cucek:queue-user:${user.socketId}`, user);
  await redis.zadd(`cucek:queue:${user.interest}`, Date.now(), user.socketId);
}

async function setPair(firstSocketId, secondSocketId) {
  if (!redis) {
    pairedUsers.set(firstSocketId, secondSocketId);
    pairedUsers.set(secondSocketId, firstSocketId);
  } else {
    await redis.set(`cucek:pair:${firstSocketId}`, secondSocketId, 'EX', MATCH_DURATION_MS / 1000);
    await redis.set(`cucek:pair:${secondSocketId}`, firstSocketId, 'EX', MATCH_DURATION_MS / 1000);
  }
  const timer = setTimeout(async () => {
    const peerId = await unpair(firstSocketId);
    if (peerId) {
      io.to(firstSocketId).emit('match-expired');
      io.to(peerId).emit('match-expired');
    }
  }, MATCH_DURATION_MS);
  pairTimers.set(firstSocketId, timer);
  pairTimers.set(secondSocketId, timer);
}

async function getPeerId(socketId) {
  return redis ? redis.get(`cucek:pair:${socketId}`) : pairedUsers.get(socketId);
}

async function broadcastOnlineCount() {
  if (onlineCountBroadcastTimer) return;
  onlineCountBroadcastTimer = setTimeout(async () => {
    onlineCountBroadcastTimer = null;
    try {
      const count = redis
        ? await redis.scard(onlineSocketsKey)
        : io.sockets.sockets.size;
      io.emit('online-count', count);
    } catch (error) {
      console.error('Online count update failed:', error.message);
    }
  }, 1000);
}

const app = express();
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOriginSet.has(origin) || (process.env.NODE_ENV !== 'production' && isLocalOrigin(origin))) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '32kb' }));
if (existsSync(distDirectory)) {
  app.use(express.static(distDirectory));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api') || request.path.startsWith('/socket.io')) {
      next();
      return;
    }
    response.sendFile(resolve(distDirectory, 'index.html'), (error) => {
      if (error) next(error);
    });
  });
}
app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'cusat-connect-server', redis: Boolean(redis), mongo: mongoose.connection.readyState === 1 }));
app.post('/api/auth/anonymous', (request, response) => {
  const result = anonymousAuthSchema.safeParse(request.body || {});
  if (!result.success) return response.status(400).json({ error: 'Invalid anonymous profile', details: result.error.flatten() });
  const session = issueToken();
  response.status(201).json({ ...session, displayName: result.data.displayName || 'Anonymous student', expiresIn: '12h' });
});
app.get('/api/auth/me', requireAuth, (request, response) => response.json({ userId: request.user.sub, role: request.user.role }));
app.get('/api/webrtc-config', requireAuth, async (_request, response) => response.json({ iceServers: await getIceServers() }));
app.post('/api/reports', requireAuth, async (request, response) => {
  const result = reportInputSchema.safeParse(request.body || {});
  if (!result.success) return response.status(400).json({ error: 'Invalid report', details: result.error.flatten() });
  try {
    if (mongoose.connection.readyState === 1) await Report.create({ reporterId: request.user.sub, ...result.data });
    response.status(201).json({ accepted: true });
  } catch (error) {
    response.status(500).json({ error: 'Could not save report' });
  }
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 100000,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
});
if (redis) io.adapter(createAdapter(redisPub, redisSub));

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  if (redis) redis.sadd(onlineSocketsKey, socket.id).catch(() => {});
  socket.emit('online-count', redis ? 0 : io.sockets.sockets.size);
  broadcastOnlineCount().catch(() => {});

  socket.on('join-queue', async (input) => {
    const result = queueInputSchema.safeParse(input);
    if (!result.success) {
      socket.emit('match-error', { message: 'Invalid matching preferences.' });
      return;
    }
    const { interest, displayName, location } = result.data;
    const ownerAccess = hasOwnerAccess(displayName, result.data.ownerNamePassword);
    if (isReservedDisplayName(displayName) && !ownerAccess) {
      socket.emit('match-error', { message: 'That name is reserved. Enter the owner password to use it.' });
      return;
    }
    const campus = nearestCampus(location);
    if (campus.distance > CAMPUS_RADIUS_KM) {
      socket.emit('match-error', { message: `You must be within ${CAMPUS_RADIUS_KM} km of CUCEK or CUSAT to match.` });
      return;
    }
    await removeFromQueue(socket.id);
    socket.data.role = ownerAccess ? 'admin' : 'student';
    const candidate = await takeCandidate(interest, socket.id);
    if (!candidate) {
      await addToQueue({ socketId: socket.id, interest, displayName, campus: campus.name });
      socket.emit('queue-joined');
      return;
    }
    await setPair(socket.id, candidate.socketId);
    io.to(socket.id).emit('match-found', { peerId: candidate.socketId, initiator: true, partnerName: candidate.displayName });
    io.to(candidate.socketId).emit('match-found', { peerId: socket.id, initiator: false, partnerName: displayName });
  });

  socket.on('signal', async ({ peerId, signal }) => {
    if (await getPeerId(socket.id) === peerId) io.to(peerId).emit('signal', { peerId: socket.id, signal });
  });

  socket.on('leave-queue', () => removeFromQueue(socket.id));
  socket.on('leave-call', async () => {
    const peerId = await unpair(socket.id);
    if (peerId) io.to(peerId).emit('peer-left');
  });
  socket.on('report', async ({ reason }) => {
    const peerId = await getPeerId(socket.id);
    const result = reportInputSchema.safeParse({ reason: reason || 'unspecified', sessionId: peerId });
    if (!result.success) return;
    if (mongoose.connection.readyState === 1) await Report.create({ reporterId: socket.user.sub, ...result.data });
    socket.emit('report-accepted');
  });
  socket.on('disconnect', async () => {
    if (redis) redis.srem(onlineSocketsKey, socket.id).catch(() => {});
    await removeFromQueue(socket.id);
    const peerId = await unpair(socket.id);
    if (peerId) io.to(peerId).emit('peer-left');
    broadcastOnlineCount().catch(() => {});
  });
});

async function start() {
  if (redis) {
    await connectRedis();
    console.log('Redis connected; multi-instance mode enabled');
  }
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, mongoOptions);
      console.log('MongoDB connected');
    } catch (error) {
      console.error('MongoDB connection failed; continuing without persistence:', error.message);
    }
  } else {
    console.log('MONGODB_URI not set; reports will not be persisted.');
  }
  httpServer.listen(PORT, () => console.log(`CUSAT Connect server listening on http://localhost:${PORT}`));
}

start();
