import type { Connector } from "./base";

export const g2ApiConnector: Connector = {
  source: "g2",
  async fetch(_config) {
    return [];
  },
};
