import { createHtmlPlugin } from "vite-plugin-html";

/**
 * @type {import("vite").UserConfig}
 */
export default {
  base: "https://oliversalzburg.github.io/substrate/",
  build: {
    modulePreload: {
      polyfill: false,
    },
    outDir: "_site",
  },
  plugins: [createHtmlPlugin()],
};
