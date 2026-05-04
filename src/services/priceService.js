/**
 * Price service — CoinGecko free API, cached in-memory
 * Prices updated every 3 minutes, returns USD value
 */

const axios = require('axios')

const COINGECKO_IDS = {
  ETH:  'ethereum',
  BNB:  'binancecoin',
  USDT: 'tether',
  'USDT-BEP20': 'tether',
}

let _cache = {}
let _lastFetch = 0
const CACHE_TTL = 3 * 60 * 1000 // 3 minutes

async function fetchPrices() {
  try {
    const ids = [...new Set(Object.values(COINGECKO_IDS))].join(',')
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price`,
      { params: { ids, vs_currencies: 'usd' }, timeout: 8000 }
    )
    _cache = data
    _lastFetch = Date.now()
    console.log('[priceService] prices updated:', Object.entries(data).map(([k, v]) => `${k}=$${v.usd}`).join(', '))
  } catch (err) {
    console.warn('[priceService] fetch failed:', err.message)
  }
}

/**
 * Get USD price per 1 unit of asset
 * @param {string} asset  e.g. 'ETH', 'BNB', 'USDT'
 * @returns {number}
 */
async function getUsdPrice(asset) {
  if (Date.now() - _lastFetch > CACHE_TTL) await fetchPrices()
  const geckoId = COINGECKO_IDS[asset.toUpperCase()]
  if (!geckoId) return asset.toUpperCase() === 'USDT' ? 1 : 0
  return _cache[geckoId]?.usd || 0
}

/**
 * Convert crypto amount to USD
 */
async function toUsd(amount, asset) {
  const price = await getUsdPrice(asset)
  return parseFloat((amount * price).toFixed(2))
}

// Start periodic refresh
function startPriceRefresh() {
  fetchPrices()
  setInterval(fetchPrices, CACHE_TTL)
}

module.exports = { getUsdPrice, toUsd, startPriceRefresh }
