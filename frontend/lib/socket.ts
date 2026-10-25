import { io, type Socket } from 'socket.io-client'

// Empty string = same origin; the nginx gateway forwards /socket.io to game-service.
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? ''

// Keep in sync with docs/events.md and the backend.
export const EVENTS = {
  // client -> server
  ROOM_CREATE: 'room:create',
  ROOM_JOIN: 'room:join',
  ROOM_READY: 'room:ready',
  ROOM_KICK: 'room:kick',
  GAME_START: 'game:start',
  WORD_SUBMIT: 'word:submit',
  ROOM_LEAVE: 'room:leave',
  // server -> client
  ROOM_STATE: 'room:state',
  PLAYER_JOINED: 'player:joined',
  PLAYER_LEFT: 'player:left',
  PLAYER_DISCONNECTED: 'player:disconnected',
  PLAYER_RECONNECTED: 'player:reconnected',
  ROUND_START: 'round:start',
  WORD_RESULT: 'word:result',
  SCORE_UPDATE: 'score:update',
  ROUND_END: 'round:end',
  GAME_END: 'game:end',
} as const

let socket: Socket | null = null
let currentToken: string | null = null

// One shared connection for the whole app (landing page -> room page keep the same socket).
export function connectSocket(token: string): Socket {
  if (socket && currentToken === token) return socket
  socket?.disconnect()
  currentToken = token
  // WebSocket only: every game-service replica accepts any socket (room state lives behind Redis), so the load
  // balancer needs no session affinity and there is no long-polling fallback that would require it.
  socket = io(SOCKET_URL || undefined, { auth: { token }, transports: ['websocket'] })
  return socket
}

export function getSocket(): Socket | null {
  return socket
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
  currentToken = null
}

// Emit an event and wait for the server's acknowledgement ({ ok, ... }). Never rejects:
// a timeout or missing connection comes back as { ok: false, error: 'TIMEOUT' }.
export function emitAck<T extends { ok: boolean } = { ok: boolean; error?: string; message?: string }>(
  event: string,
  payload: object = {},
  timeoutMs = 8000
): Promise<T> {
  return new Promise((resolve) => {
    if (!socket) return resolve({ ok: false, error: 'NO_SOCKET', message: 'Not connected to the game server' } as unknown as T)
    socket.timeout(timeoutMs).emit(event, payload, (err: Error | null, res: T) => {
      if (err) resolve({ ok: false, error: 'TIMEOUT', message: 'The game server did not answer. Please try again.' } as unknown as T)
      else resolve(res)
    })
  })
}
