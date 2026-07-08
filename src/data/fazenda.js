// Avaliação de imóveis RURAIS no padrão profissional (referência ABNT NBR 14653-3):
// valor = TERRA NUA (ponderada pela APTIDÃO: lavoura × pastagem × reserva) + BENFEITORIAS,
// com R$/ha por uso puxado ao vivo (Scot/CEPEA/AgriFatto/INCRA via Perplexity) e base
// regional de Goiás como fallback. Método da renda (arrendamento) como 2ª opinião.
// Unidade: alqueire goiano = 4,84 ha.

const axios = require('axios');
const OpenAI = require('openai');
const ALQ_HA = 4.84;

let _openai = null;
function getOpenAI() { if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return _openai; }
function norm(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }

// ── Base regional de Goiás: R$/ha por uso (REFERÊNCIA 2024-25, calibrar) ──
// Fallback quando a busca ao vivo não retorna. Perplexity refina por município.
const REGIOES = {
  sudoeste:   { label: 'Sudoeste goiano (cinturão da soja)', lavoura: 78000, pastagem: 33000, reserva: 11000 },
  cristalina: { label: 'Cristalina/Chapadão (grãos)',        lavoura: 72000, pastagem: 28000, reserva: 9500 },
  sudeste:    { label: 'Sudeste goiano (Catalão/Ipameri)',   lavoura: 55000, pastagem: 26000, reserva: 8500 },
  centro:     { label: 'Centro goiano (Anápolis/entorno)',   lavoura: 45000, pastagem: 23000, reserva: 7500 },
  matogrosso: { label: 'Mato Grosso de Goiás/São Patrício',  lavoura: 42000, pastagem: 22000, reserva: 7000 },
  norte:      { label: 'Norte/Nordeste goiano (pecuária)',   lavoura: 32000, pastagem: 16000, reserva: 5500 },
  default:    { label: 'Goiás (referência geral)',           lavoura: 42000, pastagem: 21000, reserva: 7000 },
};
const MUNI_REGIAO = {
  'rio verde': 'sudoeste', 'jatai': 'sudoeste', 'montividiu': 'sudoeste', 'mineiros': 'sudoeste', 'chapadao do ceu': 'sudoeste', 'santa helena de goias': 'sudoeste', 'quirinopolis': 'sudoeste', 'acreuna': 'sudoeste', 'parauna': 'sudoeste', 'jandaia': 'sudoeste',
  'cristalina': 'cristalina',
  'catalao': 'sudeste', 'ipameri': 'sudeste', 'urutai': 'sudeste', 'pires do rio': 'sudeste', 'goiandira': 'sudeste', 'campo alegre de goias': 'sudeste',
  'anapolis': 'centro', 'silvania': 'centro', 'leopoldo de bulhoes': 'centro', 'goianapolis': 'centro', 'orizona': 'centro', 'vianopolis': 'centro', 'gameleira de goias': 'centro', 'abadiania': 'centro', 'alexania': 'centro', 'corumba de goias': 'centro',
  'itaberai': 'matogrosso', 'inhumas': 'matogrosso', 'itaucu': 'matogrosso', 'ceres': 'matogrosso', 'rialma': 'matogrosso', 'goianesia': 'matogrosso', 'sao luis de montes belos': 'matogrosso', 'jaragua': 'matogrosso',
  'sao miguel do araguaia': 'norte', 'porangatu': 'norte', 'uruacu': 'norte', 'niquelandia': 'norte', 'minacu': 'norte', 'mara rosa': 'norte', 'formoso': 'norte', 'crixas': 'norte', 'nova crixas': 'norte',
};
function regiaoDe(cidade) {
  const k = MUNI_REGIAO[norm(cidade)];
  return k ? { key: k, ...REGIOES[k] } : { key: 'default', ...REGIOES.default };
}

// R$/ha por uso do município (Perplexity ao vivo; fallback base regional)
async function precoHaPorUso(cidade) {
  const reg = regiaoDe(cidade);
  const base = { lavoura: reg.lavoura, pastagem: reg.pastagem, reserva: reg.reserva, vtn: null, fonteLabel: `Base regional — ${reg.label}`, fontes: [], confianca: 'baixa', regiao: reg.label };
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return base;
  try {
    const prompt = `Valor de mercado da TERRA em ${cidade}, Goiás, em 2025, em R$ por HECTARE, por uso. Responda SOMENTE JSON: {"lavoura": R$/ha de terra de lavoura/agricultura mecanizada, "pastagem": R$/ha de terra de pastagem/pecuária, "reserva": R$/ha de reserva/mata (ou null), "vtn": VTN-INCRA R$/ha do município (ou null)}. Baseie em fontes reais (Scot Consultoria, CEPEA/ESALQ, AgriFatto, INCRA). Só números reais; campo desconhecido = null. Nunca invente.`;
    const { data } = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'Especialista em valor de terras agrícolas no Brasil. Responda SOMENTE JSON com números reais de fontes (Scot/CEPEA/AgriFatto/INCRA). Nunca invente.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 400,
    }, { timeout: 60000, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    let s = String(data.choices[0].message.content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}'); if (i >= 0 && j > i) s = s.slice(i, j + 1);
    const d = JSON.parse(s);
    const lav = Number(d.lavoura) || 0, past = Number(d.pastagem) || 0;
    if (lav > 1000 || past > 1000) {
      const pastF = past || reg.pastagem;
      return {
        lavoura: lav || reg.lavoura, pastagem: pastF,
        reserva: Number(d.reserva) > 0 ? Number(d.reserva) : Math.round(pastF * 0.35),
        vtn: Number(d.vtn) > 0 ? Number(d.vtn) : null,
        fonteLabel: `Mercado de ${cidade} (Scot/CEPEA/AgriFatto)`,
        fontes: (data.citations || []).slice(0, 5), confianca: 'media', regiao: reg.label,
      };
    }
  } catch (e) { console.warn('[Fazenda] precoHaPorUso:', e.message); }
  return base;
}

async function avaliarFazenda(input = {}) {
  const cidade = String(input.cidade || 'Anápolis').trim() || 'Anápolis';
  const referencia = String(input.referencia || '').trim() || null;
  const subtipo = ['chacara', 'sitio', 'fazenda'].includes(input.subtipo) ? input.subtipo : 'fazenda';
  const unidade = input.unidade === 'hectare' ? 'hectare' : 'alqueire';
  const finalidade = input.finalidade === 'aluguel' ? 'aluguel' : 'venda';
  const areaIn = Number(input.area) || 0;
  if (areaIn <= 0) return { erro: 'Informe a área da propriedade (alqueires ou hectares).' };
  const areaAlq = unidade === 'hectare' ? Math.round((areaIn / ALQ_HA) * 1000) / 1000 : areaIn;
  const areaHa = Math.round(areaAlq * ALQ_HA * 10) / 10;

  // Aptidão (% de uso). Sem informar → padrão conservador: pasto + reserva.
  let pLav = Number(input.pctLavoura) || 0, pPast = Number(input.pctPastagem) || 0, pRes = Number(input.pctReserva) || 0;
  const soma = pLav + pPast + pRes;
  if (soma <= 0) { pLav = 0; pPast = 80; pRes = 20; }
  else if (Math.abs(soma - 100) > 0.5) { pLav = pLav / soma * 100; pPast = pPast / soma * 100; pRes = pRes / soma * 100; }
  const aptidaoInformada = soma > 0;

  const precos = await precoHaPorUso(cidade);
  const rHaMix = (pLav * precos.lavoura + pPast * precos.pastagem + pRes * precos.reserva) / 100;

  // Fatores sobre a terra nua
  const acesso = input.acesso;
  const fatorAcesso = acesso === 'beira' ? 1.12 : acesso === 'asfalto' ? 1.05 : 0.92;
  const relevo = input.relevo;
  const fatorRelevo = relevo === 'plano' ? 1.05 : relevo === 'acidentado' ? 0.82 : 1.0;
  const fatorAgua = input.agua ? 1.06 : 0.96;
  const terraNua = Math.round(areaHa * rHaMix);
  const terraNuaAj = Math.round(terraNua * fatorAcesso * fatorRelevo * fatorAgua);

  // Benfeitorias (uplift por keyword sobre a terra nua)
  const benfeitorias = Array.isArray(input.benfeitorias) ? input.benfeitorias.filter(Boolean)
    : String(input.benfeitorias || '').split(',').map(s => s.trim()).filter(Boolean);
  const bn = benfeitorias.map(norm);
  let fBenf = 1.0; const bDesc = [];
  if (bn.some(b => b.includes('irriga') || b.includes('pivo') || b.includes('pivô'))) { fBenf *= 1.12; bDesc.push('irrigação/pivô'); }
  if (bn.some(b => b.includes('sede') || b.includes('casa'))) { fBenf *= 1.05; bDesc.push('sede'); }
  if (bn.some(b => b.includes('galp') || b.includes('barrac') || b.includes('armazem') || b.includes('armazém'))) { fBenf *= 1.03; bDesc.push('galpão/armazém'); }
  if (bn.some(b => b.includes('curral') || b.includes('brete') || b.includes('mangueira'))) { fBenf *= 1.03; bDesc.push('curral'); }
  if (bn.some(b => b.includes('represa') || b.includes('lago') || b.includes('acude') || b.includes('barrag'))) { fBenf *= 1.03; bDesc.push('represa/açude'); }
  if (bn.some(b => b.includes('cerca') || b.includes('curva de nivel') || b.includes('curva de nível'))) { fBenf *= 1.02; bDesc.push('cercas/conservação'); }
  const benfValor = Math.round(terraNuaAj * (fBenf - 1));
  const total = terraNuaAj + benfValor;

  const rHaFinal = areaHa > 0 ? Math.round(total / areaHa) : 0;
  const rAlqFinal = areaAlq > 0 ? Math.round(total / areaAlq) : 0;

  // Método da RENDA (arrendamento) — 2ª opinião. R$/ha/ano de referência (calibrar).
  const arrendLavHa = 3000, arrendPastHa = 550;
  const rendaAnual = Math.round(areaHa * (pLav * arrendLavHa + pPast * arrendPastHa) / 100);
  const taxaCap = 0.055;
  const valorRenda = rendaAnual > 0 ? Math.round(rendaAnual / taxaCap) : 0;

  const r = {
    cidade, referencia, subtipo, unidade, finalidade, areaAlq, areaHa,
    aptidao: { lavoura: Math.round(pLav), pastagem: Math.round(pPast), reserva: Math.round(pRes), informada: aptidaoInformada },
    precos, rHaMix: Math.round(rHaMix),
    acesso, relevo, agua: !!input.agua, energia: !!input.energia,
    fatorAcesso, fatorRelevo, fatorAgua,
    terraNua, terraNuaAj, benfeitorias, benfDesc: bDesc, fBenf, benfValor,
    total, rHaFinal, rAlqFinal,
    faixaMin: Math.round(total * 0.9), faixaMax: Math.round(total * 1.1),
    rendaAnual, valorRenda, vtn: precos.vtn,
    valorPedido: Number(input.valorPedido) > 0 ? Number(input.valorPedido) : null,
    dados: { finalidade, subtipo, cidade, bairro: referencia },
  };
  r.parecer = await gerarParecerFazenda(r).catch(() => null);
  return r;
}

async function gerarParecerFazenda(r) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const m = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`;
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é avaliador de imóveis rurais (ref. NBR 14653-3). Escreve um parecer técnico curto e claro para corretor/investidor. Português do Brasil.' },
        { role: 'user', content: `Parecer de 3-5 frases sobre ${r.subtipo} de ${r.areaHa} ha (${r.areaAlq} alq) em ${r.cidade}-GO, ${r.aptidao.lavoura}% lavoura / ${r.aptidao.pastagem}% pastagem / ${r.aptidao.reserva}% reserva. Terra nua ${m(r.terraNuaAj)} + benfeitorias ${m(r.benfValor)} = ${m(r.total)} (${m(r.rHaFinal)}/ha). Valor por renda (arrendamento) ${m(r.valorRenda)}. Comente se o valor está coerente, o que mais pesa (aptidão/água/acesso), como o comparativo e a renda se relacionam, e 1 ressalva de documentação (matrícula/CAR/georreferenciamento/reserva legal). Não invente números.` },
      ],
      temperature: 0.5, max_tokens: 340,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[Fazenda] parecer:', e.message); return null; }
}

function formatarFazenda(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível avaliar a propriedade.'}`;
  const m = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR')}`;
  const n = (v) => Number(v || 0).toLocaleString('pt-BR');
  const emoji = r.subtipo === 'fazenda' ? '🌾' : r.subtipo === 'sitio' ? '🌿' : '🏡';
  const subLabel = r.subtipo.charAt(0).toUpperCase() + r.subtipo.slice(1);

  let t = `${emoji} *AVALIAÇÃO RURAL — ${subLabel}* (ref. NBR 14653-3)\n`;
  t += `📍 ${[r.referencia, r.cidade].filter(Boolean).join(', ')}-GO · _${r.precos.regiao}_\n`;
  t += `📐 ${n(r.areaAlq)} alqueire(s) · ${n(r.areaHa)} ha\n`;
  t += `🌱 Aptidão: ${r.aptidao.lavoura}% lavoura · ${r.aptidao.pastagem}% pastagem · ${r.aptidao.reserva}% reserva${r.aptidao.informada ? '' : ' _(padrão — informe pra afinar)_'}\n`;
  const acesso = r.acesso === 'beira' ? 'Beira de asfalto' : r.acesso === 'asfalto' ? 'Acesso pelo asfalto' : 'Estrada de chão';
  const infra = [`🛣️ ${acesso}`, r.agua ? '💧 Água' : '', r.energia ? '⚡ Energia' : '', r.relevo ? `⛰️ ${r.relevo}` : ''].filter(Boolean).join(' · ');
  t += `${infra}\n`;
  if (r.benfeitorias && r.benfeitorias.length) t += `🏗️ ${r.benfeitorias.join(', ')}\n`;

  t += `\n💰 *VALOR DE MERCADO: ${m(r.total)}*\n`;
  t += `_(faixa ${m(r.faixaMin)} – ${m(r.faixaMax)})_\n`;
  t += `• *${m(r.rHaFinal)}/ha*  ·  *${m(r.rAlqFinal)}/alqueire*\n`;

  t += `\n🧮 *Composição (método comparativo):*\n`;
  t += `• Terra nua (aptidão × R$/ha): ${m(r.terraNua)}\n`;
  t += `   – R$/ha ponderado: ${m(r.rHaMix)} (lavoura ${m(r.precos.lavoura)} · pastagem ${m(r.precos.pastagem)} · reserva ${m(r.precos.reserva)} /ha)\n`;
  const ajz = [];
  if (r.fatorAcesso !== 1) ajz.push(`acesso ${r.fatorAcesso > 1 ? '+' : ''}${Math.round((r.fatorAcesso - 1) * 100)}%`);
  if (r.fatorRelevo !== 1) ajz.push(`relevo ${r.fatorRelevo > 1 ? '+' : ''}${Math.round((r.fatorRelevo - 1) * 100)}%`);
  if (r.fatorAgua !== 1) ajz.push(`água ${r.fatorAgua > 1 ? '+' : ''}${Math.round((r.fatorAgua - 1) * 100)}%`);
  if (ajz.length) t += `   – Ajustes: ${ajz.join(', ')} → terra nua ajustada ${m(r.terraNuaAj)}\n`;
  t += `• Benfeitorias${r.benfDesc.length ? ` (${r.benfDesc.join(', ')})` : ''}: ${m(r.benfValor)}\n`;

  t += `\n📈 *2ª opinião — método da renda (arrendamento):*\n`;
  t += `• Renda estimada: ${m(r.rendaAnual)}/ano → valor por capitalização (5,5%): *${m(r.valorRenda)}*\n`;
  if (r.vtn) t += `\n🏛️ *Piso VTN-INCRA:* ${m(r.vtn)}/ha (≈ ${m(Math.round(r.vtn * r.areaHa))} no total) — referência oficial (ITR)\n`;
  if (r.valorPedido) {
    const dif = Math.round((r.valorPedido / r.total - 1) * 100);
    t += `\n🏷️ *Pedido do vendedor:* ${m(r.valorPedido)} (${dif >= 0 ? '+' : ''}${dif}% vs. avaliação)\n`;
  }

  if (r.parecer) t += `\n💬 *Parecer técnico:*\n${r.parecer}\n`;

  t += `\n📑 *Checklist de documentação (confirmar antes de fechar):*\n`;
  t += `• Matrícula atualizada · Georreferenciamento (SIGEF) · CAR · Reserva Legal averbada · ITR/CCIR em dia · sem embargo ambiental/sobreposição\n`;

  try {
    const { textoFontes } = require('./fontes');
    t += textoFontes({
      metodo: 'Método comparativo por aptidão (terra nua × R$/ha por uso) + benfeitorias, com 2ª opinião pela renda (arrendamento). Referência ABNT NBR 14653-3.',
      data: new Date().toLocaleDateString('pt-BR'),
      grau: r.precos.confianca === 'media' ? 'II' : 'I (indicativo)',
      portais: [r.precos.fonteLabel],
      bases: ['Scot Consultoria / CEPEA-ESALQ / AgriFatto (R$/ha por uso)', 'VTN-INCRA (piso oficial)', 'Base regional de Goiás por aptidão'],
      links: r.precos.fontes || [],
      obs: 'Estimativa mercadológica de apoio. Valor real depende de VISTORIA (aptidão/solo/relevo/água conferidos in loco), documentação (matrícula/CAR/georreferenciamento/reserva legal) e do momento do mercado de grãos/gado. 1 alqueire goiano = 4,84 ha. Base de R$/ha por região a calibrar com dados de fechamento.',
    });
  } catch {}
  return t;
}

// ── CHÁCARA DE RECREIO (pequena, de lazer) — modelo por R$/m², NÃO por aptidão ──
// Chácara de recreio (500 m² a poucos ha) é mercado de LAZER/proximidade, não de
// produção. Vale por R$/m² de chácara na região + benfeitorias (casa é o que mais
// pesa). Distância à cidade, água, energia, condomínio fechado ajustam.
async function precoM2Chacara(cidade) {
  const base = { m2: 40, fonteLabel: 'Base de chácara de recreio (interior GO — referência)', fontes: [], confianca: 'baixa' };
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return base;
  try {
    const prompt = `Qual o preço de mercado de CHÁCARAS DE RECREIO / LAZER à venda em ${cidade}, Goiás, em 2025, em R$ por METRO QUADRADO do terreno (só a terra, sem contar a casa)? Considere chácaras pequenas (de 1.000 a 20.000 m²). Responda SOMENTE JSON: {"precoM2": R$/m² típico do terreno de chácara de recreio, "obs": "faixa/observação curta"}. Baseie em anúncios reais (VivaReal, ZAP, Chaves na Mão, OLX, imobiliárias locais). Só número real; se não achar, use null.`;
    const { data } = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'Pesquisador do mercado de chácaras de recreio no interior de Goiás. Responda SOMENTE JSON com número real de anúncios. Nunca invente.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 350,
    }, { timeout: 60000, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    let s = String(data.choices[0].message.content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}'); if (i >= 0 && j > i) s = s.slice(i, j + 1);
    const d = JSON.parse(s);
    const p = Number(d.precoM2) || 0;
    if (p >= 3 && p <= 2000) {
      return { m2: Math.round(p), fonteLabel: `Anúncios de chácaras em ${cidade}`, fontes: (data.citations || []).slice(0, 5), confianca: 'media', obs: d.obs || null };
    }
  } catch (e) { console.warn('[Chacara] precoM2:', e.message); }
  return base;
}

async function avaliarChacara(input = {}) {
  const cidade = String(input.cidade || 'Anápolis').trim() || 'Anápolis';
  const referencia = String(input.referencia || '').trim() || null;
  const finalidade = input.finalidade === 'aluguel' ? 'aluguel' : 'venda';
  const areaM2 = Number(input.areaM2 || input.area) || 0;
  if (areaM2 <= 0) return { erro: 'Informe a área da chácara em m².' };
  const distanciaKm = Number(input.distanciaKm) || null;

  const precos = await precoM2Chacara(cidade);

  const acesso = input.acesso;
  const fatorAcesso = acesso === 'beira' ? 1.15 : acesso === 'asfalto' ? 1.08 : 0.90;
  const fatorAgua = input.agua ? 1.08 : 0.94;
  const fatorEnergia = input.energia ? 1.05 : 0.95;
  const condominio = !!input.condominio;
  const fatorCond = condominio ? 1.10 : 1.0;
  let fatorDist = 1.0;
  if (distanciaKm != null) fatorDist = distanciaKm <= 10 ? 1.10 : distanciaKm <= 25 ? 1.03 : distanciaKm <= 50 ? 1.0 : 0.90;

  const terraNua = Math.round(areaM2 * precos.m2);
  const terraNuaAj = Math.round(terraNua * fatorAcesso * fatorAgua * fatorEnergia * fatorCond * fatorDist);

  // Benfeitorias: casa é o que MAIS pesa numa chácara de recreio.
  const benfeitorias = Array.isArray(input.benfeitorias) ? input.benfeitorias.filter(Boolean)
    : String(input.benfeitorias || '').split(',').map(s => s.trim()).filter(Boolean);
  const bn = benfeitorias.map(norm);
  let fBenf = 1.0; const bDesc = [];
  if (bn.some(b => b.includes('casa') || b.includes('sede') || b.includes('sobrado'))) { fBenf *= 1.35; bDesc.push('casa/sede'); }
  if (bn.some(b => b.includes('piscina'))) { fBenf *= 1.08; bDesc.push('piscina'); }
  if (bn.some(b => b.includes('poco') || b.includes('poço') || b.includes('nascente') || b.includes('represa') || b.includes('lago'))) { fBenf *= 1.05; bDesc.push('água estruturada'); }
  if (bn.some(b => b.includes('quiosque') || b.includes('churrasqueira') || b.includes('gourmet') || b.includes('area de lazer') || b.includes('área de lazer'))) { fBenf *= 1.05; bDesc.push('área de lazer'); }
  if (bn.some(b => b.includes('pomar') || b.includes('fruti'))) { fBenf *= 1.03; bDesc.push('pomar'); }
  if (bn.some(b => b.includes('solar') || b.includes('fotovolt'))) { fBenf *= 1.03; bDesc.push('energia solar'); }
  // Valor de benfeitoria informado direto (opcional) tem prioridade sobre o uplift.
  const benfValorInformado = Number(input.benfValor) > 0 ? Number(input.benfValor) : null;
  const benfValor = benfValorInformado != null ? benfValorInformado : Math.round(terraNuaAj * (fBenf - 1));
  const totalMercado = terraNuaAj + benfValor;
  // Valor DEFINIDO pelo corretor/cliente (opcional): quando informado, é ele que
  // manda no laudo (avaliação "de acordo com a cabeça do cliente"); o de mercado
  // vira referência.
  const valorDefinido = Number(input.valorDefinido) > 0 ? Number(input.valorDefinido) : null;
  const total = valorDefinido != null ? valorDefinido : totalMercado;
  const precoM2Final = areaM2 > 0 ? Math.round(total / areaM2) : 0;

  const r = {
    modo: 'recreio', cidade, referencia, finalidade, areaM2, distanciaKm,
    valorDefinido, totalMercado,
    precos, acesso, agua: !!input.agua, energia: !!input.energia, condominio,
    fatorAcesso, fatorAgua, fatorEnergia, fatorCond, fatorDist,
    terraNua, terraNuaAj, benfeitorias, benfDesc: bDesc, benfValor, benfValorInformado,
    total, precoM2Final, faixaMin: Math.round(total * 0.9), faixaMax: Math.round(total * 1.1),
    valorPedido: Number(input.valorPedido) > 0 ? Number(input.valorPedido) : null,
    dados: { finalidade, subtipo: 'chacara', cidade, bairro: referencia },
  };
  r.parecer = await gerarParecerChacara(r).catch(() => null);
  return r;
}

async function gerarParecerChacara(r) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const m = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`;
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é avaliador imobiliário. Escreve parecer curto e claro sobre chácara de recreio. Português do Brasil.' },
        { role: 'user', content: `Parecer de 3-4 frases sobre uma chácara de recreio de ${r.areaM2.toLocaleString('pt-BR')} m² em ${r.cidade}-GO. Terra ${m(r.terraNuaAj)} (${m(r.precos.m2)}/m²) + benfeitorias ${m(r.benfValor)} = ${m(r.total)}. Benfeitorias: ${r.benfeitorias.join(', ') || 'terreno'}. Comente se está coerente, que a CASA/benfeitorias e a proximidade da cidade pesam muito no valor de recreio, e 1 dica (conferir documentação/registro e o que valoriza revenda). Não invente números.` },
      ],
      temperature: 0.5, max_tokens: 280,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[Chacara] parecer:', e.message); return null; }
}

function formatarChacara(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível avaliar a chácara.'}`;
  const m = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR')}`;
  const n = (v) => Number(v || 0).toLocaleString('pt-BR');
  let t = `🏡 *AVALIAÇÃO — Chácara de Recreio*\n`;
  t += `📍 ${[r.referencia, r.cidade].filter(Boolean).join(', ')}-GO\n`;
  t += `📐 ${n(r.areaM2)} m² (${(r.areaM2 / 10000).toLocaleString('pt-BR')} ha)${r.distanciaKm ? ` · ~${r.distanciaKm} km da cidade` : ''}\n`;
  const acesso = r.acesso === 'beira' ? 'Beira de asfalto' : r.acesso === 'asfalto' ? 'Acesso pelo asfalto' : 'Estrada de chão';
  const infra = [`🛣️ ${acesso}`, r.agua ? '💧 Água' : '', r.energia ? '⚡ Energia' : '', r.condominio ? '🚪 Condomínio fechado' : ''].filter(Boolean).join(' · ');
  t += `${infra}\n`;
  if (r.benfeitorias && r.benfeitorias.length) t += `🏗️ ${r.benfeitorias.join(', ')}\n`;

  const semBenf = r.terraNuaAj;
  const mercadoComBenf = r.totalMercado;
  const m2Sem = r.areaM2 > 0 ? Math.round(semBenf / r.areaM2) : 0;
  const m2Mercado = r.areaM2 > 0 ? Math.round(mercadoComBenf / r.areaM2) : 0;

  if (r.valorDefinido != null) {
    // Valor definido pelo corretor/cliente manda; o de mercado é referência.
    const dif = mercadoComBenf > 0 ? Math.round((r.valorDefinido / mercadoComBenf - 1) * 100) : 0;
    t += `\n✅ *VALOR DEFINIDO: ${m(r.valorDefinido)}*  (${m(r.precoM2Final)}/m²)\n`;
    t += `_valor de referência do proprietário/cliente para negociação_\n`;
    t += `\n📊 *Avaliação de mercado (referência):* ${m(mercadoComBenf)} (${m(m2Mercado)}/m²)\n`;
    t += `   • Só o terreno: ${m(semBenf)}  ·  Benfeitorias: ${m(r.benfValor)}\n`;
    t += `   • O valor definido está *${dif >= 0 ? '+' : ''}${dif}%* ${dif >= 0 ? 'acima' : 'abaixo'} da avaliação de mercado\n`;
  } else {
    t += `\n💰 *ESTIMATIVAS* _(imóvel de recreio com poucos dados — valores aproximados)_\n`;
    t += `🟫 *Só o terreno* (terra nua): *${m(semBenf)}*  (${m(m2Sem)}/m²)\n`;
    t += `🏠 *Com benfeitorias* (${r.benfValorInformado != null ? 'informado' : 'estimado'}): *${m(mercadoComBenf)}*  (${m(m2Mercado)}/m²)\n`;
    if (r.benfValorInformado != null) {
      t += `\n✅ *VEREDITO FINAL: ${m(mercadoComBenf)}*\n`;
      t += `_terra nua ${m(semBenf)} + benfeitorias informadas ${m(r.benfValor)} · faixa ${m(r.faixaMin)}–${m(r.faixaMax)}_\n`;
    } else {
      t += `\n💡 _Pra fechar o *veredito final*: informe o *"Valor das benfeitorias (R$)"* ou o *"Valor definido"* (o preço que você/o cliente quer trabalhar)._\n`;
    }
  }

  t += `\n🧮 *Como cheguei no terreno:*\n`;
  t += `• ${n(r.areaM2)} m² × ${m(r.precos.m2)}/m² = ${m(r.terraNua)}\n`;
  const ajz = [];
  if (r.fatorAcesso !== 1) ajz.push(`acesso ${r.fatorAcesso > 1 ? '+' : ''}${Math.round((r.fatorAcesso - 1) * 100)}%`);
  if (r.fatorDist !== 1) ajz.push(`distância ${r.fatorDist > 1 ? '+' : ''}${Math.round((r.fatorDist - 1) * 100)}%`);
  if (r.fatorAgua !== 1) ajz.push(`água ${r.fatorAgua > 1 ? '+' : ''}${Math.round((r.fatorAgua - 1) * 100)}%`);
  if (r.fatorCond !== 1) ajz.push(`condomínio +${Math.round((r.fatorCond - 1) * 100)}%`);
  if (ajz.length) t += `• Ajustes: ${ajz.join(', ')} → *${m(semBenf)}*\n`;
  if (r.benfValorInformado == null && r.benfDesc.length) t += `• Benfeitorias estimadas (${r.benfDesc.join(', ')}): +${m(r.benfValor)}\n`;
  if (r.valorPedido) {
    const dif = Math.round((r.valorPedido / r.total - 1) * 100);
    t += `\n🏷️ *Pedido do vendedor:* ${m(r.valorPedido)} (${dif >= 0 ? '+' : ''}${dif}% vs. avaliação)\n`;
  }
  if (r.parecer) t += `\n💬 *Parecer:*\n${r.parecer}\n`;

  try {
    const { textoFontes } = require('./fontes');
    t += textoFontes({
      metodo: 'Chácara de recreio: R$/m² do terreno (anúncios de mercado) + benfeitorias, ajustado por acesso, distância da cidade, água, energia e condomínio.',
      data: new Date().toLocaleDateString('pt-BR'),
      grau: r.precos.confianca === 'media' ? 'II' : 'I (indicativo)',
      portais: [r.precos.fonteLabel],
      links: r.precos.fontes || [],
      obs: 'Estimativa de apoio. Numa chácara de recreio a CASA/benfeitorias e a proximidade da cidade pesam MUITO — se souber o valor de construção, informe. Confirme documentação (matrícula, registro, IPTU/ITR, condomínio). Diferente de fazenda produtiva (essa é por m² de lazer, não por aptidão agrícola).',
    });
  } catch {}
  return t;
}

module.exports = { avaliarFazenda, formatarFazenda, avaliarChacara, formatarChacara };
