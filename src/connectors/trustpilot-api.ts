import type { Connector } from "./base";

export const trustpilotApiConnector: Connector = {
  source: "trustpilot",
  async fetch(_config) {
    return [];
  },
};
