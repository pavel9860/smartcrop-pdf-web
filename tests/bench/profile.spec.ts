// Times the main workflow on a large native PDF and a large scanned PDF, and samples the peak
// resident memory of the test browser's processes. Prints one [bench] line per step.
import { test, expect, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'

// Summed RSS of the test browser's whole process tree (browser + renderers + GPU + utilities).
const browser_rss_mb = (): number => {
  const rows = execSync('ps -eo pid=,ppid=,rss=,args=', { encoding: 'utf8' }).split('\n')
    .map(l => l.trim().split(/\s+/)).filter(r => r.length >= 4)
    .map(([pid, ppid, rss, ...args]) => ({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss), args: args.join(' ') }))
  const tree = new Set(rows.filter(r => r.args.includes('playwright_chromium')).map(r => r.pid))
  for (let grew = true; grew;) {
    grew = false
    for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true }
  }
  return rows.filter(r => tree.has(r.pid)).reduce((s, r) => s + r.rss, 0) / 1024
}

async function idle(page: Page): Promise<void> {
  await expect(page.locator('#op-export')).toBeEnabled({ timeout: 600_000 })
  await page.waitForFunction(() => {
    const m = (window as unknown as { __model?: { view_snapshot(): { is_loading: boolean } } }).__model
    return m !== undefined && !m.view_snapshot().is_loading
  }, undefined, { timeout: 600_000 })
}

async function timed(name: string, run: () => Promise<void>): Promise<void> {
  const t0 = Date.now()
  await run()
  console.log(`[bench] ${name}: ${Date.now() - t0} ms`)
}

for (const [kind, file] of [['native', process.env['BENCH_NATIVE']], ['scan', process.env['BENCH_SCAN']]] as const) {
  test(`${kind} document workflow`, async ({ page }) => {
    test.skip(!file, `set BENCH_${kind.toUpperCase()}`)
    test.setTimeout(1_800_000)
    let peak = 0
    const sampler = setInterval(() => { peak = Math.max(peak, browser_rss_mb()) }, 500)
    await page.goto('/')
    await idle(page)
    const base_mb = browser_rss_mb()
    await timed(`${kind} open`, async () => { await page.setInputFiles('#pp-file', file!); await expect(page.locator('#pp-docname')).not.toBeEmpty(); await idle(page) })
    await timed(`${kind} next x20`, async () => { for (let i = 0; i < 20; i++) { await page.click('#nav-next'); await idle(page) } })
    if (kind === 'scan') {
      await page.click('#pp-modes [data-mode="SELECT"]')
      await page.fill('#pp-pattern', '1-3')
      await page.press('#pp-pattern', 'Enter')
      await timed('scan dewarp x3', async () => { await page.click('#sp-dewarp'); await idle(page) })
      await page.click('#pp-modes [data-mode="ALL"]')
    }
    await timed(`${kind} auto-detect all`, async () => { await page.click('#cp-detect'); await idle(page) })
    await timed(`${kind} crop all`, async () => { await page.click('#cp-crop'); await idle(page) })
    for (const fmt of kind === 'scan' ? ['PDF', 'JPG', 'PDF'] : ['PDF', 'PDF']) {
      await page.selectOption('#op-format', fmt)
      await timed(`${kind} save ${fmt}`, async () => {
        const dl = page.waitForEvent('download', { timeout: 1_200_000 })
        await page.click('#op-export')
        await dl
      })
    }
    clearInterval(sampler)
    console.log(`[bench] ${kind} memory: idle ${base_mb.toFixed(0)} MB, peak ${peak.toFixed(0)} MB`)
  })
}
