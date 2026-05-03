const { supabaseAdmin } = require('../config/supabase')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const config = require('../config')

const BETTING_MS = 25000   // 25s for betting
const SPIN_MS = 5000       // 5s spin animation
const RED_NUMBERS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]
const BLACK_NUMBERS = [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]

function payoutFor(number, betType) {
  if (betType === 'red' && RED_NUMBERS.includes(number)) return 2
  if (betType === 'black' && BLACK_NUMBERS.includes(number)) return 2
  if (betType === 'even' && number !== 0 && number % 2 === 0) return 2
  if (betType === 'odd' && number % 2 !== 0) return 2
  if (betType === '1-18' && number >= 1 && number <= 18) return 2
  if (betType === '19-36' && number >= 19 && number <= 36) return 2
  if (betType === '1st12' && number >= 1 && number <= 12) return 3
  if (betType === '2nd12' && number >= 13 && number <= 24) return 3
  if (betType === '3rd12' && number >= 25 && number <= 36) return 3
  if (!isNaN(betType) && parseInt(betType) === number) return 36
  return 0
}

class RouletteEngine {
  constructor(io) {
    this.io = io
    this.running = false
  }

  start() {
    if (this.running) return
    this.running = true
    console.log('🎡 Roulette engine started')
    this.startRound().catch(e => console.error('Roulette round error:', e))
  }

  stop() { this.running = false }

  async startRound() {
    if (!this.running) return

    const serverSeed = generateServerSeed()
    const clientSeed = generateClientSeed()
    const now = new Date()
    const bettingClosesAt = new Date(now.getTime() + BETTING_MS)

    const { data: game } = await supabaseAdmin
      .from('roulette_games')
      .insert({
        status: 'betting',
        server_seed: serverSeed,
        server_seed_hash: hashSeed(serverSeed),
        client_seed: clientSeed,
        started_at: now.toISOString(),
        betting_closes_at: bettingClosesAt.toISOString(),
      })
      .select()
      .single()

    if (!game) {
      console.error('Roulette: failed to create game')
      setTimeout(() => this.startRound(), 5000)
      return
    }

    this.io?.emit('roulette:new_round', {
      id: game.id,
      bettingClosesAt: bettingClosesAt.toISOString(),
    })

    setTimeout(() => this.spinAndResolve(game.id, serverSeed, clientSeed), BETTING_MS)
  }

  async spinAndResolve(gameId, serverSeed, clientSeed) {
    const winning = Math.floor(generateFloat(serverSeed, clientSeed, 'roulette') * 37) // 0-36

    await supabaseAdmin
      .from('roulette_games')
      .update({ status: 'spinning' })
      .eq('id', gameId)

    this.io?.emit('roulette:spinning', { id: gameId, result: winning })

    setTimeout(() => this.completeRound(gameId, winning, serverSeed), SPIN_MS)
  }

  async completeRound(gameId, winning, serverSeed) {
    // Resolve all bets
    const { data: bets } = await supabaseAdmin
      .from('roulette_bets')
      .select('*')
      .eq('game_id', gameId)

    for (const bet of bets || []) {
      const mult = payoutFor(winning, bet.bet_type)
      const payout = bet.bet_amount * mult
      const profit = payout - bet.bet_amount

      if (payout > 0) {
        const { data: u } = await supabaseAdmin.from('users').select('balance').eq('id', bet.user_id).single()
        await supabaseAdmin.from('users').update({ balance: (u?.balance || 0) + payout }).eq('id', bet.user_id)
      }

      await supabaseAdmin.from('roulette_bets').update({ payout, status: payout > 0 ? 'won' : 'lost' }).eq('id', bet.id)

      await supabaseAdmin.from('game_history').insert({
        user_id: bet.user_id,
        game_type: 'roulette',
        bet_amount: bet.bet_amount,
        profit,
        wagered: bet.bet_amount,
        multiplier: mult,
        metadata: { gameId, betType: bet.bet_type, winningNumber: winning },
      })
    }

    await supabaseAdmin
      .from('roulette_games')
      .update({
        status: 'completed',
        result_number: winning,
        ended_at: new Date().toISOString(),
      })
      .eq('id', gameId)

    this.io?.emit('roulette:completed', { id: gameId, result: winning, serverSeed })

    // Next round
    setTimeout(() => this.startRound(), 2000)
  }
}

module.exports = RouletteEngine
