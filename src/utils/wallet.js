/**
 * HD Wallet utility — BIP44 derivation via ethers.js v6
 *
 * Each user gets a unique EVM address derived from master mnemonic:
 *   m/44'/60'/0'/0/{userIndex}
 *
 * The same address works for ETH mainnet and BSC (same secp256k1 key).
 *
 * Env vars:
 *   WALLET_MNEMONIC  — 12/24 word BIP39 mnemonic (master seed)
 *   HOT_WALLET_KEY   — private key of hot wallet used for withdrawals
 */

const { ethers } = require('ethers')

const BASE_PATH = "m/44'/60'/0'/0"

let _hdNode = null

function getHdNode() {
  if (_hdNode) return _hdNode
  const mnemonic = process.env.WALLET_MNEMONIC
  if (!mnemonic) throw new Error('WALLET_MNEMONIC env var not set')
  _hdNode = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(mnemonic))
  return _hdNode
}

/**
 * Derive unique EVM deposit address for a user
 * @param {number} userIndex  - integer index stored per user
 * @returns {{ address: string, path: string }}
 */
function deriveAddress(userIndex) {
  const node = getHdNode()
  const child = node.derivePath(`${BASE_PATH}/${userIndex}`)
  return { address: child.address, path: `${BASE_PATH}/${userIndex}` }
}

/**
 * Derive full signing wallet for a user index (for internal use / verification only)
 * WARNING: never expose private key to frontend
 */
function deriveWallet(userIndex, provider) {
  const node = getHdNode()
  const child = node.derivePath(`${BASE_PATH}/${userIndex}`)
  return provider ? child.connect(provider) : child
}

/**
 * Get hot wallet used for sending withdrawals
 */
function getHotWallet(provider) {
  const key = process.env.HOT_WALLET_KEY
  if (!key) throw new Error('HOT_WALLET_KEY env var not set')
  return new ethers.Wallet(key, provider)
}

/**
 * Validate an EVM address
 */
function isValidAddress(addr) {
  try {
    ethers.getAddress(addr)
    return true
  } catch {
    return false
  }
}

/**
 * Deterministic integer index from UUID string
 * Takes first 8 hex chars of UUID → integer 0..4294967295
 * Stable: same user always gets same index
 */
function uuidToIndex(uuid) {
  const hex = uuid.replace(/-/g, '').slice(0, 8)
  return parseInt(hex, 16)
}

module.exports = { deriveAddress, deriveWallet, getHotWallet, isValidAddress, uuidToIndex }
