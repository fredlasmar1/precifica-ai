/**
 * Multiplicadores de preço por bairro em relação à média da cidade.
 *
 * Base Anápolis 2025: R$ 6.000/m² (média geral)
 * Fonte: Portais imobiliários + Sinduscon Anápolis + pesquisa de mercado
 *
 * Revisar trimestralmente conforme variações observadas no mercado.
 */

const BAIRROS_ANAPOLIS = {

  // ── ALTO PADRÃO / CONDOMÍNIOS FECHADOS ──────────────────────────
  'jundiai':                        { mult: 1.65, perfil: 'alto padrão', zona: 'norte' },
  'jundiaí':                        { mult: 1.65, perfil: 'alto padrão', zona: 'norte' },
  'bairro jundai':                  { mult: 1.65, perfil: 'alto padrão', zona: 'norte' },
  'bairro jundaí':                  { mult: 1.65, perfil: 'alto padrão', zona: 'norte' },
  'setor bougainville':             { mult: 1.70, perfil: 'alto padrão / condomínio fechado', zona: 'sul' },
  'bougainville':                   { mult: 1.70, perfil: 'alto padrão / condomínio fechado', zona: 'sul' },
  'cidade jardim':                  { mult: 1.40, perfil: 'alto padrão', zona: 'norte' },
  'alphaville':                     { mult: 1.80, perfil: 'condomínio fechado alto padrão', zona: 'sul' },
  'alphaville anapolis':            { mult: 1.80, perfil: 'condomínio fechado alto padrão', zona: 'sul' },
  'alphaville anápolis':            { mult: 1.80, perfil: 'condomínio fechado alto padrão', zona: 'sul' },
  'terras alpha':                   { mult: 1.75, perfil: 'condomínio fechado alto padrão', zona: 'sul' },
  'anaville':                       { mult: 1.60, perfil: 'condomínio fechado', zona: 'sul' },
  'recanto das aguas':              { mult: 1.55, perfil: 'condomínio fechado', zona: 'leste' },
  'recanto das águas':              { mult: 1.55, perfil: 'condomínio fechado', zona: 'leste' },
  'swiss park':                     { mult: 1.50, perfil: 'condomínio fechado', zona: 'sul' },
  'residencial gaudi':              { mult: 1.45, perfil: 'condomínio fechado', zona: 'sul' },
  'gaudi':                          { mult: 1.45, perfil: 'condomínio fechado', zona: 'sul' },
  'sun flower':                     { mult: 1.40, perfil: 'condomínio fechado', zona: 'sul' },
  'residencial sun flower':         { mult: 1.40, perfil: 'condomínio fechado', zona: 'sul' },
  "rose's garden":                  { mult: 1.40, perfil: 'condomínio fechado', zona: 'sul' },
  'roses garden':                   { mult: 1.40, perfil: 'condomínio fechado', zona: 'sul' },
  'monte sinai':                    { mult: 1.35, perfil: 'condomínio fechado', zona: 'sul' },
  'residencial monte sinai':        { mult: 1.35, perfil: 'condomínio fechado', zona: 'sul' },
  'vila verde':                     { mult: 1.30, perfil: 'condomínio fechado', zona: 'sul' },
  'residencial vila verde':         { mult: 1.30, perfil: 'condomínio fechado', zona: 'sul' },
  'jardins lisboa':                 { mult: 1.35, perfil: 'condomínio fechado', zona: 'sul' },
  'parque dos pirineus':            { mult: 1.40, perfil: 'condomínio fechado em crescimento', zona: 'leste' },
  'viviam parque':                  { mult: 1.35, perfil: 'residencial fechado', zona: 'leste' },
  'viviam':                         { mult: 1.35, perfil: 'residencial fechado', zona: 'leste' },
  'parque residencial das nações':  { mult: 1.30, perfil: 'condomínio fechado', zona: 'sul' },
  'parque das nacoes':              { mult: 1.30, perfil: 'condomínio fechado', zona: 'sul' },
  'parque das nações':              { mult: 1.30, perfil: 'condomínio fechado', zona: 'sul' },
  'setor tropical':                 { mult: 1.30, perfil: 'médio-alto residencial', zona: 'norte' },
  'tropical':                       { mult: 1.30, perfil: 'médio-alto residencial', zona: 'norte' },

  // ── MÉDIO-ALTO ───────────────────────────────────────────────────
  'jardim alexandrina':             { mult: 1.35, perfil: 'médio-alto', zona: 'norte' },
  'alexandrina':                    { mult: 1.35, perfil: 'médio-alto', zona: 'norte' },
  'maracana':                       { mult: 1.20, perfil: 'médio-alto', zona: 'norte' },
  'maracanã':                       { mult: 1.20, perfil: 'médio-alto', zona: 'norte' },
  'maracananzinho':                 { mult: 1.15, perfil: 'médio-alto', zona: 'norte' },
  'maracanãzinho':                  { mult: 1.15, perfil: 'médio-alto', zona: 'norte' },
  'bairro maracana':                { mult: 1.20, perfil: 'médio-alto', zona: 'norte' },
  'bairro maracanã':                { mult: 1.20, perfil: 'médio-alto', zona: 'norte' },
  'jardim das americas':            { mult: 1.25, perfil: 'médio-alto', zona: 'oeste' },
  'jardim das américas':            { mult: 1.25, perfil: 'médio-alto', zona: 'oeste' },
  'jardim das americas 1':          { mult: 1.25, perfil: 'médio-alto', zona: 'oeste' },
  'jardim das americas 2':          { mult: 1.20, perfil: 'médio-alto', zona: 'oeste' },
  'jardim das americas 3':          { mult: 1.15, perfil: 'médio', zona: 'oeste' },
  'alto da bela vista':             { mult: 1.25, perfil: 'médio-alto', zona: 'sul' },
  'bela vista':                     { mult: 1.20, perfil: 'médio-alto', zona: 'sul' },
  'joquel club':                    { mult: 1.20, perfil: 'médio-alto', zona: 'norte' },
  'joquei club':                    { mult: 1.20, perfil: 'médio-alto', zona: 'norte' },
  'jóquei club':                    { mult: 1.20, perfil: 'médio-alto', zona: 'norte' },
  'cidade universitaria':           { mult: 1.15, perfil: 'médio-alto universitário', zona: 'sul' },
  'cidade universitária':           { mult: 1.15, perfil: 'médio-alto universitário', zona: 'sul' },
  'loteamento cidade universitaria':{ mult: 1.15, perfil: 'médio-alto universitário', zona: 'sul' },
  'jardim petropolis':              { mult: 1.15, perfil: 'médio', zona: 'leste' },
  'jardim petrópolis':              { mult: 1.15, perfil: 'médio', zona: 'leste' },
  'adriana parque':                 { mult: 1.15, perfil: 'médio-alto', zona: 'sul' },
  'adriana':                        { mult: 1.15, perfil: 'médio-alto', zona: 'sul' },

  // ── MÉDIO ────────────────────────────────────────────────────────
  'centro':                         { mult: 1.10, perfil: 'médio comercial', zona: 'centro' },
  'setor central':                  { mult: 1.10, perfil: 'médio comercial', zona: 'centro' },
  's central':                      { mult: 1.10, perfil: 'médio comercial', zona: 'centro' },
  'bairro de lourdes':              { mult: 1.10, perfil: 'médio', zona: 'centro' },
  'lourdes':                        { mult: 1.10, perfil: 'médio', zona: 'centro' },
  'vila brasil':                    { mult: 1.05, perfil: 'médio', zona: 'centro' },
  'jardim calixto':                 { mult: 1.05, perfil: 'médio', zona: 'centro' },
  'calixtolandia':                  { mult: 1.00, perfil: 'médio', zona: 'centro' },
  'calixtolandia':                  { mult: 1.00, perfil: 'médio', zona: 'centro' },
  'jardim das acacias':             { mult: 1.05, perfil: 'médio', zona: 'norte' },
  'jardim das acácias':             { mult: 1.05, perfil: 'médio', zona: 'norte' },
  'parque brasilia':                { mult: 1.00, perfil: 'médio', zona: 'leste' },
  'parque brasília':                { mult: 1.00, perfil: 'médio', zona: 'leste' },
  'recanto do sol':                 { mult: 0.98, perfil: 'médio', zona: 'norte' },
  'vila santana':                   { mult: 0.95, perfil: 'médio', zona: 'oeste' },
  'setor sul':                      { mult: 0.98, perfil: 'médio', zona: 'sul' },
  'setor sul jamil miguel':         { mult: 0.98, perfil: 'médio', zona: 'sul' },
  'novo paraiso':                   { mult: 0.98, perfil: 'médio', zona: 'norte' },
  'novo paraíso':                   { mult: 0.98, perfil: 'médio', zona: 'norte' },
  'eldorado':                       { mult: 0.98, perfil: 'médio', zona: 'norte' },
  'jardim eldorado':                { mult: 0.98, perfil: 'médio', zona: 'norte' },
  'bnh':                            { mult: 0.95, perfil: 'médio', zona: 'sul' },
  'residencial araujoville':        { mult: 0.95, perfil: 'médio', zona: 'leste' },
  'residencial araújoville':        { mult: 0.95, perfil: 'médio', zona: 'leste' },
  'parque dos eucaliptos':          { mult: 0.95, perfil: 'médio', zona: 'leste' },
  'vila sao vicente':               { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'vila são vicente':               { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'jardim goiano':                  { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'jardim gonçalves':               { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'jardim goncalves':               { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'jardim nações unidas':           { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'jardim nacoes unidas':           { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'jardim alvorada':                { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'alvorada':                       { mult: 0.90, perfil: 'médio', zona: 'norte' },
  'jardim america':                 { mult: 1.00, perfil: 'médio', zona: 'leste' },
  'jardim américa':                 { mult: 1.00, perfil: 'médio', zona: 'leste' },
  'jardim bandeirante':             { mult: 0.95, perfil: 'médio', zona: 'norte' },
  'jardim europa':                  { mult: 0.88, perfil: 'médio', zona: 'norte' }, // calibrado: ~R$700-800/m² terreno (VivaReal/Chaves na Mão abr/2026)
  'parque sao joao':                { mult: 0.95, perfil: 'médio', zona: 'leste' },
  'parque são joão':                { mult: 0.95, perfil: 'médio', zona: 'leste' },
  'santo andre':                    { mult: 0.93, perfil: 'médio', zona: 'leste' },
  'santo andré':                    { mult: 0.93, perfil: 'médio', zona: 'leste' },
  'bairro santo andre':             { mult: 0.93, perfil: 'médio', zona: 'leste' },
  'bairro santo andré':             { mult: 0.93, perfil: 'médio', zona: 'leste' },
  'sao carlos':                     { mult: 0.92, perfil: 'médio', zona: 'leste' },
  'são carlos':                     { mult: 0.92, perfil: 'médio', zona: 'leste' },
  'vila mariana':                   { mult: 0.95, perfil: 'médio', zona: 'centro' },
  'boa vista':                      { mult: 0.93, perfil: 'médio', zona: 'norte' },
  'bairro boa vista':               { mult: 0.93, perfil: 'médio', zona: 'norte' },
  'vila miguel jorge':              { mult: 0.93, perfil: 'médio', zona: 'leste' },
  'village jardim anapolis':        { mult: 1.00, perfil: 'médio', zona: 'sul' },
  'parque calixtopolis':            { mult: 0.93, perfil: 'médio', zona: 'centro' },
  'parque calixtópolis':            { mult: 0.93, perfil: 'médio', zona: 'centro' },
  'setor residencial jandaia':      { mult: 0.95, perfil: 'médio', zona: 'sul' },
  'jandaia':                        { mult: 0.95, perfil: 'médio', zona: 'sul' },
  'batista':                        { mult: 0.90, perfil: 'médio', zona: 'centro' },
  'anapolis city':                  { mult: 1.05, perfil: 'médio', zona: 'sul' },

  // ── POPULAR / MÉDIO-BAIXO ────────────────────────────────────────
  'vila jaiara':                    { mult: 0.85, perfil: 'popular', zona: 'oeste' },
  'vila jaiara norte':              { mult: 0.88, perfil: 'popular', zona: 'oeste' },
  'vila jaiara setor norte':        { mult: 0.88, perfil: 'popular', zona: 'oeste' },
  'vila jaiara sul':                { mult: 0.83, perfil: 'popular', zona: 'oeste' },
  'vila jaiara setor sul':          { mult: 0.83, perfil: 'popular', zona: 'oeste' },
  'vila jaiara leste':              { mult: 0.85, perfil: 'popular', zona: 'oeste' },
  'vila jaiara setor leste':        { mult: 0.85, perfil: 'popular', zona: 'oeste' },
  'nova vila jaiara':               { mult: 0.85, perfil: 'popular', zona: 'oeste' },
  'vila esperanca':                 { mult: 0.80, perfil: 'popular', zona: 'oeste' },
  'vila esperança':                 { mult: 0.80, perfil: 'popular', zona: 'oeste' },
  'vila fabril':                    { mult: 0.82, perfil: 'popular', zona: 'sul' },
  'bandeiras':                      { mult: 0.85, perfil: 'popular', zona: 'norte' },
  'bairro das bandeiras':           { mult: 0.85, perfil: 'popular', zona: 'norte' },
  'bairro bandeiras':               { mult: 0.85, perfil: 'popular', zona: 'norte' },
  'vila norte':                     { mult: 0.85, perfil: 'popular', zona: 'norte' },
  'vila sul':                       { mult: 0.85, perfil: 'popular', zona: 'sul' },
  'jardim progresso':               { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila harmonia':                  { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'jardim arco verde':              { mult: 0.80, perfil: 'popular', zona: 'norte' },
  'filostro machado':               { mult: 0.80, perfil: 'popular', zona: 'leste' },
  'residencial geovanni braga':     { mult: 0.82, perfil: 'popular', zona: 'leste' },
  'geovanni braga':                 { mult: 0.82, perfil: 'popular', zona: 'leste' },
  'vila goias':                     { mult: 0.82, perfil: 'popular', zona: 'centro' },
  'vila goiás':                     { mult: 0.82, perfil: 'popular', zona: 'centro' },
  'vila gois':                      { mult: 0.82, perfil: 'popular', zona: 'centro' },
  'vila góis':                      { mult: 0.82, perfil: 'popular', zona: 'centro' },
  'vila jussara':                   { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila santa maria':               { mult: 0.83, perfil: 'popular', zona: 'norte' },
  'vila santa maria de nazare':     { mult: 0.83, perfil: 'popular', zona: 'norte' },
  'vila santa maria de nazareth':   { mult: 0.83, perfil: 'popular', zona: 'norte' },
  'vila santa isabel':              { mult: 0.83, perfil: 'popular', zona: 'centro' },
  'vila santa izabel':              { mult: 0.83, perfil: 'popular', zona: 'centro' },
  'vila santa terezinha':           { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila formosa':                   { mult: 0.82, perfil: 'popular', zona: 'leste' },
  'vila sao joaquim':               { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila são joaquim':               { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila sao jorge':                 { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila são jorge':                 { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila sao jose':                  { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila são josé':                  { mult: 0.82, perfil: 'popular', zona: 'norte' },
  'vila nossa senhora dabadia':     { mult: 0.82, perfil: 'popular', zona: 'sul' },
  'vila nossa senhora da abadia':   { mult: 0.82, perfil: 'popular', zona: 'sul' },
  'jardim nações unidas':           { mult: 0.90, perfil: 'popular', zona: 'norte' },
  'paraiso':                        { mult: 0.88, perfil: 'popular', zona: 'leste' },
  'paraíso':                        { mult: 0.88, perfil: 'popular', zona: 'leste' },
  'sao joao':                       { mult: 0.85, perfil: 'popular', zona: 'norte' },
  'são joão':                       { mult: 0.85, perfil: 'popular', zona: 'norte' },
  'bairro sao joao':                { mult: 0.85, perfil: 'popular', zona: 'norte' },
  'bairro são joão':                { mult: 0.85, perfil: 'popular', zona: 'norte' },
  'bairro itamaraty':               { mult: 0.88, perfil: 'popular', zona: 'leste' },
  'itamaraty':                      { mult: 0.88, perfil: 'popular', zona: 'leste' },

  // ── INDUSTRIAL / ESPECIAL ────────────────────────────────────────
  'daia':                           { mult: 0.70, perfil: 'industrial/logístico', zona: 'sul' },
  'distrito agroindustrial':        { mult: 0.70, perfil: 'industrial/logístico', zona: 'sul' },
  'polocentro':                     { mult: 0.85, perfil: 'comercial/industrial', zona: 'norte' },
  'setor industrial aeroporto':     { mult: 0.80, perfil: 'industrial', zona: 'sul' },
  'setor industrial munir calixto': { mult: 0.78, perfil: 'industrial', zona: 'norte' },
  'vila industrial':                { mult: 0.78, perfil: 'industrial', zona: 'norte' },
  'vila jundiai industrial':        { mult: 0.80, perfil: 'industrial', zona: 'norte' },
  'jk parque industrial':           { mult: 0.78, perfil: 'industrial', zona: 'sul' },
  'bairro industrial da estacao':   { mult: 0.80, perfil: 'industrial', zona: 'centro' }
};

const BAIRROS_GOIANIA = {
  'jardim goias':        { mult: 1.65, perfil: 'alto luxo', zona: 'sul' },
  'jardim goiás':        { mult: 1.65, perfil: 'alto luxo', zona: 'sul' },
  'setor marista':       { mult: 1.55, perfil: 'alto padrão', zona: 'sul' },
  'setor bueno':         { mult: 1.45, perfil: 'alto padrão', zona: 'sul' },
  'setor oeste':         { mult: 1.40, perfil: 'alto padrão', zona: 'centro' },
  'park lozandes':       { mult: 1.50, perfil: 'alto padrão', zona: 'sul' },
  'setor sul':           { mult: 1.30, perfil: 'médio-alto', zona: 'sul' },
  'setor central':       { mult: 1.10, perfil: 'médio comercial', zona: 'centro' },
  'centro':              { mult: 1.05, perfil: 'médio comercial', zona: 'centro' },
  'setor universitario': { mult: 1.20, perfil: 'médio-alto', zona: 'leste' },
  'jardim america':      { mult: 1.25, perfil: 'médio-alto', zona: 'sul' },
  'jardim atlântico':    { mult: 1.10, perfil: 'médio', zona: 'norte' },
  'cidade jardim':       { mult: 1.15, perfil: 'médio', zona: 'norte' },
  'setor jaó':           { mult: 1.10, perfil: 'médio-alto', zona: 'leste' },
  'parque amazônia':     { mult: 0.95, perfil: 'médio', zona: 'sul' },
  'jardim europa':       { mult: 0.88, perfil: 'médio', zona: 'norte' }, // calibrado: ~R$700-800/m² terreno (VivaReal/Chaves na Mão abr/2026)
  'fazenda caveiras':    { mult: 1.30, perfil: 'condomínio fechado', zona: 'sul' }
};

const BAIRROS = {
  'anapolis':  BAIRROS_ANAPOLIS,
  'anápolis':  BAIRROS_ANAPOLIS,
  'goiania':   BAIRROS_GOIANIA,
  'goiânia':   BAIRROS_GOIANIA
};

/**
 * Retorna o multiplicador e perfil de um bairro.
 * Tenta match exato, depois parcial, depois retorna padrão.
 */
function getMultiplicadorBairro(cidade, bairro) {
  if (!cidade || !bairro) return { mult: 1.0, perfil: null, zona: null, conhecido: false };

  const cidadeKey = cidade.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const bairroKey = bairro.toLowerCase().trim();

  // Busca cidade com ou sem acentos
  const cidadeBairros = BAIRROS[cidadeKey] ||
    BAIRROS[cidade.toLowerCase().trim()] ||
    BAIRROS_ANAPOLIS; // Padrão: Anápolis

  // Match exato
  if (cidadeBairros[bairroKey]) {
    return { ...cidadeBairros[bairroKey], conhecido: true };
  }

  // Match exato sem acentos
  const bairroSemAcento = bairroKey
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [key, value] of Object.entries(cidadeBairros)) {
    const keySemAcento = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (keySemAcento === bairroSemAcento) {
      return { ...value, conhecido: true };
    }
  }

  // Match parcial (contém)
  for (const [key, value] of Object.entries(cidadeBairros)) {
    if (bairroKey.includes(key) || key.includes(bairroKey)) {
      return { ...value, conhecido: true };
    }
  }

  // Match parcial sem acentos
  for (const [key, value] of Object.entries(cidadeBairros)) {
    const keySemAcento = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (bairroSemAcento.includes(keySemAcento) || keySemAcento.includes(bairroSemAcento)) {
      return { ...value, conhecido: true };
    }
  }

  return { mult: 1.0, perfil: null, zona: null, conhecido: false };
}

/**
 * Retorna bairros vizinhos na mesma zona de uma cidade.
 */
function getBairrosVizinhos(cidade, bairro, limite = 5) {
  const { zona } = getMultiplicadorBairro(cidade, bairro);
  if (!zona) return [];

  const cidadeKey = cidade.toLowerCase().trim();
  const cidadeBairros = BAIRROS[cidadeKey] || BAIRROS_ANAPOLIS;
  const bairroKey = bairro.toLowerCase().trim();

  return Object.entries(cidadeBairros)
    .filter(([key, val]) => val.zona === zona && key !== bairroKey)
    .sort((a, b) => Math.abs(a[1].mult - 1) - Math.abs(b[1].mult - 1))
    .slice(0, limite)
    .map(([key]) => key);
}

module.exports = { getMultiplicadorBairro, getBairrosVizinhos, BAIRROS };
