/**
 * Manual test for the MTG deck-building assistant.
 *
 * Validates Kimi k2.5 (via OpenRouter) + minimal Scryfall RAG integration:
 *   1. Looks up each card in the deck list against the Scryfall API
 *   2. Builds a context block from the retrieved card data
 *   3. Sends the enriched prompt to kimi-k2-5 via `generate()`
 *   4. Prints the model's deck analysis
 *
 * Usage (from repo root):
 *   set -a && source .env && set +a
 *   npx tsx test-mtg-assistant.ts
 */

import { Client, OpenRouterAdapter, generate, Message } from './packages/llm/src/index.js'

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL = 'moonshotai/kimi-k2-5'

const API_KEY = process.env['OPENROUTER_API_KEY']
if (!API_KEY) {
  console.error('❌  OPENROUTER_API_KEY is not set.')
  console.error('    Run:  set -a && source .env && set +a')
  process.exit(1)
}

const client = new Client({
  providers: {
    openrouter: new OpenRouterAdapter({ api_key: API_KEY }),
  },
  default_provider: 'openrouter',
})

// ── Mock deck list ────────────────────────────────────────────────────────────
//
// A tiny Atraxa superfriends shell — representative EDH deck.

const MOCK_DECK = `
Commander:
1 Atraxa, Praetors' Voice

Mainboard:
1 Sol Ring
1 Command Tower
1 Evolving Wilds
1 Cultivate
1 Kodama's Reach
1 Doubling Season
1 Deepglow Skate
1 Viral Drake
1 Inexorable Tide
1 Contagion Engine
1 Tamiyo, Field Researcher
1 Teferi, Hero of Dominaria
1 Vraska, Golgari Queen
`.trim()

// ── Scryfall RAG ──────────────────────────────────────────────────────────────
//
// Extracts card names from a decklist and fetches their oracle text from
// Scryfall, building a compact context block for the model.

interface ScryfallCard {
  name: string
  mana_cost?: string
  type_line: string
  oracle_text?: string
  power?: string
  toughness?: string
  loyalty?: string
}

/**
 * Parse card names out of a simple decklist (handles "1 Card Name" lines,
 * skips section headers and blank lines).
 */
function parseCardNames(decklist: string): string[] {
  const names: string[] = []
  for (const raw of decklist.split('\n')) {
    const line = raw.trim()
    if (!line || line.endsWith(':')) continue          // blank / section header
    const match = line.match(/^\d+\s+(.+)$/)
    if (match?.[1]) names.push(match[1])
  }
  return names
}

/**
 * Fetch a single card from Scryfall by exact name.
 * Returns null on any error (network, 404, etc.) so the rest of the deck
 * can still be processed.
 */
async function fetchCard(name: string): Promise<ScryfallCard | null> {
  try {
    const url = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'mtg-assistant-test/1.0' },
    })
    if (!res.ok) {
      console.warn(`  ⚠  Scryfall ${res.status} for "${name}"`)
      return null
    }
    const data = await res.json() as Record<string, unknown>
    return {
      name:        data['name']        as string,
      mana_cost:   data['mana_cost']   as string | undefined,
      type_line:   data['type_line']   as string,
      oracle_text: data['oracle_text'] as string | undefined,
      power:       data['power']       as string | undefined,
      toughness:   data['toughness']   as string | undefined,
      loyalty:     data['loyalty']     as string | undefined,
    }
  } catch (err) {
    console.warn(`  ⚠  Network error for "${name}": ${String(err)}`)
    return null
  }
}

/**
 * Fetch all cards in the decklist concurrently (Scryfall rate-limit is
 * generous for small requests; cap parallelism to 4 to be polite).
 */
async function fetchDeckCards(names: string[]): Promise<ScryfallCard[]> {
  const results: ScryfallCard[] = []
  const CHUNK = 4
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK)
    const fetched = await Promise.all(chunk.map(fetchCard))
    for (const card of fetched) {
      if (card) results.push(card)
    }
    // Brief pause between chunks to be a polite Scryfall consumer
    if (i + CHUNK < names.length) {
      await new Promise(r => setTimeout(r, 100))
    }
  }
  return results
}

/**
 * Format a card as a concise oracle-text block for the model's context.
 */
function formatCard(card: ScryfallCard): string {
  const lines: string[] = [`${card.name} ${card.mana_cost ?? ''}`.trim()]
  lines.push(card.type_line)
  if (card.oracle_text) lines.push(card.oracle_text)
  if (card.power && card.toughness) lines.push(`${card.power}/${card.toughness}`)
  if (card.loyalty) lines.push(`Loyalty: ${card.loyalty}`)
  return lines.join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function test(): Promise<void> {
  console.log('🃏  MTG Assistant — integration test')
  console.log(`    Model : ${MODEL}`)
  console.log()

  // 1. Parse card names from the mock deck
  const cardNames = parseCardNames(MOCK_DECK)
  console.log(`📋  Parsed ${cardNames.length} cards from decklist`)

  // 2. Fetch oracle text from Scryfall (RAG retrieval step)
  console.log('🔍  Fetching card data from Scryfall…')
  const cards = await fetchDeckCards(cardNames)
  console.log(`    Retrieved ${cards.length}/${cardNames.length} cards`)
  console.log()

  // 3. Build the RAG context block
  const cardContext = cards.map(formatCard).join('\n\n---\n\n')

  const systemPrompt = `You are an expert Magic: The Gathering deck-building assistant
specialising in Commander (EDH) format. You have deep knowledge of card
synergies, mana curves, and competitive viability. When analysing decklists,
be specific: cite card names, explain mechanical interactions, and give
actionable improvement suggestions.`

  const userMessage = `Here is an EDH deck I'm working on:

--- DECK LIST ---
${MOCK_DECK}

--- CARD ORACLE TEXT (from Scryfall) ---
${cardContext}

What do you think of this deck? Please:
1. Identify the main strategy / win conditions
2. Highlight the 2–3 strongest synergies
3. Suggest 2–3 cards that would improve the deck and explain why`

  // 4. Call Kimi k2.5 via the @attractor/llm generate() API
  console.log('🤖  Calling Kimi k2.5 via OpenRouter…')
  console.log()

  let result
  try {
    result = await generate({
      client,
      model: MODEL,
      provider: 'openrouter',
      messages: [Message.user(userMessage)],
      system: systemPrompt,
      max_tokens: 1024,
      temperature: 0.7,
    })
  } catch (err) {
    console.error('❌  generate() threw an error:')
    console.error(err)
    process.exit(1)
  }

  // 5. Print results
  console.log('─'.repeat(60))
  console.log('📝  Model response:')
  console.log('─'.repeat(60))
  console.log(result.text)
  console.log()
  console.log('─'.repeat(60))
  console.log('📊  Token usage:')
  console.log(`    Input  : ${result.usage.input_tokens}`)
  console.log(`    Output : ${result.usage.output_tokens}`)
  console.log(`    Total  : ${result.usage.total_tokens}`)
  console.log(`    Finish : ${result.finish_reason.reason}`)
  console.log()
  console.log('✅  Test complete.')
}

test().catch(err => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
