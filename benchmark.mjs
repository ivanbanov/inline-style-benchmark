// Automated CSS styling-performance benchmark.
//
// Reproduces the manual DevTools Performance measurements (see report.png) with
// Playwright + the Chrome DevTools Protocol tracing API. For every styling
// technique we load a fresh page, isolate a single style-change action inside a
// trace window, and read the same two numbers DevTools shows by hand:
//
//   render   = Recalculate Style ("UpdateLayoutTree") + Layout
//   painting = Paint + Pre-Paint + Layerize + Composite/Commit + Raster
//
// Output: results.json (machine-readable) + a printed summary table.

import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PAGE_URL = 'file://' + resolve(__dirname, 'benchmark.html')

const RUNS = Number(process.env.RUNS || 5)
const THROTTLES = [1, 6]

// One row per report line: label + the two page functions it triggers.
const TECHNIQUES = [
  { label: 'element style attr',            parent: 'changeParentsStyleAttrRawValue',  child: 'changeChildrenStyleAttrRawValue' },
  { label: 'element style attr with cssvar', parent: 'changeParentsStyleAttrCSSVar',    child: 'changeChildrenStyleAttrCSSVar' },
  { label: '<html> style attr with cssvar',  parent: 'changeParentsDocumentCSSVar',     child: 'changeChildrenDocumentCSSVar' },
  { label: 'class',                          parent: 'changeParentsClassNameRawValue',  child: 'changeChildrenClassNameRawValue' },
  { label: 'class with cssvar',              parent: 'changeParentsClassNameCSSVar',    child: 'changeChildrenClassNameCSSVar' },
  { label: 'insertRule',                     parent: 'insertRuleParentRawValue',        child: 'insertRuleChildRawValue' },
  { label: 'insertRule with cssvar',         parent: 'insertRuleParentCSSVar',          child: 'insertRuleChildCSSVar' },
  { label: 'inject style tag',               parent: 'injectParentStyleTag',            child: 'injectChildStyleTag' },
]

// Trace event names, bucketed the way DevTools groups them.
const RENDER_EVENTS = new Set(['UpdateLayoutTree', 'Layout'])
const PAINT_EVENTS = new Set([
  'Paint', 'PrePaint', 'Layerize', 'UpdateLayer', 'UpdateLayerTree',
  'CompositeLayers', 'Composite Layers', 'Commit', 'RasterTask', 'Rasterize',
])

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Start a CDP trace, collecting timeline events until stopTracing() resolves.
async function startTracing(client) {
  const events = []
  const onData = (payload) => events.push(...payload.value)
  client.on('Tracing.dataCollected', onData)
  await client.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
      ],
    },
  })
  return async function stopTracing() {
    const complete = new Promise((res) => client.once('Tracing.tracingComplete', res))
    await client.send('Tracing.end')
    await complete
    client.off('Tracing.dataCollected', onData)
    return events
  }
}

// Sum durations (ms) of matching complete ("X") events within the trace window.
function summarize(events) {
  let render = 0
  let painting = 0
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    if (RENDER_EVENTS.has(e.name)) render += e.dur / 1000
    else if (PAINT_EVENTS.has(e.name)) painting += e.dur / 1000
  }
  return { render: +render.toFixed(1), painting: +painting.toFixed(1) }
}

async function measure(browser, fn, throttle) {
  const page = await browser.newPage()
  try {
    await page.goto(PAGE_URL)
    await page.waitForFunction(() => document.querySelectorAll('body > div').length >= 5000)

    const client = await page.context().newCDPSession(page)
    await client.send('Emulation.setCPUThrottlingRate', { rate: throttle })

    const stop = await startTracing(client)

    // Trigger the action, then wait only until the render pipeline goes idle:
    // keep requesting frames and resolve once one lands back at a normal cadence
    // (a light change settles in ~1 frame; inject-style-tag runs the full cap).
    const maxWait = throttle > 1 ? 8000 : 3000
    await page.evaluate(
      ({ name, maxWait }) =>
        new Promise((res) => {
          window[name]()
          const start = performance.now()
          let last = start
          const tick = (now) => {
            const gap = now - last
            const elapsed = now - start
            last = now
            // Idle frame (< 50ms) after a minimum settle, or hard cap reached.
            if ((elapsed > 200 && gap < 50) || elapsed > maxWait) {
              // one more frame so the paint is captured, then finish
              requestAnimationFrame(() => setTimeout(res, 50))
            } else {
              requestAnimationFrame(tick)
            }
          }
          requestAnimationFrame(tick)
        }),
      { name: fn, maxWait }
    )

    return summarize(await stop())
  } finally {
    await page.close()
  }
}

async function main() {
  const browser = await chromium.launch()
  const results = {
    meta: {
      machine: `${os.cpus()[0].model} ${Math.round(os.totalmem() / 1e9)}gb`,
      domNodes: 5000,
      runs: RUNS,
      timeUnit: 'ms',
      note: 'Headless Chromium via Playwright + CDP tracing. Values are medians.',
    },
    tables: {},
  }

  for (const throttle of THROTTLES) {
    const key = throttle === 1 ? 'no-throttling' : `${throttle}x-throttling`
    results.tables[key] = []
    for (const t of TECHNIQUES) {
      const acc = { parentRender: [], parentPainting: [], childRender: [], childPainting: [] }
      for (let r = 0; r < RUNS; r++) {
        const p = await measure(browser, t.parent, throttle)
        const c = await measure(browser, t.child, throttle)
        acc.parentRender.push(p.render)
        acc.parentPainting.push(p.painting)
        acc.childRender.push(c.render)
        acc.childPainting.push(c.painting)
      }
      const row = {
        technique: t.label,
        parentRender: +median(acc.parentRender).toFixed(1),
        parentPainting: +median(acc.parentPainting).toFixed(1),
        childRender: +median(acc.childRender).toFixed(1),
        childPainting: +median(acc.childPainting).toFixed(1),
      }
      results.tables[key].push(row)
      console.log(
        `[${key}] ${t.label.padEnd(30)} ` +
          `P ${String(row.parentRender).padStart(6)}/${String(row.parentPainting).padStart(6)}  ` +
          `C ${String(row.childRender).padStart(6)}/${String(row.childPainting).padStart(6)}`
      )
    }
    console.log('')
  }

  await browser.close()

  const out = resolve(__dirname, 'results.json')
  writeFileSync(out, JSON.stringify(results, null, 2))
  console.log(`Wrote ${out}  (columns: render/painting, P=parent C=child)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
