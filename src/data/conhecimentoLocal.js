/**
 * Base de conhecimento local sobre o mercado imobiliário de Anápolis e região.
 *
 * Essa informação é injetada no prompt da Perplexity como CONTEXTO para que
 * a IA saiba validar os resultados da pesquisa. NÃO substitui os dados reais
 * dos portais — serve para a IA rejeitar resultados absurdos e buscar melhor.
 *
 * MANTER ATUALIZADO: Fred (corretor local) deve revisar periodicamente.
 */

const CONHECIMENTO_ANAPOLIS = `
CONTEXTO DO MERCADO IMOBILIÁRIO DE ANÁPOLIS-GO (usar para validar resultados):

=== PERFIL DA CIDADE ===
- Anápolis é a 3ª maior cidade de Goiás (~400 mil habitantes)
- Polo industrial (DAIA - Distrito Agroindustrial de Anápolis)
- Localizada entre Goiânia (55km) e Brasília (150km)
- Mercado imobiliário em crescimento, mas preços são SIGNIFICATIVAMENTE
  menores que Goiânia e Brasília

=== CLASSIFICAÇÃO DOS BAIRROS ===

ALTO PADRÃO (os mais caros):
- Jundiaí: bairro nobre, casas grandes (geralmente acima de 300m²),
  condomínios fechados, lotes amplos. NÃO existem imóveis pequenos aqui.
  Lotes mínimos costumam ser 300-500m².
- Cidade Jardim: alto padrão, casas e apartamentos de qualidade
- Jardim Alexandrina: médio-alto, boas casas

MÉDIO-ALTO:
- Maracanã / Maracananzinho: bairros tradicionais, boa valorização
- Jardim das Américas: crescimento recente, condomínios novos
- Jardim Petrópolis: bairro consolidado, boas casas

CENTRO:
- Centro: predominantemente comercial, imóveis mais antigos
- Terrenos/lotes no centro são mais baratos que em bairros nobres
  porque são menores e a região é comercial, não residencial de luxo
- Valor do m² de LOTE no centro: faixa de R$ 800 a R$ 1.200/m²

MÉDIO:
- Vila Brasil, Bairro de Lourdes, Jardim Calixto
- Vila São Vicente, Jardim das Acácias, Recanto do Sol
- Parque Brasília, Vila Santana

POPULAR:
- Vila Jaiara, Vila Esperança, Vila Fabril
- Bandeiras, Vila Norte, Vila Sul
- Filostro Machado, Jardim Progresso, Vila Harmonia
- Preços bem mais baixos, lotes menores

=== FAIXAS DE PREÇO REAIS DE REFERÊNCIA (2025-2026) ===
(usar para VALIDAR resultados — se a pesquisa trouxer valores muito
diferentes, desconfiar e buscar mais)

TERRENOS/LOTES VAZIOS:
- Jundiaí (condomínio): R$ 800 a R$ 1.500/m²
- Centro: R$ 800 a R$ 1.200/m²
- Bairros nobres: R$ 600 a R$ 1.200/m²
- Bairros médios: R$ 400 a R$ 800/m²
- Bairros populares: R$ 200 a R$ 500/m²
- ATENÇÃO: terrenos NÃO custam R$ 3.000/m² em Anápolis. Se encontrar
  esse valor, provavelmente é uma casa construída, não lote vazio.

CASAS (revenda/usadas):
- Jundiaí: R$ 3.000 a R$ 5.500/m² (casas grandes, alto padrão)
- Bairros nobres: R$ 2.500 a R$ 4.500/m²
- Bairros médios: R$ 2.000 a R$ 3.500/m²
- Bairros populares: R$ 1.200 a R$ 2.500/m²

APARTAMENTOS:
- Novos/planta: R$ 4.000 a R$ 7.000/m²
- Usados bom estado: R$ 2.500 a R$ 4.500/m²
- Bairros populares: R$ 2.000 a R$ 3.500/m²

=== CUIDADOS IMPORTANTES ===
- NÃO confundir Anápolis-GO com qualquer cidade homônima
- NÃO confundir bairro Jundiaí (em Anápolis) com cidade Jundiaí-SP
- Preços de Anápolis são 30-50% menores que Goiânia
- O DAIA (distrito industrial) tem galpões/terrenos industriais com
  preços completamente diferentes — não misturar com residencial
`;

const CONHECIMENTO_GOIANIA = `
CONTEXTO DO MERCADO IMOBILIÁRIO DE GOIÂNIA-GO:

=== PERFIL ===
- Capital de Goiás, ~1.5 milhão de habitantes
- Maior e mais caro mercado imobiliário do estado

=== CLASSIFICAÇÃO DOS BAIRROS ===

ALTO LUXO: Jardim Goiás (R$ 8.000-12.000/m² apto novo)
ALTO PADRÃO: Setor Marista, Setor Bueno, Setor Oeste, Park Lozandes,
  Alto da Glória (R$ 6.000-10.000/m²)
MÉDIO-ALTO: Setor Sul, Setor Universitário, Jardim América,
  Nova Suíça (R$ 4.500-7.000/m²)
MÉDIO: Setor Campinas, Bela Vista, Vila Nova, Setor Aeroporto
  (R$ 3.000-5.000/m²)
POPULAR: Jardim Guanabara, Vila Redenção, Jardim Nova Esperança
  (R$ 2.000-3.500/m²)
`;

/**
 * Retorna o contexto de conhecimento local para uma cidade.
 * Injetado no prompt da Perplexity para melhor precisão.
 */
function getConhecimentoLocal(cidade) {
  const cidadeNorm = (cidade || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  if (cidadeNorm.includes('anapolis') || cidadeNorm.includes('anápolis')) {
    return CONHECIMENTO_ANAPOLIS;
  }
  if (cidadeNorm.includes('goiania') || cidadeNorm.includes('goiânia')) {
    return CONHECIMENTO_GOIANIA;
  }
  // Cidades da região de Anápolis — usar conhecimento de Anápolis como referência
  const regiao = ['neropolis', 'goianapolis', 'damolandia', 'campo limpo',
    'ouro verde', 'petrolina', 'pirenopolis', 'abadiania', 'corumba',
    'cocalzinho', 'itaucu', 'inhumas', 'jaragua'];
  if (regiao.some(c => cidadeNorm.includes(c))) {
    return `Cidade da região de Anápolis-GO. Preços geralmente 20-40% menores que Anápolis.
${CONHECIMENTO_ANAPOLIS}`;
  }

  return `Cidade do interior de Goiás. Preços geralmente menores que Goiânia e Anápolis.`;
}

module.exports = { getConhecimentoLocal };
