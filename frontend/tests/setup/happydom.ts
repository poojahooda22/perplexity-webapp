// Preloaded by `bun test` (see bunfig.toml [test].preload) BEFORE any test file runs.
// Registers happy-dom's `document`/`window`/`localStorage`/`matchMedia` etc. as globals so
// React components can render in the test runner. Bun has no jsdom; happy-dom is the shim.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
  // Tests run offline. Don't fetch external scripts/CSS referenced in the DOM (e.g. the
  // TradingView heatmap <iframe> script, favicon sheets) — treat disabled loads as a
  // successful no-op so they neither throw nor spam the test output.
  settings: {
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    handleDisabledFileLoadingAsSuccess: true,
  },
});