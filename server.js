import express from 'express'
import axios from 'axios'
import 'dotenv/config'
import Groq from 'groq-sdk' // Importamos el SDK de Groq

const GROQ_API_KEY = process.env.GROQ_API_KEY
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID
const IGDB_CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET
const CHATGPT_API_KEY = process.env.CHATGPT_API_KEY

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

// FUNCIÓN AUXILIAR: Pedir resumen a Groq (Reemplaza a Gemini)
async function pedirResumenGroq(instruccionSistema, bloqueTexto) {
  if (!GROQ_API_KEY) {
    return 'Error: API Key de Groq no configurada.'
  }
  try {
    // Usamos el modelo top de Groq con gran ventana de contexto
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: instruccionSistema },
        { role: 'user', content: `Reseñas de los usuarios:\n${bloqueTexto}` },
      ],
      model: 'llama-3.3-70b-versatile',
      max_tokens: 600,
      temperature: 0.5,
    })
    return (
      chatCompletion.choices[0]?.message?.content || 'No se recibió respuesta.'
    )
  } catch (error) {
    console.error('Error en Groq:', error.message)
    return 'No se pudo generar el resumen con Groq debido a un error en la API.'
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

// Función con rotación de modelos en cascada (4 de Groq + Gemini + ChatGPT de último recurso)
async function obtenerResumenAI(prompt, textoCompleto) {
  // Recortamos el texto para no saturar los Tokens Por Minuto (TPM)
  const textoRecortado = textoCompleto.substring(0, 8000)

  // Intento 1: Tu función original de Groq
  try {
    const resumen = await pedirResumenGroq(prompt, textoRecortado)
    if (resumen && !resumen.includes('No se pudo generar')) {
      console.log('🟢 Resumen generado con éxito por Groq (Función Principal).')
      return resumen
    }
    throw new Error('La función principal de Groq devolvió un error string.')
  } catch (e) {
    console.log('⚠️ Groq principal falló. Intentando con Groq Llama-3.1-8b...')
  }

  // Intento 2: Groq directo con Llama 3.1 8B Instant
  try {
    const resGroqDirecto = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'user', content: `${prompt}\n\nReseñas:\n${textoRecortado}` },
        ],
        max_tokens: 150,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    )
    const respuesta = resGroqDirecto.data?.choices?.[0]?.message?.content
    if (respuesta) {
      console.log('🟢 Resumen generado con éxito por Groq (Llama 3.1 8B).')
      return respuesta.trim()
    }
  } catch (e) {
    console.log(
      '⚠️ Groq Llama 3.1 también falló. Intentando con Groq Gemma 2...',
    )
  }

  // Intento 3: Groq directo con Gemma 2 9B
  try {
    const resGemma = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'gemma2-9b-it',
        messages: [
          { role: 'user', content: `${prompt}\n\nReseñas:\n${textoRecortado}` },
        ],
        max_tokens: 150,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    )
    const respuestaGemma = resGemma.data?.choices?.[0]?.message?.content
    if (respuestaGemma) {
      console.log('🟢 Resumen generado con éxito por Groq (Gemma 2).')
      return respuestaGemma.trim()
    }
  } catch (e) {
    console.log('⚠️ Groq Gemma 2 falló. Intentando con Groq Mixtral 8x7B...')
  }

  // Intento 4: Groq directo con Mixtral 8x7B
  try {
    const resMixtral = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'mixtral-8x7b-32768',
        messages: [
          { role: 'user', content: `${prompt}\n\nReseñas:\n${textoRecortado}` },
        ],
        max_tokens: 150,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    )
    const respuestaMixtral = resMixtral.data?.choices?.[0]?.message?.content
    if (respuestaMixtral) {
      console.log('🟢 Resumen generado con éxito por Groq (Mixtral 8x7B).')
      return respuestaMixtral.trim()
    }
  } catch (e) {
    console.log(
      '⚠️ Todos los modelos de Groq agotados. Saltando a Gemini 1.5 Flash...',
    )
  }

  // Intento 5: Fallback con Gemini 1.5 Flash
  try {
    const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`
    const resGemini = await axios.post(urlGemini, {
      contents: [
        {
          parts: [
            { text: `${prompt}\n\nReseñas a analizar:\n${textoRecortado}` },
          ],
        },
      ],
    })
    const textoGemini =
      resGemini.data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (textoGemini) {
      console.log('🟢 Resumen generado con éxito por Gemini 1.5 Flash.')
      return textoGemini.trim()
    }
    throw new Error('Estructura de Gemini inválida')
  } catch (geminiError) {
    console.log(
      '⚠️ Gemini también falló. Activando último recurso con ChatGPT (gpt-4o-mini)...',
    )
  }

  // NUEVO - Intento 6: Último recurso absoluto con ChatGPT de OpenAI
  try {
    const resChatGPT = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: `${prompt}\n\nReseñas:\n${textoRecortado}` },
        ],
        max_tokens: 150,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.CHATGPT_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    )
    const respuestaChatGPT = resChatGPT.data?.choices?.[0]?.message?.content
    if (respuestaChatGPT) {
      console.log('🟢 Resumen generado con éxito por ChatGPT (gpt-4o-mini).')
      return respuestaChatGPT.trim()
    }
    throw new Error('Estructura de ChatGPT inválida')
  } catch (chatgptError) {
    console.error(
      '❌ Todas las IA fallaron por completo:',
      chatgptError.response?.data || chatgptError.message,
    )
    return 'No se pudo generar el resumen debido a una saturación global en los proveedores de IA.'
  }
}

// ENDPOINT 2: El motor de análisis con sistema de redundancia cuádruple
app.get('/analizar/:appId', async (req, res) => {
  const { appId } = req.params
  const nombreDesdeUrl = req.query.name || ''

  try {
    // 1. CONSULTAS DE METADATA A STEAM
    const urlMetaGeneral = `https://store.steampowered.com/appreviews/${appId}?json=1&filter=all&language=all&num_per_page=0`
    const urlAppDetails = `https://store.steampowered.com/api/appdetails?appids=${appId}`

    // CONSULTAS DE TEXTO (50 comentarios)
    const urlTextoRecientes = `https://store.steampowered.com/appreviews/${appId}?json=1&filter=recent&sort=all&num_per_page=50`
    const urlTextoHistoricas = `https://store.steampowered.com/appreviews/${appId}?json=1&filter=all&sort=all&num_per_page=50`

    const [resMetaGeneral, resAppDetails, resTxtRecientes, resTxtHistoricas] =
      await Promise.all([
        axios.get(urlMetaGeneral),
        axios.get(urlAppDetails),
        axios.get(urlTextoRecientes),
        axios.get(urlTextoHistoricas),
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

    // Calculamos la nota exacta de la muestra para inyectar en el prompt
    const listaRecientes = resTxtRecientes.data?.reviews || []
    const totalRecientes = listaRecientes.length
    const positivasRecientes = listaRecientes.filter(
      (r) => r.voted_up === true,
    ).length

    const pctRecientes =
      totalRecientes > 0
        ? Math.round((positivasRecientes / totalRecientes) * 100)
        : 0
    const notaRecientes = (pctRecientes / 10).toFixed(1)

    const textoRecientes = listaRecientes.map((r) => `- ${r.review}`).join('\n')
    const textoHistoricas = (resTxtHistoricas.data?.reviews || [])
      .map((r) => `- ${r.review}`)
      .join('\n')

    const promptTecnico = `Sos un analista de rendimiento. Basándote en estas reseñas de los últimos 30 días, redactá un resumen ultra corto, directo y al grano (máximo 1 párrafo de 3 líneas) sobre el ESTADO TÉCNICO ACTUAL (bugs, FPS, optimización). No des rodeos. Al finalizar el párrafo, incluí obligatoriamente un cierre usando estos datos reales: mencioná que le das una puntuación de ${notaRecientes}/10 ya que el ${pctRecientes}% de estas opiniones recientes son positivas.`
    const promptGeneral =
      'Sos un crítico de videojuegos. Basándote en estas reseñas de todos los tiempos, redactá un resumen ultra corto, directo y al grano (máximo 1 párrafo de 3 líneas) sobre la CALIDAD GENERAL del juego y su jugabilidad. No des rodeos.'

    // 2. PROCESAR RESÚMENES CON LA FUNCIÓN DE ALTA DISPONIBILIDAD
    let resumenTecnico =
      'No hay suficientes comentarios recientes para evaluar el estado técnico.'
    if (textoRecientes) {
      resumenTecnico = await obtenerResumenAI(promptTecnico, textoRecientes)
    }

    await esperar(1500) // Pausa un poquito más larga para evitar bloqueos por IP

    let resumenGeneral =
      'No hay reseñas históricas suficientes para evaluar el juego.'
    if (textoHistoricas) {
      resumenGeneral = await obtenerResumenAI(promptGeneral, textoHistoricas)
    }

    // 3. CONSULTAR A IGDB
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

    // 4. RESPUESTA FINAL
    return res.json({
      metaCard,
      resumenTecnico,
      resumenGeneral,
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
