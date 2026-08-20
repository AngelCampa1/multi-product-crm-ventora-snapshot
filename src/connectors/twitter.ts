import type { Connector } from "./base";

export const twitterConnector: Connector = {
  source: "twitter",
  async fetch(_config) {
    return [];
  },
};
