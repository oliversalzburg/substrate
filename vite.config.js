import { createHtmlPlugin } from "vite-plugin-html";
import { viteSingleFile } from "vite-plugin-singlefile";

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
  plugins: [viteSingleFile(), createHtmlPlugin()],
};
