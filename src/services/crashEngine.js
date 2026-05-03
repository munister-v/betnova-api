const { supabaseAdmin } = require('../config/supabase')
const { generateCrashMultiplier, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const config = require('../config')

const BETTING_PHASE_MS = 8000   // 8 sec to place bets
const TICK_MS = 100             // update multiplier every 100ms

class CrashEngine {
  constructor(io) {
    this.io = io
    this.currentGame = null
    this.tickInterval = null
    this.startTime = null
    this.crashMultiplier = null
    this.currentMultiplier = 1.0
    this.running = false
  }

  start() {
    if (this.running) return
    this.running = true
    console.log('🎲 Crash engine started')
    this.startNewRound()
  }

  stop() {
    this.running = false
    if (this.tickInterval) clearInterval(this.tickInterval)
  }

  async startNewRound() {
    if (!this.running) return

    const serverSeed = generateServerSeed()
    const clientSeed = generateClientSeed()
    this.crashMultiplier = generateCrashMultiplier(serverSeed, clientSeed, 0, config.houseEdge)

    const { data: game } = await supabaseAdmin
      .from('crash_games')
      .insert({
        status: 'waiting',
        server_seed: serverSeed,
        server_seed_hash: hashSeed(serverSeed),
        crash_multiplier: this.crashMultiplier,
        hash: hashSeed(serverSeed),
      })
      .select()
      .single()

    this.currentGame = game
    this.currentMultiplier = 1.0

    this.io.emit('crash:waiting', {
      gameId: game.id,
      hash: game.hash,
      bettingEndsIn: BETTING_PHASE_MS,
    })

    console.log(`🎲 Round ${game.id} — betting open, crash at ${this.crashMultiplier}x`)

    setTimeout(() => this.beginFlight(), BETTING_PHASE_MS)
  }

  async beginFlight() {
    if (!this.currentGame) return

    await supabaseAdmin
      .from('crash_games')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', this.currentGame.id)

    this.startTime = Date.now()

    this.io.emit('crash:started', { gameId: this.currentGame.id })

    this.tickInterval = setInterval(() => this.tick(), TICK_MS)
  }

  tick() {
    const elapsed = (Date.now() - this.startTime) / 1000
    // Multiplier grows exponentially: e^(0.06*t)
    this.currentMultiplier = Math.floor(Math.pow(Math.E, 0.06 * elapsed) * 100) / 100

    // Update DB multiplier every second
    if (Math.round(elapsed * 10) % 10 === 0) {
      supabaseAdmin
        .from('crash_games')
        .update({ multiplier: this.currentMultiplier })
        .eq('id', this.currentGame.id)
        .then(() => {})
    }

    this.io.emit('crash:tick', {
      gameId: this.currentGame.id,
      multiplier: this.currentMultiplier,
    })

    if (this.currentMultiplier >= this.crashMultiplier) {
      this.crash()
    }
  }

  async crash() {
    clearInterval(this.tickInterval)
    this.tickInterval = null

    await supabaseAdmin
      .from('crash_games')
      .update({
        status: 'crashed',
        multiplier: this.crashMultiplier,
        ended_at: new Date().toISOString(),
      })
      .eq('id', this.currentGame.id)

    // Mark all remaining active bets as lost
    await supabaseAdmin
      .from('crash_bets')
      .update({ status: 'lost' })
      .eq('game_id', this.currentGame.id)
      .eq('status', 'active')

    this.io.emit('crash:crashed', {
      gameId: this.currentGame.id,
      multiplier: this.crashMultiplier,
    })

    console.log(`💥 Round ${this.currentGame.id} crashed at ${this.crashMultiplier}x`)

    // Wait 3 seconds then start next round
    setTimeout(() => this.startNewRound(), 3000)
  }
}

module.exports = CrashEngine
