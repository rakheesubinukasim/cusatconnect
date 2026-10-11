# CUSAT Connect

Anonymous video matching with a React frontend, Express/Socket.IO signaling server, WebRTC media, JWT sessions, optional Redis active-session storage, and MongoDB report persistence. Users within 10 km of either CUCEK or CUSAT can join, while the owner username can join from anywhere. Each video connection lasts three minutes before the next person is matched automatically.

## Run locally

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`; set `JWT_SECRET` for any shared environment, and set `MONGODB_URI` or `REDIS_URL` when those services are available.
3. Start frontend and signaling server: `npm run dev` (or `npm run dev:full`)
4. Open `http://localhost:5173`.

The development command is safe to run again while the app is already running; it reuses services on ports 4000 and 5173 instead of starting duplicate processes.

For a single-server deployment, run `npm start`. This builds the React app and serves the frontend, API, and Socket.IO signaling server from `PORT` (default `4000`). Set `CLIENT_ORIGIN` to the public HTTPS origin and configure the deployment platform to run `npm start`.

Users choose a username when they enter. The exact username `Rakheesubinu Kasim` requires the private `OWNER_NAME_PASSWORD` value from `.env`; other usernames do not need a password but must share browser location and be within 10 km of CUCEK or CUSAT. The server binds every API and Socket.IO session to the authenticated username. Set a strong password before sharing a deployment.

Camera, microphone, and geolocation require `localhost` or HTTPS. The server validates that non-owner users are within 10 km of either CUCEK or CUSAT; owner access bypasses the radius check.

The API issues anonymous 12-hour JWTs at `POST /api/auth/anonymous`. Reports require `Authorization: Bearer <token>`. Socket.IO requires the same token in the handshake auth payload. Redis is optional locally and is used for active-session TTLs when configured.

### TURN video transport

Video sessions use the built-in Socket.IO/WebRTC signaling path. Configure one public TURN server in `.env` for users behind restrictive NATs:

```env
STUN_URL=stun:13.127.200.56:3478
VITE_SERVER_URL=turn:your-turn-server.example:3478
VITE_TURN_USERNAME=your_turn_username
VITE_TURN_PASSWORD=your_turn_password
```

The backend exposes these ICE servers through the authenticated `/api/webrtc-config` route. TURN credentials stay server-side and are never compiled into the frontend.

### MongoDB Atlas

Set the Atlas connection string in the local `.env` file. Replace the placeholders with your Atlas database user and password, URL-encoding special password characters such as `@`, `:`, `/`, or `#`.

```env
MONGODB_URI=mongodb+srv://<db_user>:<db_password>@cluster0.kbm0yq3.mongodb.net/?appName=Cluster0
MONGODB_DB=cucek_connect
```

In MongoDB Atlas, add the development machine's IP address under Network Access and ensure the database user has permission to read and write the selected database. Start the server with `npm run server`; `/api/health` reports `"mongo":true` when the connection succeeds. Reports are stored in the `reports` collection.

### Public WebRTC access

The relay warning means direct ICE failed. For users on different networks, configure `VITE_SERVER_URL`, `VITE_TURN_USERNAME`, and `VITE_TURN_PASSWORD` in `.env`; STUN alone is not sufficient. Set `CLIENT_ORIGIN` to the exact public HTTPS frontend origin, deploy the Node server on a public HTTPS/WSS-capable host, and configure the frontend proxy or production API URL to reach that server. Do not use `*` with credentialed CORS.

## Production shape

Host the React build on a static host/CDN, run `server/index.js` on a Node-capable service, use MongoDB Atlas for persistence, and configure a TURN server for users behind restrictive NATs. Set `CLIENT_ORIGIN` to the deployed frontend origin.

### 2,000+ concurrent users

The browser handles media through WebRTC, while the Node server handles authentication, matching, and signaling. For 2,000+ concurrent users:

1. Use a managed Redis instance and set `REDIS_URL`. Redis is used for the Socket.IO adapter and shared matching/pair state, allowing multiple backend instances to work as one service.
2. Run multiple Node instances behind an HTTPS load balancer. Enable WebSocket upgrades; Socket.IO connection-state recovery and the Redis adapter allow clients to reconnect to another instance.
3. Set `PORT=4000` for the backend and keep the frontend on a static host/CDN. Route `/api` and `/socket.io` to the backend.
4. Use a managed TURN service and rotate its credentials regularly.
5. Use a managed MongoDB deployment for reports and monitor Redis memory, backend CPU, connection count, and Socket.IO errors.
6. Keep video media peer-to-peer or on TURN; do not proxy video through Node. Size TURN capacity separately because every connected pair can use relay bandwidth.

Without Redis, the server remains suitable for local development but queue and pair state are process-local; it must not be scaled horizontally.

### TURN and public deployment checklist

1. Copy `.env.example` to `.env` on the backend host only.
2. Set the real TURN server values in that backend `.env`.

3. Deploy the frontend and backend over HTTPS. Browsers block camera and microphone access from a plain HTTP public site.
4. Configure the backend:

```env
PORT=4000
CLIENT_ORIGIN=https://your-frontend.example
JWT_SECRET=generate-a-long-random-value
```

5. Configure the frontend so `/api` and `/socket.io` are reverse-proxied to the backend, or deploy both behind the same HTTPS domain. Socket.IO WebSocket upgrades must be enabled.
6. Verify the backend before testing video:

```text
https://your-backend.example/api/health
```

It should return `ok: true`. Then open the frontend on two different networks and allow camera, microphone, and location permissions.
