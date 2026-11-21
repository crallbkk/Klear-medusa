import Medusa from "@medusajs/js-sdk";

// Set by Medusa's admin bundler to the backend's address (the same origin
// unless the admin is hosted apart from it).
declare const __BACKEND_URL__: string | undefined;

// The one client the admin extension talks to the backend with. It carries
// the signed-in person's session; nothing here holds a key.
export const sdk = new Medusa({
  baseUrl: (typeof __BACKEND_URL__ !== "undefined" && __BACKEND_URL__) || "/",
  auth: {
    type: "session",
  },
});
