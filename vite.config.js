import { createHtmlPlugin } from "vite-plugin-html";

/**
 * @type {import("vite").UserConfig}
 */
export default {
  build: {
    modulePreload: {
      polyfill: false,
    },
    outDir: "_site",
  },
  plugins: [createHtmlPlugin()],
};
