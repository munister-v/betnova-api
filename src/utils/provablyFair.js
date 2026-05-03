const crypto = require('crypto')

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex')
}

function generateClientSeed() {
  return crypto.randomBytes(16).toString('hex')
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

// Generates a float 0-1 from server seed + client seed + nonce
function generateFloat(serverSeed, clientSeed, nonce) {
  const hmac = crypto.createHmac('sha256', serverSeed)
  hmac.update(`${clientSeed}:${nonce}`)
  const hash = hmac.digest('hex')
  // Use first 8 hex chars → 32-bit int → float
  const num = parseInt(hash.slice(0, 8), 16)
  return num / 0xffffffff
}

// Crash multiplier from float: house edge applied
function crashMultiplierFromFloat(float, houseEdge = 2) {
  const e = 100 / houseEdge
  if (float * e < 1) return 1.0
  return Math.floor((e / (1 - float)) * 100) / 100
}

function generateCrashMultiplier(serverSeed, clientSeed, nonce, houseEdge) {
  const float = generateFloat(serverSeed, clientSeed, nonce)
  return crashMultiplierFromFloat(float, houseEdge)
}

module.exports = {
  generateServerSeed,
  generateClientSeed,
  hashSeed,
  generateFloat,
  generateCrashMultiplier,
}
