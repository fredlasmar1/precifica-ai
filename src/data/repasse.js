const OpenAI = require('openai');

/**
 * MODO REPASSE — transforma uma avaliação de mercado em "repasse" (venda
 * rápida abaixo do mercado, estilo carro de repasse). Sugere um desconto pela
 * liquidez, calcula o preço de repasse, a economia do comprador e o tempo de
 * venda acelerado. A "FIPE do imóvel" = o valor de mercado (avaliação por
 * amostragem); o repasse é esse valor menos a margem.
 */
let _openai = null;
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/** Dias-base de venda no mercado, a partir da liquidez estimada. */
function baseDias(indiceLiquidez) {
  const s = String(indiceLiquidez || '').toLowerCase();
  if (s.includes('baixa')) return 150;
  if (s.includes('alta')) return 45;
  return 90; // normal
}

/** Desconto sugerido (%) pela liquidez — menos líquido = mais desconto p/ girar. */
function descontoSugerido(indiceLiquidez) {
  const s = String(indiceLiquidez || '').toLowerCase();
  if (s.includes('baixa')) return 18;
  if (s.includes('alta')) return 8;
  return 12;
}

/** Tempo de venda estimado no preço de repasse (dias). */
function tempoRepasse(dias, descontoPct) {
  const fator = Math.max(0.18, 1 - (Number(descontoPct) || 0) * 0.05);
  return Math.max(15, Math.round(dias * fator));
}

/** Calcula os números do repasse a partir do valor de mercado + desconto. */
function calcularRepasse(resultado, descontoPct) {
  const valorMercado = Number(resultado.precoRecomendado) || 0;
  const desc = Math.max(0, Math.min(40, Number(descontoPct) || 0));
  const repasse = Math.round(valorMercado * (1 - desc / 100));
  const economia = valorMercado - repasse;
  const dias = baseDias(resultado.indiceLiquidez);
  return {
    valorMercado, desconto: desc, repasse, economia,
    economiaPct: desc,
    tempoMercadoDias: dias,
    tempoRepasseDias: tempoRepasse(dias, desc),
  };
}

/** Estratégia de divulgação do repasse (IA, linguagem simples). */
async function estrategiaRepasse(dados, r) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um consultor de vendas imobiliárias em Anápolis-GO. Escreva de forma SIMPLES e prática, em tópicos curtos.' },
        { role: 'user', content: `Um corretor vai vender um(a) ${dados.tipo} no bairro ${dados.bairro} (Anápolis) como REPASSE (venda rápida). Valor de mercado: R$ ${r.valorMercado.toLocaleString('pt-BR')}. Preço de repasse: R$ ${r.repasse.toLocaleString('pt-BR')} (${r.desconto}% abaixo, comprador economiza R$ ${r.economia.toLocaleString('pt-BR')}). Escreva uma estratégia de venda em 4 tópicos curtos: (1) como anunciar destacando a oportunidade, (2) o público certo, (3) o gatilho de urgência, (4) uma dica para fechar rápido. Sem enrolação.` },
      ],
      temperature: 0.5, max_tokens: 320,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[Repasse] estratégia erro:', e.message); return null; }
}

module.exports = { baseDias, descontoSugerido, tempoRepasse, calcularRepasse, estrategiaRepasse };
