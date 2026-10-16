// Resolution hooks for running the repo's TypeScript libraries straight from Node, with no build step.
//
// Why this lives in the repo: every round since R2 wrote its assertion suite as a `.mjs` file in /tmp,
// and /tmp is a scratch pad — the stack of suites has now been wiped twice (2026-10-14, and again before
// R3-16 could run it), taking ~1,000 assertions with it each time. The libraries those suites proved are
// still on disk; the proofs were not. A test that exists only in a directory the OS cleans is a claim
// about the code, not evidence about it.
//
// Node strips types from `.ts` files on import, but it does not know this project's `@/` alias or the
// extensionless relative specifiers the app writes (`from './x'`). So: map `@/…` onto `src/…`, and give
// a bare specifier a `.ts`, then `.tsx`, then `/index.ts`.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

/** Repo root, derived from this file's own location so the harness travels with the checkout. */
const SRC = pathToFileURL(resolvePath(fileURLToPath(import.meta.url), '..', '..', 'src') + '/')

export async function resolve(specifier, context, nextResolve) {
  // `@/lib/x` → <repo>/src/lib/x(.ts|.tsx|/index.ts)
  if (specifier.startsWith('@/')) {
    const target = new URL(specifier.slice(2), SRC)
    const found = withExtension(target)
    if (found) return { url: found.href, format: 'module-typescript', shortCircuit: true }
  }

  // An extensionless relative import made from inside `src/` — the app's own style.
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const base = dirname(fileURLToPath(context.parentURL))
    const here = resolvePath(base, specifier)
    if (!/\.[a-z]+$/.test(here)) {
      for (const cand of [`${here}.ts`, `${here}.tsx`, `${here}/index.ts`]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, format: 'module-typescript', shortCircuit: true }
      }
    }
  }

  return nextResolve(specifier, context)
}

function withExtension(url) {
  const p = fileURLToPath(url)
  if (/\.[a-z]+$/.test(p)) return existsSync(p) ? url : null
  for (const cand of [`${p}.ts`, `${p}.tsx`, `${p}/index.ts`]) {
    if (existsSync(cand)) return pathToFileURL(cand)
  }
  return null
}
