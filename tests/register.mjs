// Import this, not hooks.mjs: `node --experimental-strip-types --import ./tests/register.mjs ./tests/x.test.mjs`.
//
// A file that only *exports* the resolve hook does nothing when passed to `--import` — nothing registers
// it, and every `@/…` import then dies with ERR_MODULE_NOT_FOUND. The registration is the other half of
// the pair, and it belongs next to the hooks so the two are never separated by a clean-up.
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
