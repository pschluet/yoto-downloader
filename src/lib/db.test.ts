import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/lib-dynamodb")>(
    "@aws-sdk/lib-dynamodb",
  );
  return {
    ...actual,
    DynamoDBDocumentClient: { from: vi.fn(() => ({ send: mockSend })) },
  };
});

describe("updateTrack", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    process.env.JOBS_TABLE_NAME = "jobs-table";
  });

  it("clears fields set to undefined with REMOVE instead of a dangling SET reference", async () => {
    const { updateTrack } = await import("@/lib/db");

    await updateTrack("job-1", 0, { status: "downloading", pct: 0, etaSeconds: undefined });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0].input;

    expect(input.UpdateExpression).toBe(
      "SET tracks[0].#f0 = :v0, tracks[0].#f1 = :v1 REMOVE tracks[0].#f2",
    );
    expect(input.ExpressionAttributeNames).toEqual({ "#f0": "status", "#f1": "pct", "#f2": "etaSeconds" });
    expect(input.ExpressionAttributeValues).toEqual({ ":v0": "downloading", ":v1": 0 });
  });

  it("uses REMOVE only when every patched field is undefined", async () => {
    const { updateTrack } = await import("@/lib/db");

    await updateTrack("job-1", 0, { error: undefined });

    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toBe("REMOVE tracks[0].#f0");
    expect(input.ExpressionAttributeValues).toBeUndefined();
  });
});
