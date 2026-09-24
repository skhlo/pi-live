import { defineConfig } from "/tmp/pi-better-openai.qnz8hk/node_modules/vitest/dist/config.js";

export default defineConfig({
  resolve: {
    alias: {
      undici: "/private/tmp/dotfiles-pi-live-spec/preview/live-spec/transport/fake-undici.ts",
      ws: "/private/tmp/dotfiles-pi-live-spec/preview/live-spec/transport/fake-ws.ts",
    },
  },
});
