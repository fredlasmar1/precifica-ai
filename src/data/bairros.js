/**
 * Multiplicadores de preço por bairro (relativo à média da cidade)
 *
 * IMPORTANTE: estes valores são REFERÊNCIA de mercado baseada em
 * faixas observadas em portais imobiliários. Devem ser revisados
 * trimestralmente conforme você (corretor) observe variações reais.
 *
 * Exemplo: se Goiânia tem média de R$ 5.800/m² e Setor Bueno tem
 * multiplicador 1.45, o preço base de Setor Bueno fica R$ 8.410/m².
 */

const BAIRROS_GOIANIA = {
  // Top — bairros nobres
  'jardim goias':        { mult: 1.65, perfil: 'alto luxo' },
  'jardim goiás':        { mult: 1.65, perfil: 'alto luxo' },
  'setor marista':       { mult: 1.55, perfil: 'alto padrão' },
  'marista':             { mult: 1.55, perfil: 'alto padrão' },
  'setor bueno':         { mult: 1.45, perfil: 'alto padrão' },
  'bueno':               { mult: 1.45, perfil: 'alto padrão' },
  'setor oeste':         { mult: 1.40, perfil: 'alto padrão' },
  'oeste':               { mult: 1.40, perfil: 'alto padrão' },
  'park lozandes':       { mult: 1.50, perfil: 'alto padrão' },
  'alto da gloria':      { mult: 1.45, perfil: 'alto padrão' },
  'alto da glória':      { mult: 1.45, perfil: 'alto padrão' },

  // Médio-alto
  'setor sul':           { mult: 1.30, perfil: 'médio-alto' },
  'setor central':       { mult: 1.10, perfil: 'médio comercial' },
  'centro':              { mult: 1.05, perfil: 'médio comercial' },
  'setor aeroporto':     { mult: 1.15, perfil: 'médio' },
  'setor universitario': { mult: 1.20, perfil: 'médio-alto' },
  'setor universitário': { mult: 1.20, perfil: 'médio-alto' },
  'jardim america':      { mult: 1.25, perfil: 'médio-alto' },
  'jardim américa':      { mult: 1.25, perfil: 'médio-alto' },
  'setor coimbra':       { mult: 1.10, perfil: 'médio' },
  'jardim atlantico':    { mult: 1.10, perfil: 'médio' },
  'jardim atlântico':    { mult: 1.10, perfil: 'médio' },
  'cidade jardim':       { mult: 1.15, perfil: 'médio' },
  'setor pedro ludovico': { mult: 1.05, perfil: 'médio' },
  'pedro ludovico':      { mult: 1.05, perfil: 'médio' },
  'setor nova suica':    { mult: 1.20, perfil: 'médio-alto' },
  'setor nova suíça':    { mult: 1.20, perfil: 'médio-alto' },
  'nova suica':          { mult: 1.20, perfil: 'médio-alto' },

  // Médio
  'setor leste universitario': { mult: 1.15, perfil: 'médio' },
  'setor leste vila nova': { mult: 1.05, perfil: 'médio' },
  'vila nova':           { mult: 1.00, perfil: 'médio' },
  'setor campinas':      { mult: 0.95, perfil: 'médio' },
  'campinas':            { mult: 0.95, perfil: 'médio' },
  'setor criméia':       { mult: 0.90, perfil: 'médio' },
  'crimeia':             { mult: 0.90, perfil: 'médio' },
  'setor bela vista':    { mult: 1.05, perfil: 'médio' },
  'bela vista':          { mult: 1.05, perfil: 'médio' },
  'setor jaó':           { mult: 1.10, perfil: 'médio-alto' },
  'jao':                 { mult: 1.10, perfil: 'médio-alto' },
  'jaó':                 { mult: 1.10, perfil: 'médio-alto' },
  'setor negrao de lima': { mult: 0.85, perfil: 'médio-baixo' },
  'negrao de lima':      { mult: 0.85, perfil: 'médio-baixo' },
  'goiania 2':           { mult: 0.85, perfil: 'médio-baixo' },
  'goiânia 2':           { mult: 0.85, perfil: 'médio-baixo' },

  // Médio-baixo / popular
  'jardim guanabara':    { mult: 0.80, perfil: 'popular' },
  'setor garavelo':      { mult: 0.85, perfil: 'popular' },
  'vila redencao':       { mult: 0.80, perfil: 'popular' },
  'vila redenção':       { mult: 0.80, perfil: 'popular' },
  'jardim nova esperanca': { mult: 0.75, perfil: 'popular' },
  'parque amazonia':     { mult: 0.95, perfil: 'médio' },
  'parque amazônia':     { mult: 0.95, perfil: 'médio' },
  'jardim europa':       { mult: 0.90, perfil: 'médio' },
  'vila brasilia':       { mult: 0.80, perfil: 'popular' },
  'vila brasília':       { mult: 0.80, perfil: 'popular' },
  'fazenda caveiras':    { mult: 1.30, perfil: 'condomínio fechado' }
};

const BAIRROS_ANAPOLIS = {
  // Top — bairros nobres de Anápolis
  'jundiai':             { mult: 1.50, perfil: 'alto padrão' },
  'jundiaí':             { mult: 1.50, perfil: 'alto padrão' },
  'cidade jardim':       { mult: 1.35, perfil: 'alto padrão' },
  'maracananzinho':      { mult: 1.20, perfil: 'médio-alto' },
  'maracanã':            { mult: 1.15, perfil: 'médio-alto' },
  'maracana':            { mult: 1.15, perfil: 'médio-alto' },
  'jardim alexandrina':  { mult: 1.30, perfil: 'médio-alto' },
  'alexandrina':         { mult: 1.30, perfil: 'médio-alto' },

  // Centro e médio
  'centro':              { mult: 1.10, perfil: 'médio comercial' },
  'vila brasil':         { mult: 1.05, perfil: 'médio' },
  'bairro de lourdes':   { mult: 1.10, perfil: 'médio' },
  'jardim das americas': { mult: 1.20, perfil: 'médio-alto' },
  'jardim das américas': { mult: 1.20, perfil: 'médio-alto' },
  'vila são vicente':    { mult: 0.95, perfil: 'médio' },
  'vila sao vicente':    { mult: 0.95, perfil: 'médio' },
  'jardim calixto':      { mult: 1.00, perfil: 'médio' },
  'jardim das acacias':  { mult: 1.05, perfil: 'médio' },
  'jardim das acácias':  { mult: 1.05, perfil: 'médio' },
  'parque brasilia':     { mult: 1.00, perfil: 'médio' },
  'parque brasília':     { mult: 1.00, perfil: 'médio' },
  'vila santana':        { mult: 0.95, perfil: 'médio' },
  'recanto do sol':      { mult: 0.95, perfil: 'médio' },
  'polocentro':          { mult: 1.05, perfil: 'médio (comercial/industrial)' },
  'jardim petropolis':   { mult: 1.10, perfil: 'médio' },
  'jardim petrópolis':   { mult: 1.10, perfil: 'médio' },

  // Popular / médio-baixo
  'vila jaiara':         { mult: 0.85, perfil: 'popular' },
  'vila esperanca':      { mult: 0.80, perfil: 'popular' },
  'vila esperança':      { mult: 0.80, perfil: 'popular' },
  'vila fabril':         { mult: 0.85, perfil: 'popular' },
  'bandeiras':           { mult: 0.85, perfil: 'popular' },
  'vila norte':          { mult: 0.85, perfil: 'popular' },
  'vila sul':            { mult: 0.90, perfil: 'popular' },
  'setor sul':           { mult: 0.95, perfil: 'médio' },
  'filostro machado':    { mult: 0.80, perfil: 'popular' },
  'residencial geovanni braga': { mult: 0.85, perfil: 'popular' },
  'jardim progresso':    { mult: 0.85, perfil: 'popular' },
  'vila harmonia':       { mult: 0.85, perfil: 'popular' },
  'jardim arco verde':   { mult: 0.80, perfil: 'popular' }
};

const BAIRROS = {
  'goiania': BAIRROS_GOIANIA,
  'goiânia': BAIRROS_GOIANIA,
  'anapolis': BAIRROS_ANAPOLIS,
  'anápolis': BAIRROS_ANAPOLIS
};

/**
 * Retorna o multiplicador de bairro (1.0 se não conhecido)
 */
function getMultiplicadorBairro(cidade, bairro) {
  if (!cidade || !bairro) return { mult: 1.0, perfil: null, conhecido: false };

  const cidadeKey = cidade.toLowerCase().trim();
  const bairroKey = bairro.toLowerCase().trim();

  const cidadeBairros = BAIRROS[cidadeKey];
  if (!cidadeBairros) return { mult: 1.0, perfil: null, conhecido: false };

  // Match exato
  if (cidadeBairros[bairroKey]) {
    return { ...cidadeBairros[bairroKey], conhecido: true };
  }

  // Match parcial: o bairro contém ou está contido em alguma chave conhecida
  for (const [key, value] of Object.entries(cidadeBairros)) {
    if (bairroKey.includes(key) || key.includes(bairroKey)) {
      return { ...value, conhecido: true };
    }
  }

  return { mult: 1.0, perfil: null, conhecido: false };
}

module.exports = { getMultiplicadorBairro, BAIRROS };
