// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookieStatus } from "@/lib/cookies";
import { AdminCookiesPanel } from "./AdminCookiesPanel";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const ABSENT_STATUS: CookieStatus = {
  present: false,
  lastModified: null,
  size: null,
  uploadedBy: null,
};

const PRESENT_STATUS: CookieStatus = {
  present: true,
  lastModified: "2026-01-01T00:00:00.000Z",
  size: 2048,
  uploadedBy: "paul@example.com",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminCookiesPanel", () => {
  it("renders 'No cookies uploaded yet' when absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ABSENT_STATUS));
    render(<AdminCookiesPanel />);

    await waitFor(() => expect(screen.getByText(/no cookies uploaded yet/i)).toBeInTheDocument());
  });

  it("renders the upload date, uploader, and size when present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(PRESENT_STATUS));
    render(<AdminCookiesPanel />);

    await waitFor(() => {
      expect(screen.getByText(/paul@example\.com/)).toBeInTheDocument();
      expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
    });
  });

  it("reads a chosen file into the textarea", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ABSENT_STATUS));
    render(<AdminCookiesPanel />);
    await waitFor(() => expect(screen.getByText(/no cookies uploaded yet/i)).toBeInTheDocument());

    const file = new File(["# Netscape HTTP Cookie File\ncontents"], "cookies.txt", {
      type: "text/plain",
    });
    const input = screen.getByLabelText(/paste cookies\.txt contents, or choose a file/i);
    await userEvent.upload(input, file);

    expect(await screen.findByDisplayValue(/# Netscape HTTP Cookie File/)).toBeInTheDocument();
  });

  it("shows an error and skips reading an oversized file", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ABSENT_STATUS));
    render(<AdminCookiesPanel />);
    await waitFor(() => expect(screen.getByText(/no cookies uploaded yet/i)).toBeInTheDocument());

    const file = new File(["small"], "cookies.txt", { type: "text/plain" });
    Object.defineProperty(file, "size", { value: 512 * 1024 + 1 });
    const input = screen.getByLabelText(/paste cookies\.txt contents, or choose a file/i);
    await userEvent.upload(input, file);

    expect(await screen.findByText(/too large/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial status GET
  });

  it("saves the textarea contents via PUT and refreshes status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ABSENT_STATUS));
    render(<AdminCookiesPanel />);
    await waitFor(() => expect(screen.getByText(/no cookies uploaded yet/i)).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText(/netscape http cookie file/i);
    await userEvent.type(textarea, "raw-cookie-contents");

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse(PRESENT_STATUS));

    await userEvent.click(screen.getByRole("button", { name: /save cookies/i }));

    await waitFor(() => expect(screen.getByText(/cookies saved/i)).toBeInTheDocument());
    const [, putInit] = fetchMock.mock.calls[1];
    expect(putInit).toMatchObject({ method: "PUT" });
    expect(JSON.parse(putInit.body)).toEqual({ cookies: "raw-cookie-contents" });
    expect(screen.getByText(/paul@example\.com/)).toBeInTheDocument();
  });

  it("renders the server's error message on a failed save", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ABSENT_STATUS));
    render(<AdminCookiesPanel />);
    await waitFor(() => expect(screen.getByText(/no cookies uploaded yet/i)).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText(/netscape http cookie file/i);
    await userEvent.type(textarea, "bad-cookies");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "Lines must be tab-separated (7 fields)." }, false),
    );

    await userEvent.click(screen.getByRole("button", { name: /save cookies/i }));

    expect(await screen.findByText(/tab-separated/i)).toBeInTheDocument();
  });

  it("disables Test until cookies are present, then shows the resolved title", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(PRESENT_STATUS));
    render(<AdminCookiesPanel />);
    await waitFor(() => expect(screen.getByText(/paul@example\.com/)).toBeInTheDocument());

    const testButton = screen.getByRole("button", { name: /test/i });
    expect(testButton).toBeEnabled();

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, title: "Some Song", usedCookies: true }));
    await userEvent.click(testButton);

    expect(await screen.findByText(/resolved "some song"/i)).toBeInTheDocument();
  });

  it("keeps Test disabled when no cookies are present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(ABSENT_STATUS));
    render(<AdminCookiesPanel />);
    await waitFor(() => expect(screen.getByText(/no cookies uploaded yet/i)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /test/i })).toBeDisabled();
  });
});
