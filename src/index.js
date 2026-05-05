require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const helmet = require('helmet')
const morgan = require('morgan')

const config = require('./config')
const { setupSocket } = require('./services/socketService')
const CrashEngine = require('./services/crashEngine')
const RouletteEngine = require('./services/rouletteEngine')
const { setIo } = require('./utils/emitWin')
const { startPriceRefresh } = require('./services/priceService')
const depositMonitor = require('./services/depositMonitor')

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: config.frontendUrl,
    credentials: true,
  },
})

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(morgan('dev'))
app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}))
app.use(express.json())
app.use(cookieParser(config.cookieSecret))

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'))
app.use('/api/user', require('./routes/user'))
app.use('/api/crash', require('./routes/crash'))
app.use('/api/coinflip', require('./routes/coinflip'))
app.use('/api/roulette', require('./routes/roulette'))
app.use('/api/mine', require('./routes/mine'))
app.use('/api/chat', require('./routes/chat'))
app.use('/api/xp', require('./routes/xp'))
app.use('/api/transaction', require('./routes/transaction'))
app.use('/api/payment', require('./routes/payment'))
app.use('/api/game-history', require('./routes/gameHistory'))
app.use('/api/game-status', require('./routes/gameStatus'))
app.use('/api/referrals', require('./routes/referrals'))
app.use('/api/slots', require('./routes/slots'))
app.use('/api/blackjack', require('./routes/blackjack'))
const jackpotRouter = require('./routes/jackpot')
app.use('/api/jackpot', jackpotRouter)
app.use('/api/promo', require('./routes/promo'))
app.use('/api/bonus', require('./routes/bonus'))
app.use('/api/plinko', require('./routes/plinko'))
app.use('/api/dice', require('./routes/dice'))
app.use('/api/hilo', require('./routes/hilo'))
app.use('/api/keno', require('./routes/keno'))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }))

// 404
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }))

// Error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ success: false, error: 'Internal server error' })
})

// ── WebSocket ────────────────────────────────────────────────────────────────
setupSocket(io, app)
setIo(io) // allow routes to emit live:win events

// ── Payment services ─────────────────────────────────────────────────────────
startPriceRefresh()
if (process.env.WALLET_MNEMONIC) {
  depositMonitor.start()
} else {
  console.warn('[payment] WALLET_MNEMONIC not set — deposit monitoring disabled')
}

// ── Crash engine ─────────────────────────────────────────────────────────────
const crashEngine = new CrashEngine(io)
crashEngine.start()

// ── Roulette engine ─────────────────────────────────────────────────────────
const rouletteEngine = new RouletteEngine(io)
rouletteEngine.start()

// ── Jackpot io ref ───────────────────────────────────────────────────────────
app.set('io', io)

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`🚀 Server running on port ${config.port}`)
  console.log(`📡 Frontend: ${config.frontendUrl}`)
})
