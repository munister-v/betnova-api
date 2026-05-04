// Shared helper to broadcast a win to all connected clients via Socket.io
// Call after recording a win in game_history

let _io = null

function setIo(io) {
  _io = io
}

const GAME_EMOJI = {
  crash:   '🚀',
  coinflip:'🪙',
  roulette:'🎡',
  mine:    '💎',
  plinko:  '🔮',
  dice:    '🎲',
  hilo:    '🃏',
  slots:   '🎰',
  blackjack:'♠️',
  jackpot: '🏆',
}

/**
 * Emit a live win event to all connected clients
 * @param {object} opts
 * @param {string} opts.gameType
 * @param {string} opts.username
 * @param {string|null} opts.avatarUrl
 * @param {number} opts.betAmount
 * @param {number} opts.profit      - net profit (can be negative)
 * @param {number} opts.multiplier
 */
function emitWin({ gameType, username, avatarUrl, betAmount, profit, multiplier }) {
  if (!_io || profit <= 0) return
  _io.emit('live:win', {
    gameType,
    emoji: GAME_EMOJI[gameType] || '🎲',
    username: username || 'Anonymous',
    avatarUrl: avatarUrl || null,
    betAmount: parseFloat(betAmount.toFixed(2)),
    profit:    parseFloat(profit.toFixed(2)),
    multiplier: parseFloat(parseFloat(multiplier).toFixed(2)),
    ts: Date.now(),
  })
}

module.exports = { setIo, emitWin }
