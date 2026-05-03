require('dotenv').config()

module.exports = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET || 'changeme',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  cookieSecret: process.env.COOKIE_SECRET || 'changeme',
  cookieDomain: process.env.COOKIE_DOMAIN || 'localhost',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  houseEdge: parseFloat(process.env.HOUSE_EDGE || '2'),
  crashHashSeed: process.env.CRASH_HASH_SEED || 'default-seed',
  nowpayments: {
    apiKey: process.env.NOWPAYMENTS_API_KEY || '',
    ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET || '',
    callbackUrl: process.env.NOWPAYMENTS_CALLBACK_URL || '',
  },
}
