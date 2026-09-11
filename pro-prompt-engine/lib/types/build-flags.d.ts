/**
 * Compile-time build flags injected by wxt.config.ts's `vite.define` — a
 * literal text substitution, not a runtime env read (see that file's
 * comment). `__PP_E2E__` is `true` only in the e2e build
 * (`npm run build:e2e`, PP_E2E=1); every other build substitutes `false`
 * and the minifier drops whatever branch it guards.
 */
declare const __PP_E2E__: boolean;
