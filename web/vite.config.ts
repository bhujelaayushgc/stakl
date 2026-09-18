import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: process.env.LOCALDESK_DEV_URL || "http://127.0.0.1:49152",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (req) => {
            req.removeHeader("origin");
            if (process.env.LOCALDESK_DEV_TOKEN)
              req.setHeader(
                "Authorization",
                `Bearer ${process.env.LOCALDESK_DEV_TOKEN}`,
              );
          });
        },
      },
    },
  },
  test: {
    exclude: ["e2e/**", "node_modules/**"],
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
