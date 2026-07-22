import express from 'express'
import axios from 'axios'
import 'dotenv/config'
import Groq from 'groq-sdk' // Importamos el SDK de Groq

const GROQ_API_KEY = process.env.GROQ_API_KEY
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID
const IGDB_CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET

// Inicializamos Groq
const groq = new Groq({ apiKey: GROQ_API_KEY })

const app = express()
const PORT = 3001

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept',
  )
  next()
})

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// FUNCIÓN AUXILIAR: Obtener Token de IGDB
async function obtenerIgdbToken() {
  try {
    const url = `https://id.twitch.tv/oauth2/token?client_id=${IGDB_CLIENT_ID}&client_secret=${IGDB_CLIENT_SECRET}&grant_type=client_credentials`
    const respuesta = await axios.post(url)
    return respuesta.data.access_token
  } catch (error) {
    console.error('Error obteniendo Token de IGDB:', error.message)
    return null
  }
}

// ENDPOINT 1: Buscador optimizado para renderizar las tarjetas del listado
app.get('/buscar', async (req, res) => {
  const { name } = req.query
  if (!name) return res.json([])

  try {
    // 1. Buscamos los juegos que coincidan con el nombre (Steam los ordena por popularidad)
    const urlBusqueda = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=spanish&cc=AR`
    const respuestaBusqueda = await axios.get(urlBusqueda)

    const items = respuestaBusqueda.data?.items || []
    // Cortamos a los primeros 10 para armar el listado principal
    const topJuegos = items.slice(0, 10)

    // 2. Enriquecemos los 10 juegos en paralelo
    const promesasEnriquecer = topJuegos.map(async (juego) => {
      const appId = juego.id.toString()

      // EL CAPSULE: Usamos directo el tiny_image que devuelve la búsqueda.
      // Es el capsule_231x87.jpg real, con el hash correcto y no es la versión v5.
      const capsule_image =
        juego.tiny_image ||
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_231x87.jpg`

      try {
        // EL HEADER Y REVIEWS: Hacemos 2 consultas en paralelo.
        // Una para sacar los votos y otra a appdetails para sacar la imagen con el hash correcto.
        const urlReviewsSummary = `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&num_per_page=0`
        const urlAppDetails = `https://store.steampowered.com/api/appdetails?appids=${appId}`

        const [resSummary, resDetails] = await Promise.all([
          axios.get(urlReviewsSummary),
          axios.get(urlAppDetails),
        ])

        const summary = resSummary.data?.query_summary || {}
        const detailsData = resDetails.data?.[appId]?.data || {}

        // Extraemos el header_image real de los detalles del juego (ya trae el hash y todo)
        const header_image =
          detailsData.header_image ||
          `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`

        return {
          appId,
          name: juego.name,
          header_image,
          capsule_image,
          total_reviews: summary.total_reviews || 0,
          review_score_desc: summary.review_score_desc || 'Sin análisis',
        }
      } catch (err) {
        // Fallback de seguridad si algo falla en la petición
        return {
          appId,
          name: juego.name,
          header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
          capsule_image,
          total_reviews: 0,
          review_score_desc: 'Sin análisis',
        }
      }
    })

    const resultadosTarjetas = await Promise.all(promesasEnriquecer)
    return res.json(resultadosTarjetas)
  } catch (error) {
    console.error('Error en el buscador de tarjetas:', error.message)
    return res
      .status(500)
      .json({ error: 'Error al procesar la búsqueda en Steam.' })
  }
})

// Todos los comentarios que terminan en el análisis (contexto Y destacados) tienen que
// pesar 400 caracteres o menos EN EL ORIGINAL. Esto es intencional incluso sabiendo que una
// traducción (ej. desde chino/japonés, idiomas muy "densos") puede expandirse varias veces:
// por eso además hay un tope duro post-traducción más abajo (MAX_CARACTERES_DESTACADO_TRADUCIDO).
const MAX_CARACTERES_COMENTARIO = 400
// Tope de seguridad DESPUÉS de traducir un destacado. No depende del idioma original: pase lo
// que pase en la traducción, un destacado nunca puede superar este largo en el resultado final.
const MAX_CARACTERES_DESTACADO_TRADUCIDO = 900
const SEGUNDOS_30_DIAS = 30 * 24 * 60 * 60

// FUNCIÓN AUXILIAR: Limpia caracteres invisibles y espacios raros del texto
function limpiarTextoResena(texto) {
  if (!texto) return ''
  return texto
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim()
}

// FUNCIÓN AUXILIAR: traduce la clasificación oficial de Steam (Overwhelmingly Positive, Mixed,
// etc.) al español. Se usa SOLO en el cierre de la columna "históricos" (reseñas generales),
// que es la que se basa en el % oficial de Steam (miles de reseñas).
function traducirDescripcionValve(desc) {
  if (!desc) return 'sin datos suficientes'
  const traducciones = {
    'Overwhelmingly Positive': 'extremadamente positivas',
    'Very Positive': 'muy positivas',
    'Mostly Positive': 'mayormente positivas',
    Positive: 'positivas',
    Mixed: 'mixtas',
    'Mostly Negative': 'mayormente negativas',
    Negative: 'negativas',
    'Very Negative': 'muy negativas',
    'Overwhelmingly Negative': 'extremadamente negativas',
    'No user reviews': 'sin reseñas de usuarios',
  }
  return traducciones[desc] || desc.toLowerCase()
}

// FUNCIÓN AUXILIAR: veredicto determinístico en base a un %, usado SOLO como fallback de la
// columna "recientes" si falla la IA (para que el cierre nunca quede vacío).
function veredictoSegunPct(pct) {
  if (pct === null)
    return 'no hay reseñas suficientes como para sacar una conclusión confiable'
  if (pct >= 85) return 'se recomienda su compra'
  if (pct >= 70) return 'vale la pena probarlo'
  if (pct >= 50)
    return 'conviene leer un poco más antes de decidir, ya que las opiniones están bastante divididas'
  return 'conviene esperar antes de comprarlo, dado que predominan las críticas'
}

// FUNCIÓN AUXILIAR: Detecta reseñas basura (plantillas, ASCII art, vacías, etc.)
// Se usa más abajo en obtenerResenasFiltradas; en JS las function declarations se "hoistean",
// así que no importa que esté definida después en el archivo.

// FUNCIÓN AUXILIAR: Pagina reseñas de Steam usando el cursor, filtrando basura y longitud
// A MEDIDA que van llegando. El objetivo es juntar `objetivoFiltradas` reseñas válidas
// (≤ MAX_CARACTERES_COMENTARIO caracteres, no-basura, y dentro del rango de fecha si aplica).
// Si con la primera tanda no alcanza, sigue pidiendo páginas de a `perPage` hasta lograrlo,
// hasta agotar las reseñas del juego, o hasta `maxCrudasTotal` como tope de seguridad
// (para juegos con cientos de miles de reseñas no nos quedamos pidiendo para siempre).
async function obtenerResenasFiltradas(
  appId,
  {
    dayRange = null,
    objetivoFiltradas = 150,
    maxCrudasTotal = 900,
    perPage = 100,
    filtroAdicional = () => true,
  } = {},
) {
  let cursor = '*'
  let crudasProcesadas = 0
  const filtradas = []

  while (crudasProcesadas < maxCrudasTotal) {
    const params = new URLSearchParams({
      json: 1,
      filter: 'all', // 'all' = ordenadas por utilidad/votos, necesario para que day_range funcione
      language: 'all',
      num_per_page: perPage,
      cursor,
    })
    // OJO: si no se manda day_range, Steam NO devuelve "las más valoradas de todo el historial",
    // sino solo dentro de una ventana reciente por default. Para pedir de verdad "todo el
    // historial" hay que forzar el máximo de un int64. Cuando sí queremos una ventana chica
    // (ej. últimos 30 días) usamos el dayRange recibido.
    params.set('day_range', dayRange ?? '9223372036854775807')

    let data
    try {
      const respuesta = await axios.get(
        `https://store.steampowered.com/appreviews/${appId}?${params.toString()}`,
      )
      data = respuesta.data
    } catch (err) {
      console.error(`Error paginando reseñas de ${appId}:`, err.message)
      break
    }

    const reviews = data?.reviews || []
    if (reviews.length === 0) break

    crudasProcesadas += reviews.length

    for (const r of reviews) {
      if (esComentarioBasura(r)) continue
      if (limpiarTextoResena(r.review).length > MAX_CARACTERES_COMENTARIO)
        continue
      if (!filtroAdicional(r)) continue
      filtradas.push(r)
    }

    // Ya juntamos suficientes candidatas válidas, no hace falta seguir pidiendo páginas
    if (filtradas.length >= objetivoFiltradas) break
    // No hay más páginas (se acabaron las reseñas del juego, típico de indies/juegos nuevos)
    if (!data.cursor || reviews.length < perPage) break

    cursor = data.cursor
  }

  return filtradas
}

// FUNCIÓN AUXILIAR: Detecta reseñas basura (plantillas, ASCII art, vacías, etc.)
function esComentarioBasura(reviewObj) {
  const texto = limpiarTextoResena(reviewObj.review)
  if (!texto || texto.length < 3) return true

  // Plantillas tipo "---{ Graphics }---" con checkboxes
  if (/---\{[^}]+\}---/.test(texto)) return true
  const checkboxes = (texto.match(/[☑☐✓✗]/g) || []).length
  if (
    checkboxes >= 5 &&
    /graphics|gameplay|audio|audience|difficulty|grind|story|price|bugs/i.test(
      texto,
    )
  ) {
    return true
  }

  // ASCII / Braille art (gigachad, etc.): pocos caracteres alfabéticos o muchos bloques
  const letras = (texto.match(/[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ0-9]/g) || []).length
  const bloques = (texto.match(/[\u2800-\u28FF⣿⡿⠿█▀▄▌▐░▒▓]/g) || []).length
  if (texto.length >= 80) {
    if (letras / texto.length < 0.12) return true
    if (bloques / texto.length > 0.25) return true
  }

  // Solo emojis / símbolos repetidos sin contenido real
  if (letras < 8 && texto.length > 20) return true

  return false
}

// FUNCIÓN AUXILIAR: Calcula qué tan "valorada" es una reseña combinando
// votos útiles, votos graciosos, el weighted_vote_score de Steam y las reacciones.
function calcularValoracion(review) {
  const votosArriba = review.votes_up || 0
  const votosGraciosos = review.votes_funny || 0
  const pesoSteam = parseFloat(review.weighted_vote_score || 0) * 100
  const reacciones = (review.reactions || []).reduce(
    (acc, r) => acc + (r.count || 0),
    0,
  )
  return votosArriba * 3 + votosGraciosos + pesoSteam + reacciones
}

// FUNCIÓN AUXILIAR: Convierte una reseña cruda al objeto que consume el frontend
function formatearDestacado(review) {
  const reacciones = (review.reactions || []).reduce(
    (acc, r) => acc + (r.count || 0),
    0,
  )
  const wvs = parseFloat(review.weighted_vote_score || 0)
  const minutosJugados = review.author?.playtime_at_review || 0
  return {
    recommendationid: review.recommendationid,
    review: limpiarTextoResena(review.review).slice(
      0,
      MAX_CARACTERES_COMENTARIO,
    ), // red de seguridad; ya viene ≤400
    language: review.language || '',
    voted_up: review.voted_up,
    votes_up: review.votes_up || 0,
    votes_funny: review.votes_funny || 0,
    weighted_vote_score: Math.round(wvs * 100),
    reactions: reacciones,
    timestamp_created: review.timestamp_created,
    timestamp_updated: review.timestamp_updated,
    fue_modificado: review.timestamp_updated > review.timestamp_created,
    autorNombre: review.author?.personaname || 'Usuario de Steam',
    autorPerfilUrl: review.author?.profile_url || null,
    horasJugadas: Math.round((minutosJugados / 60) * 10) / 10,
  }
}

// Idiomas donde un carácter representa mucha más información que en español (sistemas
// logográficos/silábicos: un símbolo puede equivaler a una palabra entera). Al traducirlos,
// el resultado se expande varias veces respecto al original. El ruso, por ejemplo, NO entra acá:
// el cirílico es alfabético como el español, un carácter ≈ un sonido, no hay expansión rara.
// Los valores son los códigos de idioma que usa la propia API de Steam.
const IDIOMAS_DENSOS = new Set(['schinese', 'tchinese', 'japanese', 'koreana'])
// Si un candidato a destacado está en uno de esos idiomas, tiene que ser bien cortito en el
// original (≤50 caracteres) para que la traducción no termine siendo un párrafo gigante.
const MAX_CARACTERES_DESTACADO_IDIOMA_DENSO = 50

// FUNCIÓN AUXILIAR: decide si un comentario puede ser destacado (no si va a la IA de contexto,
// eso no tiene esta restricción). Todo lo que no sea idioma denso ya pasó el filtro de 400
// caracteres en el fetch, así que no hace falta chequear nada más ahí.
function calificaComoDestacado(review) {
  if (!IDIOMAS_DENSOS.has(review.language)) return true
  return (
    limpiarTextoResena(review.review).length <=
    MAX_CARACTERES_DESTACADO_IDIOMA_DENSO
  )
}

// FUNCIÓN AUXILIAR: A partir de un pool YA FILTRADO (sin basura, ≤ MAX_CARACTERES_COMENTARIO,
// y ya dentro del rango de fecha correspondiente — ver obtenerResenasFiltradas), arma:
// - el texto de contexto para la IA (top 50 más valoradas, sin los 2 destacados)
// - los 2 comentarios destacados (los más valorados del top 50)
// - pctMuestra: el % de reseñas positivas DENTRO de esta muestra de 50 (NO es el % oficial de
//   Steam). Se usa únicamente en el cierre de la columna "recientes" (ver procesarColumna).
function armarInsumosDeResenas(reviews, { excluirIds = new Set() } = {}) {
  // Excluimos duplicados entre columnas (para que un destacado de "recientes" no se repita
  // también como destacado de "históricos") y, por las dudas, re-chequeamos basura/longitud
  // como red de seguridad extra (ya deberían venir filtradas desde obtenerResenasFiltradas).
  const validas = reviews.filter((r) => {
    if (excluirIds.has(r.recommendationid)) return false
    if (esComentarioBasura(r)) return false
    if (limpiarTextoResena(r.review).length > MAX_CARACTERES_COMENTARIO)
      return false
    return true
  })

  const conValoracion = validas
    .map((r) => ({ ...r, _valoracion: calcularValoracion(r) }))
    .sort((a, b) => b._valoracion - a._valoracion)

  const top50 = conValoracion.slice(0, 50)

  // Los 2 destacados: los más valorados del top 50 que ADEMÁS califiquen (ver calificaComoDestacado).
  // Si el mejor valorado es, por ejemplo, chino y tiene más de 50 caracteres, se lo salta y se
  // toma el siguiente mejor valorado que sí pase el chequeo. El que quedó afuera no se pierde:
  // como no entra en "destacados", cae automáticamente en "paraContexto" más abajo.
  const destacados = top50.filter(calificaComoDestacado).slice(0, 2)

  const idsDestacados = new Set(destacados.map((d) => d.recommendationid))
  const paraContexto = top50.filter(
    (r) => !idsDestacados.has(r.recommendationid),
  )

  const textoContexto = paraContexto
    .map((r) => `- ${limpiarTextoResena(r.review)}`)
    .join('\n')

  const totalPositivas = top50.filter((r) => r.voted_up).length
  const pctMuestra =
    top50.length > 0 ? Math.round((totalPositivas / top50.length) * 100) : 0

  return {
    textoContexto,
    destacados: destacados.map(formatearDestacado),
    pctMuestra,
  }
}

// ============================================================================
// TODO-EN-UNO: 1 solo llamado de IA por columna que arma resumen + traduce
// los 2 destacados (si hace falta) + redacta el cierre. Así son 2 llamados
// totales por análisis (1 por columna), en vez de hasta 4 por columna.
// ============================================================================

const INTRO_DESTACADOS_RECIENTES =
  'A continuación, vemos 2 comentarios destacados por la comunidad en los últimos 30 días:'
const INTRO_DESTACADOS_HISTORICOS =
  'A continuación, vemos 2 reseñas más valoradas por la comunidad:'

// Arma el prompt único que le pedimos a la IA: resumen + traducción de destacados + cierre,
// todo en formato JSON para poder parsearlo de forma determinística.
//
// `datosCierre` cambia de forma según `tipo`:
//   - 'recientes':  { pctMuestra }  -> % calculado sobre la muestra de 50 reseñas más valoradas
//                    de los últimos 30 días. El cierre es una RECOMENDACIÓN (comprar/probar/
//                    esperar/no recomendar), nunca una nota /10.
//   - 'historicos': { pctOficial, descOficialEsp } -> % OFICIAL de Steam sobre todo
//                    el historial (miles de reseñas). El cierre es una NOTA /10, nunca una
//                    recomendación de compra (para no contradecir a la columna de "recientes").
function construirPromptCompleto(tipo, textoContexto, destacados, datosCierre) {
  const instruccionResumen =
    tipo === 'recientes'
      ? `Sos un analista que resume ÚNICAMENTE lo que opina la comunidad de jugadores en Steam en sus reseñas de los últimos 30 días, nunca lo que es el juego en sí. Tenés PROHIBIDO describir el género, la ambientación, la historia o las mecánicas como si fuera una ficha de producto (eso ya lo redactan los desarrolladores, no es tu trabajo). Contá SOLO los temas que la gente REALMENTE menciona en las reseñas de más abajo (puede ser rendimiento, bugs, balance, contenido nuevo, precio, servidores, actualizaciones, o cualquier otra cosa, no hay una lista fija de temas obligatorios). Si en las reseñas nadie habla de rendimiento, FPS u optimización, NO los menciones ni asumas que "no hay quejas técnicas" — simplemente no es un tema que haya surgido, y mencionarlo igual sería inventar algo que la comunidad no dijo. Adaptate al tipo de juego: en un título simple, liviano o 2D no tiene sentido sacar el tema de FPS u optimización si nadie lo comenta; en un juego pesado o exigente, si la gente sí lo menciona, ahí sí correspondería. Redactá un párrafo directo (4 a 5 líneas aproximadamente) que mencione 2 o 3 puntos concretos y recurrentes que hayas notado en las reseñas, siempre citando la percepción de los jugadores ("varios reportan que...", "la comunidad siente que..."), nunca como descripción objetiva del juego, y sin listar géneros ni funciones.`
      : `Sos un analista que resume ÚNICAMENTE la opinión real de la comunidad de Steam sobre este juego, nunca una descripción del juego en sí (nada de género, ambientación o mecánicas como ficha de producto). Basándote en las reseñas de todos los tiempos de más abajo, contá qué es lo que la comunidad realmente valora o critica, usando ÚNICAMENTE los temas que aparecen en esos comentarios (puede ser la jugabilidad, el mundo, el combate, la banda sonora, el precio, la duración, la rejugabilidad, o cualquier otra cosa que la gente mencione — no una lista fija de temas obligatorios). No des por sentado ni menciones un tema si no aparece reflejado en las reseñas de contexto. Redactá un párrafo directo (4 a 5 líneas aproximadamente) que mencione 2 o 3 puntos concretos y recurrentes, siempre citando la percepción real de los jugadores, nunca describiendo de qué trata el juego.`

  const bloqueDestacados = destacados
    .map(
      (d, i) =>
        `DESTACADO_${i + 1} (idioma original reportado por Steam: "${d.language || 'desconocido'}"):\n${d.review}`,
    )
    .join('\n\n')

  const instruccionDestacados =
    destacados.length > 0
      ? `\n\nAdemás, te paso ${destacados.length} comentario(s) destacado(s) por la comunidad (son los mejor valorados). Si alguno NO está escrito en español, traducilo al español completo, natural y fiel al original, sin resumirlo ni acortarlo. Si ya está en español, dejalo tal cual (como mucho corregí errores de tipeo obvios).\n\n${bloqueDestacados}`
      : ''

  let instruccionCierre
  if (tipo === 'recientes') {
    const { pctMuestra } = datosCierre
    instruccionCierre = `Por último, redactá una frase de cierre en español (máximo 2 líneas) con una RECOMENDACIÓN concreta y honesta: si vale la pena comprarlo ya, esperar una rebaja, o directamente evitarlo por ahora. NO uses el formato "puntuación X/10", esto tiene que sonar a consejo, no a nota escolar. Empezá OBLIGATORIAMENTE con "De las reseñas más recientes (últimos 30 días), un ${pctMuestra}% son positivas, por lo que" y completá la frase con tu recomendación concreta (o reformulalo ligeramente pero siempre arrancando con ese scope temporal explícito). Usá EXACTAMENTE el número ${pctMuestra}% y no menciones ninguna cantidad de reseñas (nada de "50 reseñas").`
} else {
    const { pctOficial, descOficialEsp } = datosCierre
    instruccionCierre =
      pctOficial !== null
        ? `Por último, redactá una frase de cierre en español (máximo 2 líneas) con una conclusión/recomendación basada en el panorama histórico del juego. NO es una recomendación de compra inmediata tipo "cómpralo ya" o "esperá una rebaja" (eso lo hace la otra columna, que analiza los últimos 30 días). Empezá OBLIGATORIAMENTE con "En vista general desde su lanzamiento, el juego tiene un ${pctOficial}% de reseñas positivas (Steam las clasifica como «${descOficialEsp}»), por lo que" y completá con tu conclusión (recomiendo / no recomiendo / recomiendo con reservas, etc.). NO uses formato de puntuación tipo "X/10" ni ningún número en formato "x/x". Usá EXACTAMENTE el número ${pctOficial}% y no menciones ninguna cantidad de reseñas.`
        : `Por último, redactá una frase de cierre en español (máximo 2 líneas) aclarando que no hay datos oficiales suficientes de Steam como para dar una puntuación confiable, pero mencioná brevemente la impresión general que te dejaron las reseñas que leíste.`
  }

  return `${instruccionResumen}${instruccionDestacados}

${instruccionCierre}

RESEÑAS DE CONTEXTO PARA ARMAR EL RESUMEN (no las repitas ni las cites, son solo insumo):
${textoContexto}

Respondé ÚNICAMENTE con un JSON válido, sin texto antes ni después, sin marcadores de código como \`\`\`, con EXACTAMENTE esta forma:
{"resumen": "...", "destacados": [${destacados.map((_, i) => `"traducción o texto original del DESTACADO_${i + 1}"`).join(', ')}], "cierre": "..."}`
}

// Intenta extraer y parsear el JSON de la respuesta de la IA, aunque venga con texto
// extra alrededor o con marcadores de código.
function extraerJSON(textoCrudo) {
  if (!textoCrudo) return null
  let limpio = textoCrudo.trim()
  limpio = limpio
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  const inicio = limpio.indexOf('{')
  const fin = limpio.lastIndexOf('}')
  if (inicio === -1 || fin === -1 || fin < inicio) return null

  try {
    return JSON.parse(limpio.slice(inicio, fin + 1))
  } catch {
    return null
  }
}

const SYSTEM_MSG =
  'Respondés siempre y únicamente en JSON válido, sin texto adicional ni marcadores de código.'

// FUNCIÓN AUXILIAR: crea un "intento" que llama a un modelo de Groq vía el SDK.
// Todos los modelos de Groq comparten la misma forma de llamado, solo cambia el nombre del modelo.
function crearIntentoGroq(nombre, modelo) {
  return {
    nombre,
    llamar: async (promptCompleto) => {
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: SYSTEM_MSG },
          { role: 'user', content: promptCompleto },
        ],
        model: modelo,
        max_tokens: 1800,
        temperature: 0.4,
      })
      return chatCompletion.choices[0]?.message?.content
    },
  }
}

// Los 3 modelos de Groq vigentes hoy (reemplazan a llama-3.3-70b-versatile,
// llama-3.1-8b-instant, gemma2-9b-it y mixtral-8x7b-32768, todos deprecados/removidos).
const intentoGptOss120b = crearIntentoGroq(
  'Groq (GPT-OSS 120B)',
  'openai/gpt-oss-120b',
)
const intentoGptOss20b = crearIntentoGroq(
  'Groq (GPT-OSS 20B)',
  'openai/gpt-oss-20b',
)
// Ojo: qwen3.6-27b está listado como modelo "preview" en Groq (pensado para evaluación,
// no para producción 100% estable). Lo dejamos como respaldo extra, no como principal.
const intentoQwen36 = crearIntentoGroq(
  'Groq (Qwen 3.6 27B)',
  'qwen/qwen3.6-27b',
)

// Gemini como cuarto respaldo, fuera de Groq (otro proveedor = otro pool de cuota).
const intentoGemini = {
  nombre: 'Gemini 2.5 Flash',
  llamar: async (promptCompleto) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`
    const r = await axios.post(url, {
      contents: [{ parts: [{ text: promptCompleto }] }],
    })
    return r.data?.candidates?.[0]?.content?.parts?.[0]?.text
  },
}

// Órdenes distintos por columna: así "recientes" e "históricos" no le pegan
// las 2 veces seguidas al mismo modelo/cuota como proveedor principal.
const ORDEN_RECIENTES = [
  intentoGptOss120b,
  intentoQwen36,
  intentoGptOss20b,
  intentoGemini,
]
const ORDEN_HISTORICOS = [
  intentoGptOss20b,
  intentoGemini,
  intentoGptOss120b,
  intentoQwen36,
]

// Cascada de proveedores: recorre el orden recibido y se queda con el primero que
// devuelva un JSON válido con un campo "resumen".
async function obtenerAnalisisCompletoIA(promptCompleto, ordenProveedores) {
  for (const intento of ordenProveedores) {
    try {
      const textoCrudo = await intento.llamar(promptCompleto)
      const json = extraerJSON(textoCrudo)
      if (json && typeof json.resumen === 'string' && json.resumen.trim()) {
        console.log(
          `🟢 Análisis combinado generado con éxito por ${intento.nombre}.`,
        )
        return json
      }
      console.log(
        `⚠️ ${intento.nombre} no devolvió un JSON válido, probando el siguiente...`,
      )
    } catch (err) {
      console.log(
        `⚠️ ${intento.nombre} falló (${err.message}), probando el siguiente...`,
      )
    }
  }

  return null // todos los proveedores fallaron
}

// Procesa una columna completa (recientes o históricos) con UN solo llamado de IA.
//
// `datosOficiales` SOLO se usa para 'historicos' ({ pctOficial, descOficialEsp }, calculado a
// partir del query_summary oficial de Steam sobre TODAS las reseñas). Para 'recientes' se pasa
// null y en cambio se usa insumos.pctMuestra (calculado sobre la muestra de 50 más valoradas).
async function procesarColumna(tipo, insumos, datosOficiales) {
  const introDestacados =
    insumos.destacados.length > 0
      ? tipo === 'recientes'
        ? INTRO_DESTACADOS_RECIENTES
        : INTRO_DESTACADOS_HISTORICOS
      : ''

  let datosCierre
  let cierreFallback

  if (tipo === 'recientes') {
    const { pctMuestra } = insumos
    datosCierre = { pctMuestra }
    cierreFallback = `Con un ${pctMuestra}% de opiniones positivas entre las reseñas más valoradas de los últimos 30 días, ${veredictoSegunPct(pctMuestra)}.`
  } else {
    const { pctOficial, descOficialEsp } = datosOficiales
    datosCierre = { pctOficial, descOficialEsp }
    cierreFallback =
      pctOficial !== null
        ? `En vista general desde su lanzamiento, el juego tiene un ${pctOficial}% de reseñas positivas (${descOficialEsp}), por lo que lo recomiendo como una buena opción.`
        : 'No hay datos oficiales suficientes de Steam como para dar una puntuación confiable.'
  }

  if (!insumos.textoContexto) {
    return {
      resumen:
        tipo === 'recientes'
          ? 'No hay suficientes comentarios recientes para evaluar el estado técnico.'
          : 'No hay reseñas históricas suficientes para evaluar el juego.',
      destacados: insumos.destacados,
      cierre: cierreFallback,
      intro: '',
    }
  }

  const promptCompleto = construirPromptCompleto(
    tipo,
    insumos.textoContexto,
    insumos.destacados,
    datosCierre,
  )

  const ordenProveedores =
    tipo === 'recientes' ? ORDEN_RECIENTES : ORDEN_HISTORICOS
  const resultadoIA = await obtenerAnalisisCompletoIA(
    promptCompleto,
    ordenProveedores,
  )

  // Fallback total: si TODOS los proveedores fallaron, igual devolvemos algo coherente
  // (resumen genérico, destacados sin traducir, cierre con los números reales).
  if (!resultadoIA) {
    return {
      resumen:
        'No se pudo generar el resumen debido a una saturación global en los proveedores de IA.',
      destacados: insumos.destacados,
      cierre: cierreFallback,
      intro: introDestacados,
    }
  }

  const destacadosFinal = insumos.destacados.map((d, i) => {
    const traducido =
      Array.isArray(resultadoIA.destacados) && resultadoIA.destacados[i]
        ? String(resultadoIA.destacados[i]).trim()
        : null
    if (!traducido) return d
    // SALVAGUARDA CLAVE: el original ya viene garantizado ≤400 caracteres, pero una traducción
    // desde un idioma muy "denso" (chino, japonés, coreano) puede expandirse varias veces. Este
    // tope duro asegura que, pase lo que pase en la traducción, nunca llegue un destacado gigante.
    return {
      ...d,
      review: traducido.slice(0, MAX_CARACTERES_DESTACADO_TRADUCIDO),
    }
  })

  return {
    resumen: resultadoIA.resumen?.trim() || 'No se pudo generar el resumen.',
    destacados: destacadosFinal,
    cierre: resultadoIA.cierre?.trim() || cierreFallback,
    intro: introDestacados,
  }
}

// ENDPOINT 2: El motor de análisis con sistema de redundancia
app.get('/analizar/:appId', async (req, res) => {
  const { appId } = req.params
  const nombreDesdeUrl = req.query.name || ''

  try {
    // 1. CONSULTAS DE METADATA A STEAM
    // Este resumen oficial (miles de reseñas de TODA la vida del juego) es el que ya se
    // mostraba arriba en la tarjeta, y ahora también alimenta el cierre de "históricos".
    const urlMetaGeneral = `https://store.steampowered.com/appreviews/${appId}?json=1&filter=all&language=all&num_per_page=0`
    const urlAppDetails = `https://store.steampowered.com/api/appdetails?appids=${appId}`

    // 2. TRAEMOS RESEÑAS YA FILTRADAS: se pide de a 100, filtrando basura y longitud
    // (≤ 400 caracteres en el original) sobre la marcha, hasta juntar 150 candidatas válidas
    // por columna (o hasta agotar las reseñas del juego, típico de indies/juegos nuevos).
    // "Recientes" además exige que la reseña sea de los últimos 30 días.
    const limiteRecientes = Math.floor(Date.now() / 1000) - SEGUNDOS_30_DIAS
    const [
      resMetaGeneral,
      resAppDetails,
      listaRecientesFiltrada,
      listaHistoricasFiltrada,
    ] = await Promise.all([
      axios.get(urlMetaGeneral),
      axios.get(urlAppDetails),
      obtenerResenasFiltradas(appId, {
        dayRange: 30,
        filtroAdicional: (r) => r.timestamp_created >= limiteRecientes,
      }),
      obtenerResenasFiltradas(appId, { dayRange: null }),
    ])

    const appDetailsData = resAppDetails.data?.[appId]?.data || {}
    const headerImage = appDetailsData.header_image || ''
    const capsuleImageV5 = appDetailsData.capsule_imagev5 || ''
    const metacritic = appDetailsData.metacritic || {}
    const nombreJuego =
      nombreDesdeUrl || appDetailsData.name || 'Juego Desconocido'

    const summaryGeneral = resMetaGeneral.data?.query_summary || {}

    const calcularPorcentaje = (positives, total) => {
      if (!total || total === 0) return 0
      return Math.round((positives / total) * 100)
    }

    const pctGeneral = calcularPorcentaje(
      summaryGeneral.total_positive,
      summaryGeneral.total_reviews,
    )

    // % y clasificación OFICIAL de Steam sobre todo el historial (miles de reseñas). Se usa
    // SOLO para el cierre de la columna "históricos" (estilo puntuación /10). La columna
    // "recientes" usa en cambio insumos.pctMuestra (calculado sobre la muestra de 50).
    const datosOficialesHistoricos = {
      pctOficial: summaryGeneral.total_reviews > 0 ? pctGeneral : null,
      descOficialEsp: traducirDescripcionValve(
        summaryGeneral.review_score_desc,
      ),
    }

    const metaCard = {
      appId: appId,
      name: nombreJuego,
      header_image: headerImage,
      capsule_imagev5: capsuleImageV5,
      metacritic: {
        score: metacritic.score ?? null,
        url: metacritic.url ?? null,
      },
      allReviews: {
        review_score: summaryGeneral.review_score ?? 0,
        review_score_desc: summaryGeneral.review_score_desc || 'Sin análisis',
        total_reviews: summaryGeneral.total_reviews || 0,
        total_positive: summaryGeneral.total_positive || 0,
        total_negative: summaryGeneral.total_negative || 0,
        positive_percentage: pctGeneral,
      },
    }

    // 3. ARMAMOS LOS INSUMOS: recientes (30 días) e históricos (todas las fechas) por separado
    const insumosRecientes = armarInsumosDeResenas(listaRecientesFiltrada)
    const idsDestacadosRecientes = new Set(
      insumosRecientes.destacados.map((d) => d.recommendationid),
    )
    const insumosHistoricas = armarInsumosDeResenas(listaHistoricasFiltrada, {
      excluirIds: idsDestacadosRecientes,
    })

    // 4. GENERAMOS TODO EN 2 LLAMADOS DE IA (uno por columna): resumen + destacados
    // traducidos (si hace falta) + cierre, todo junto en un solo JSON por columna.
    // Cada columna usa un orden de proveedores distinto (ver ORDEN_RECIENTES / ORDEN_HISTORICOS)
    // para no vaciar la cuota del mismo modelo dos veces seguidas.
    const resultadoRecientes = await procesarColumna(
      'recientes',
      insumosRecientes,
      null, // 'recientes' no usa datos oficiales, usa insumosRecientes.pctMuestra
    )

    await esperar(1500) // Pausa para evitar bloqueos por IP entre las 2 columnas

    const resultadoHistoricas = await procesarColumna(
      'historicos',
      insumosHistoricas,
      datosOficialesHistoricos,
    )

    // 5. CONSULTAR A IGDB
    let igdbDatos = {
      criticScore: '--',
      userScore: '--',
      totalScore: '--',
      count: 0,
    }

    const igdbToken = await obtenerIgdbToken()

    if (igdbToken) {
      try {
        const urlGames = 'https://api.igdb.com/v4/games'
        let nombreParaBuscar = nombreJuego
          .toLowerCase()
          .replace('remake', '')
          .trim()

        const queryGames = `fields name, rating, aggregated_rating, total_rating, total_rating_count, summary; search "${nombreParaBuscar}"; limit 5;`
        const resGame = await axios.post(urlGames, queryGames, {
          headers: {
            'Client-ID': IGDB_CLIENT_ID,
            Authorization: `Bearer ${igdbToken}`,
            'Content-Type': 'text/plain',
            Accept: 'application/json',
          },
        })

        if (resGame.data && resGame.data.length > 0) {
          const candidatos = resGame.data
          const quiereRemake = nombreJuego.toLowerCase().includes('remake')
          let juegoCorrecto = null

          if (quiereRemake) {
            juegoCorrecto = candidatos.find(
              (c) =>
                c.summary &&
                (c.summary.toLowerCase().includes('remake') ||
                  c.summary.includes('2023')),
            )
          }

          if (!juegoCorrecto) {
            juegoCorrecto =
              candidatos.find((c) => c.total_rating) || candidatos[0]
          }

          const criticScore = juegoCorrecto.aggregated_rating
            ? (Math.round(juegoCorrecto.aggregated_rating) / 10).toFixed(1)
            : '--'
          const userScore = juegoCorrecto.rating
            ? (juegoCorrecto.rating / 10).toFixed(1)
            : '--'
          const totalScore = juegoCorrecto.total_rating
            ? (juegoCorrecto.total_rating / 10).toFixed(1)
            : '--'

          igdbDatos = {
            criticScore: criticScore.toString(),
            userScore: userScore.toString(),
            totalScore: totalScore.toString(),
            count: juegoCorrecto.total_rating_count || 0,
          }
        }
      } catch (err) {
        console.error('Error filtrando IGDB en el backend:', err.message)
      }
    }

    // 6. RESPUESTA FINAL (mismo shape que el frontend ya espera)
    return res.json({
      metaCard,
      resumenTecnico: resultadoRecientes.resumen,
      resumenGeneral: resultadoHistoricas.resumen,
      introDestacadosRecientes: resultadoRecientes.intro,
      cierreRecientes: resultadoRecientes.cierre,
      introDestacadosHistoricos: resultadoHistoricas.intro,
      cierreHistoricos: resultadoHistoricas.cierre,
      destacadosRecientes: resultadoRecientes.destacados,
      destacadosHistoricos: resultadoHistoricas.destacados,
      igdb: igdbDatos,
    })
  } catch (error) {
    console.error('Error crítico en el analizador:', error.message)
    return res
      .status(500)
      .json({ error: 'Error general al procesar el análisis.' })
  }
})

app.listen(PORT, () => {
  console.log(
    `🚀 Backend unificado con Groq corriendo en http://localhost:${PORT}`,
  )
})
