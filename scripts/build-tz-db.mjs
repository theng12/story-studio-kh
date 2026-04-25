#!/usr/bin/env node
// Generates frontend/data/timezones.json from the Node runtime's bundled
// IANA database (Intl.supportedValuesOf('timeZone')). Run this whenever
// you upgrade Node or want to pick up a new tzdata release; the output
// ships bundled so the UI never hits the network for this list.
//
// Usage:  node scripts/build-tz-db.mjs

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '..', 'frontend', 'data', 'timezones.json')

// Curated shortlist surfaced as "Popular" in the picker. Kept small on
// purpose — the grouped regional lists below cover everything else.
// Asia/Phnom_Penh is first because this is the primary user's home zone.
const POPULAR = [
  'UTC',
  'Asia/Phnom_Penh',
  'America/Los_Angeles',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
]

function offsetMinutesAt(zone, date) {
  // Compute the zone's UTC offset (in minutes) at the given instant by
  // asking Intl for the local wall time and diffing against the same
  // instant in UTC. Works for any zone, DST or not.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(date)
  const get = (t) => Number(parts.find((p) => p.type === t)?.value)
  let hour = get('hour')
  if (hour === 24) hour = 0   // Node < 22 can return '24' for midnight
  const wall = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    hour, get('minute'), get('second'),
  )
  return Math.round((wall - date.getTime()) / 60000)
}

function regionForZone(zone) {
  const prefix = zone.split('/')[0]
  switch (prefix) {
    case 'Africa':     return 'Africa'
    case 'America':    return 'Americas'
    case 'Antarctica': return 'Antarctic'
    case 'Arctic':     return 'Arctic'
    case 'Asia':       return 'Asia'
    case 'Atlantic':   return 'Atlantic'
    case 'Australia':  return 'Oceania'
    case 'Europe':     return 'Europe'
    case 'Indian':     return 'Indian'
    case 'Pacific':    return 'Oceania'
    case 'UTC':        return 'UTC'
    case 'Etc':        return 'UTC'
    default:           return 'Other'
  }
}

function cityFromZone(zone) {
  const tail = zone.split('/').slice(1).join(' / ') || zone
  return tail.replace(/_/g, ' ')
}

function main() {
  if (typeof Intl.supportedValuesOf !== 'function') {
    throw new Error('Intl.supportedValuesOf is not available in this Node runtime. Use Node 18+.')
  }
  const zones = Intl.supportedValuesOf('timeZone').slice()
  // Node doesn't include a canonical 'UTC' entry in supportedValuesOf,
  // but creators rely on it as a neutral default. Inject it explicitly.
  if (!zones.includes('UTC')) zones.push('UTC')
  zones.sort()

  const jan = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 15, 12, 0, 0))
  const jul = new Date(Date.UTC(new Date().getUTCFullYear(), 6, 15, 12, 0, 0))

  const byRegion = {}
  for (const zone of zones) {
    const region = regionForZone(zone)
    if (!byRegion[region]) byRegion[region] = []
    byRegion[region].push({
      id: zone,
      city: cityFromZone(zone),
      offset_minutes_jan: offsetMinutesAt(zone, jan),
      offset_minutes_jul: offsetMinutesAt(zone, jul),
    })
  }

  const regionOrder = [
    'UTC', 'Americas', 'Europe', 'Africa', 'Asia', 'Oceania',
    'Atlantic', 'Indian', 'Antarctic', 'Arctic', 'Other',
  ]
  const regions = regionOrder
    .filter((r) => byRegion[r] && byRegion[r].length)
    .map((name) => ({ name, zones: byRegion[name] }))

  const popular = POPULAR.filter((z) => zones.includes(z))

  const out = {
    generated_at: new Date().toISOString(),
    source: `Intl.supportedValuesOf('timeZone') on Node ${process.version}`,
    total: zones.length,
    popular,
    regions,
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
  console.log(`Wrote ${zones.length} zones across ${regions.length} regions → ${OUT}`)
}

main()
