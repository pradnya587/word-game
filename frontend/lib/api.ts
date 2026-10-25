import type { Session } from '@/types'

// Empty string = same origin, i.e. the browser talks to the nginx gateway which routes to auth-service.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''
export const MOCK = process.env.NEXT_PUBLIC_MOCK !== 'false'

async function post(path: string, body: unknown): Promise<Session> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong')
  return data // { token, user: { id, username } }
}

// auth-service: POST /api/auth/login    { email, password }
export async function login(input: { email: string; password: string }): Promise<Session> {
  if (MOCK) return { token: 'mock-token', user: { id: 'mock', username: input.email.split('@')[0] } }
  return post('/api/auth/login', input)
}

// auth-service: POST /api/auth/register { username, email, password }
export async function register(input: { username: string; email: string; password: string }): Promise<Session> {
  if (MOCK) return { token: 'mock-token', user: { id: 'mock', username: input.username } }
  return post('/api/auth/register', input)
}

// auth-service: POST /api/auth/guest — a temporary identity so guests can play too.
export async function guest(): Promise<Session> {
  if (MOCK) return { token: 'mock-token', user: { id: 'guest', username: 'Guest' } }
  return post('/api/auth/guest', {})
}
