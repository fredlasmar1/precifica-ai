// Avaliação de propriedades RURAIS (chácara / sítio / fazenda) para a web.
// Reusa o motor rural do precificador (base R$/alqueire + ajustes de subtipo,
// acesso ao asfalto, água, energia e benfeitorias) — o mesmo que o bot do
// Telegram usa. Unidade canônica: alqueire goiano (1 alq = 48.400 m² = 4,84 ha).

const { calcularPreco } = require('./precificador');
const ALQ_M2 = 48400, ALQ_HA = 4.84;

/**
 * input: { cidade, referencia (rodovia/região), subtipo (chacara|sitio|fazenda),
 *          area, unidade (alqueire|hectare), acesso (beira|asfalto|chao),
 *          agua (bool), energia (bool), benfeitorias (csv|array), finalidade }
 */
async function avaliarFazenda(input = {}) {
  const cidade = String(input.cidade || '').trim() || 'Anápolis';
  const referencia = String(input.referencia || '').trim() || null;
  const subtipo = ['chacara', 'sitio', 'fazenda'].includes(input.subtipo) ? input.subtipo : 'fazenda';
  const unidade = input.unidade === 'hectare' ? 'hectare' : 'alqueire';
  const areaIn = Number(input.area) || 0;
  if (areaIn <= 0) return { erro: 'Informe a área da propriedade (alqueires ou hectares).' };

  const areaAlq = unidade === 'hectare' ? Math.round((areaIn / ALQ_HA) * 1000) / 1000 : areaIn;
  const areaHa = Math.round(areaAlq * ALQ_HA * 10) / 10;
  const metragem = Math.round(areaAlq * ALQ_M2);
  const acesso = input.acesso; // 'beira' | 'asfalto' | 'chao'
  const finalidade = input.finalidade === 'aluguel' ? 'aluguel' : 'venda';
  const benfeitorias = Array.isArray(input.benfeitorias)
    ? input.benfeitorias.filter(Boolean)
    : String(input.benfeitorias || '').split(',').map(s => s.trim()).filter(Boolean);

  const dados = {
    tipo: 'rural', finalidade, cidade, bairro: referencia,
    metragem, subTipoRural: subtipo, areaAlqueires: areaAlq,
    margemAsfalto: acesso === 'beira',
    acessoAsfalto: acesso === 'beira' || acesso === 'asfalto',
    temAgua: !!input.agua, temEnergia: !!input.energia,
    benfeitorias, rodoviaReferencia: referencia,
  };
  const resultado = await calcularPreco(dados);
  return { dados, resultado, areaAlq, areaHa, subtipo, cidade, referencia };
}

function formatarFazenda(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível avaliar a propriedade.'}`;
  const { resultado: R, dados, areaAlq, areaHa, subtipo, cidade, referencia } = r;
  if (!R || R.erro) return `⚠️ ${R?.erro || 'Não consegui avaliar a propriedade rural.'}`;
  const m = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR')}`;
  const total = R.precoRecomendado || 0;
  const precoAlq = R.precoAlqImovel || (areaAlq > 0 ? Math.round(total / areaAlq) : 0);
  const precoHa = Math.round(precoAlq / ALQ_HA);
  const emoji = subtipo === 'fazenda' ? '🌾' : subtipo === 'sitio' ? '🌿' : '🏡';
  const subLabel = subtipo.charAt(0).toUpperCase() + subtipo.slice(1);
  const finLabel = dados.finalidade === 'aluguel' ? 'Aluguel' : 'Venda';

  let t = `${emoji} *LAUDO RURAL — ${subLabel}* • ${finLabel}\n`;
  t += `📍 ${[referencia, cidade].filter(Boolean).join(', ')}-GO\n`;
  t += `📐 ${areaAlq} alqueire(s) goiano(s) · ${areaHa} ha\n`;
  const acesso = dados.margemAsfalto ? 'Beira de asfalto' : dados.acessoAsfalto ? 'Acesso pelo asfalto' : 'Acesso por chão';
  t += `🛣️ ${acesso}\n`;
  const infra = [dados.temAgua ? '💧 Água' : '', dados.temEnergia ? '⚡ Energia' : ''].filter(Boolean).join(' • ');
  if (infra) t += `${infra}\n`;
  if (dados.benfeitorias && dados.benfeitorias.length) t += `🏗️ ${dados.benfeitorias.join(', ')}\n`;

  t += `\n💰 *Faixa de valor:*\n• Mínimo: *${m(R.precoMinimo)}*\n• Recomendado: *${m(total)}*\n• Máximo: *${m(R.precoMaximo)}*\n`;
  t += `\n📊 *Por alqueire: ${m(precoAlq)}/alq*  ·  *Por hectare: ${m(precoHa)}/ha*\n`;
  if (R.precoAlqMercado) t += `• Referência de mercado: ${m(R.precoAlqMercado)}/alq\n`;
  t += `\n⚡ *Liquidez:* ${R.indiceLiquidez || '—'}${R.tempoEstimadoDias ? ` · ~${R.tempoEstimadoDias} dias` : ''}\n`;

  if (Array.isArray(R.ajustesAplicados) && R.ajustesAplicados.length) {
    t += `\n🔧 *Ajustes aplicados:*\n`;
    R.ajustesAplicados.slice(0, 8).forEach(a => { t += `• ${a}\n`; });
  }
  const comps = (R.analiseIA && R.analiseIA.comparativos) || [];
  if (comps.length) {
    t += `\n🔎 *Comparativos de mercado:*\n`;
    comps.slice(0, 5).forEach(c => {
      const desc = c.descricao || c.titulo || c.fonte || 'anúncio';
      t += `• ${desc}${c.preco ? ` — ${m(c.preco)}` : ''}${c.url ? `\n  ${c.url}` : ''}\n`;
    });
  }
  try {
    const { textoFontes } = require('./fontes');
    t += textoFontes({
      metodo: 'Avaliação rural por R$/alqueire (base regional) + ajustes de subtipo, acesso ao asfalto, água/energia e benfeitorias.',
      data: new Date().toLocaleDateString('pt-BR'),
      grau: R.confiancaFonte === 'alta' ? 'II (amostra robusta)' : 'I (referência)',
      portais: R.fontesConsultadas,
      bases: ['Base rural R$/alqueire (Goiás)', 'INCRA/VTN e mercado regional como referência'],
      obs: 'Estimativa mercadológica de apoio. O valor de terra rural varia MUITO por aptidão (lavoura vs pastagem), água, topografia, documentação (CAR/georreferenciamento) e região — confirme com vistoria e a Planta de Valores / VTN-INCRA do município. 1 alqueire goiano = 4,84 ha.',
    });
  } catch {}
  return t;
}

module.exports = { avaliarFazenda, formatarFazenda };
