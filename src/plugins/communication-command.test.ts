import { describe, expect, it } from "vitest";
import {
  parseCommunicationCommandReceiptV1,
  parseCommunicationCommandV1,
} from "./communication-command";

const destination = {
  providerId: "helmsman.slack/review",
  artifactHash: "a".repeat(64),
  workspace: "T123",
  channel: "C123",
  mention: "@reviewers",
  connectionId: "connection-1",
};
const command = {
  version: 1,
  repo: "acme/widgets",
  number: 42,
  expectedDestination: destination,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
};

describe("communication command contracts", () => {
  it("retains the exact destination in successful receipts", () => {
    const retained = parseCommunicationCommandV1(command);
    expect(
      parseCommunicationCommandReceiptV1(
        {
          version: 1,
          requestId: command.requestId,
          input: {
            version: 1,
            repo: command.repo,
            number: command.number,
            expectedDestination: destination,
          },
          status: "succeeded",
          result: {
            repo: command.repo,
            number: command.number,
            destination,
            permalink:
              "https://example.slack.com/archives/C123/p1710000000000000",
          },
          reason: null,
        },
        retained,
      ),
    ).toMatchObject({ status: "succeeded", result: { destination } });
  });

  it("rejects a changed destination or unsafe permalink", () => {
    const retained = parseCommunicationCommandV1(command);
    const receipt = {
      version: 1,
      requestId: command.requestId,
      input: {
        version: 1,
        repo: command.repo,
        number: command.number,
        expectedDestination: destination,
      },
      status: "succeeded",
      result: {
        repo: command.repo,
        number: command.number,
        destination: { ...destination, channel: "C456" },
        permalink: null,
      },
      reason: null,
    };
    expect(() =>
      parseCommunicationCommandReceiptV1(receipt, retained),
    ).toThrow();
    expect(() =>
      parseCommunicationCommandReceiptV1(
        {
          ...receipt,
          result: {
            ...receipt.result,
            destination,
            permalink:
              "https://attacker.example/archives/C123/p1710000000000000",
          },
        },
        retained,
      ),
    ).toThrow();
  });
});

import {
  parseCommunicationNotificationsV1,
  parseCommunicationSettingsValuesV1,
} from "./communication";

describe("communication read contracts", () => {
  it("accepts an empty fresh-install settings value set", () => {
    expect(
      parseCommunicationSettingsValuesV1({
        enabled: false,
        watchEnabled: false,
        clientId: "",
        channelId: "",
        channelName: "",
        browserSurface: "",
        reviewChannel: "",
        reviewMention: "",
      }),
    ).toMatchObject({ enabled: false, channelId: "" });
  });

  it("accepts zero unread notifications", () => {
    expect(
      parseCommunicationNotificationsV1({
        version: 1,
        quality: "complete",
        unread: 0,
        health: {
          enabled: false,
          status: "disabled",
          channelName: "",
          intervalMs: 300000,
          lastSuccessAt: null,
          error: null,
        },
        githubHealth: null,
        notifications: [],
      }).unread,
    ).toBe(0);
  });
});
