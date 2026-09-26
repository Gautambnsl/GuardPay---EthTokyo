import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Browser talks only to the agent API; secrets never reach the client bundle.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4000", "/mock-world": "http://localhost:4000" },
  },
});
