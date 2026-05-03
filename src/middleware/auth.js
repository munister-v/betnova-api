const jwt = require('jsonwebtoken')
const config = require('../config')

function authMiddleware(req, res, next) {
  const token = req.cookies?.platform_token

  if (!token) {
    return res.status(401).json({ success: false, error: 'Not authenticated' })
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret)
    req.user = payload
    next()
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' })
  }
}

// Optional auth — attaches user if token present, doesn't block
function optionalAuth(req, res, next) {
  const token = req.cookies?.platform_token
  if (token) {
    try {
      req.user = jwt.verify(token, config.jwtSecret)
    } catch (_) {}
  }
  next()
}

module.exports = { authMiddleware, optionalAuth }
