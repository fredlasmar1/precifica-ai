const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(process.cwd(), '.perplexity-cache.json');

/**
 * Cache persistente em arquivo JSON.
 * Sobrevive a redeploys do Railway (diferente do NodeCache em memória).
 * Cada entrada tem TTL em milissegundos.
 */

let _data = {};

// Carrega cache do disco na inicialização
function load() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      // Limpa entradas expiradas
      const now = Date.now();
      let cleaned = 0;
      for (const key of Object.keys(_data)) {
        if (_data[key].expiresAt && _data[key].expiresAt < now) {
          delete _data[key];
          cleaned++;
        }
      }
      const total = Object.keys(_data).length;
      console.log(`[Cache] Carregado: ${total} entradas (${cleaned} expiradas removidas)`);
    }
  } catch (err) {
    console.warn('[Cache] Erro ao carregar:', err.message);
    _data = {};
  }
}

function save() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_data), 'utf-8');
  } catch (err) {
    console.warn('[Cache] Erro ao salvar:', err.message);
  }
}

/**
 * Busca no cache. Retorna null se não encontrado ou expirado.
 */
function get(key) {
  const entry = _data[key];
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    delete _data[key];
    return null;
  }
  return entry.value;
}

/**
 * Salva no cache com TTL em segundos.
 */
function set(key, value, ttlSeconds) {
  _data[key] = {
    value,
    expiresAt: Date.now() + (ttlSeconds * 1000),
    savedAt: new Date().toISOString()
  };
  save();
}

/**
 * Busca por chave similar (match parcial).
 * Útil para reaproveitar pesquisa de bairro/tipo parecido.
 * Ex: terreno 360m² e terreno 380m² no mesmo bairro podem usar o mesmo cache.
 */
function getSimilar(prefix) {
  const now = Date.now();
  for (const key of Object.keys(_data)) {
    if (key.startsWith(prefix) && _data[key].expiresAt > now) {
      return _data[key].value;
    }
  }
  return null;
}

// Inicializa
load();

module.exports = { get, set, getSimilar };
