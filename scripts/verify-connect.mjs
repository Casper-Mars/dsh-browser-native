/**
 * Live attach check for dsh-browser-native.
 *
 * Runs the plugin's own attach path (dist/session.js → CdpSession) against a
 * real CDP endpoint, opens a page, navigates, and disconnects. Used as the
 * AC3 evidence command:
 *
 *   node scripts/verify-connect.mjs 'ws://host.docker.internal:3000/?token=test-token'
 */

import { buildSnapshot } from '../dist/html.js'
import { CdpSession } from '../dist/session.js'

const cdpUrl = process.argv[2] ?? process.env.DSH_BROWSER_CDP_URL
if (cdpUrl === undefined || cdpUrl.trim() === '') {
  console.error('usage: node scripts/verify-connect.mjs <cdp-url>')
  process.exit(2)
}

const session = new CdpSession({ cdpUrl, connectTimeoutMs: 20_000 })
const page = await session.ensurePage()
console.log('attach:', JSON.stringify(session.status()))

const response = await page.goto('https://example.com', {
  waitUntil: 'domcontentloaded',
  timeout: 30_000,
})
console.log('goto:', JSON.stringify({ status: response?.status() ?? null, url: page.url(), title: await page.title() }))

const snapshot = buildSnapshot(await page.content(), { maxLength: 120 })
console.log('snapshot:', JSON.stringify({ title: snapshot.title, elements: snapshot.elements.length, text: snapshot.text.split('\n')[0] }))

const again = await session.ensurePage()
console.log('reused same page:', again === page)

console.log('close:', JSON.stringify(await session.close()))
console.log('after close:', JSON.stringify(session.status()))
