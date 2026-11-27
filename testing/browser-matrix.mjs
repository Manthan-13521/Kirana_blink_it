import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { harness } from '../tests/harness.mjs'

const { chromium, firefox, webkit, devices } = await import(process.env.KIRANA_PLAYWRIGHT_MODULE || 'playwright')
const hosted = 'https://blink-it.pages.dev'
const only = process.argv[2]
const evidence = process.env.KIRANA_BROWSER_EVIDENCE_DIR
const matrix = [
  ['budget-android', chromium, devices['Moto G4']],
  ['modern-android', chromium, devices['Pixel 7']],
  ['iphone', webkit, devices['iPhone 15']],
  ['tablet', webkit, devices['iPad Mini']],
  ['desktop', chromium, { viewport: { width: 1440, height: 950 } }],
  ['desktop-firefox', firefox, { viewport: { width: 1366, height: 900 } }],
]
const args = (engine) => engine === chromium && process.env.KIRANA_CHROMIUM_PATH
  ? { executablePath: process.env.KIRANA_CHROMIUM_PATH } : {}
const local = await harness()
let failed = false
const report = (name, scope, fields) => console.log(JSON.stringify({ name, scope, ...fields }))
const button = (page, name) => page.getByRole('button', { name, exact: true })
try {
  for (const [name, engine, profile] of matrix) {
    if (only && only !== name) continue
    let browser
    try {
      browser = await engine.launch(args(engine))
      const context = await browser.newContext(profile)
      const page = await context.newPage()
      page.setDefaultTimeout(12000)
      const errors = []
      page.on('pageerror', error => errors.push(error.name))
      await page.goto(local.base)
      await page.locator('.product-card').first().waitFor()
      if (evidence && (name === 'desktop' || name === 'budget-android'))
        await page.screenshot({ path: join(evidence, name + '-storefront.png') })
      const search = page.getByRole('textbox', { name: 'Search groceries' })
      await search.focus()
      await search.fill('doodh')
      await button(page, 'Farm Toned Milk').waitFor()
      await button(page, 'Add Farm Toned Milk').click()
      await button(page, 'Increase Farm Toned Milk').first().click()
      await page.getByRole('button', { name: /^My basket/ }).click()
      const basket = page.getByRole('dialog')
      await basket.getByText('Farm Toned Milk', { exact: true }).waitFor()
      await button(basket, 'Remove Farm Toned Milk').click()
      assert.ok(await basket.getByText('Farm Toned Milk', { exact: true }).isVisible())
      await button(basket, 'Close').click()
      await page.reload()
      await page.getByRole('button', { name: /^My basket/ }).click()
      await basket.getByText('Farm Toned Milk', { exact: true }).waitFor()
      await button(basket, 'Close').click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.goto(local.base + '/owner')
      await button(page, 'Sign in as owner').click()
      await button(page, 'Continue as demo owner').click()
      await button(page, 'Catalog & stock').waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      const rider = await context.newPage()
      await rider.goto(local.base + '/rider')
      await button(rider, 'Sign in as rider').click()
      await button(rider, 'Continue as demo rider').click()
      await rider.getByRole('heading', { name: 'Your delivery run' }).waitFor()
      assert.equal(await rider.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (name === 'desktop') {
        await page.goto(local.base + '/owner')
        await button(page, 'Sign in as owner').click()
        await button(page, 'Continue as demo owner').click()
        await button(page, 'Catalog & stock').waitFor()
        await rider.getByRole('button', { name: 'Refresh assignments' }).click()
        await rider.getByRole('alert').getByText('This account cannot perform that action.').waitFor()
        assert.equal(await rider.getByRole('table').count(), 0)
      }
      assert.deepEqual(errors, [])
      report(name, 'local browser emulation', { result: 'pass', checks: 10 })
      await context.close()
    } catch (error) {
      failed = true
      report(name, 'local browser emulation', { result: 'fail', reason: error.message.split('\n')[0] })
    } finally { await browser?.close() }
  }

  if (!only || only === 'image') {
    const browser = await webkit.launch()
    try {
      const page = await browser.newPage({ ...devices['iPhone 15'], serviceWorkers: 'block' })
      page.setDefaultTimeout(12000)
      await page.goto(local.base + '/owner')
      await button(page, 'Sign in as owner').click()
      await button(page, 'Continue as demo owner').click()
      await button(page, 'Catalog & stock').click()
      await button(page, 'Add product').click()
      const form = page.getByRole('dialog')
      await form.getByLabel('Product name').fill('Browser recovery fixture')
      await form.getByLabel('SKU', { exact: true }).fill('BROWSER-RECOVERY')
      await form.getByRole('combobox').first().selectOption('fresh')
      await form.getByLabel('Selling price (₹)').fill('20')
      await form.locator('input[type=file]').setInputFiles(resolve('public/catalog/01.webp'))
      await form.getByText('01.webp', { exact: true }).waitFor()
      let interrupted = 0
      let detailsUpdates = 0
      page.on('request', request => {
        if (request.method() === 'PUT' && /\/api\/admin\/products\/[^/]+$/.test(request.url())) detailsUpdates++
      })
      await page.route(url => /\/api\/admin\/products\/[^/]+\/image$/.test(url.pathname), async (route) => {
        if (interrupted++ === 0) await route.abort('connectionfailed')
        else await route.continue()
      })
      assert.deepEqual(await form.locator('form :invalid').evaluateAll(nodes => nodes.map(node => node.parentElement.textContent)), [])
      await button(form, 'Save product').click()
      await form.getByRole('alert').waitFor({ timeout: 4000 }).catch(async (error) => {
        throw new Error(`Expected interrupted upload feedback after ${interrupted} image requests. ` +
          (await page.locator('dialog, [role=dialog], [role=status]').allTextContents()).map(text => text.slice(0, 140)).join(' ') +
          ' ' + error.message.split('\n')[0])
      })
      assert.match(await form.getByRole('alert').innerText(), /Product details were saved.*photo could not be updated.*connection unavailable/i)
      await button(form, 'Save product').click()
      await page.getByText('Product saved.', { exact: true }).waitFor()
      const response = await page.request.get(local.base + '/api/admin/products?q=browser+recovery')
      const { products } = await response.json()
      assert.equal(products.length, 1)
      assert.match(products[0].image, /^\/media\//)
      assert.equal(detailsUpdates, 0)
      report('interrupted image upload', 'local iPhone WebKit', { result: 'pass', attempts: interrupted,
        products: products.length, detailsUpdates })
    } catch (error) {
      failed = true
      report('interrupted image upload', 'local iPhone WebKit', { result: 'fail',
        reason: error.message.split('\n').filter(line => line.trim()).slice(0, 3).join(' ') })
    } finally { await browser.close() }
  }

  if (!only || only === 'hosted') {
    const browserLab = await chromium.launch(args(chromium))
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const page = await browserLab.newPage(devices['Moto G4'])
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 93750,
        })
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        await page.addInitScript(() => {
          const vitals = { lcp: null, cls: 0 }
          window.kiranaLabVitals = vitals
          new PerformanceObserver(list => { vitals.lcp = list.getEntries().at(-1)?.startTime ?? null })
            .observe({ type: 'largest-contentful-paint', buffered: true })
          new PerformanceObserver(list => {
            for (const entry of list.getEntries()) if (!entry.hadRecentInput) vitals.cls += entry.value
          }).observe({ type: 'layout-shift', buffered: true })
        })
        await page.goto(hosted, { waitUntil: 'load' })
        await page.locator('.product-card').first().waitFor()
        await page.waitForFunction(() => window.kiranaLabVitals.lcp !== null)
        const vitals = await page.evaluate(() => window.kiranaLabVitals)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        report('budget Android lab', 'hosted', { result: 'pass', attempt, lcpMs: Math.round(vitals.lcp), cls: vitals.cls })
        await page.close()
      }
      for (const [path, label] of [['/orders', 'Sign in to view orders'], ['/owner', 'Sign in as owner'], ['/rider', 'Sign in as rider']]) {
        const page = await browserLab.newPage()
        await page.goto(hosted + path)
        await button(page, label).click()
        await button(page, 'Continue with Google').waitFor()
        await page.close()
        report(path, 'hosted', { result: 'pass', check: 'Google sign-in entry' })
      }
    } catch (error) {
      failed = true
      report('hosted browser', 'Chromium', { result: 'fail', reason: error.message.split('\n')[0] })
    } finally { await browserLab.close() }
  }
} finally {
  await local.stop()
}
if (failed) process.exitCode = 1
