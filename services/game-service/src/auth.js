const jwt = require('jsonwebtoken')

// Tokens are issued by auth-service. We only verify the signature locally — no network call per connection.
function verifyToken(token, secret) {
  const p = jwt.verify(token, secret, { algorithms: ['HS256'] })
  if (!p.sub || !p.username) throw new Error('bad token payload')
  return { id: String(p.sub), username: String(p.username), guest: !!p.guest }
}
module.exports = { verifyToken }
