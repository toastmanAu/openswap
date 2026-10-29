#!/usr/bin/env -S npx tsx
// Regenerates lock-v2-tests/vectors/{wire,fill}.json from the TS codec and model.
import { writeFile } from 'node:fs/promises';
import { buildFillVectors, buildWireVectors } from '../sdk/src/v2/vectors.js';
const dir = new URL('../lock-v2-tests/vectors/', import.meta.url);
await writeFile(new URL('wire.json', dir), JSON.stringify(buildWireVectors(), null, 2) + '\n');
const fill = buildFillVectors();
await writeFile(new URL('fill.json', dir), JSON.stringify(fill, null, 1) + '\n');
const counts: Record<number, number> = {};
for (const v of fill) counts[v.expected] = (counts[v.expected] ?? 0) + 1;
console.log(`wrote ${fill.length} fill vectors; by verdict`, counts);
